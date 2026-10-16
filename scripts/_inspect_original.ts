/**
 * E13 --inspect-original (owner 16.10): is what Bunny keeps as /original the
 * file we sent, or a converted one? Audio came back with originalHash ≠
 * Drive's sha256 and length/1280x720 like a video; video matched.
 *
 * Downloads the signed /original to a temp file, hashing it ON OUR SIDE while
 * it streams (Bunny's originalHash is not used here), then describes it:
 * ffprobe when installed, and always a first-bytes sniff (ID3 / MPEG frame /
 * ftyp / RIFF / EBML) so the question is answered even without ffprobe.
 * When our hash differs from Drive's, the Drive file is downloaded too and
 * described the same way, side by side. Temp files are removed in `finally`.
 *
 * Not a test itself (no `test_` prefix).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdtempSync, openSync, readSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describeError } from "../src/lib/bunny/errors";
import { signedOriginalUrl } from "../src/lib/bunny/sign";
import { REFERER, type Recorder } from "./_bunny_checks";

export const INSPECT_CHECKS = ["original: הורדה", "original: sha256 מקומי מול Drive", "original: סוג הקובץ"];
const MB = 1024 * 1024;
const ffprobeBin = () => process.env.E13_FFPROBE_BIN ?? "ffprobe";

/** Streams `url` into `path`, hashing every chunk on the way. One attempt. */
export async function downloadHashed(url: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; bytes: number; sha256: string; seconds: number }> {
  const t0 = Date.now();
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    return { status: res.status, bytes: 0, sha256: "", seconds: 0 };
  }
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>),
    async function* (src: AsyncIterable<Buffer>) {
      for await (const chunk of src) {
        hash.update(chunk);
        bytes += chunk.length;
        yield chunk;
      }
    },
    createWriteStream(path)
  );
  return { status: res.status, bytes, sha256: hash.digest("hex"), seconds: Math.max(1, Math.round((Date.now() - t0) / 1000)) };
}

