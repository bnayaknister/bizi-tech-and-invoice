# FUTURE — infra / strategic items, post-beta

> Larger moves that are directionally right but must NOT happen mid-beta.
> Distinct from POLISH_BACKLOG.md (design nits). Record here, act later.

---

## ~~Move Supabase + Vercel to a European region (Frankfurt)~~ ✅ DONE (Aug 2026)

**Both services are in Frankfurt today.** Supabase `eu-central-1`, Vercel
`fra1` (pinned in `vercel.json`). They are co-located, and Frankfurt is ~50ms
from Israel — the better leg on BOTH sides, which is exactly what this item
asked for.

Verified 2026-09-07 against the live deployment:

```
curl -sI https://bizi-tech-and-invoice.vercel.app/documents
  → x-vercel-cache: MISS        (the function ran; not an edge cache hit)
  → x-vercel-id: fra1::fra1::…  (<edge>::<function region>::<id>)
```

Note for anyone re-checking: `/login` is prerendered static, so its
`x-vercel-id` names the edge PoP, not the function region. Probe a dynamic
route instead.

**What the move cost, recorded because it is still being paid:** bindings on
the `auth` schema did not survive it. Migration `0058` restored
`trg_handle_new_user` (the function came across, the trigger binding did not),
and ticket **T16** is still open to sweep for others lost the same way.

**History (the original entry, kept because the reasoning still reads true):**
the project began in Singapore (`ap-southeast-1`) with Vercel defaulting to
iad1, making every compute↔DB call a trans-Pacific ~250ms hop. Pinning
`"regions": ["sin1"]` on 2026-07-22 co-located them and collapsed that to
~10ms — the free win. But Singapore is ~155ms from Israel, so the
user↔function leg stayed high, which is what made the Frankfurt move worth its
risk. The owner deferred it on 2026-07-22 as too dangerous mid-beta; it was
carried out once the team had settled.
