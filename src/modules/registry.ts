import type { ModuleDef } from "@/modules/types";
import { radarModule } from "@/modules/radar";
import { showsModule } from "@/modules/shows";
import { productionsModule } from "@/modules/productions";
import { financeModule } from "@/modules/finance";
import { contractsModule } from "@/modules/contracts";
import { usersModule } from "@/modules/users";
import { archiveModule } from "@/modules/archive";
import { settingsModule } from "@/modules/settings";

// This is module 7 proving the architecture: one new folder
// (src/modules/shows), one new line below. Nothing above changed.
export const MODULES: ModuleDef[] = [
  radarModule,
  showsModule,
  productionsModule,
  financeModule,
  contractsModule,
  usersModule,
  archiveModule,
  settingsModule,
];
