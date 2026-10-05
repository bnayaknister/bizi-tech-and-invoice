/**
 * The document cell's shape, extracted from ProjectsClient.
 *
 * It moved out for a mechanical reason, not a stylistic one: lib/projects/
 * unified.ts carries a `docs` field on every row, and ProjectsClient imports
 * that module — so the type living inside the component would be a cycle
 * (component → unified → component). A two-field shape in lib breaks it, and
 * ProjectsClient re-exports the name so nothing that already imported
 * `ProjectDoc` from there has to change.
 *
 * It is NOT `ResolvedDocument` (lib/documents/forProduction.ts:139) and must not
 * become it: the resolver's row carries `id`, `amount` and `pdf_url`, and a
 * money screen hands the client only the four facts the cell draws. A `pdf_url`
 * on the wire is a link to a document the viewer may not be entitled to open.
 */
export type ProjectDoc = {
  type: number;
  number: string | null;
  date: string | null;
  /** This document also resolved to another row — a bundle. Counted once anywhere. */
  shared: boolean;
  cancelled: boolean;
  /** Which of the six resolver routes won. Drives the cell's tooltip. */
  path: string;
};
