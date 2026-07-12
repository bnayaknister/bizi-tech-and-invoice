export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-lg w-full text-center border border-[var(--rule)] rounded bg-[var(--panel2)] p-10">
        <div className="flex items-center justify-center gap-3 mb-4">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="2" y="9" width="2.5" height="6" rx="1" fill="#3FD68C" />
            <rect x="6.5" y="5" width="2.5" height="14" rx="1" fill="#3FD68C" />
            <rect x="11" y="2" width="2.5" height="20" rx="1" fill="#F2B441" />
            <rect x="15.5" y="6" width="2.5" height="12" rx="1" fill="#FF4D4D" />
            <rect x="20" y="10" width="2.5" height="4" rx="1" fill="#56C8E8" />
          </svg>
          <h1 className="text-xl font-black">ביזי סטודיו · פודקלאב</h1>
        </div>
        <p className="text-[var(--dim)] text-sm leading-relaxed">
          מערכת הענן בהקמה. שלב 0 — פריסה חיה. השלב הבא: חיבור מסד הנתונים,
          הרשאות, וטעינת הנתונים האמיתיים.
        </p>
      </div>
    </main>
  );
}
