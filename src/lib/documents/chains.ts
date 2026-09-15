/**
 * Group documents into CHAINS — the set of rows that describe one bill.
 *
 * Morning's chain is a parent link: a work order fathers a deal invoice, which
 * fathers a tax invoice, which fathers a receipt, and every child records its
 * parent's NUMBER in `documents.parent_doc_numbers`. Live case this was written
 * for, בר ביצוע:
 *
 *     10333 (100)  →  40326 (300)  →  50070 (305)
 *
 * All three carry the SAME ₪49,560, because they are one bill described three
 * times — not three bills. Anything that adds them together produces ₪148,680
 * for a ₪42,000 net milestone, which is why record-billed compares by MAX and
 * why the screen has to be able to say "these two are one charge".
 *
 * ═══ UNION-FIND OVER NUMBERS, INCLUDING ABSENT PARENTS ═══
 * Each `parent_doc_numbers` entry is an edge. Parents that are not themselves in
 * the input still take part as NODES: 40326's parent is the work order 10333,
 * and a 100 can never be a record-billed candidate (reconcile.ts:545 refuses
 * it), so without the absent node two documents fathered by the same order would
 * look unrelated. Joining through it is the only way to see that they are not.
 *
 * Over-grouping is the SAFE direction and under-grouping is not. The purpose of
 * the chain is to stop amounts being summed; a chain drawn too wide still
 * compares by MAX and still refuses to add, while a chain drawn too narrow
 * silently adds two halves of one bill.
 *
 * A document with no number falls back to its id, so it forms a chain of one
 * rather than colliding with every other numberless row under a shared "".
 */
export type ChainableDoc = {
  id: string;
  morning_doc_number: string | null;
  parent_doc_numbers: string[] | null;
};

export function chainIds(docs: ChainableDoc[]): Map<string, string> {
  const parent = new Map<string, string>();

  const find = (x: string): string => {
    let root = x;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
    // path compression, so a long chain does not re-walk on every lookup
    let cur = x;
    while ((parent.get(cur) ?? cur) !== cur) {
      const next = parent.get(cur) ?? cur;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const keyOf = (d: ChainableDoc) => (d.morning_doc_number ?? "").trim() || d.id;

  for (const d of docs ?? []) {
    const key = keyOf(d);
    if (!parent.has(key)) parent.set(key, key);
    for (const p of d.parent_doc_numbers ?? []) {
      const pk = String(p ?? "").trim();
      if (!pk) continue;
      if (!parent.has(pk)) parent.set(pk, pk);
      union(key, pk);
    }
  }

  const out = new Map<string, string>();
  for (const d of docs ?? []) out.set(d.id, find(keyOf(d)));
  return out;
}
