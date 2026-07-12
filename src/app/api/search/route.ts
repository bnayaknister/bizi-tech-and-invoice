import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// RLS does the permission filtering here — a tech's session simply won't
// return client/job rows because their policy grants no SELECT on them.
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (!q || q.length < 2) return NextResponse.json({ clients: [], jobs: [], productions: [] });

  const supabase = createClient();
  const like = `%${q}%`;

  const [clients, jobs, productions] = await Promise.all([
    supabase.from("clients").select("id,name").ilike("name", like).limit(8),
    supabase.from("jobs").select("id,campaign,amount,client_id").ilike("campaign", like).limit(8),
    supabase.from("productions").select("id,podcast_name,guest").or(`podcast_name.ilike.${like},guest.ilike.${like}`).limit(8),
  ]);

  return NextResponse.json({
    clients: clients.data ?? [],
    jobs: jobs.data ?? [],
    productions: productions.data ?? [],
  });
}
