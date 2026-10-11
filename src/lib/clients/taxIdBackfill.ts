/**
 * The one-time ח.פ backfill from Morning (E17-3, owner decision 11.10: "עמודת
 * ח.פ מקומית בטבלת clients, השלמה חד-פעמית ממורנינג"). PURE — this file
 * decides; `scripts/backfill_tax_id.ts` reads, prints and (with --apply)
 * writes. The split is what lets the suite pin every bucket with a fake
 * Morning and no database (F19).
 *
 * ═══ THE RULES ═══
 *   · matched ONLY by `clients.morning_client_id` — never by name. A name match
 *     is a guess, and a guessed ח.פ is a wrong number on the next registration's
 *     duplicate check.
 *   · a value is proposed only when Morning's is valid: exactly 9 digits after
 *     trimming (the same rule as `validateTaxId`, owner 7.10). Anything else is
 *     reported, never "fixed" here.
 *   · 🔴 a CONFLICT writes nobody. `clients_tax_id_key` (0107) is unique, so two
 *     of ours with one ח.פ cannot both hold it — and picking one of them would
 *     be a decision about which client is real. That is the owner's, not a
 *     script's. Three ways to conflict:
 *       shared_by_our_clients — two or more of ours would get the same number
 *                               (typically two cards mapped to one Morning
 *                               client, legitimate since 0026);
 *       held_by_other_client  — another of ours already holds it;
 *       differs_from_existing — this client already holds a DIFFERENT number.
 *   · an existing equal value is "already set", not an update. Nothing is ever
 *     overwritten.
 */

export type OurClientForBackfill = {
  id: string;
  name: string;
  morning_client_id: string | null;
  tax_id: string | null;
};

export type MorningClientForBackfill = { id: string; name: string; taxId?: string | null };

export type ConflictReason = "shared_by_our_clients" | "held_by_other_client" | "differs_from_existing";

export type TaxIdBackfillPlan = {
  /** will be written with --apply */
  update: { clientId: string; name: string; morningClientId: string; taxId: string }[];
  /** Morning has no ח.פ for this client */
  noTaxId: { clientId: string; name: string; morningClientId: string }[];
  /** Morning has something, and it is not 9 digits */
  invalid: { clientId: string; name: string; morningClientId: string; raw: string }[];
  /** written for none of them — see the header */
  conflict: {
    taxId: string;
    reason: ConflictReason;
    clients: { clientId: string; name: string; morningClientId: string | null; existing: string | null }[];
  }[];
  /** already holds exactly Morning's value */
  alreadySet: { clientId: string; name: string; taxId: string }[];
  /** mapped to a Morning id the Morning list did not return (deleted, or inactive there) */
  notInMorning: { clientId: string; name: string; morningClientId: string }[];
  /** how many of ours have no Morning id at all — nothing to look up */
  unmapped: number;
};

const NINE_DIGITS = /^[0-9]{9}$/;

export function planTaxIdBackfill(
  ours: OurClientForBackfill[],
  morning: MorningClientForBackfill[]
): TaxIdBackfillPlan {
  const plan: TaxIdBackfillPlan = {
    update: [],
    noTaxId: [],
    invalid: [],
    conflict: [],
    alreadySet: [],
    notInMorning: [],
    unmapped: 0,
  };
  const morningById = new Map(morning.map((m) => [m.id, m]));

  // who already holds which number, before anything moves
  const holderOf = new Map<string, OurClientForBackfill>();
  for (const c of ours) if (c.tax_id) holderOf.set(c.tax_id, c);

  type Candidate = { client: OurClientForBackfill; morningClientId: string; taxId: string };
  const candidates: Candidate[] = [];

  for (const c of ours) {
    if (!c.morning_client_id) {
      plan.unmapped++;
      continue;
    }
    const m = morningById.get(c.morning_client_id);
    if (!m) {
      plan.notInMorning.push({ clientId: c.id, name: c.name, morningClientId: c.morning_client_id });
      continue;
    }
    const raw = typeof m.taxId === "string" ? m.taxId.trim() : "";
    if (raw === "") {
      plan.noTaxId.push({ clientId: c.id, name: c.name, morningClientId: c.morning_client_id });
      continue;
    }
    if (!NINE_DIGITS.test(raw)) {
      plan.invalid.push({ clientId: c.id, name: c.name, morningClientId: c.morning_client_id, raw: m.taxId as string });
      continue;
    }
    if (c.tax_id === raw) {
      plan.alreadySet.push({ clientId: c.id, name: c.name, taxId: raw });
      continue;
    }
    if (c.tax_id && c.tax_id !== raw) {
      plan.conflict.push({
        taxId: raw,
        reason: "differs_from_existing",
        clients: [{ clientId: c.id, name: c.name, morningClientId: c.morning_client_id, existing: c.tax_id }],
      });
      continue;
    }
    candidates.push({ client: c, morningClientId: c.morning_client_id, taxId: raw });
  }

  // group by the number they would receive; any group of two or more, or a
  // number already held by someone else, writes nobody
  const byTaxId = new Map<string, Candidate[]>();
  for (const k of candidates) byTaxId.set(k.taxId, [...(byTaxId.get(k.taxId) ?? []), k]);

  for (const [taxId, group] of Array.from(byTaxId.entries())) {
    const holder = holderOf.get(taxId);
    if (group.length > 1) {
      plan.conflict.push({
        taxId,
        reason: "shared_by_our_clients",
        clients: [
          ...group.map((g) => ({ clientId: g.client.id, name: g.client.name, morningClientId: g.morningClientId, existing: g.client.tax_id })),
          ...(holder ? [{ clientId: holder.id, name: holder.name, morningClientId: holder.morning_client_id, existing: holder.tax_id }] : []),
        ],
      });
      continue;
    }
    if (holder) {
      const g = group[0];
      plan.conflict.push({
        taxId,
        reason: "held_by_other_client",
        clients: [
          { clientId: g.client.id, name: g.client.name, morningClientId: g.morningClientId, existing: g.client.tax_id },
          { clientId: holder.id, name: holder.name, morningClientId: holder.morning_client_id, existing: holder.tax_id },
        ],
      });
      continue;
    }
    const g = group[0];
    plan.update.push({ clientId: g.client.id, name: g.client.name, morningClientId: g.morningClientId, taxId });
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "he");
  plan.update.sort(byName);
  plan.noTaxId.sort(byName);
  plan.invalid.sort(byName);
  plan.alreadySet.sort(byName);
  plan.notInMorning.sort(byName);
  plan.conflict.sort((a, b) => a.taxId.localeCompare(b.taxId));
  return plan;
}

