import {
  ENTITY_CONFIG,
  canEditField,
  canViewField,
  type FieldDef,
} from "@/lib/entities";
import type { Profile } from "@/lib/profile";
import type { FieldMeta } from "@/components/EntityFieldRows";

/**
 * The client card's editable field set, per VIEWER.
 *
 * ═══ THE SAME COMPUTATION THE DRAWER'S GET PERFORMS ═══
 * GET /api/entity/client/[id] builds exactly this (route.ts, "field metadata
 * the drawer renders from"). /clients renders the same rows from a server
 * component, so it needs the same list — and the owner's rule for the screen
 * was that the editing surface is not a second copy.
 *
 * It is a FUNCTION here, in a file that imports nothing but entities.ts, for
 * two reasons:
 *  · the screen's data module imports `next/headers` (via the server supabase
 *    client), so a predicate living there cannot be unit-tested offline — and
 *    F19 requires this change's suite to be offline;
 *  · a permission change in entities.ts must reach the drawer and the screen in
 *    the same commit, which only happens if they both derive it rather than
 *    each listing fields.
 *
 * 🔴 It returns the DB COLUMNS only. The client's Morning-held facts — emails,
 * phone, contactPerson and the ח.פ — are NOT here and must not be: they have
 * no column (`selectColumns` would 400 the whole card) and they save with
 * validation and a confirmation window, which a blur-saving row does not do.
 * They are declared as MORNING_ONLY_CLIENT_FIELDS and rendered by
 * ClientMorningCard. And `contact_name`, the retired column, is absent from
 * both lists on purpose (entities.ts:159-176).
 */
export function clientFieldMeta(profile: Profile): FieldMeta[] {
  return ENTITY_CONFIG.client.fields
    .filter((f: FieldDef) => canViewField(profile, f.view))
    .map((f: FieldDef) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      editable: canEditField(profile, f.edit),
      options: typeof f.options === "string" ? f.options : f.options ?? null,
    }));
}
