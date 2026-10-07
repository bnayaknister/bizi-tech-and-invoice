import { redirect } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import ClientsScreen from "./ClientsScreen";
import { loadClientsScreen } from "./data";

// A money screen: every read is aggregate and the card edits billing terms,
// so it is force-dynamic like /finance and /radar — a cached client list is a
// cached debt total.
export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  // The gate is `loadClientsScreen`'s own (canSeeClients: owner ||
  // can_view_money, owner 7.10) — asked BEFORE any read happens, and asked
  // again by /clients/[id]. A hidden hub card is not an authorisation, so the
  // screen refuses on its own rather than trusting that nobody linked here.
  const res = await loadClientsScreen(null);
  if (!res.ok) redirect("/");

  return (
    <div className="min-h-screen">
      <AppHeader profile={res.profile} />
      <ClientsScreen data={res.data} />
    </div>
  );
}
