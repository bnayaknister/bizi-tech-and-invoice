// Stop a failed query from reading as an empty result.
//
// supabase-js resolves rather than rejects: a query that PostgREST refused
// comes back as { data: null, error }. The house pattern across this codebase
// destructures only `data` and then writes `data ?? []`, which turns every
// failure into "there is nothing here" — a screen that renders perfectly and
// says the wrong thing.
//
// That cost a debugging round on 2026-08-12: /shows displayed "0 פעילות ·
// 0 חד־פעמיות" with a clean console and a clean terminal, because the select
// named a column a migration had not created yet. PostgREST answered
// 400 / 42703, and `?? []` swallowed it whole. Nothing in the build can catch
// this either — the client is constructed without a Database generic, so a
// select() string is opaque to tsc.
//
// Two functions, because "the query failed" and "the query found nothing" are
// different facts and must not collapse into one:
//   mustRows  — a list read. Throws on error, returns [] for an empty result.
//   must      — a maybeSingle() read. Throws on error, returns null for no row.
//
// Both throw SupabaseReadError, which carries the PostgREST code so a caller
// can tell 42703 (missing column — usually an unapplied migration) apart from
// a permission or connectivity fault.

export type QueryResult<T> = {
  data: T | null;
  error: { message: string; code?: string | null } | null;
};

export class SupabaseReadError extends Error {
  readonly code: string | null;
  readonly context: string;

  constructor(context: string, message: string, code: string | null) {
    // 42703 = undefined_column. In this repo that has meant an unapplied
    // migration every single time, so the hint is worth carrying.
    const hint = code === "42703" ? " — ייתכן שמיגרציה טרם הורצה" : "";
    super(`${context}: ${message}${hint}`);
    this.name = "SupabaseReadError";
    this.code = code ?? null;
    this.context = context;
  }
}

/** List read. Throws on error; an empty result is [] and is not an error. */
export function mustRows<T>(res: QueryResult<T[]>, context: string): T[] {
  if (res.error) throw new SupabaseReadError(context, res.error.message, res.error.code ?? null);
  return res.data ?? [];
}

/** Single-row read. Throws on error; "no such row" is null and is not an error. */
export function must<T>(res: QueryResult<T>, context: string): T | null {
  if (res.error) throw new SupabaseReadError(context, res.error.message, res.error.code ?? null);
  return res.data;
}
