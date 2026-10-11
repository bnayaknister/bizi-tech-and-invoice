/**
 * E17-4's switch — `REGISTRATION_ENABLED`. Rule 40: OFF unless the value is
 * exactly "true". Off means the bot and the system behave exactly as before
 * E17-4 (unknown numbers get the neutral sentence and the owner's notice), and
 * `/join/*` and `/api/join/*` answer 404.
 *
 * Its own module, with no imports, so the page, the routes, the bot and the
 * clients screen all ask the same one line.
 */
export function isRegistrationEnabled(): boolean {
  return process.env.REGISTRATION_ENABLED === "true";
}
