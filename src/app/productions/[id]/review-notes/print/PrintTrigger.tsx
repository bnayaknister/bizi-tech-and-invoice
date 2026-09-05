"use client";

import { useEffect } from "react";

// Opens the browser's print dialog once, on mount. Rendered only when the page
// is asked for with ?print=1, so the same URL is a readable tab by default and
// a print job on demand.
//
// window.print() is the whole PDF story here — the project has no jsPDF, no
// puppeteer, no react-pdf, and this page is not a reason to add one: every
// browser's print dialog already writes PDF, and a dependency that renders
// Hebrew RTL correctly is a much larger commitment than a stylesheet.
export default function PrintTrigger() {
  useEffect(() => {
    window.print();
  }, []);
  return null;
}
