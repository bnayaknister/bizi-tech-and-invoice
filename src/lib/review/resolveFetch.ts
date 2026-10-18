// E13-9 — the browser side of "טופל" / "בטל טופל" (the drawer and the
// "הערות הלקוח" window share it). Returns an error text, or null on success.
export async function postResolve(productionId: string, commentId: string, resolved: boolean): Promise<string | null> {
  try {
    const res = await fetch(`/api/productions/${productionId}/review-comments/${commentId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved }),
    });
    if (res.ok) return null;
    const d = await res.json().catch(() => ({}));
    return typeof d.error === "string" ? d.error : "שמירת הסימון נכשלה";
  } catch {
    return "שמירת הסימון נכשלה";
  }
}

// "✓ סמן הכול כטופל": asks first ("לסמן N הערות כטופלו?"), then sends the ids
// the question counted. Returns an error text, "cancelled", or null on success.
export async function confirmAndResolveAll(productionId: string, itemId: string, commentIds: string[]): Promise<string | null> {
  if (!commentIds.length) return "cancelled";
  const n = commentIds.length;
  if (!window.confirm(n === 1 ? "לסמן הערה אחת כטופלה?" : `לסמן ${n} הערות כטופלו?`)) return "cancelled";
  try {
    const res = await fetch(`/api/productions/${productionId}/review-items/${itemId}/resolve-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment_ids: commentIds }),
    });
    if (res.ok) return null;
    const d = await res.json().catch(() => ({}));
    return typeof d.error === "string" ? d.error : "שמירת הסימון נכשלה";
  } catch {
    return "שמירת הסימון נכשלה";
  }
}
