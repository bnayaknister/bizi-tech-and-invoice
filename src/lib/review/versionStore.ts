import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { Integrity, ItemKind, NewBunnyVersion, VersionPatch, VersionRow, VersionStore } from "./versions";
import type { ReviewVersionStatus } from "@/lib/bunny/status";

// The Supabase side of lib/review/versions.ts — service role only: the review
// tables have no user policies (0057, 0114), can_edit_stages is checked by the
// route before this is built. Typed client, no casts between a query and its
// fields (same rule as scripts/e13_backfill_v1.ts).

const VERSION_COLS =
  "id,item_id,number,source,media_link,bunny_video_id,bunny_status,bunny_status_raw,is_audio_only,original_filename,original_size_bytes,drive_file_id,drive_sha256,drive_size_bytes,integrity,ready_at,fetch_requested_at,is_backfill,created_at";

const STATUSES: ReviewVersionStatus[] = ["created", "uploading", "processing", "playable", "ready", "failed"];
const INTEGRITIES: Integrity[] = ["hash_match", "size_match", "mismatch", "unchecked"];

type Row = Database["public"]["Tables"]["client_review_versions"]["Row"];

export function toVersionRow(r: Pick<Row, keyof VersionRow>): VersionRow {
  const status = STATUSES.find((s) => s === r.bunny_status) ?? null;
  const integrity = INTEGRITIES.find((s) => s === r.integrity) ?? null;
  return {
    id: r.id,
    item_id: r.item_id,
    number: r.number,
    source: r.source === "bunny" ? "bunny" : "drive",
    media_link: r.media_link,
    bunny_video_id: r.bunny_video_id,
    bunny_status: status,
    bunny_status_raw: r.bunny_status_raw,
    is_audio_only: r.is_audio_only,
    original_filename: r.original_filename,
    original_size_bytes: r.original_size_bytes,
    drive_file_id: r.drive_file_id,
    drive_sha256: r.drive_sha256,
    drive_size_bytes: r.drive_size_bytes,
    integrity,
    ready_at: r.ready_at,
    fetch_requested_at: r.fetch_requested_at,
    is_backfill: r.is_backfill,
    created_at: r.created_at,
  };
}

export const VERSION_SELECT = VERSION_COLS;