export const CONFLICT_LABEL: Record<ConflictReason, string> = {
  shared_by_our_clients: "אותו ח.פ לכמה לקוחות אצלנו",
  held_by_other_client: "הח.פ כבר שמור אצל לקוח אחר",
  differs_from_existing: "ללקוח כבר יש ח.פ אחר",
};

/** The report, as lines. Pure, so the suite can assert the shape too. */
export function formatTaxIdBackfillReport(plan: TaxIdBackfillPlan, apply: boolean): string[] {
  const out: string[] = [];
  out.push(apply ? "═══ השלמת ח.פ ממורנינג — מצב כתיבה (--apply) ═══" : "═══ השלמת ח.פ ממורנינג — דוח בלבד, שום דבר לא נכתב ═══");
  out.push("");
  out.push(`יתעדכנו: ${plan.update.length}`);
  out.push(`אין ח.פ במורנינג: ${plan.noTaxId.length}`);
  out.push(`ח.פ לא תקין: ${plan.invalid.length}`);
  out.push(`התנגשות (לא נכתב לאף אחד): ${plan.conflict.length}`);
  out.push(`כבר מעודכן: ${plan.alreadySet.length}`);
  out.push(`ממופה למזהה שמורנינג לא החזיר: ${plan.notInMorning.length}`);
  out.push(`בלי מזהה מורנינג (לא נבדק): ${plan.unmapped}`);

  const section = (title: string, rows: string[]) => {
    out.push("");
    out.push(`── ${title} (${rows.length})`);
    for (const r of rows) out.push(`  ${r}`);
  };
  section("יתעדכנו", plan.update.map((u) => `${u.name} | ${u.taxId} | client ${u.clientId} | morning ${u.morningClientId}`));
  section("אין ח.פ במורנינג", plan.noTaxId.map((u) => `${u.name} | client ${u.clientId} | morning ${u.morningClientId}`));
  section("ח.פ לא תקין", plan.invalid.map((u) => `${u.name} | "${u.raw}" | client ${u.clientId} | morning ${u.morningClientId}`));
  section(
    "התנגשות",
    plan.conflict.map(
      (c) =>
        `${c.taxId} | ${CONFLICT_LABEL[c.reason]} | ` +
        c.clients.map((x) => `${x.name} (client ${x.clientId}${x.existing ? `, קיים: ${x.existing}` : ""})`).join(" ; ")
    )
  );
  section("ממופה למזהה שמורנינג לא החזיר", plan.notInMorning.map((u) => `${u.name} | client ${u.clientId} | morning ${u.morningClientId}`));
  return out;
}

export type ApplyResult = {
  written: { clientId: string; taxId: string }[];
  /** the row changed under us (someone set a ח.פ meanwhile) — not overwritten */
  skipped: { clientId: string; taxId: string; reason: string }[];
  failed: { clientId: string; taxId: string; error: string }[];
};

/**
 * Writes `plan.update` and NOTHING else — conflicts, invalid values and the
 * rest are never touched. Called only by the script, only behind --apply.
 *
 * Each write is guarded by `tax_id is null`: between the report and the write
 * someone may have typed a number on the card, and that number wins. A 23505
 * (the unique index caught a number that arrived meanwhile on another client)
 * is a skip with its reason, not a failure of the run. One event per written
 * row, so "where did this ח.פ come from" is answerable later.
 */
export async function applyTaxIdBackfill(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  plan: TaxIdBackfillPlan
): Promise<ApplyResult> {
  const res: ApplyResult = { written: [], skipped: [], failed: [] };
  for (const u of plan.update) {
    const { data, error } = await admin
      // clients-status: a write by id — the plan was built from active clients only
      .from("clients")
      .update({ tax_id: u.taxId })
      .eq("id", u.clientId)
      .is("tax_id", null)
      .select("id");
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        res.skipped.push({ clientId: u.clientId, taxId: u.taxId, reason: "הח.פ נשמר בינתיים אצל לקוח אחר" });
      } else {
        res.failed.push({ clientId: u.clientId, taxId: u.taxId, error: error.message });
      }
      continue;
    }
    if (!data || (data as unknown[]).length === 0) {
      res.skipped.push({ clientId: u.clientId, taxId: u.taxId, reason: "ללקוח כבר יש ח.פ — לא נדרס" });
      continue;
    }
    res.written.push({ clientId: u.clientId, taxId: u.taxId });
    await admin.from("events").insert({
      entity_type: "client",
      entity_id: u.clientId,
      event_type: "client_tax_id_backfilled",
      payload: { tax_id: u.taxId, morning_client_id: u.morningClientId, source: "scripts/backfill_tax_id.ts" },
    });
  }
  return res;
}
