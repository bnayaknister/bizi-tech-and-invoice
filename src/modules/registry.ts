import type { ModuleDef } from "@/modules/types";
import { radarModule } from "@/modules/radar";
import { productionsModule } from "@/modules/productions";
import { financeModule } from "@/modules/finance";
import { contractsModule } from "@/modules/contracts";
import { usersModule } from "@/modules/users";
import { archiveModule } from "@/modules/archive";

// Adding a 7th module = write its folder, then append one line here.
// Nothing above this array needs to change.
export const MODULES: ModuleDef[] = [
  radarModule,
  productionsModule,
  financeModule,
  contractsModule,
  usersModule,
  archiveModule,
];
