// EntityDrawer field registry — the single source of truth for what each
// permission level may SEE and EDIT per entity type.
//
// Rule 1 of the drawer spec: fields the viewer lacks permission for are
// never selected server-side — not hidden, not present in the response.
// The API route builds its select list from `visibleFields`, so a column
// that isn't visible simply does not exist for that user. Editing is then
// triple-walled: `editableFields` here (API rejects), RLS (row gate),
// and the 0010 column-guard triggers (final wall in the DB itself).

import type { Profile } from "@/lib/profile";

export type ViewPerm = "any" | "money" | "stages";
export type EditPerm = "money" | "stages" | "either" | "none";

export type FieldDef = {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "date" | "select" | "readonly";
  view: ViewPerm;
  edit: EditPerm;
  options?: { value: string; label: string }[] | "clients" | "shows";
};

export type EntityType = "production" | "job" | "show" | "client" | "contract";

export const ENTITY_TYPES: EntityType[] = ["production", "job", "show", "client", "contract"];

type EntityConfig = {
  table: string;
  icon: string;
  label: string;
  titleKey: string;
  fields: FieldDef[];
};

export const ENTITY_CONFIG: Record<EntityType, EntityConfig> = {
  production: {
    table: "productions",
    icon: "🎬",
    label: "הפקה",
    titleKey: "podcast_name",
    fields: [
      { key: "podcast_name", label: "פודקאסט", type: "text", view: "any", edit: "stages" },
      { key: "guest", label: "אורח", type: "text", view: "any", edit: "stages" },
      { key: "record_date", label: "תאריך הקלטה", type: "date", view: "any", edit: "stages" },
      { key: "record_time", label: "שעת הקלטה", type: "text", view: "any", edit: "stages" },
      { key: "studio", label: "אולפן", type: "text", view: "any", edit: "stages" },
      // rendered as a fixed tag at the top of the drawer (+ its own modal), not
      // as a generic field row — filtered out of the field list like `status`.
      // Registered here so the entity PATCH accepts it under can_edit_stages.
      { key: "storage_disk", label: "דיסק", type: "text", view: "any", edit: "stages" },
      // derived from the 6 stages; the only manual transition (client
      // approval) gets a dedicated flow later, not a free-text edit
      { key: "status", label: "סטטוס", type: "readonly", view: "any", edit: "none" },
      { key: "on_hold", label: "הקפאה", type: "boolean", view: "any", edit: "stages" },
      // display-only — the freeze flow (drawer + board) captures these; the
      // drawer routes the on_hold toggle through /api/productions/[id] so a
      // reason/who/when is always recorded, never a bare boolean
      { key: "on_hold_reason", label: "סיבת הקפאה", type: "readonly", view: "any", edit: "none" },
      { key: "on_hold_since", label: "מוקפא מאז", type: "readonly", view: "any", edit: "none" },
      { key: "show_id", label: "תוכנית", type: "select", view: "any", edit: "stages", options: "shows" },
      { key: "client_id", label: "לקוח", type: "select", view: "money", edit: "money", options: "clients" },
      // Marking a single production internal takes it out of billing entirely
      // (checkEligibility returns applicable:false on kind<>'client', silently
      // and correctly) — so it is money editing, not stage editing. NOTE: there
      // is no DB guard on this column, unlike default_rate/billing_mode; this
      // registry plus the API route are the only walls today.
      {
        key: "kind",
        label: "סוג הפקה",
        type: "select",
        view: "money",
        edit: "money",
        options: [
          { value: "client", label: "לקוח (מחויבת)" },
          { value: "internal", label: "פנימית (לא מחויבת)" },
          { value: "contract", label: "חוזה" },
        ],
      },
      // Why this production is not billing (enqueue.ts writes it, the radar
      // reads it as a 🟡). Exposed here so the drawer can SELECT the column at
      // all — `selectColumns` is built from this list, so a column that isn't
      // registered does not exist for the drawer.
      //
      // view "any", not "money", and that is a deliberate call rather than an
      // oversight: no reason string this column can hold carries an amount —
      // they name a missing show, a missing client, an unmapped Morning client,
      // an undefined rate or unentered hours. And since 0067 the reason most
      // often waiting here is "לא הוזנו שעות ההקלטה", whose only possible
      // reader is the TECHNICIAN, who has no money permission at all. A money-
      // gated flag would be invisible to the one person who can clear it.
      //
      // edit "none": it is derived state. It is cleared by enqueueDocument on
      // the next successful pass, never by hand.
      { key: "billing_block_reason", label: "חסימת חיוב", type: "readonly", view: "any", edit: "none" },
      { key: "notes", label: "הערות", type: "text", view: "any", edit: "either" },
    ],
  },
  job: {
    table: "jobs",
    icon: "💰",
    label: "חיוב",
    titleKey: "campaign",
    // job rows are can_view_money-only at the RLS level already; the field
    // perms mirror that so the config stays honest on its own
    fields: [
      { key: "date", label: "תאריך", type: "date", view: "money", edit: "money" },
      { key: "campaign", label: "קמפיין", type: "text", view: "money", edit: "money" },
      { key: "amount", label: "סכום", type: "number", view: "money", edit: "money" },
      { key: "paid", label: "שולם", type: "boolean", view: "money", edit: "money" },
      { key: "invoice_biz", label: "חשבונית עסקה", type: "text", view: "money", edit: "money" },
      { key: "invoice_tax", label: "חשבונית מס", type: "text", view: "money", edit: "money" },
      { key: "due_date", label: "פירעון (מחושב)", type: "readonly", view: "money", edit: "none" },
      { key: "manual_only", label: "חיוב כללי (ללא הפקה)", type: "boolean", view: "money", edit: "money" },
      { key: "client_id", label: "לקוח", type: "select", view: "money", edit: "money", options: "clients" },
      { key: "notes", label: "הערות", type: "text", view: "money", edit: "money" },
    ],
  },
  show: {
    table: "shows",
    icon: "📺",
    label: "תוכנית",
    titleKey: "name",
    fields: [
      // "stages" not "either": a show's name is an operational detail. The
      // bookkeeper (money, no stages) views productions/shows but edits
      // nothing there (owner rule 2026-07-21) — matching aliases/studio/etc.
      { key: "name", label: "שם", type: "text", view: "any", edit: "stages" },
      { key: "aliases", label: "כינויים (מופרדים בפסיק)", type: "text", view: "any", edit: "stages" },
      { key: "client_id", label: "לקוח", type: "select", view: "money", edit: "money", options: "clients" },
      {
        key: "billing_mode", label: "מודל חיוב", type: "select", view: "money", edit: "money",
        options: [
          { value: "per_episode", label: "לפי פרק" },
          { value: "contract", label: "חוזה" },
          { value: "none", label: "ללא חיוב" },
        ],
      },
      // default_rate is intentionally NOT here: its SELECT privilege is
      // revoked from the authenticated role (0021), so it's edited only on
      // the dedicated show card (via the service-role path), never through
      // this generic session-selecting drawer.
      { key: "default_studio", label: "אולפן קבוע", type: "text", view: "any", edit: "stages" },
      { key: "camera_count", label: "מספר מצלמות", type: "number", view: "any", edit: "stages" },
      { key: "notes", label: "הערות", type: "text", view: "any", edit: "stages" },
      { key: "color", label: "צבע", type: "text", view: "any", edit: "stages" },
      { key: "active", label: "פעילה", type: "boolean", view: "any", edit: "stages" },
      { key: "is_oneoff", label: "חד־פעמית", type: "boolean", view: "any", edit: "stages" },
    ],
  },
  client: {
    table: "clients",
    icon: "👤",
    label: "לקוח",
    titleKey: "name",
    fields: [
      { key: "name", label: "שם", type: "text", view: "any", edit: "money" },
      // `contact_name` USED TO BE A ROW HERE. Removed 2026-09-09 (owner) — do
      // not put it back.
      //
      // The card grew a contact block that reads Morning's `contactPerson`
      // live, so "איש קשר" appeared TWICE on one screen with two different
      // values. Not a display glitch: the two fields were never synced and had
      // drifted apart in all three rows that held a value — for ידיעות
      // אחרונות they name two different people.
      //
      // The column still exists and still holds those three values; nothing was
      // migrated or deleted. It simply has no reader in the app any more, and
      // that is deliberate — re-registering it here would restore the duplicate.
      // The values, and the open question of which of the two is current, are
      // written out in docs/TICKETS.md under "מבצעי / מונחה-אירוע".
      //
      // (It also cannot be quietly repurposed: selectColumns builds the SELECT
      // from this list, so anything added here must be a real column.)
      {
        key: "billing_mode", label: "מודל חיוב", type: "select", view: "money", edit: "money",
        options: [
          { value: "per_episode", label: "לפי פרק" },
          { value: "retainer", label: "ריטיינר" },
          { value: "package", label: "חבילה" },
          { value: "none", label: "ללא חיוב" },
        ],
      },
      {
        key: "payment_terms", label: "תנאי תשלום", type: "select", view: "money", edit: "money",
        options: [
          { value: "immediate", label: "מיידי" },
          { value: "net_30", label: "שוטף+30" },
          { value: "net_60", label: "שוטף+60" },
          { value: "eom_30", label: "סוף חודש+30" },
          { value: "eom_60", label: "סוף חודש+60" },
          { value: "eom_90", label: "סוף חודש+90" },
        ],
      },
      { key: "default_rate", label: "מחיר ברירת מחדל", type: "number", view: "money", edit: "money" },
      {
        key: "billing_cadence", label: "קצב חיוב (ברירת מחדל)", type: "select", view: "money", edit: "money",
        options: [
          { value: "per_episode", label: "פר-פרק (חשבון עסקה מיד)" },
          { value: "monthly", label: "מרוכז חודשי" },
          { value: "every_n", label: "מרוכז כל N פרקים" },
        ],
      },
      { key: "billing_every_n", label: "N (רק לקצב 'כל N פרקים')", type: "number", view: "money", edit: "money" },
    ],
  },
  contract: {
    table: "contracts",
    icon: "📄",
    label: "חוזה",
    titleKey: "name",
    fields: [
      { key: "name", label: "שם", type: "text", view: "money", edit: "money" },
      { key: "client_id", label: "לקוח", type: "select", view: "money", edit: "money", options: "clients" },
      { key: "total_amount", label: "סכום כולל", type: "number", view: "money", edit: "money" },
      // 0098 — מכסת פרקים. רשומה כאן ולא רק במסך החוזים משתי סיבות: היא מה
      // שמכניס את העמודה ל-`selectColumns` (ובלעדיה המסך הגנרי לא היה קורא
      // אותה בכלל), והיא מה שהופך את `patch: { included_episodes }` לחוקי
      // ב-`/api/entity/contract/[id]` — המסלול שמסך החוזים כבר משתמש בו
      // לעדכון סטטוס (ContractsClient.tsx:135).
      // ⚠️ הראוט הגנרי אינו מוליד ולידציה. הגבולות 1..500 נאכפים ב-CHECK של
      // 0098, והבדיקה ב-lib/contracts/quota.ts היא מה שמונע מהם להגיע כשגיאת
      // Postgres גולמית. אותה אסימטריה שיש ל-total_amount מאז 0002.
      { key: "included_episodes", label: "פרקים בחבילה", type: "number", view: "money", edit: "money" },
      { key: "start_date", label: "תחילה", type: "date", view: "money", edit: "money" },
      { key: "end_date", label: "סיום", type: "date", view: "money", edit: "money" },
      {
        key: "status", label: "סטטוס", type: "select", view: "money", edit: "money",
        options: [
          { value: "active", label: "פעיל" },
          { value: "closed", label: "סגור" },
        ],
      },
    ],
  },
};

