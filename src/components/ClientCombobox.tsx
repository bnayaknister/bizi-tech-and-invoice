"use client";

// Smart client field (owner request 2026-07-17) — used everywhere a client
// is chosen (show card, EntityDrawer, orphan-show assignment). Type to
// search existing clients (normalized: ignores double spaces and niqud);
// no match -> "create new client" -> the API's own near-duplicate check
// (src/lib/clients/match.ts) may come back with "did you mean X?" before
// actually creating one, so a typo/variant spelling never becomes a second
// row for a client that already exists (see the "גל אורן" incident this
// was built to stop happening again).
import { forwardRef, useMemo, useState } from "react";
import { normalizeClientName } from "@/lib/clients/match";

export type ComboboxClient = { id: string; name: string };

type Suggestion = { id: string; name: string; pendingName: string };

const ClientCombobox = forwardRef<
  HTMLInputElement,
  {
    clients: ComboboxClient[];
    value: string | null;
    onChange: (clientId: string | null) => void;
    onCreated?: (client: ComboboxClient) => void;
    disabled?: boolean;
    placeholder?: string;
    onEnterNext?: () => void;
    className?: string;
  }
>(function ClientCombobox(
  { clients, value, onChange, onCreated, disabled, placeholder, onEnterNext, className },
  ref
) {
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);

  const selected = value ? clients.find((c) => c.id === value) ?? null : null;
  const displayValue = editing ? query : selected?.name ?? "";

  const filtered = useMemo(() => {
    const norm = normalizeClientName(query);
    const list = norm ? clients.filter((c) => normalizeClientName(c.name).includes(norm)) : clients;
    return list.slice(0, 8);
  }, [clients, query]);

  const exactMatch = useMemo(
    () => filtered.some((c) => normalizeClientName(c.name) === normalizeClientName(query)),
    [filtered, query]
  );
  const showCreateOption = editing && query.trim().length > 0 && !exactMatch;
  const options: ({ kind: "client"; client: ComboboxClient } | { kind: "create" })[] = [
    ...filtered.map((client) => ({ kind: "client" as const, client })),
    ...(showCreateOption ? [{ kind: "create" as const }] : []),
  ];

  function openForEditing() {
    if (disabled) return;
    setEditing(true);
    setQuery("");
    setHighlight(0);
    setSuggestion(null);
    setError(null);
  }

  function commitClient(client: ComboboxClient) {
    onChange(client.id);
    setEditing(false);
    setQuery("");
    setSuggestion(null);
  }

  async function createClient(name: string, force: boolean) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, force }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "יצירת הלקוח נכשלה");
      return;
    }
    const d = await res.json();
    if (d.needsConfirmation) {
      setSuggestion({ id: d.suggestion.id, name: d.suggestion.name, pendingName: name });
      return;
    }
    if (d.created) onCreated?.(d.client);
    commitClient(d.client);
    onEnterNext?.();
  }

  function commitHighlighted() {
    const opt = options[highlight];
    if (!opt) {
      if (!editing) onEnterNext?.();
      return;
    }
    if (opt.kind === "client") {
      commitClient(opt.client);
      onEnterNext?.();
    } else {
      void createClient(query.trim(), false);
    }
  }

  return (
    <div className={`relative ${className ?? ""}`}>
      <input
        ref={ref}
        value={displayValue}
        disabled={disabled || busy}
        placeholder={placeholder ?? "— בחר לקוח —"}
        onFocus={openForEditing}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          if (!editing) setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, options.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            commitHighlighted();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
            setQuery("");
            setSuggestion(null);
          }
        }}
        onBlur={() => window.setTimeout(() => setEditing(false), 150)}
        className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1.5 text-sm focus:border-[var(--signal)] outline-none disabled:opacity-60"
      />

      {editing && !suggestion && (options.length > 0 || busy) && (
        <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto border border-[var(--rule2)] rounded bg-[var(--panel2)] shadow-lg text-sm">
          {busy && <div className="px-3 py-2 text-xs text-[var(--faint)]">יוצר…</div>}
          {!busy &&
            options.map((opt, i) => (
              <button
                key={opt.kind === "client" ? opt.client.id : "__create__"}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (opt.kind === "client") {
                    commitClient(opt.client);
                    onEnterNext?.();
                  } else {
                    void createClient(query.trim(), false);
                  }
                }}
                className={`block w-full text-right px-3 py-1.5 ${
                  i === highlight ? "bg-[var(--panel3)]" : "hover:bg-[var(--panel3)]"
                } ${opt.kind === "create" ? "text-[var(--signal)]" : ""}`}
              >
                {opt.kind === "client" ? opt.client.name : `➕ צור לקוח חדש: "${query.trim()}"`}
              </button>
            ))}
        </div>
      )}

      {suggestion && (
        <div className="absolute z-20 mt-1 w-full border border-[var(--amber)] rounded bg-[var(--panel2)] shadow-lg p-3 text-xs">
          <div className="mb-2 text-[var(--dim)]">
            האם התכוונת ל־<b>{suggestion.name}</b>? (דומה ל־&quot;{suggestion.pendingName}&quot;)
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                commitClient({ id: suggestion.id, name: suggestion.name });
                onEnterNext?.();
              }}
              className="border border-[var(--rule)] rounded px-2 py-1 hover:bg-[var(--panel3)]"
            >
              כן, בחר את {suggestion.name}
            </button>
            <button
              type="button"
              onClick={() => void createClient(suggestion.pendingName, true)}
              className="border border-[var(--rule)] rounded px-2 py-1 hover:bg-[var(--panel3)]"
            >
              לא, צור חדש בכל זאת
            </button>
          </div>
        </div>
      )}

      {error && <div className="mt-1 text-[10px] text-[var(--peak)]">{error}</div>}
    </div>
  );
});

export default ClientCombobox;
