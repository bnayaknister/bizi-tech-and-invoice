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
  };
}
