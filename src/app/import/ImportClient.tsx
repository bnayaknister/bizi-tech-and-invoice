"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type FieldChange = { field: string; label: string; from: unknown; to: unknown };
type RowPlan = {
  externalId: string | null;
  title: string;
  bucket: "new" | "update" | "unchanged" | "archive";
  matchedId: string | null;
  changes: FieldChange[];
};
type Preview = {
  kind: "production" | "job";
  counts: { new: number; update: number; unchanged: number; archive: number };
  total: number;
  rows: RowPlan[];
};

const KIND_LABEL = { production: "הפקות", job: "חשבונות" };
const val = (v: unknown) => (v == null || v === "" ? "—" : String(v));

export default function ImportClient() {
  const router = useRouter();
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, "skip" | "restore" | "update">>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null); setDone(null); setPreview(null);
    const content = await file.text();
    setText(content);
    setFileName(file.name);
    setBusy(true);
    const res = await fetch("/api/import/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: content }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "שגיאה בקריאת הקובץ");
      return;
    }
    setPreview(await res.json());
  }

  async function apply() {
    if (!text) return;
    setBusy(true); setError(null);
    const res = await fetch("/api/import/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, decisions }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "שגיאה בייבוא");
      return;
    }
    const d = await res.json();
    const a = d.applied;
    setDone(`יובאו: ${a.created} נוצרו · ${a.updated} עודכנו · ${a.unchanged} ללא שינוי · ${a.archiveSkipped} בארכיון דולגו${a.skipped ? ` · ${a.skipped} דולגו` : ""}`);
    setPreview(null);
    setText(null);
    router.refresh();
  }

  const archiveRows = preview?.rows.filter((r) => r.bucket === "archive") ?? [];
  const newRows = preview?.rows.filter((r) => r.bucket === "new") ?? [];
  const updateRows = preview?.rows.filter((r) => r.bucket === "update") ?? [];

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-lg font-bold mb-1">ייבוא אקסל</h1>
      <p className="text-xs text-[var(--faint)] mb-5">
        הפקות או חשבונות — המערכת מזהה לבד לפי העמודות. ייבוא לעולם לא מוחק, ולא דורס שדות שהמערכת מנהלת
        (סטטוס, שלבים, קישורים).
      </p>

      <label className="inline-flex items-center gap-2 text-sm border border-[var(--rule)] rounded-lg px-4 py-2 cursor-pointer hover:bg-[var(--panel3)]">
        <input type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
        בחר קובץ CSV
      </label>
      {fileName && <span className="text-xs text-[var(--dim)] mr-3">{fileName}</span>}

      {busy && <div className="mt-4 text-sm text-[var(--dim)]">מעבד…</div>}
      {error && <div className="mt-4 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-lg px-3 py-2">{error}</div>}
      {done && <div className="mt-4 text-sm text-[var(--green)] border border-[var(--rule)] rounded-lg px-3 py-2">{done}</div>}

      {preview && (
        <div className="mt-6">
          <div className="text-xs text-[var(--dim)] mb-3">
            זוהה קובץ <b className="text-[var(--violet-light)]">{KIND_LABEL[preview.kind]}</b> · {preview.total} שורות
          </div>

          {/* bucket summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5">
            <Bucket color="var(--green)" label="🟢 חדשות" n={preview.counts.new} sub="ייווצרו" />
            <Bucket color="var(--amber)" label="🟡 מתעדכנות" n={preview.counts.update} sub="שדות שהשתנו" />
            <Bucket color="var(--faint)" label="⚪ ללא שינוי" n={preview.counts.unchanged} sub="לא ייגעו" />
            <Bucket color="var(--red)" label="🔴 בארכיון" n={preview.counts.archive} sub="דורש החלטה" />
          </div>

          <p className="text-[11px] text-[var(--faint)] mb-5">
            ⚫ שדות שהמערכת שינתה (סטטוס, שלבים, קישורים, legacy) לא נדרסים — הם לא בסט הייבוא.
          </p>

          {/* archive decisions */}
          {archiveRows.length > 0 && (
            <Section title="🔴 בארכיון — דורש החלטה">
              {archiveRows.map((r) => (
                <div key={r.externalId} className="flex items-center gap-2 px-3 py-2 text-xs border-b border-[var(--rule)] last:border-b-0">
                  <span className="font-mono text-[var(--faint)]">{r.externalId}</span>
                  <span className="flex-1">{r.title}</span>
                  <select
                    value={decisions[r.externalId ?? ""] ?? "skip"}
                    onChange={(e) => setDecisions((d) => ({ ...d, [r.externalId ?? ""]: e.target.value as "skip" | "restore" | "update" }))}
                    className="bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1"
                  >
                    <option value="skip">דלג (ברירת מחדל)</option>
                    <option value="restore">שחזר לחי</option>
                    <option value="update">עדכן בארכיון</option>
                  </select>
                </div>
              ))}
            </Section>
          )}

          {/* updates with field diffs */}
          {updateRows.length > 0 && (
            <Section title={`🟡 מתעדכנות (${updateRows.length})`}>
              {updateRows.slice(0, 50).map((r) => (
                <div key={r.externalId ?? r.matchedId} className="px-3 py-2 text-xs border-b border-[var(--rule)] last:border-b-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-[var(--faint)]">{r.externalId}</span>
                    <span className="font-bold">{r.title}</span>
                  </div>
                  <div className="flex flex-col gap-0.5 pr-4">
                    {r.changes.map((c) => (
                      <div key={c.field} className="flex items-center gap-2 text-[var(--dim)]">
                        <span className="text-[var(--faint)] w-24 shrink-0">{c.label}</span>
                        <span className="line-through text-[var(--faint)]">{val(c.from)}</span>
                        <span>←</span>
                        <span className="text-[var(--ink)]">{val(c.to)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {updateRows.length > 50 && <div className="px-3 py-2 text-[11px] text-[var(--faint)]">ועוד {updateRows.length - 50}…</div>}
            </Section>
          )}

          {/* new */}
          {newRows.length > 0 && (
            <Section title={`🟢 חדשות (${newRows.length})`}>
              {newRows.slice(0, 50).map((r, i) => (
                <div key={(r.externalId ?? "") + i} className="flex items-center gap-2 px-3 py-2 text-xs border-b border-[var(--rule)] last:border-b-0">
                  <span className="font-mono text-[var(--faint)]">{r.externalId ?? "חדש"}</span>
                  <span>{r.title}</span>
                </div>
              ))}
              {newRows.length > 50 && <div className="px-3 py-2 text-[11px] text-[var(--faint)]">ועוד {newRows.length - 50}…</div>}
            </Section>
          )}

          <div className="flex gap-2 mt-6">
            <button
              onClick={apply}
              disabled={busy || (preview.counts.new === 0 && preview.counts.update === 0 && archiveRows.every((r) => (decisions[r.externalId ?? ""] ?? "skip") === "skip"))}
              className="bg-[var(--violet)] text-white font-bold rounded-lg px-5 py-2 text-sm disabled:opacity-40"
            >
              אשר וייבא
            </button>
            <button onClick={() => { setPreview(null); setText(null); setFileName(""); }} className="border border-[var(--rule)] rounded-lg px-5 py-2 text-sm text-[var(--dim)]">
              ביטול
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Bucket({ color, label, n, sub }: { color: string; label: string; n: number; sub: string }) {
  return (
    <div className="rounded-lg border border-[var(--rule)] bg-[var(--panel2)] p-3">
      <div className="text-xs" style={{ color }}>{label}</div>
      <div className="font-mono text-2xl font-medium mt-1">{n}</div>
      <div className="text-[10px] text-[var(--faint)]">{sub}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-xs font-bold text-[var(--dim)] mb-1.5">{title}</div>
      <div className="rounded-lg border border-[var(--rule)] overflow-hidden bg-[var(--panel2)]">{children}</div>
    </div>
  );
}
