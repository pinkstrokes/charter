#!/usr/bin/env bash
# Download UCI "Online Retail II" into data/companyB/raw/ with curl and verify it.
# curl, not Python: the python.org Python on this Mac has no root certificates.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAW="$(cd "$HERE/../.." && pwd)/data/companyB/raw"
URL="https://archive.ics.uci.edu/static/public/502/online+retail+ii.zip"
ZIP_SHA256="572e36277c2390fbfde10664750731e0a86f55e33470d91919085f0408e67bfb"
XLSX_SHA256="bcbe73b35f5b7babf197fb0cb983a11f5d9ff929078d4aa53d171b1f2df2e980"

mkdir -p "$RAW"
if [ ! -f "$RAW/online_retail_ii.zip" ]; then
  curl -sS -L --fail --retry 3 -o "$RAW/online_retail_ii.zip.part" "$URL"
  mv "$RAW/online_retail_ii.zip.part" "$RAW/online_retail_ii.zip"
fi

got_zip="$(shasum -a 256 "$RAW/online_retail_ii.zip" | cut -d' ' -f1)"
if [ "$got_zip" != "$ZIP_SHA256" ]; then
  echo "note: zip SHA-256 $got_zip differs from the recorded $ZIP_SHA256 (re-zipped upstream?); checking the xlsx" >&2
fi

unzip -o -q "$RAW/online_retail_ii.zip" online_retail_II.xlsx -d "$RAW"
got_xlsx="$(shasum -a 256 "$RAW/online_retail_II.xlsx" | cut -d' ' -f1)"
if [ "$got_xlsx" != "$XLSX_SHA256" ]; then
  echo "error: xlsx SHA-256 $got_xlsx differs from the recorded $XLSX_SHA256 (see data/companyB/PROVENANCE.md)" >&2
  exit 1
fi
echo "ok: $RAW/online_retail_II.xlsx ($got_xlsx)"
