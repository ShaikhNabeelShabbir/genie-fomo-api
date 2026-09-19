import { DatabaseSync } from "node:sqlite";
import { d1sql, type D1Like, type D1Statement } from "../worker/src/d1.ts";
import { setDefaultSql } from "../supabase/functions/api/db.ts";

/** Called with every statement text the adapter prepares; the route sweep uses it for the plan audit. */
export type OnPrepare = (text: string) => void;

/** In-memory SQLite with THE schema (every D1 migration), installed as the API's default `sql`. */
export async function openSchema(onPrepare: OnPrepare = () => undefined): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
  const dir = new URL("../worker/d1/migrations/", import.meta.url);
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.name.endsWith(".sql")) files.push(e.name);
  for (const f of files.sort()) db.exec(await Deno.readTextFile(new URL(f, dir)));
  const like: D1Like = {
    prepare(text: string): D1Statement {
      onPrepare(text);
      const write = /^\s*(insert|update|delete|replace)/i.test(text) && !/returning/i.test(text);
      const make = (params: unknown[]): D1Statement => ({
        bind: (...values: unknown[]) => make(values),
        all: () => {
          const st = db.prepare(text);
          const p = params as (string | number | bigint | null | Uint8Array)[];
          if (write) return Promise.resolve({ results: [], meta: { changes: Number(st.run(...p).changes) } });
          return Promise.resolve({ results: st.all(...p) as unknown[], meta: {} });
        },
      });
      return make([]);
    },
    async batch(stmts: D1Statement[]) {
      const out = [];
      for (const s of stmts) out.push(await s.all());
      return out;
    },
  };
  setDefaultSql(d1sql(like));
  return db;
}
