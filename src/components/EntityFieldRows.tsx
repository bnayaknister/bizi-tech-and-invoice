"use client";

import { useRef, type MutableRefObject } from "react";
import ClientCombobox from "@/components/ClientCombobox";

/**
 * The entity field rows — label on the left, the right control on the right,
 * per permission.
 *
 * ═══ WHY THIS IS ITS OWN FILE ═══
 * It was a closure inside EntityDrawer (`renderValue`), which was fine while
 * the drawer was the only screen that edited an entity. /clients (owner 7.10)
 * edits the same six client fields from a full screen, and the owner's rule for
 * it was explicit: "אותו רכיב בדיוק שמשמש את המגירה — לא שכפול שדות". So the
 * rows moved out here and BOTH callers render this; neither owns a copy.
 *
 * That is not tidiness. The fields are a permission surface — `editable` comes
 * from the server per viewer, and the select/date/number/array handling is
 * where a copy would quietly drift. A second spelling of this file is a second
 * place for a money field to become editable by the wrong person.
 *
 * ═══ WHAT IT DELIBERATELY DOES NOT DO ═══
 * · It does not fetch and it does not own the entity. The caller holds `entity`
 *   and does the optimistic paint, because the two callers roll back
 *   differently (the drawer reverts one field; the screen reloads the row).
 * · It renders what it is GIVEN. The drawer filters `status` / `storage_disk` /
 *   `billing_block_reason` out of the production list before passing them,
 *   because those have dedicated UI at the top of the drawer — that filter
 *   stays at the call site, so this component has no idea which screen it is
 *   on and cannot grow a special case.
 * · It never renders the client card's Morning-held fields (emails / phone /
 *   contactPerson / taxId). Those are not columns and they save with
 *   validation and a confirmation window; see MORNING_ONLY_CLIENT_FIELDS in
 *   entities.ts for why a blur-saving row is the wrong shape for them.
 */
export type FieldMeta = {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "date" | "select" | "readonly";
  editable: boolean;
  options: { value: string; label: string }[] | "clients" | "shows" | null;
};

export type OptionsData = {
  clients: { id: string; name: string }[];
  shows: { id: string; name: string }[];
};

export default function EntityFieldRows({
  fields,
  entity,
  optionsData,
  onSave,
  onClientCreated,
  dirtyRef,
  labelWidth = 110,
}: {
  fields: FieldMeta[];
  entity: Record<string, unknown>;
  optionsData: OptionsData;
  onSave: (key: string, value: unknown) => void;
  onClientCreated?: (client: { id: string; name: string }) => void;
  /**
   * Typed text/number edits awaiting blur. Passed IN rather than owned here so
   * the drawer's Cmd+Enter "flush everything dirty" keeps working — it reads
   * this very ref. A caller with no such shortcut can omit it and gets a local
   * one.
   */
  dirtyRef?: MutableRefObject<Record<string, unknown>>;
  labelWidth?: number;
}) {
  const localDirty = useRef<Record<string, unknown>>({});
  const dirty = dirtyRef ?? localDirty;

  function optionsFor(f: FieldMeta): { value: string; label: string }[] {
    if (f.options === "clients") return optionsData.clients.map((c) => ({ value: c.id, label: c.name }));
    if (f.options === "shows") return optionsData.shows.map((s) => ({ value: s.id, label: s.name }));
    return f.options ?? [];
  }

  function renderValue(f: FieldMeta) {
    const v = entity[f.key];
    if (f.type === "readonly")
      return <span className="text-sm">{v == null || v === "" ? "—" : String(v)}</span>;
    if (!f.editable) {
      if (f.type === "select") {
        const opt = optionsFor(f).find((o) => o.value === v);
        return <span className="text-sm">{opt?.label ?? (v == null ? "—" : String(v))}</span>;
      }
      if (f.type === "boolean") return <span className="text-sm">{v ? "כן" : "לא"}</span>;
      return <span className="text-sm">{v == null || v === "" ? "—" : String(v)}</span>;
    }
    switch (f.type) {
      case "boolean":
        return (
          <input type="checkbox" checked={Boolean(v)} onChange={(e) => onSave(f.key, e.target.checked)} />
        );
      case "select":
        if (f.options === "clients") {
          return (
            <ClientCombobox
              clients={optionsData.clients}
              value={(v as string) ?? null}
              // reaching this editable branch means the server allowed editing
              // this (money) field — so this viewer is a can_edit_money user
              morningCreate
              canEditMoney={f.editable}
              onChange={(clientId) => onSave(f.key, clientId)}
              onCreated={onClientCreated}
            />
          );
        }
        return (
          <select
            value={(v as string) ?? ""}
            onChange={(e) => onSave(f.key, e.target.value || null)}
            className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1 text-sm"
          >
            <option value="">—</option>
            {optionsFor(f).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );
      case "date":
        return (
          <input
            type="date"
            value={(v as string) ?? ""}
            onChange={(e) => onSave(f.key, e.target.value || null)}
            className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1 text-sm"
          />
        );
      default: {
        const isNumber = f.type === "number";
        const display = Array.isArray(v) ? (v as string[]).join(", ") : v == null ? "" : String(v);
        return (
          <input
            type={isNumber ? "number" : "text"}
            defaultValue={display}
            key={`${f.key}:${display}`}
            onChange={(e) => {
              const raw = e.target.value;
              dirty.current[f.key] = Array.isArray(v)
                ? raw.split(",").map((x) => x.trim()).filter(Boolean)
                : isNumber
                  ? raw === "" ? null : Number(raw)
                  : raw === "" ? null : raw;
            }}
            onBlur={() => {
              if (f.key in dirty.current) {
                const val = dirty.current[f.key];
                delete dirty.current[f.key];
                onSave(f.key, val);
              }
            }}
            className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1 text-sm"
          />
        );
      }
    }
  }

  return (
    <div className="space-y-2.5">
      {fields.map((f) => (
        <div
          key={f.key}
          className="grid items-center gap-2"
          style={{ gridTemplateColumns: `${labelWidth}px 1fr` }}
        >
          <label className="text-xs text-[var(--dim)]">{f.label}</label>
          {renderValue(f)}
        </div>
      ))}
    </div>
  );
}
