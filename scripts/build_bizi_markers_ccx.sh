#!/bin/sh
# E13-11 — package the "Bizi · מרקרים" UXP panel as a .ccx (Adobe: "a regular
# ZIP file under the hood", manifest.json at its root). Output:
#   public/downloads/bizi-markers.ccx   (served to logged-in users; the drawer's "התקנת הפאנל")
# Adobe recommends packaging with the UXP Developer Tool (••• › Package); if an
# install of this zip ever fails, package the same folder there instead.
# Run: sh scripts/build_bizi_markers_ccx.sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/premiere-plugin/bizi-markers"
OUT="$ROOT/public/downloads/bizi-markers.ccx"
mkdir -p "$ROOT/public/downloads"
rm -f "$OUT"
cd "$SRC"
zip -X -q -r "$OUT" manifest.json index.html index.js lib.js icons -x '*.DS_Store' -x '._*'
echo "built $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
unzip -l "$OUT"
