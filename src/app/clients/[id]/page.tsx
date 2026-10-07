import { redirect } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import ClientsScreen from "../ClientsScreen";
import { loadClientsScreen } from "../data";

export const dynamic = "force-dynamic";

// The same screen with one client's card open. A separate route rather than
// client state so the card is addressable, the back button works and the list
// rows can be plain links (no JS required to open a client).
//
// The gate is the same function the list page uses, asked again here: a
// per-client URL is exactly the kind of link that gets shared past the hub.
export default async function ClientPage({ params }: { params: { id: string } }) {
  const res = await loadClientsScreen(params.id);
  if (!res.ok) redirect("/");
  // An id that matches no client leaves `card` null and the list renders alone —
  // not a 404. A stale link to a merged-away client should land the operator on
  // the list, which is where they can find whoever it became.
  return (
    <div className="min-h-screen">
      <AppHeader profile={res.profile} />
      <ClientsScreen data={res.data} />
    </div>
  );
}
