import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  RECIPIENT_CAP,
  getAccountantEmail,
  fetchClientEmails,
  resolveDefaultRecipients,
} from "@/lib/documents/recipients";
import type { PendingDocType } from "@/lib/morning/types";

// What the recipient picker needs for ONE queued document (owner spec
// 2026-07-29): the client's LIVE Morning emails, the local accountant default,
// and the pre-selected default for this doc type. can_edit_money — same gate as
// the approval it precedes. A failed Morning read never blocks: clientFetchFailed
// is surfaced and the picker still offers the accountant default.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("pending_documents")
    .select("id,doc_type,client_id,status")
    .eq("id", params.id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "המסמך לא נמצא" }, { status: 404 });

  const docType = row.doc_type as PendingDocType;
  const accountantEmail = await getAccountantEmail(admin);
  const { emails, ok } = await fetchClientEmails(admin, row.client_id as string | null);
  const defaultSelected = resolveDefaultRecipients(docType, emails, accountantEmail);

  return NextResponse.json({
    docType,
    clientEmails: emails,
    clientFetchFailed: !ok,
    accountantEmail,
    defaultSelected,
    cap: RECIPIENT_CAP,
  });
}
