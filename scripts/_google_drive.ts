/**
 * Google Drive, READ-ONLY, for the E13 diagnostic scripts
 * (scripts/e13_drive_fetch_test.ts). Not a test itself (no `test_` prefix).
 *
 * The code moved to src/lib/google/drive.ts in E13-3 — the product route uses
 * it too. This file only re-exports it, so the scripts keep their import path.
 */
export {
  DRIVE_READONLY,
  DriveError,
  buildAssertion,
  driveFileMeta,
  driveMediaUrl,
  extractDriveFileId,
  serviceAccountEmail,
  serviceAccountToken,
  type DriveFileMeta,
} from "../src/lib/google/drive";
