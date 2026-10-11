import { createMorningClient, isDryRun, listClients } from "@/lib/morning/client";
import type { MorningPort } from "./approve";

/**
 * The real Morning, behind the port approve.ts takes. Its own module so the
 * offline suites can hand approve.ts a fake one and never import a network
 * path. `listClients` is a READ and runs live even in a dry run (it always
 * has); `createMorningClient` honours MORNING_DRY_RUN itself.
 */
export const realMorning: MorningPort = {
  isDryRun,
  listClients: async () => (await listClients()).map((m) => ({ id: m.id, name: m.name, taxId: m.taxId ?? null })),
  createClient: (f) =>
    createMorningClient({ name: f.name, taxId: f.taxId, phone: f.phone, emails: f.emails, address: f.address }),
};