/**
 * ═══ THE CLIENT CARD'S MORNING-HELD FIELDS ═══
 *
 * The other half of the client card declared above. These four facts belong to
 * the client exactly as `payment_terms` does — the card shows them, the card
 * edits them — but they live in MORNING and `clients` has no column for any of
 * them.
 *
 * 🔴 WHY THEY ARE A SEPARATE LIST AND NOT ROWS IN `ENTITY_CONFIG.client.fields`
 * — this is the constraint, not a preference: `selectColumns` turns every
 * registered key straight into the PostgREST select list (bottom of this file),
 * so a key with no column 400s the ENTIRE client card for every viewer, not
 * just that one field. `editableKeys` and `visibleFields` read the same array.
 * Registering them there is not "untidy", it is a broken client card.
 *
 * And they are not rendered by the generic field rows either, for a second and
 * independent reason: those rows save on blur with no validation and no
 * confirmation, which is right for `default_rate` and wrong for a number that
 * prints on a tax document. EntityFieldRows renders the DB fields; the Morning
 * block (ClientMorningCard) renders these.
 *
 * `view`/`edit` are the same gate the client NAME carries (`edit: "money"`,
 * above): contact details and the ח.פ travel with the name. The PATCH route
 * lifts these keys out of `patch` BEFORE the allow-list runs and re-checks
 * can_edit_money itself — a list is not an authorisation.
 *
 * ⚠️ `send` IS ABSENT ON PURPOSE. Morning recomputes it from `emails` and
 * overwrites anything we pass (measured 2026-09-09, morning/client.ts), so it
 * is read-only in the card and must never appear in a writable field list.
 */
