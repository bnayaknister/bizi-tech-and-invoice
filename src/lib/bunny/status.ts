// From a freshly FETCHED Bunny video object to our version fields (plan §3).
//
// Only the video object's `status` is read here — never a webhook payload's
// number: the two enums differ (video 4 = Finished, webhook 4 = "Resolution
// finished"). The webhook only tells us to fetch again.
//
//   video status: 0 Created · 1 Uploaded · 2 Processing · 3 Transcoding ·
//                 4 Finished · 5 Error · 6 UploadFailed · 7 JitSegmenting ·
//                 8 JitPlaylistsCreated
//
// 🔴 THE READY GATE (§9): Finished is NOT ready until Bunny reports the
// original kept (hasOriginal + originalHash). Without it the version stays
// 'processing' and `originalMissing` is raised so the caller leaves a
// `review_original_missing` event. Migration 0114 enforces the same rule
// with a CHECK, so this function cannot be bypassed by a careless caller.

export type BunnyVideo = {
  guid: string;
  videoLibraryId?: number;
  status: number;
  length?: number | null; // seconds
  width?: number | null;
  height?: number | null;
  availableResolutions?: string | null;
  encodeProgress?: number | null;
  storageSize?: number | null;
  hasMP4Fallback?: boolean | null;
  hasOriginal?: boolean | null;
  originalHash?: string | null;
};

export type ReviewVersionStatus = "created" | "uploading" | "processing" | "playable" | "ready" | "failed";

export type DerivedVersion = {
  bunny_status: Exclude<ReviewVersionStatus, "uploading">;
  bunny_status_raw: number;
  duration_ms: number | null;
  has_original: boolean;
  original_sha256: string | null;
  /** status says Finished, but the original is not confirmed kept */
  originalMissing: boolean;
  /** Bunny returned a status number this code does not know */
  unknownStatus: boolean;
  /** upload reached Bunny (status >= Uploaded and not a failure) — Q11: the moment a number is assigned */
  uploadConfirmed: boolean;
};

export function deriveVersionFromVideo(v: BunnyVideo): DerivedVersion {
  const hasOriginal = v.hasOriginal === true;
  const hash = typeof v.originalHash === "string" && v.originalHash.trim() !== "" ? v.originalHash.trim() : null;
  const duration =
    typeof v.length === "number" && Number.isFinite(v.length) && v.length >= 0 ? Math.round(v.length * 1000) : null;
  const playableResolutions = (v.availableResolutions ?? "").split(",").some((r) => r.trim() !== "");

  let status: DerivedVersion["bunny_status"];
  let originalMissing = false;
  let unknownStatus = false;
  switch (v.status) {
    case 0:
      status = "created";
      break;
    case 5:
    case 6:
      status = "failed";
      break;
    case 4:
      if (hasOriginal && hash) status = "ready";
      else {
        status = "processing";
        originalMissing = true;
      }
      break;
    case 1:
    case 2:
    case 3:
    case 7:
    case 8:
      status = playableResolutions ? "playable" : "processing";
      break;
    default:
      status = "processing";
      unknownStatus = true;
  }

  return {
    bunny_status: status,
    bunny_status_raw: v.status,
    duration_ms: duration,
    has_original: hasOriginal,
    original_sha256: hash,
    originalMissing,
    unknownStatus,
    uploadConfirmed: v.status >= 1 && v.status !== 5 && v.status !== 6 && !unknownStatus,
  };
}
