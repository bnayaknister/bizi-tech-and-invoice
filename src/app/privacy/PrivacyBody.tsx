import {
  PRIVACY_CONTACT_EMAIL,
  PRIVACY_INTRO,
  PRIVACY_SECTIONS,
  PRIVACY_TITLE,
  PRIVACY_UPDATED_AT,
} from "@/lib/legal/privacy";

/**
 * The privacy policy's layout. Its OWN module, like /b/[token]/DeadLink, so
 * the render suite can import and render it with no Next runtime and no
 * session. Every word comes from lib/legal/privacy.ts.
 */
export default function PrivacyBody() {
  return (
    <div dir="rtl" className="mx-auto w-full max-w-[640px] px-4 py-10 space-y-6">
      <header className="space-y-1">
        <div className="text-4xl">🎙️</div>
        <h1 className="text-lg font-bold leading-tight">{PRIVACY_TITLE}</h1>
        <p className="text-xs text-[var(--faint)]">
          עודכן לאחרונה: <span dir="ltr">{PRIVACY_UPDATED_AT}</span>
        </p>
      </header>

      <p className="text-sm text-[var(--dim)] leading-relaxed">{PRIVACY_INTRO}</p>

      {PRIVACY_SECTIONS.map((s, i) => (
        <section key={s.id} id={s.id} className="space-y-2 scroll-mt-6">
          <h2 className="text-sm font-bold">
            {i + 1}. {s.title}
          </h2>
          {s.paragraphs.map((p) => (
            <p key={p} className="text-sm text-[var(--dim)] leading-relaxed">
              {p}
            </p>
          ))}
          {s.bullets && (
            <ul className="list-disc pr-5 space-y-1 text-sm text-[var(--dim)] leading-relaxed">
              {s.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <p className="text-xs text-[var(--faint)] pt-2 border-t border-[var(--rule)]">
        <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`} dir="ltr" className="underline">
          {PRIVACY_CONTACT_EMAIL}
        </a>
      </p>
    </div>
  );
}
