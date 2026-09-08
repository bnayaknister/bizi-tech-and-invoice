import type { ModuleDef } from "@/modules/types";
import { radarModule } from "@/modules/radar";
import { showsModule } from "@/modules/shows";
import { productionsModule } from "@/modules/productions";
import { miscModule } from "@/modules/misc";
import { financeModule } from "@/modules/finance";
import { projectsModule } from "@/modules/projects";
import { contractsModule } from "@/modules/contracts";
import { usersModule } from "@/modules/users";
import { archiveModule } from "@/modules/archive";
import { settingsModule } from "@/modules/settings";
import { approvalsModule } from "@/modules/approvals";
import { documentsModule } from "@/modules/documents";
import { docRegistryModule } from "@/modules/doc-registry";

// Order = importance, not module count (owner note 2026-07-18). The hub
// grid fills this array into a 3-col RTL grid, so the first row (and, in
// RTL, its right side first) is the most prominent real estate. Productions
// is the team's central daily screen and users belongs beside it up top;
// archive and settings are barely touched and sit last. In RTL the
// right-most card of row 1 is read first, so productions is placed to land
// there, with users next to it, and archive/settings anchored at the end.
export const MODULES: ModuleDef[] = [
  radarModule,
  usersModule,
  productionsModule,
  // directly after הפקות (and so, trivially, before מסמכים): both are
  // can_view_stages work lists and they answer the same question about two
  // different kinds of job, so they belong adjacent rather than split by the
  // money screens
  miscModule,
  financeModule,
  projectsModule,
  docRegistryModule,
  documentsModule,
  contractsModule,
  showsModule,
  approvalsModule,
  archiveModule,
  settingsModule,
];
