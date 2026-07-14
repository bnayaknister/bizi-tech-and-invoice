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
      { key: "studio", label: "אולפן", type: "text", view: "any", edit: "stages" },
      // derived from the 6 stages; the only manual transition (client
      // approval) gets a dedicated flow later, not a free-text edit
      { key: "status", label: "סטטוס", type: "readonly", view: "any", edit: "none" },
      { key: "on_hold", label: "הקפאה", type: "boolean", view: "any", edit: "stages" },
      { key: "show_id", label: "תוכנית", type: "select", view: "any", edit: "stages", options: "shows" },
      { key: "client_id", label: "לקוח", type: "select", view: "money", edit: "money", options: "clients" },
      { key: "kind", label: "סוג", type: "readonly", view: "money", edit: "none" },
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
      { key: "name", label: "שם", type: "text", view: "any", edit: "either" },
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
      { key: "default_rate", label: "מחיר לפרק", type: "number", view: "money", edit: "money" },
      { key: "default_studio", label: "אולפן קבוע", type: "text", view: "any", edit: "stages" },
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
      { key: "contact_name", label: "איש קשר", type: "text", view: "money", edit: "money" },
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