export function supabaseVersionStore(admin: SupabaseClient<Database>): VersionStore {
  const itemQuery = (productionId: string, kind: ItemKind, reelIndex: number | null) => {
    const q = admin.from("client_review_items").select("id").eq("production_id", productionId).eq("kind", kind);
    return reelIndex === null ? q.is("reel_index", null) : q.eq("reel_index", reelIndex);
  };

  return {
    async production(id) {
      const { data, error } = await admin.from("productions").select("id,has_episode,reels_count").eq("id", id).maybeSingle();
      if (error) throw new Error(`productions: ${error.message}`);
      return data ? { id: data.id, has_episode: !!data.has_episode, reels_count: Number(data.reels_count) || 0 } : null;
    },

    async findItem(productionId, kind, reelIndex) {
      const { data, error } = await itemQuery(productionId, kind, reelIndex).maybeSingle();
      if (error) throw new Error(`client_review_items: ${error.message}`);
      return data ? { id: data.id } : null;
    },

    async createItem(productionId, kind, reelIndex) {
      // Q6 (owner 16.10): approved=false ALWAYS — a deliberate departure from
      // review-items PATCH, which copies the track flag. A new deliverable the
      // client never saw must not inherit "approved" (and the purge clock).
      const { data, error } = await admin
        .from("client_review_items")
        .insert({ production_id: productionId, kind, reel_index: reelIndex, approved: false })
        .select("id")
        .single();
      if (!error && data) return { id: data.id };
      if (error?.code === "23505") {
        const existing = await this.findItem(productionId, kind, reelIndex);
        if (existing) return existing;
      }
      throw new Error(`client_review_items insert: ${error?.message ?? "no row"}`);
    },

    async activeSameFile(itemId, driveFileId, sha256) {
      const { data, error } = await admin
        .from("client_review_versions")
        .select("id,number,bunny_status")
        .eq("item_id", itemId)
        .eq("source", "bunny")
        .eq("drive_file_id", driveFileId)
        .eq("drive_sha256", sha256)
        .is("media_deleted_at", null)
        .neq("bunny_status", "failed")
        .limit(1);
      if (error) throw new Error(`client_review_versions: ${error.message}`);
      const r = data?.[0];
      return r ? { id: r.id, number: r.number } : null;
    },

    async insertVersion(row: NewBunnyVersion) {
      const { error } = await admin.from("client_review_versions").insert(row);
      if (!error) return "ok";
      if (error.code === "23505" && /uq_crv_item_drive_sha/.test(error.message)) return "duplicate";
      throw new Error(`client_review_versions insert: ${error.message}`);
    },

    async attachGuid(versionId, guid) {
      const { data, error } = await admin
        .from("client_review_versions")
        .update({ bunny_video_id: guid })
        .eq("id", versionId)
        .is("bunny_video_id", null)
        .select("id");
      if (error) {
        if (error.code === "23505") return false; // the guid is already another version's
        throw new Error(`attach guid: ${error.message}`);
      }
      return (data ?? []).length === 1;
    },

    async update(versionId, patch: VersionPatch) {
      const { error } = await admin.from("client_review_versions").update(patch).eq("id", versionId);
      if (error) throw new Error(`client_review_versions update: ${error.message}`);
    },

    async getVersion(versionId) {
      const { data, error } = await admin.from("client_review_versions").select(VERSION_COLS).eq("id", versionId).maybeSingle();
      if (error) throw new Error(`client_review_versions: ${error.message}`);
      return data ? toVersionRow(data) : null;
    },

    async versionProduction(versionId) {
      const { data: v, error } = await admin.from("client_review_versions").select("item_id").eq("id", versionId).maybeSingle();
      if (error) throw new Error(`client_review_versions: ${error.message}`);
      if (!v) return null;
      const { data: it, error: iErr } = await admin.from("client_review_items").select("production_id").eq("id", v.item_id).maybeSingle();
      if (iErr) throw new Error(`client_review_items: ${iErr.message}`);
      return it?.production_id ?? null;
    },

    async assignNumber(versionId) {
      const { data, error } = await admin.rpc("assign_review_version_number", { p_version_id: versionId });
      if (error) throw new Error(`assign_review_version_number: ${error.message}`);
      return Number(data);
    },

    async versionByGuid(guid) {
      const { data, error } = await admin.from("client_review_versions").select(VERSION_COLS).eq("bunny_video_id", guid).maybeSingle();
      if (error) throw new Error(`client_review_versions: ${error.message}`);
      return data ? toVersionRow(data) : null;
    },

    async pendingVersions(limit) {
      // isFinal() as a filter: a live Bunny row that is not failed, and not
      // ready-with-a-concluded-integrity. Oldest fetch first.
      const { data, error } = await admin
        .from("client_review_versions")
        .select(VERSION_COLS)
        .eq("source", "bunny")
        .is("media_deleted_at", null)
        .or("bunny_status.in.(uploading,created,processing,playable),and(bunny_status.eq.ready,or(integrity.is.null,integrity.eq.unchecked))")
        .order("fetch_requested_at", { ascending: true })
        .limit(limit);
      if (error) throw new Error(`client_review_versions pending: ${error.message}`);
      const rows = (data ?? []).map(toVersionRow);
      const itemIds = Array.from(new Set(rows.map((r) => r.item_id)));
      if (!itemIds.length) return [];
      const { data: items, error: iErr } = await admin.from("client_review_items").select("id,production_id").in("id", itemIds);
      if (iErr) throw new Error(`client_review_items: ${iErr.message}`);
      const prodOf = new Map((items ?? []).map((i) => [i.id, i.production_id]));
      return rows.flatMap((row) => {
        const productionId = prodOf.get(row.item_id);
        return productionId ? [{ row, productionId }] : [];
      });
    },

    async knownGuids(guids) {
      if (!guids.length) return new Set<string>();
      const { data, error } = await admin.from("client_review_versions").select("bunny_video_id").in("bunny_video_id", guids);
      if (error) throw new Error(`client_review_versions guids: ${error.message}`);
      return new Set((data ?? []).flatMap((r) => (r.bunny_video_id ? [r.bunny_video_id] : [])));
    },

    async eventExists(type, key, value) {
      const { data, error } = await admin.from("events").select("id").eq("event_type", type).eq(`payload->>${key}`, value).limit(1);
      if (error) throw new Error(`events: ${error.message}`);
      return (data ?? []).length > 0;
    },

    async systemEvent(type, payload) {
      // events.entity_id is NOT NULL; system events use the zero uuid (registration/approve.ts, the E13 backfill)
      await admin.from("events").insert({
        entity_type: "system",
        entity_id: "00000000-0000-0000-0000-000000000000",
        event_type: type,
        payload: JSON.parse(JSON.stringify(payload)),
      });
    },

    async event(type, productionId, payload, actorId) {
      // a trace, never a reason to fail the action that produced it
      await admin.from("events").insert({
        entity_type: "production",
        entity_id: productionId,
        event_type: type,
        payload: JSON.parse(JSON.stringify(payload)),
        ...(actorId ? { actor_id: actorId } : {}),
      });
    },

    // ── owner 22.10: the warnings and the confirmation screen ──
    async sendContext(productionId) {
      const { data, error } = await admin
        .from("productions")
        .select("show_id,podcast_name,record_date,shows(name)")
        .eq("id", productionId)
        .maybeSingle();
      if (error) throw new Error(`productions: ${error.message}`);
      const show = (data as unknown as { shows?: { name?: string } | null } | null)?.shows ?? null;
      return {
        showId: (data?.show_id as string | null) ?? null,
        showName: show?.name ?? null,
        podcastName: (data?.podcast_name as string | null) ?? null,
        recordDate: (data?.record_date as string | null) ?? null,
      };
    },

    async sameDriveFile(driveFileId) {
      const { data, error } = await admin
        .from("client_review_versions")
        .select("item_id,number,client_review_items!inner(production_id,kind,reel_index,productions!inner(show_id,record_date,shows(name)))")
        .eq("drive_file_id", driveFileId)
        .neq("bunny_status", "failed")
        .limit(50);
      if (error) throw new Error(`client_review_versions: ${error.message}`);
      type R = {
        item_id: string;
        number: number | null;
        client_review_items: {
          production_id: string;
          kind: string;
          reel_index: number | null;
          productions: { show_id: string | null; record_date: string | null; shows: { name: string } | null };
        };
      };
      return ((data ?? []) as unknown as R[]).map((r) => ({
        itemId: r.item_id,
        productionId: r.client_review_items.production_id,
        showId: r.client_review_items.productions?.show_id ?? null,
        showName: r.client_review_items.productions?.shows?.name ?? null,
        kind: r.client_review_items.kind,
        reelIndex: r.client_review_items.reel_index,
        recordDate: r.client_review_items.productions?.record_date ?? null,
        number: r.number,
      }));
    },

    async warnShows() {
      const { data, error } = await admin.from("shows").select("id,name,aliases").eq("active", true);
      if (error) throw new Error(`shows: ${error.message}`);
      return (data ?? []).map((r) => ({ id: r.id as string, name: r.name as string, aliases: (r.aliases as string[] | null) ?? [] }));
    },

    async itemOf(itemId) {
      const { data, error } = await admin.from("client_review_items").select("kind,reel_index").eq("id", itemId).maybeSingle();
      if (error) throw new Error(`client_review_items: ${error.message}`);
      if (!data) return null;
      return { kind: data.kind === "reel" ? "reel" : "episode", reel_index: (data.reel_index as number | null) ?? null };
    },

    async itemMaxNumber(itemId) {
      const { data, error } = await admin
        .from("client_review_versions")
        .select("number")
        .eq("item_id", itemId)
        .not("number", "is", null)
        .order("number", { ascending: false })
        .limit(1);
      if (error) throw new Error(`client_review_versions: ${error.message}`);
      return Number(data?.[0]?.number) || 0;
    },
  };
}
