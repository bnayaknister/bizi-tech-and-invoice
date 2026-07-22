# FUTURE — infra / strategic items, post-beta

> Larger moves that are directionally right but must NOT happen mid-beta.
> Distinct from POLISH_BACKLOG.md (design nits). Record here, act later.

---

## Move Supabase + Vercel to a European region (Frankfurt)

**Why:** the Supabase project is in Singapore (`ap-southeast-1`); Vercel is now
co-located in `sin1`, so compute↔DB round-trips collapsed ~250ms → ~10ms. But
Singapore is ~155ms from Israel, so the per-navigation user↔function floor stays
high. Both services in Frankfurt (`eu-central-1` / `fra1`) would be ~50ms from
Israel — better on BOTH legs.

**Why not now (owner, 2026-07-22):** this is a Supabase project migration mid-
beta — new database, new API keys, and a migration of the auth users. Too much
risk while the team is still settling in. **Do it after the team has settled**,
not during beta.

**Scope when we do it:** provision EU Supabase project → migrate schema + data
→ migrate auth users → rotate keys (env on Vercel + local) → repoint Morning /
calendar / any webhooks → set `"regions": ["fra1"]` in vercel.json. See
[memory: bizi-region-latency].
