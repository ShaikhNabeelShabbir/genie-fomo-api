/**
 * postgres.js-shaped tagged template over Cloudflare D1, so rewritten SQL text is the only
 * change in callers. Rules and the SQLite cheatsheet: docs/D1_MIGRATION.md "The `sql` shim".
 * Self-contained on purpose: Deno tests import it, so no workers-types global is referenced;
 * `D1Database` satisfies `D1Like` structurally.
 */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all(): Promise<D1Outcome>;
}
export interface D1Outcome {
  readonly results: unknown[];
  readonly meta: { readonly changes?: number };
}
export interface D1Like {
  prepare(query: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Outcome[]>;
}

export type Row = Record<string, unknown>;
export type Rows<T> = T & { readonly count: number };

/** A compiled statement: text with `?` placeholders and its bound values. Lazy: runs on first `then`. */
export class Query<T = Row[]> implements PromiseLike<Rows<T>> {
  #promise: Promise<Rows<T>> | undefined;
  constructor(
    readonly text: string,
    readonly params: readonly unknown[],
    private readonly exec: () => Promise<Rows<T>>,
  ) {}
  then<R1 = Rows<T>, R2 = never>(
    onFulfilled?: ((v: Rows<T>) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    this.#promise ??= this.exec();
    return this.#promise.then(onFulfilled, onRejected);
  }
  catch<R = never>(onRejected?: ((e: unknown) => R | PromiseLike<R>) | null): Promise<Rows<T> | R> {
    return this.then(undefined, onRejected);
  }
}

export interface Sql {
  <T extends readonly unknown[] = Row[]>(strings: TemplateStringsArray, ...params: unknown[]): Query<T>;
  /** A bare identifier (`[a-z_][a-z0-9_]*`), e.g. a view name. */
  (identifier: string): Query<never>;
  unsafe<T extends readonly unknown[] = Row[]>(text: string, params?: readonly unknown[]): Query<T>;
  /** Statements between `await`s inside `fn` run as ONE `db.batch` (atomic); each `await` is a batch boundary. */
  begin<T>(fn: (tx: Sql) => Promise<T> | T): Promise<T>;
  end(opts?: unknown): Promise<void>;
}

const D1_MAX_PARAMS = 100;
const IDENT = /^[a-z_][a-z0-9_]*$/;
const IN_LIST = /\bin\s*\(\s*$/i;
const EQ_ANY = /\s*=\s*any\s*\(\s*$/i;

/** What D1 will bind: no booleans, no Dates, no bigints, no objects. */
export const bindable = (v: unknown): unknown => {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === "object" && !(v instanceof ArrayBuffer) && !ArrayBuffer.isView(v)) return JSON.stringify(v);
  return v;
};

const isFragment = (v: unknown): v is Query<unknown> => v instanceof Query;

/** Merge template text and params; nested fragments splice in; arrays expand inside `in (…)` / `= any(…)`. */
export const compile = (strings: readonly string[], values: readonly unknown[]): { text: string; params: unknown[] } => {
  let text = "";
  const params: unknown[] = [];
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i === values.length) break;
    const v = values[i];
    if (isFragment(v)) {
      text += v.text;
      params.push(...v.params);
    } else if (Array.isArray(v) && (IN_LIST.test(text) || EQ_ANY.test(text))) {
      text = text.replace(EQ_ANY, " in (") + v.map(() => "?").join(", ");
      params.push(...v.map(bindable));
    } else {
      text += "?";
      params.push(bindable(v));
    }
  }
  return { text, params };
};

const guard = (text: string, params: readonly unknown[]): void => {
  if (params.length > D1_MAX_PARAMS) {
    throw new Error(
      `d1sql: statement binds ${params.length} parameters, D1 allows ${D1_MAX_PARAMS} (chunk the ids): ${text.trim().slice(0, 80)}`,
    );
  }
};

const rows = <T>(o: D1Outcome): Rows<T> =>
  Object.assign(o.results as unknown as T & object, { count: o.results.length || (o.meta.changes ?? 0) }) as Rows<T>;

const isTemplate = (v: unknown): v is TemplateStringsArray => Array.isArray(v) && "raw" in v;

/** Build a `Sql` whose statements run through `exec`; `eager` issues them at creation (a transaction queue). */
const makeSql = (exec: (text: string, params: readonly unknown[]) => Promise<D1Outcome>, begin: Sql["begin"], eager = false): Sql => {
  const run = <T>(text: string, params: readonly unknown[]): Query<T> => {
    guard(text, params);
    const issued = eager ? exec(text, params) : undefined;
    issued?.catch(() => undefined); // a never-awaited queued statement must not surface as an unhandled rejection
    return new Query<T>(text, params, () => (issued ?? exec(text, params)).then((o) => rows<T>(o)));
  };
  const call = (first: TemplateStringsArray | string, ...values: unknown[]): Query<unknown> => {
    if (isTemplate(first)) {
      const { text, params } = compile(first, values);
      return run(text, params);
    }
    if (!IDENT.test(first)) throw new Error(`d1sql: '${first}' is not a bare identifier ([a-z_][a-z0-9_]*)`);
    return new Query<never>(first, [], () => Promise.reject(new Error(`d1sql: identifier '${first}' is a fragment, not a statement`)));
  };
  return Object.assign(call as Sql, {
    unsafe: <T>(text: string, params: readonly unknown[] = []) => run<T>(text, params.map(bindable)),
    begin,
    end: () => Promise.resolve(),
  });
};

/**
 * `begin`: every statement is queued as it is issued and the queue is flushed as ONE `db.batch`
 * at the next microtask, i.e. at the next `await` inside `fn` (or when `fn` returns). Statements
 * issued between awaits are atomic together; a queued write's rows (`returning`) and `count`
 * are real. A read sees the state after the previous flush. See docs/D1_MIGRATION.md "The `sql` shim".
 */
const transaction = (db: D1Like) => async <T>(fn: (tx: Sql) => Promise<T> | T): Promise<T> => {
  type Pending = { stmt: D1Statement; resolve: (o: D1Outcome) => void; reject: (e: unknown) => void };
  let queue: Pending[] = [];
  let scheduled = false;
  let failure: unknown;
  let tail: Promise<void> = Promise.resolve(); // batches run one after another; `begin` waits for the last
  const runBatch = async (): Promise<void> => {
    scheduled = false;
    const batch = queue;
    queue = [];
    if (!batch.length) return;
    try {
      const outcomes = await db.batch(batch.map((p) => p.stmt));
      outcomes.forEach((o, i) => batch[i].resolve(o));
    } catch (e) {
      failure ??= e;
      batch.forEach((p) => p.reject(e));
    }
  };
  const flush = (): Promise<void> => (tail = tail.then(runBatch));
  const exec = (text: string, params: readonly unknown[]): Promise<D1Outcome> =>
    new Promise<D1Outcome>((resolve, reject) => {
      queue.push({ stmt: db.prepare(text).bind(...params), resolve, reject });
      if (!scheduled) { scheduled = true; queueMicrotask(() => void flush()); }
    });
  const tx = makeSql(exec, (inner) => Promise.resolve(inner(tx)), true);
  const out = await fn(tx);
  await flush();
  if (failure !== undefined) throw failure; // a batch that failed after its statements were fire-and-forgotten
  return out;
};

export function d1sql(db: D1Like): Sql {
  const exec = (text: string, params: readonly unknown[]): Promise<D1Outcome> => db.prepare(text).bind(...params).all();
  return makeSql(exec, transaction(db));
}
