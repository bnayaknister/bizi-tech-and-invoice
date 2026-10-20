"use client";

import { useState } from "react";
import Link from "next/link";
import type { DiskRow } from "@/lib/disks.server";

// B35: add, rename, hide / show, delete (only with no productions).
// Every action says what happened, in the screen, right where it was done.

type Flash = { kind: "saved" | "error"; text: string } | null;

export default function DisksClient({ initialDisks }: { initialDisks: DiskRow[] }) {
  const [disks, setDisks] = useState(initialDisks);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const sorted = [...disks].sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name, "he"));

  async function call(key: string, url: string, method: string, body?: unknown) {
    setBusy(key);
    setFlash(null);
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setFlash({ kind: "error", text: data.error ?? "הפעולה נכשלה" });
      return null;
    }
    return data;
  }

  async function add() {
    const name = newName.trim();
    if (!name) return;
    const data = await call("new", "/api/storage-disks", "POST", { name });
    if (!data) return;
    setDisks((ds) => [...ds, data.disk]);
    setNewName("");
    setFlash({ kind: "saved", text: `נשמר ✓ — "${data.disk.name}" נוסף לרשימה` });
  }

  async function rename(d: DiskRow, name: string) {
    const data = await call(d.id, `/api/storage-disks/${d.id}`, "PATCH", { name });
    if (!data) return;
    setDisks((ds) => ds.map((x) => (x.id === d.id ? data.disk : x)));
    setEditing(null);
    setFlash({
      kind: "saved",
      text:
        d.productions > 0
          ? `נשמר ✓ — "${d.name}" נקרא עכשיו "${data.disk.name}" (${d.productions} הפקות עודכנו; ההיסטוריה שומרת את השם הקודם)`
          : `נשמר ✓ — "${d.name}" נקרא עכשיו "${data.disk.name}"`,
    });
  }

  async function setHidden(d: DiskRow, hidden: boolean) {
    const data = await call(d.id, `/api/storage-disks/${d.id}`, "PATCH", { hidden });
    if (!data) return;
    setDisks((ds) => ds.map((x) => (x.id === d.id ? data.disk : x)));
    setFlash({
      kind: "saved",
      text: hidden ? `נשמר ✓ — "${d.name}" הוסתר מחלון הטכנאי` : `נשמר ✓ — "${d.name}" חזר לחלון הטכנאי`,
    });
  }

  async function remove(d: DiskRow) {
    if (!window.confirm(`למחוק את הכונן "${d.name}"? אין עליו הפקות.`)) return;
    const data = await call(d.id, `/api/storage-disks/${d.id}`, "DELETE");
    if (!data) return;
    setDisks((ds) => ds.filter((x) => x.id !== d.id));
    setFlash({ kind: "saved", text: `נמחק ✓ — "${d.name}"` });
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="flex items-center gap-3 mb-1">
        <Link href="/settings" className="text-xs text-[var(--faint)] hover:text-[var(--ink)]">
          → הגדרות
        </Link>
      </div>
      <h1 className="text-lg font-bold mb-1">💾 כונני אחסון</h1>
      <p className="text-xs text-[var(--faint)] mb-4">
        הרשימה שהטכנאי בוחר ממנה בחלון &quot;לאיזה דיסק הוקלט הפרק?&quot;. כונן שיש עליו הפקות לא נמחק — מסתירים אותו, וההיסטוריה ממשיכה להציג
        את השם שלו. שם כפול (בלי תלות ברווחים ובאותיות) נחסם.
      </p>

      <div className="flex items-center gap-2 mb-4">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          maxLength={60}
          dir="ltr"
          placeholder="שם כונן חדש, למשל SSD-04"
          aria-label="שם כונן חדש"
          className="flex-1 border border-[var(--rule)] rounded-xl px-3 py-1.5 text-sm font-mono text-left outline-none focus:border-[var(--violet-light)]"
          style={{ background: "rgba(255,255,255,0.04)" }}
        />
        <button
          onClick={() => void add()}
          disabled={!newName.trim() || busy === "new"}
          className="text-xs font-bold rounded-lg px-4 py-2 text-white disabled:opacity-40"
          style={{ background: "var(--violet)" }}
        >
          {busy === "new" ? "מוסיף…" : "הוספה"}
        </button>
      </div>

      {flash && (
        <div
          role="status"
          className={`mb-4 text-xs rounded-xl px-3 py-2 border ${
            flash.kind === "saved" ? "text-[var(--green)] border-[var(--green)]" : "text-[var(--peak)] border-[var(--peak)]"
          }`}
        >
          {flash.text}
        </div>
      )}

      <div className="border border-[var(--rule)] rounded-2xl divide-y divide-[var(--rule)]" style={{ background: "rgba(255,255,255,0.03)" }}>
        {sorted.length === 0 && <div className="p-4 text-xs text-[var(--faint)]">אין כוננים ברשימה.</div>}
        {sorted.map((d) => (
          <div key={d.id} className={`flex items-center gap-3 px-4 py-2.5 ${d.hidden ? "opacity-60" : ""}`}>
            {editing?.id === d.id ? (
              <>
                <input
                  autoFocus
                  value={editing.name}
                  maxLength={60}
                  dir="ltr"
                  onChange={(e) => setEditing({ id: d.id, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void rename(d, editing.name);
                    if (e.key === "Escape") setEditing(null);
                  }}
                  aria-label="שם הכונן"
                  className="flex-1 min-w-0 border border-[var(--rule)] rounded-lg px-2 py-1 text-sm font-mono text-left outline-none focus:border-[var(--violet-light)]"
                  style={{ background: "rgba(255,255,255,0.04)" }}
                />
                <button
                  onClick={() => void rename(d, editing.name)}
                  disabled={busy === d.id || !editing.name.trim() || editing.name.trim() === d.name}
                  className="text-xs font-bold rounded-lg px-3 py-1 text-white disabled:opacity-40"
                  style={{ background: "var(--violet)" }}
                >
                  שמירה
                </button>
                <button onClick={() => setEditing(null)} className="text-xs border border-[var(--rule)] text-[var(--dim)] rounded-lg px-3 py-1">
                  ביטול
                </button>
              </>
            ) : (
              <>
                <span className="font-mono text-sm flex-1 min-w-0 truncate" dir="ltr" style={{ textAlign: "right" }}>
                  {d.name}
                </span>
                {d.hidden && (
                  <span className="text-[10px] text-[var(--amber)] border border-[var(--amber)] rounded-full px-2 py-0.5">מוסתר</span>
                )}
                <span className="text-[11px] text-[var(--faint)] w-20 text-left">{d.productions} הפקות</span>
                <button
                  onClick={() => setEditing({ id: d.id, name: d.name })}
                  disabled={busy !== null}
                  className="text-xs border border-[var(--rule)] text-[var(--dim)] rounded-lg px-2 py-1 hover:text-[var(--ink)]"
                >
                  ✎ שינוי שם
                </button>
                <button
                  onClick={() => void setHidden(d, !d.hidden)}
                  disabled={busy !== null}
                  className="text-xs border border-[var(--rule)] text-[var(--dim)] rounded-lg px-2 py-1 hover:text-[var(--ink)]"
                >
                  {d.hidden ? "הצגה" : "הסתרה"}
                </button>
                {d.productions === 0 && (
                  <button
                    onClick={() => void remove(d)}
                    disabled={busy !== null}
                    className="text-xs border border-[var(--red)] text-[var(--red)] rounded-lg px-2 py-1"
                  >
                    מחיקה
                  </button>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
