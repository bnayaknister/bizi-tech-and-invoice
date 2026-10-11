/**
 * An in-memory stand-in for a supabase-js client, for the OFFLINE suites (F19).
 * Not a test itself (no `test_` prefix).
 *
 * It FILTERS and ENFORCES like the real thing where the suites depend on it:
 *   · eq / neq / in / is / gt / gte / lt / lte, including `payload->>key`
 *   · count: "exact" + head
 *   · unique indexes (declared per table) -> error code 23505, row not written
 *   · upsert with ignoreDuplicates -> returns only the rows actually inserted
 * Every call is recorded in `calls` so a suite can assert what was NOT done.
 */
import { randomUUID } from "node:crypto";

export type Row = Record<string, unknown>;
export type Call = { table: string; op: string; payload?: unknown };

type Unique = { table: string; cols: string[]; where?: (r: Row) => boolean };

function get(r: Row, path: string): unknown {
  const m = /^(\w+)->>(\w+)$/.exec(path);
  if (m) {
    const o = r[m[1]] as Record<string, unknown> | null | undefined;
    const v = o?.[m[2]];
    return v === undefined || v === null ? null : String(v);
  }
  return r[path];
}

export function fakeDb(
  tables: Record<string, Row[]>,
  opts: { unique?: Unique[]; failOn?: Record<string, string[]>; now?: () => Date } = {}
) {
  const calls: Call[] = [];
  const now = opts.now ?? (() => new Date());
  const uniques = opts.unique ?? [];
  const store = tables;

  function violates(table: string, row: Row, ignoreSelf?: Row): boolean {
    for (const u of uniques.filter((x) => x.table === table)) {
      if (u.where && !u.where(row)) continue;
      if (u.cols.some((c) => row[c] === null || row[c] === undefined)) continue;
      const hit = (store[table] ?? []).some(
        (r) => r !== ignoreSelf && (!u.where || u.where(r)) && u.cols.every((c) => r[c] === row[c])
      );
      if (hit) return true;
    }
    return false;
  }

  function from(table: string) {
    store[table] = store[table] ?? [];
    let op = "select";
    let payload: unknown;
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } | undefined;
    let head = false;
    let countMode = false;
    let one: "single" | "maybe" | null = null;
    let returning = false;
    const filters: ((r: Row) => boolean)[] = [];
    let limitN: number | null = null;

    const b: Record<string, unknown> = {};
    const chain = (fn: () => void) => () => (fn(), b);
    b.select = (_cols?: string, o?: { count?: string; head?: boolean }) => {
      if (op !== "select") returning = true;
      if (o?.count) countMode = true;
      if (o?.head) head = true;
      return b;
    };
    b.insert = (v: unknown) => ((op = "insert"), (payload = v), b);
    b.upsert = (v: unknown, o?: { onConflict?: string; ignoreDuplicates?: boolean }) => (
      (op = "upsert"), (payload = v), (upsertOpts = o), b
    );
    b.update = (v: unknown) => ((op = "update"), (payload = v), b);
    b.delete = () => ((op = "delete"), b);
    b.eq = (c: string, v: unknown) => (filters.push((r) => get(r, c) === v), b);
    b.neq = (c: string, v: unknown) => (filters.push((r) => get(r, c) !== v), b);
    b.in = (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(get(r, c))), b);
    b.is = (c: string, v: unknown) => (filters.push((r) => (get(r, c) ?? null) === v), b);
    b.gt = (c: string, v: string) => (filters.push((r) => String(get(r, c)) > v), b);
    b.gte = (c: string, v: string) => (filters.push((r) => String(get(r, c)) >= v), b);
    b.lt = (c: string, v: string) => (filters.push((r) => String(get(r, c)) < v), b);
    b.lte = (c: string, v: string) => (filters.push((r) => String(get(r, c)) <= v), b);
    b.not = (c: string, o: string, v: unknown) => {
      if (o === "is" && v === null) filters.push((r) => get(r, c) != null);
      return b;
    };
    b.order = () => b;
    b.range = () => b;
    b.limit = (n: number) => ((limitN = n), b);
    b.maybeSingle = chain(() => (one = "maybe"));
    b.single = chain(() => (one = "single"));

    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      calls.push({ table, op, payload });
      const fail = opts.failOn?.[table];
      if (fail && fail.includes(op)) {
        return Promise.resolve({ data: null, error: { message: "boom", code: "XX000" }, count: null }).then(res, rej);
      }
      const match = (r: Row) => filters.every((f) => f(r));
      let data: unknown = null;
      let error: { message: string; code: string } | null = null;
      let count: number | null = null;

      if (op === "select") {
        let rows = store[table].filter(match);
        if (limitN !== null) rows = rows.slice(0, limitN);
        if (countMode) count = rows.length;
        data = head ? null : one ? rows[0] ?? null : rows;
        if (one === "single" && !rows[0]) error = { message: "no rows", code: "PGRST116" };
      } else if (op === "insert" || op === "upsert") {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const inserted: Row[] = [];
        for (const raw of list) {
          const row: Row = { id: raw.id ?? randomUUID(), created_at: now().toISOString(), ...raw };
          if (violates(table, row)) {
            if (op === "upsert" && upsertOpts?.ignoreDuplicates) continue;
            if (op === "upsert" && upsertOpts?.onConflict) {
              const keys = upsertOpts.onConflict.split(",");
              const existing = store[table].find((r) => keys.every((k) => r[k] === row[k]));
              if (existing) {
                Object.assign(existing, raw);
                inserted.push(existing);
                continue;
              }
            }
            error = { message: "duplicate key value violates unique constraint", code: "23505" };
            break;
          }
          store[table].push(row);
          inserted.push(row);
        }
        if (!error) data = one ? inserted[0] ?? null : returning || op === "upsert" ? inserted : null;
      } else if (op === "update") {
        const rows = store[table].filter(match);
        for (const r of rows) Object.assign(r, payload as Row);
        data = returning ? rows : null;
      } else if (op === "delete") {
        const keep = store[table].filter((r) => !match(r));
        data = returning ? store[table].filter(match) : null;
        store[table] = keep;
      }
      return Promise.resolve({ data, error, count }).then(res, rej);
    };
    return b;
  }

  return { client: { from } as never, calls, store };
}

/** The 0001/0107/0101 unique indexes the registration suites lean on. */
export const REGISTRATION_UNIQUES: Unique[] = [
  { table: "clients", cols: ["normalized_name"] },
  { table: "clients", cols: ["tax_id"], where: (r) => r.tax_id != null },
  { table: "client_registrations", cols: ["link_id"], where: (r) => r.link_id != null },
  { table: "registration_links", cols: ["token"] },
  { table: "wa_messages", cols: ["wamid"] },
];
