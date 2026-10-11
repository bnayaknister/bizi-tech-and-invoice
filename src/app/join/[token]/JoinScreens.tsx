/**
 * The two fixed screens of /join (E17-4). Their own module so the render suite
 * can import them without the page's database read.
 *
 * ⚠️ BOTH ARE DELIBERATELY UNINFORMATIVE.
 *   · JoinDeadLink — unknown, expired, used, revoked, or a tampered bot link:
 *     ONE screen (owner decision 11.10). Which of them it was would confirm
 *     that a token was once real.
 *   · JoinThanks — a new registration, a match to an existing card and a
 *     honeypot hit get the SAME words. The page must not reveal that a ח.פ
 *     belongs to an existing client, nor that a bot was spotted.
 */

export const BRAND = "Bizi Podclub";
export const JOIN_DEAD = "הקישור הזה לא פעיל. לשאלות כתבו לנו בוואטסאפ.";
export const JOIN_THANKS_TITLE = "תודה! קיבלנו את הפרטים ✅";
export const JOIN_THANKS_BODY = "נחזור אליכם בהקדם בוואטסאפ.";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div dir="rtl" className="mx-auto w-full max-w-[460px] px-4 py-10">
      <div className="text-center mb-6">
        <div className="text-3xl">🎙️</div>
        <div className="font-bold text-lg mt-1">{BRAND}</div>
      </div>
      {children}
    </div>
  );
}

export function JoinDeadLink({ whatsappNumber }: { whatsappNumber: string | null }) {
  return (
    <Shell>
      <div className="text-center space-y-4">
        <p className="text-sm text-[var(--dim)]">{JOIN_DEAD}</p>
        {whatsappNumber && (
          <a
            href={`https://wa.me/${whatsappNumber}`}
            rel="noreferrer noopener"
            className="inline-block rounded-xl px-4 py-2 text-sm font-bold border border-[var(--violet-light)]"
          >
            כתבו לנו בוואטסאפ
          </a>
        )}
      </div>
    </Shell>
  );
}

export function JoinThanks() {
  return (
    <Shell>
      <div className="text-center space-y-2">
        <p className="text-base font-bold">{JOIN_THANKS_TITLE}</p>
        <p className="text-sm text-[var(--dim)]">{JOIN_THANKS_BODY}</p>
      </div>
    </Shell>
  );
}

export { Shell as JoinShell };
