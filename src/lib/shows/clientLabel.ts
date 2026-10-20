// "Show the client's name in the production row" (owner 20.10) — a per-show
// setting, OFF by default, kept in shows.settings (jsonb, {} on every show
// until now and read nowhere else) so no migration was needed. PURE.
//
// ON: the board card and the drawer title read "<client> (<show>)", e.g.
// "קורין קיציס (שומעת רגע?)". OFF, or a show without a client: exactly the
// show name, as before.

export const SHOW_CLIENT_NAME_KEY = "show_client_name";

export function showClientNameOn(settings: unknown): boolean {
  return !!settings && typeof settings === "object" && !Array.isArray(settings)
    && (settings as Record<string, unknown>)[SHOW_CLIENT_NAME_KEY] === true;
}

export function productionLabel(showName: string, clientName: string | null | undefined, on: boolean): string {
  const client = (clientName ?? "").trim();
  return on && client ? `${client} (${showName})` : showName;
}

/** The settings object with the flag set — every other key kept. */
export function withShowClientName(settings: unknown, on: boolean): Record<string, unknown> {
  const base = settings && typeof settings === "object" && !Array.isArray(settings) ? { ...(settings as Record<string, unknown>) } : {};
  base[SHOW_CLIENT_NAME_KEY] = on;
  return base;
}