/** What the first bytes say the container is. */
export function sniffContainer(path: string): string {
  const buf = Buffer.alloc(16);
  const fd = openSync(path, "r");
  let n = 0;
  try {
    n = readSync(fd, buf, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  const b = buf.subarray(0, n);
  if (b.subarray(0, 3).toString("latin1") === "ID3") return "MP3 (תגית ID3 בהתחלה)";
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "MP3/AAC (MPEG frame sync)";
  if (b.subarray(4, 8).toString("latin1") === "ftyp") return `MP4/ISO-BMFF (brand ${b.subarray(8, 12).toString("latin1")})`;
  if (b.subarray(0, 4).toString("latin1") === "RIFF") return `RIFF/${b.subarray(8, 12).toString("latin1")}`;
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return "Matroska/WebM";
  if (b.subarray(0, 4).toString("latin1") === "fLaC") return "FLAC";
  if (b.subarray(0, 4).toString("latin1") === "OggS") return "Ogg";
  return `לא מזוהה (bytes: ${b.toString("hex")})`;
}

type ProbeStream = { codec_type?: string; codec_name?: string; width?: number; height?: number; sample_rate?: string; channels?: number; bit_rate?: string; disposition?: { attached_pic?: number } };
type ProbeJson = { format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string }; streams?: ProbeStream[] };

/** ffprobe -show_format -show_streams as one line; null + reason when ffprobe is not there. */
export async function ffprobeSummary(path: string): Promise<{ ok: true; line: string; realVideo: boolean } | { ok: false; reason: string }> {
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string; err?: Error }>((resolve) => {
    let stdout = "";
    let stderr = "";
    let p;
    try {
      p = spawn(ffprobeBin(), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
    } catch (e) {
      resolve({ code: null, stdout, stderr, err: e as Error });
      return;
    }
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (err) => resolve({ code: null, stdout, stderr, err }));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  if (out.err) {
    return { ok: false, reason: (out.err as NodeJS.ErrnoException).code === "ENOENT" ? "ffprobe לא מותקן (brew install ffmpeg)" : describeError(out.err) };
  }
  if (out.code !== 0) return { ok: false, reason: `ffprobe יצא בקוד ${out.code}: ${out.stderr.trim().slice(0, 300)}` };
  let j: ProbeJson;
  try {
    j = JSON.parse(out.stdout) as ProbeJson;
  } catch {
    return { ok: false, reason: "ffprobe החזיר פלט שאינו JSON" };
  }
  const f = j.format ?? {};
  const streams = (j.streams ?? []).map((s) => {
    const cover = s.disposition?.attached_pic === 1;
    const v = s.codec_type === "video" ? ` ${s.width ?? "?"}x${s.height ?? "?"}${cover ? " (תמונת עטיפה)" : ""}` : "";
    const a = s.codec_type === "audio" ? ` ${s.sample_rate ?? "?"}Hz ${s.channels ?? "?"}ch` : "";
    return `${s.codec_type ?? "?"}:${s.codec_name ?? "?"}${v}${a}${s.bit_rate ? ` ${Math.round(Number(s.bit_rate) / 1000)}kbps` : ""}`;
  });
  const realVideo = (j.streams ?? []).some((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const dur = f.duration ? `${Number(f.duration).toFixed(1)}s` : "?";
  return {
    ok: true,
    realVideo,
    line: `container ${f.format_name ?? "?"} · משך ${dur} · ${streams.length} רצועות: ${streams.join(" | ") || "—"} · רצועת וידאו אמיתית: ${realVideo ? "כן" : "לא"}`,
  };
}

/**
 * The whole inspection on a finished video. `drive` (when the source was a
 * Drive file) gives the sha256 to compare with and the means to download the
 * Drive file for a side-by-side when they differ. Never throws.
 */
export async function inspectOriginal(
  label: string,
  guid: string,
  record: Recorder,
  drive: { sha256: string | null; mediaUrl: string | null; getToken: (() => Promise<string>) | null } | null
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "e13-original-"));
  try {
    const orig = join(dir, "original.bin");
    let got;
    try {
      got = await downloadHashed(signedOriginalUrl(guid, 3600).url, orig, { Referer: REFERER });
    } catch (e) {
      record(label, "original: הורדה", "לא נבדק", `ניסיון אחד: ${describeError(e)}`);
      return;
    }
    if (got.status !== 200) {
      record(label, "original: הורדה", "נכשל", `HTTP ${got.status}`);
      return;
    }
    record(label, "original: הורדה", "עבר", `${(got.bytes / MB).toFixed(1)}MB (${got.bytes} bytes) ב-${got.seconds}s · sha256 מקומי ${got.sha256}`);

    const same = drive?.sha256 ? drive.sha256.trim().toLowerCase() === got.sha256 : null;
    if (same === null) {
      record(label, "original: sha256 מקומי מול Drive", "דילוג", "אין sha256 של Drive להשוואה");
    } else {
      record(label, "original: sha256 מקומי מול Drive", same ? "עבר" : "נכשל",
        same ? "זהה — Bunny שומר את הקובץ המקורי בדיוק" : `שונה: drive ${drive!.sha256!.slice(0, 16)}… ≠ מקומי ${got.sha256.slice(0, 16)}…`);
    }

    const probe = await ffprobeSummary(orig);
    record(label, "original: סוג הקובץ", "עבר", `בתים ראשונים: ${sniffContainer(orig)} · ffprobe: ${probe.ok ? probe.line : probe.reason}`);

    if (same === false) {
      if (!drive?.mediaUrl || !drive.getToken) {
        record(label, "Drive: סוג הקובץ (להשוואה)", "דילוג", "אין גישה לקובץ ה-Drive (הורץ עם --sha256 בלבד)");
        return;
      }
      const dpath = join(dir, "drive.bin");
      try {
        // a fresh token: the one the fetch used may be hours old after a long encode
        const d = await downloadHashed(drive.mediaUrl, dpath, { Authorization: `Bearer ${await drive.getToken()}` });
        if (d.status !== 200) {
          record(label, "Drive: סוג הקובץ (להשוואה)", "נכשל", `הורדה מ-Drive: HTTP ${d.status}`);
          return;
        }
        const dp = await ffprobeSummary(dpath);
        record(label, "Drive: סוג הקובץ (להשוואה)", "עבר",
          `${(d.bytes / MB).toFixed(1)}MB (${d.bytes} bytes) · sha256 מקומי ${d.sha256}${d.sha256 === drive.sha256!.trim().toLowerCase() ? " (= Drive)" : " (≠ מה ש-Drive מדווח!)"} · בתים ראשונים: ${sniffContainer(dpath)} · ffprobe: ${dp.ok ? dp.line : dp.reason}`);
      } catch (e) {
        record(label, "Drive: סוג הקובץ (להשוואה)", "לא נבדק", `הורדה מ-Drive: ${describeError(e)}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    console.log(`     🧹 קבצים זמניים נמחקו (${dir})`);
  }
}
