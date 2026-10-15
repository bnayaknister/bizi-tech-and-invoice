// Bunny Stream configuration — server-side only. None of these is ever
// NEXT_PUBLIC_ (plan §8); scripts/test_bunny.ts fails if one appears in src/.
//
//   BUNNY_STREAM_LIBRARY_ID     the bizi-review library (numeric)
//   BUNNY_STREAM_API_KEY        the LIBRARY's API key (never the account key — plan Q13)
//   BUNNY_STREAM_READONLY_KEY   webhook signature key (used by the webhook step, not here yet)
//   BUNNY_STREAM_CDN_HOSTNAME   the library's pull zone hostname, e.g. vz-xxxx.b-cdn.net
//   BUNNY_CDN_TOKEN_KEY         the pull zone's Token Authentication key
//   BUNNY_DRY_RUN               must be exactly "false" to write to Bunny

// ═══ DRY_RUN, THE SAME SHAPE AS MORNING AND CALENDAR (rule 40) ═══
// Defaults ON: a missing or mistyped env var can never create, upload or
// delete anything at Bunny. Reads (getVideo) run for real — they write nothing.
export function isBunnyDryRun(): boolean {
  return process.env.BUNNY_DRY_RUN !== "false";
}

export class BunnyConfigError extends Error {
  constructor(missing: string[]) {
    super(`Bunny: חסרים משתני סביבה: ${missing.join(", ")}`);
    this.name = "BunnyConfigError";
  }
}

function read(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** The library + API key every video call needs. Throws on anything missing. */
export function bunnyApiConfig(): { libraryId: string; apiKey: string } {
  const libraryId = read("BUNNY_STREAM_LIBRARY_ID");
  const apiKey = read("BUNNY_STREAM_API_KEY");
  const missing = [
    !libraryId && "BUNNY_STREAM_LIBRARY_ID",
    !apiKey && "BUNNY_STREAM_API_KEY",
  ].filter(Boolean) as string[];
  if (missing.length) throw new BunnyConfigError(missing);
  if (!/^\d+$/.test(libraryId)) throw new Error("Bunny: BUNNY_STREAM_LIBRARY_ID אינו מספר");
  return { libraryId, apiKey };
}

/** What signing a CDN URL needs. Throws on anything missing. */
export function bunnyCdnConfig(): { hostname: string; tokenKey: string } {
  const hostname = read("BUNNY_STREAM_CDN_HOSTNAME").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const tokenKey = read("BUNNY_CDN_TOKEN_KEY");
  const missing = [
    !hostname && "BUNNY_STREAM_CDN_HOSTNAME",
    !tokenKey && "BUNNY_CDN_TOKEN_KEY",
  ].filter(Boolean) as string[];
  if (missing.length) throw new BunnyConfigError(missing);
  return { hostname, tokenKey };
}