export type MorningOnlyField = { key: string; label: string; view: ViewPerm; edit: EditPerm };

export const MORNING_ONLY_CLIENT_FIELDS: MorningOnlyField[] = [
  { key: "emails", label: "כתובות מייל", view: "money", edit: "money" },
  { key: "phone", label: "טלפון", view: "money", edit: "money" },
  { key: "contactPerson", label: "איש קשר", view: "money", edit: "money" },
  // 🔴 7.10 — editable from the clients screen, and every write goes to
  // Morning behind an explicit confirmation window. Validated as exactly 9
  // digits before the wire (lib/clients/taxId.ts).
  { key: "taxId", label: "ח.פ / ע.מ", view: "money", edit: "money" },
];

/**
 * The keys the PATCH route must lift out of `patch`. DERIVED, so the route and
 * the card cannot hold different ideas of which fields are remote — the route
 * used to carry its own hard-coded copy of three of these.
 */
export const MORNING_ONLY_CLIENT_KEYS: readonly string[] = MORNING_ONLY_CLIENT_FIELDS.map((f) => f.key);

export function canViewField(profile: Profile, view: ViewPerm): boolean {
  if (view === "any") return true;
  if (view === "money") return profile.can_view_money;
  return profile.can_view_stages;
}

export function canEditField(profile: Profile, edit: EditPerm): boolean {
  if (edit === "none") return false;
  if (edit === "money") return profile.can_edit_money;
  if (edit === "stages") return profile.can_edit_stages;
  return profile.can_edit_money || profile.can_edit_stages;
}

export function visibleFields(type: EntityType, profile: Profile): FieldDef[] {
  return ENTITY_CONFIG[type].fields.filter((f) => canViewField(profile, f.view));
}

export function editableKeys(type: EntityType, profile: Profile): Set<string> {
  return new Set(
    ENTITY_CONFIG[type].fields
      .filter((f) => canViewField(profile, f.view) && canEditField(profile, f.edit))
      .map((f) => f.key)
  );
}

export function selectColumns(type: EntityType, profile: Profile): string {
  return ["id", ...visibleFields(type, profile).map((f) => f.key)].join(",");
}
