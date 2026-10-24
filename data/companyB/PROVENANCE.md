# Provenance: company B source data

## Source

| | |
|---|---|
| Dataset | Online Retail II (UCI Machine Learning Repository, dataset id 502) |
| Page | https://archive.ics.uci.edu/dataset/502/online+retail+ii |
| Download URL | https://archive.ics.uci.edu/static/public/502/online+retail+ii.zip |
| DOI | https://doi.org/10.24432/C5CG6D |
| Creator | Daqing Chen (donated to UCI on 2019-09-20) |
| License | Creative Commons Attribution 4.0 International (CC BY 4.0) |
| Citation | Chen, D. (2012). Online Retail II [Dataset]. UCI Machine Learning Repository. https://doi.org/10.24432/C5CG6D |

Content: every transaction of a UK-based, registered, non-store online retailer (mostly
giftware, many customers are wholesalers) from 2009-12-01 to 2011-12-09.

## Download

| | |
|---|---|
| Tool | `curl 8.7.1` (`curl -sS -L --fail`), not Python, because the python.org Python on this Mac has no root certificates |
| Started | 2026-10-24T05:27:33Z |
| Finished | 2026-10-24T05:27:52Z |
| HTTP response | `200 OK`, `Server: nginx/1.31.4`, `Transfer-Encoding: chunked` (no Content-Length, ETag or Last-Modified) |

| File (under `data/companyB/raw/`, gitignored) | Bytes | SHA-256 |
|---|---:|---|
| `online_retail_ii.zip` (as downloaded) | 45,622,418 | `572e36277c2390fbfde10664750731e0a86f55e33470d91919085f0408e67bfb` |
| `online_retail_II.xlsx` (the only zip entry, dated 2023-05-22 15:20, stored uncompressed) | 45,622,278 | `bcbe73b35f5b7babf197fb0cb983a11f5d9ff929078d4aa53d171b1f2df2e980` |

`tools/data_b/fetch_raw.sh` repeats the download and checks both hashes; `build_company_b.py`
refuses to build from an xlsx with a different SHA-256 unless `--allow-hash-mismatch` is passed.
The build also writes a parse cache to `raw/cache/` (gitignored), named after the xlsx hash.

## What is in the xlsx

| Sheet | Rows | Dates |
|---|---:|---|
| `Year 2009-2010` | 525,461 | 2009-12-01 07:45 to 2010-12-09 20:01 |
| `Year 2010-2011` | 541,910 | 2010-12-01 08:26 to 2011-12-09 12:50 |

Columns: `Invoice`, `StockCode`, `Description`, `Quantity`, `InvoiceDate`, `Price` (GBP per
unit), `Customer ID`, `Country`. Invoice numbers starting with `C` are cancellations; `A` marks
bad-debt adjustments.

The two sheets overlap: the 22,523 rows (1,088 invoices) dated 2010-12-01 08:26 to 2010-12-09
20:01 appear in both, identically. The build keeps the copy in `Year 2010-2011` and verifies
the overlap is an exact duplicate before dropping the other (it stops otherwise).

## Attribution for derived files

`customers.json`, `invoices.json`, `credit_notes.json` and `stats.json` are derived from the
dataset above (selection, aggregation, inferred links and labels, as described in `README.md`)
and are shared under CC BY 4.0 with this attribution.
