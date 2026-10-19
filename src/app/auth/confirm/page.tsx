import SoundWaveLogo from "@/components/SoundWaveLogo";
import { CONFIRM_TYPES, isConfirmType, safeNext } from "./params";

// U1-2: the landing page of the invite / recovery email links
// (`{{ .SiteURL }}/auth/confirm?token_hash=…&type=invite|recovery&next=…`).
//
// It verifies NOTHING on load. Mail / AV / WhatsApp link scanners open every
// link they see, and a GET that spent the one-time token would burn it before
// the person ever clicked (bizi-invite-link-scanners). Only the "המשך" button
// POSTs to ./verify, which runs verifyOtp on the server and sets the session
// cookies. Scanners don't submit forms.
//
// Reachable without a session: the middleware only walls signed-in unapproved
// users, and /auth/* is on its open list.
export const dynamic = "force-dynamic";

type SearchParams = { [key: string]: string | string[] | undefined };

function one(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

export default function AuthConfirmPage({ searchParams }: { searchParams: SearchParams }) {
  const tokenHash = one(searchParams.token_hash);
  const type = one(searchParams.type);
  const error = one(searchParams.error);

  let body: React.ReactNode;
  if (error === "expired") {
    body = <Message text="הקישור כבר לא בתוקף. יש לבקש קישור חדש ממנהל המערכת." />;
  } else if (error) {
    body = <Message text="לא הצלחנו לאמת את הקישור. יש לבקש קישור חדש ממנהל המערכת." />;
  } else if (!tokenHash || !isConfirmType(type)) {
    body = <Message text="הקישור אינו תקין. יש לבקש קישור חדש ממנהל המערכת." />;
  } else {
    const next = safeNext(one(searchParams.next), type);
    body = (
      <form method="POST" action="/auth/confirm/verify" className="flex flex-col gap-3">
        <input type="hidden" name="token_hash" value={tokenHash} />
        <input type="hidden" name="type" value={type} />
        <input type="hidden" name="next" value={next} />
        <p className="text-center text-sm text-[var(--faint)] mb-2">
          {CONFIRM_TYPES[type]}
        </p>
        <button
          type="submit"
          className="text-white font-bold rounded-xl px-3 py-2.5 text-sm"
          style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 14px rgba(139,92,246,0.3)" }}
        >
          המשך
        </button>
      </form>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="glass-card w-full max-w-sm" style={{ padding: "34px 32px" }}>
        <span className="corner-glow" style={{ ["--glow-color" as string]: "rgba(192,132,252,0.26)" }} />
        <div className="glass-content">
          <div className="flex flex-col items-center gap-3 mb-5">
            <SoundWaveLogo size={40} animated />
            <h1 className="text-lg font-black text-center">Bizi Podclub Manage</h1>
          </div>
          {body}
        </div>
      </div>
    </main>
  );
}

function Message({ text }: { text: string }) {
  return <div className="text-center text-sm text-[var(--faint)] py-2">{text}</div>;
}
