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
  readonly meta: { readonly changes?: number; readonly duration?: number; readonly rows_read?: number };
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
    /** The template this was compiled from, so an enclosing statement can recompile it (see `compile`). */
    readonly source?: { readonly strings: readonly string[]; readonly values: readonly unknown[] },
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

/**
 * Merge template text and params; nested fragments splice in.
 *
 * AN ID LIST AFTER `in (` OR `= any(` BINDS ONE `?` PER ID WHILE THE STATEMENT FITS D1'S 100, AND
 * AS ONE JSON PARAMETER (`json_each`) WHEN IT WOULD NOT. Two incidents, one rule (19 Sep 2026):
 *  - Always one-per-id took the trader list down at the app's page size: Postgres bound
 *    `= any($1)` as a single array, the D1 port (e12d303) made it N binds, and a page of 100
 *    handles bound 101 (knownChainsFor), 200 (scorecardRows), 119-501 (/trades).
 *  - Always json_each (3eec954, live for hours) was worse where it was not needed: a WHERE term
 *    holding a subquery is never pushed down into an aggregate view, so `wallet_chain_presence
 *    where handle in (…25…)` went from an index SEARCH to a SCAN of all of `trades` on every
 *    sampler chunk.
 * So a statement that ran before today compiles exactly as it did, and only one that could not
 * run at all takes the json_each form. An empty list is `in ()`, which SQLite accepts as "no rows".
 * ponytail: in the json_each form a NUMBER element does not match a TEXT column (no affinity is
 * applied to `value`); every list in the tree is string ids. Cast in the caller if that changes.
 */
export const compile = (
  strings: readonly string[], values: readonly unknown[], listsAsJson = false,
): { text: string; params: unknown[] } => {
  let text = "";
  const params: unknown[] = [];
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i === values.length) break;
    const v = values[i];
    if (isFragment(v)) {
      const inner = v.source ? compile(v.source.strings, v.source.values, listsAsJson) : v;
      text += inner.text;
      params.push(...inner.params);
    } else if (Array.isArray(v) && (IN_LIST.test(text) || EQ_ANY.test(text))) {
      text = text.replace(EQ_ANY, " in (");
      if (listsAsJson) {
        text += "select value from json_each(?)";
        params.push(JSON.stringify(v.map(bindable)));
      } else {
        text += v.map(() => "?").join(", ");
        params.push(...v.map(bindable));
      }
    } else {
      text += "?";
      params.push(bindable(v));
    }
  }
  return { text, params };
};

/** One `?` per id while it fits; every list as one parameter when it would not. */
export const compileToFit = (strings: readonly string[], values: readonly unknown[]): { text: string; params: unknown[] } => {
  const inline = compile(strings, values);
  return inline.params.length <= D1_MAX_PARAMS ? inline : compile(strings, values, true);
};

const guard = (text: string, params: readonly unknown[]): void => {
  if (params.length > D1_MAX_PARAMS) {
    throw new Error(
      `d1sql: statement binds ${params.length} parameters, D1 allows ${D1_MAX_PARAMS} (id lists bind as one; this is a multi-row write — chunk the rows): ${text.trim().slice(0, 80)}`,
    );
  }
};

const rows = <T>(o: D1Outcome): Rows<T> =>
  Object.assign(o.results as unknown as T & object, { count: o.results.length || (o.meta.changes ?? 0) }) as Rows<T>;

/** A statement at or over this wall time is logged with its cost, so the tail NAMES the slow query. */
export const SLOW_STATEMENT_MS = 1000;
const head = (text: string): string => text.trim().replace(/\s+/g, " ").slice(0, 120);

const isTemplate = (v: unknown): v is TemplateStringsArray => Array.isArray(v) && "raw" in v;

/** Build a `Sql` whose statements run through `exec`; `eager` issues them at creation (a transaction queue). */
const makeSql = (exec: (text: string, params: readonly unknown[]) => Promise<D1Outcome>, begin: Sql["begin"], eager = false): Sql => {
  const run = <T>(text: string, params: readonly unknown[], source?: Query<T>["source"]): Query<T> => {
    guard(text, params);
    const issued = eager ? exec(text, params) : undefined;
    issued?.catch(() => undefined); // a never-awaited queued statement must not surface as an unhandled rejection
    return new Query<T>(text, params, () => (issued ?? exec(text, params)).then((o) => rows<T>(o)), source);
  };
  const call = (first: TemplateStringsArray | string, ...values: unknown[]): Query<unknown> => {
    if (isTemplate(first)) {
      const { text, params } = compileToFit(first, values);
      return run(text, params, { strings: first, values });
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
  type Pending = { text: string; stmt: D1Statement; resolve: (o: D1Outcome) => void; reject: (e: unknown) => void };
  let queue: Pending[] = [];
  let scheduled = false;
  let failure: unknown;
  let tail: Promise<void> = Promise.resolve(); // batches run one after another; `begin` waits for the last
  const runBatch = async (): Promise<void> => {
    scheduled = false;
    const batch = queue;
    queue = [];
    if (!batch.length) return;
    const started = Date.now();
    try {
      const outcomes = await db.batch(batch.map((p) => p.stmt));
      const wall = Date.now() - started;
      if (wall >= SLOW_STATEMENT_MS) console.warn(`d1 slow batch: ${wall} ms wall, ${batch.length} statements, first: ${head(batch[0].text)}`);
      outcomes.forEach((o, i) => batch[i].resolve(o));
    } catch (e) {
      console.error(`d1 batch of ${batch.length} failed after ${Date.now() - started} ms, first: ${head(batch[0].text)}`);
      failure ??= e;
      batch.forEach((p) => p.reject(e));
    }
  };
  const flush = (): Promise<void> => (tail = tail.then(runBatch));
  const exec = (text: string, params: readonly unknown[]): Promise<D1Outcome> =>
    new Promise<D1Outcome>((resolve, reject) => {
      queue.push({ text, stmt: db.prepare(text).bind(...params), resolve, reject });
      if (!scheduled) { scheduled = true; queueMicrotask(() => void flush()); }
    });
  const tx = makeSql(exec, (inner) => Promise.resolve(inner(tx)), true);
  const out = await fn(tx);
  await flush();
  if (failure !== undefined) throw failure; // a batch that failed after its statements were fire-and-forgotten
  return out;
};

/**
 * Wall time against D1's own `duration` tells queueing from cost: a 4 s wall on a 3 ms statement
 * is a database busy with someone else's work. A failure carries the SQL it failed on, which the
 * 19 Sep incident had to be re-run under a tail to learn.
 */
export const timed = async (text: string, issue: () => Promise<D1Outcome>): Promise<D1Outcome> => {
  const started = Date.now();
  try {
    const o = await issue();
    const wall = Date.now() - started;
    if (wall >= SLOW_STATEMENT_MS) {
      console.warn(`d1 slow: ${wall} ms wall, ${o.meta.duration ?? "?"} ms sql, ${o.meta.rows_read ?? "?"} rows read: ${head(text)}`);
    }
    return o;
  } catch (e) {
    console.error(`d1 failed after ${Date.now() - started} ms: ${head(text)}`);
    throw e;
  }
};

export function d1sql(db: D1Like): Sql {
  const exec = (text: string, params: readonly unknown[]): Promise<D1Outcome> =>
    timed(text, () => db.prepare(text).bind(...params).all());
  return makeSql(exec, transaction(db));
}
