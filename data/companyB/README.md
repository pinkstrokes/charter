# Company B: accounts receivable of a UK giftware wholesaler

Real invoices and credit notes of a UK online giftware wholesaler (UCI "Online Retail II"),
1 December 2010 to 31 May 2011, for its 120 largest wholesale-like customers. This is the
receivables side only: there are no payments, remittances or emails here (they are simulated
elsewhere). All amounts are integers in pence (GBP, the source currency).

Built by `tools/data_b/build_company_b.py`; source and hashes in `PROVENANCE.md`.

## Files

| File | Content |
|---|---|
| `customers.json` | 120 customers |
| `invoices.json` | 1,645 invoices with their 28,836 lines |
| `credit_notes.json` | 380 credit notes (963 lines) with inferred links to invoices |
| `stats.json` | counts, totals, per-country figures, distributions, messy phenomena |
| `PROVENANCE.md` | source, licence, download time, sizes, SHA-256 |
| `raw/` (gitignored) | downloaded zip, xlsx, parse cache |

The three record files are JSON arrays with one record per line (valid JSON; easy to `grep`,
`head` or diff). Records are sorted by date, then number; customers by rank.

## Real vs derived

| Real (copied from the source) | Derived (computed by the build) |
|---|---|
| invoice and credit-note numbers, timestamps | `customer_code` (`B-` + source id), the customer selection |
| customer ids and countries | `country` when a customer has several (none in this selection), `currency_guess` |
| stock codes, descriptions, quantities, unit prices, line order | `line_type`, `gross_pence`, `special_lines` buckets, `net_pence` (sums of lines) |
| cancellations (`C` documents) and their lines | every credit-note link: `linked_invoice_no`, `additional_linked_invoice_nos`, `allocations`, `link_confidence`, `match`, `later_matching_invoice_no` |
| special lines: postage, manual, discount, bank charges | `reason_guess`, all `flags`, invoice `credit_note_nos` / `credited_pence`, `stats.json` |

Not in the source and not invented here: customer names, addresses, contacts, payment terms,
due dates, VAT, payments. The source never says which invoice a credit note belongs to; the
links are inferred (see below) and have no ground truth.

## Window and selection

- Window: 2010-12-01 00:00 to 2011-05-31 23:59, UK wall-clock time as recorded (the source has
  no time zone). A document belongs to the window by its earliest line timestamp.
- Rows without a Customer ID are excluded: 59,976 window rows in 1,785 documents worth
  £586,339.55 (orders without a customer account, stock write-offs, unattributed credits).
- Eligible customers have at least 3 invoices (non-`C` documents) in the window: 828 of the
  2,767 customers active in the window.
- They are ranked by net revenue in the window, i.e. the sum of quantity x price over all their
  window lines including credit notes; the top 120 are kept (ties by id). Number 120 has
  £3,582.62, number 121 £3,582.33. The 120 account for 41.5% of the window revenue of
  identified customers.
- Every invoice and credit note of those 120 customers in the window is included. Earlier
  history (from 2009-12-01) is used only to find the originals of credit notes.

## Transformations

1. Both sheets are read with pandas + openpyxl keeping exact cell values (numeric stock codes and
   invoice numbers become strings, prices stay exact decimals).
2. Sheet overlap: `Year 2009-2010` runs to 2010-12-09 and `Year 2010-2011` restarts on
   2010-12-01. The 22,523 rows (1,088 documents) of that overlap are identical in both sheets
   (checked as multisets; the build stops if not), so the sheet-1 copy is dropped. Repeated lines
   within one sheet are real and kept.
3. Rows are grouped by invoice number into documents. `C` = credit note, `A` = bad-debt
   adjustment (6 in the source, none with a customer). `invoice_date` is the earliest line time.
4. Amounts: `line_total_pence` = quantity x unit price x 100 with exact decimals, rounded half
   away from zero. `unit_price_pence` is rounded the same way; lines with a sub-penny price (e.g.
   £0.001, none in this selection) also carry `unit_price_gbp_exact`. Document totals are sums of
   line totals.
5. Line types (stock codes matched case-insensitively):

   | `line_type` | Stock codes | Invoice bucket |
   |---|---|---|
   | `product` | everything else (incl. PADS, DCGS..., SP1002) | `gross_pence` |
   | `gift_voucher` | gift_0001_xx | `gross_pence` |
   | `postage` | POST, DOT, C2 | `special_lines.postage_pence` |
   | `manual` | M, m | `special_lines.manual_pence` |
   | `adjustment` | ADJUST, ADJUST2, B | `special_lines.manual_pence` |
   | `discount` | D | `special_lines.manual_pence` |
   | `samples` | S | `special_lines.manual_pence` |
   | `test` | TEST001, TEST002 | `special_lines.manual_pence` |
   | `bank_charges` | BANK CHARGES | `special_lines.fees_pence` |
   | `fee` | AMAZONFEE, CRUK | `special_lines.fees_pence` |

   The selected world contains product, postage (POST, C2), manual (M), discount (D) and bank
   charges lines; the other types exist only outside it.
6. Customer `country` is the country on most of the customer's window invoices (ties: the
   latest invoice's). `currency_guess` is `EUR` for euro-area countries of 2011 (Austria,
   Belgium, Cyprus, EIRE, Estonia, Finland, France, Germany, Greece, Italy, Luxembourg, Malta,
   Netherlands, Portugal, Slovakia, Slovenia, Spain), otherwise `GBP`. It is only a hint for the
   payment simulator: every invoice is billed in GBP.

### Linking credit notes to invoices

Candidates are the customer's invoices dated at or before the credit note, from the whole source
(so originals before the window are found too).

- Credit notes with goods lines: quantities are summed per stock code. For a candidate,
  `coverage` is the share of the credited value whose units appear on it (capped at the
  invoiced quantity), `price_coverage` the part of that at the same unit price, and
  effective = (coverage + price_coverage) / 2. A credited code one character away from a code on
  the candidate, with the same quantity and price, counts if the candidate already matches other
  credited codes (wrong variant keyed).
- Credit notes made only of special lines: a candidate is evidence when it has the same special
  line amount (weight 1.0), its total equals the credit (0.9), it has a goods line with the
  manual line's quantity and price (0.8; 0.6 if a larger quantity), a discount equal to a round
  percentage of it within 31 days (0.7) or matching one of its line quantities (0.5), or postage
  at the refunded rate (0.9 if it charged at least that many units, else 0.6).
- score = effective^4 x (1 + share of credited value with exactly the invoiced quantity) x
  (10 if the credit reverses the whole candidate) / (1 + age in days / 14)^2. The age term
  follows the lags observed in this data (median about 9 days, long tail).
- `linked_invoice_no` is the best-scoring candidate. If it leaves more than 5% of the credited
  goods value unexplained, up to 3 more invoices are added greedily, each explaining at least
  5% (`additional_linked_invoice_nos`). `allocations` splits `amount_pence`: each additional
  invoice gets the value it explains, the primary gets the rest (including unexplained value
  and special lines).
- `link_confidence` = best score / (sum of all candidate scores + 0.01) x effective coverage,
  where 0.01 stands for "the original is not in the data"; a multi-invoice link is scored as one
  candidate. It is 0 when nothing links. Treat it as a ranking signal, not a calibrated
  probability. Current spread: 183 links >= 0.8, 92 in 0.5-0.8, 59 in 0.2-0.5, 22 below 0.2, 24
  unlinked.
- `later_matching_invoice_no`: an invoice raised within 2 days after the credit note that holds at
  least 80% of the credited goods and consists at least half of them (a re-bill; prices may
  differ). Each such invoice is used for one credit note only.
- `reason_guess`: `manual_adjustment` when the credit note has no goods lines; `cancellation` when
  it reverses at least 90% of the goods value of its linked invoices with effective coverage
  >= 0.9; otherwise `return` (also when no original is found).

## Record fields

`customers.json`: `customer_code`, `source_customer_id`, `country`, `currency_guess`,
`invoice_count`, `net_revenue_pence` (window invoices minus window credit notes),
`first_invoice_date`, `last_invoice_date` (`YYYY-MM-DD`, window), `rank`, `invoiced_pence`,
`credit_note_count`, `credited_pence`, `countries_seen`, `first_seen_in_source`,
`invoices_before_window`, `invoiced_before_window_pence` (history since 2009-12-01).

`invoices.json`: `invoice_no`, `customer_code`, `invoice_date` (`2010-12-01T08:26:00`),
`gross_pence` (goods lines), `special_lines` {`postage_pence`, `manual_pence`, `fees_pence`},
`net_pence` (= gross + special lines = sum of lines, the amount billed), `currency`, `line_count`,
`credit_note_nos` and `credited_pence` (credit notes allocated to it), `flags`, `source_sheet`,
`lines` [{`stock_code`, `description`, `quantity`, `unit_price_pence`, `line_total_pence`,
`line_type`, `source_row` (spreadsheet row in `source_sheet`)}].

`credit_notes.json`: `credit_no`, `customer_code`, `date` (ISO date-time), `amount_pence`
(positive), `linked_invoice_no` (or null), `link_confidence`, `reason_guess`, `currency`,
`linked_invoice_date`, `linked_invoice_net_pence`, `linked_invoice_in_window` (false: the original
predates the window and is not in `invoices.json`), `additional_linked_invoice_nos`, `allocations`
[{`invoice_no`, `amount_pence`}], `match` {`basis`, `coverage`, `price_coverage`,
`share_of_invoice_credited`, `days_after_invoice`, `candidates`, `plausible_alternatives`,
`neighbouring_code_matches`}, `later_matching_invoice_no`, `goods_pence` and `special_lines`
(positive credited amounts, summing to `amount_pence`), `line_count`, `flags`, `source_sheet`,
`lines` (as in the source: negative quantities and line totals).

Invoice flags: `partially_credited`, `fully_credited` (allocated credits >= 90% of net),
`duplicate_looking_same_day_same_amount`, `identical_content_repeat`, `duplicate_lines`,
`multiple_timestamps`, `large_quantity_line` (|quantity| >= 1000), `zero_price_line`,
`sub_penny_price`, `quantity_sign_mismatch`, `matches_earlier_credit_note` (it is a re-bill).

Credit-note flags: `no_findable_original`, `original_before_window`, `ambiguous_original` (another
candidate scores >= half the best), `partially_traceable` (coverage < 1), `price_differs_from_original`,
`exceeds_original_invoice`, `spans_several_invoices`, `neighbouring_stock_code_matched`,
`cancel_and_rebill`, `precedes_matching_invoice`, `special_lines_only`,
`same_amount_as_recent_credit_note` (same customer and amount within 31 days), plus the line
flags above.

## Key numbers

| | |
|---|---|
| Customers | 120 (100 UK; 16 with `currency_guess` EUR; 12 countries) |
| Invoices | 1,645, billed £1,369,504.60 (goods £1,341,607.24, postage £17,316.75, manual £10,550.61, bank charges £30.00) |
| Credit notes | 380, £74,500.81 (5.4% of billed); 99 of 120 customers (82.5%) have at least one |
| Net revenue | £1,295,003.79 |
| Invoice size (net) | median £416.54, mean £832.53; p5 £22.20, p25 £204.00, p75 £797.77, p95 £2,719.02, max £21,535.90 |
| Lines per invoice | median 11, p95 53, max 294 |
| Credit-note reasons | 340 return, 29 manual adjustment, 11 cancellation |

## Messy phenomena (counts in `stats.json`)

In the selected world:

| Phenomenon | Count |
|---|---:|
| credit notes spanning several earlier invoices | 79 |
| credit notes with an ambiguous original (customer re-ordered the same items) | 69 |
| credit notes against an invoice from before the window (likely paid already: unapplied credit), £6,723.15 | 51 |
| credit notes whose unit price differs from the linked invoice | 51 |
| invoices receiving more than one credit note | 51 |
| credit notes made only of Manual / Discount / POSTAGE lines | 29 |
| credit notes with no findable original, £10,791.72 | 24 |
| invoices fully credited | 17 |
| cancel-and-rebill (credit, then a near-identical invoice within 2 days) | 10 |
| credit notes repeating a recent credit's exact amount (possible double credit), £1,872.01 | 8 |
| duplicate-looking invoices (same customer, day and amount), in 8 groups | 28 |
| invoices identical in content to another of the same customer | 40 |
| repeated identical lines within a document (85 documents) | 193 |
| stock code split over several lines of one document (14 at different prices) | 328 |
| manual (M) lines: 24 on invoices (£10,550.61), 27 on credit notes (£18,489.63) | 51 |
| postage lines: 113 on invoices (£17,316.75), 9 refunds on credit notes (£8,322.49) | 122 |
| discount (D) lines, all on credit notes (£769.45) | 9 |
| lines with \|quantity\| >= 1000 | 45 |
| stock codes with more than one description | 47 |
| invoices whose lines carry several timestamps | 6 |
| zero-price lines | 5 |
| negative-quantity lines on non-`C` invoices, negative or sub-penny prices | 0 |

Outside the selected world (window or whole source): 59,976 window rows without a customer, 651
negative-quantity lines on non-`C` window invoices (all without a customer; 3,393 in the whole
source), 1,292 zero-price window lines, 89 window credit notes without a customer, 22,523 rows
duplicated across the two sheets, 6 bad-debt adjustment documents (negative prices), 18 sub-penny
prices, 174 stock codes spelled several ways (case, e.g. 15056BL / 15056bl, or a trailing space),
13 customer ids with more than one country.

Notable real cases:

- `B-15749`: bulk invoices 540815 and 540818 (2011-01-11, £22,998.40 together) are reversed by a
  single credit note C550456 on 2011-04-18, one line keyed as 47566B "TEA TIME PARTY BUNTING"
  instead of 47556B "TEA TIME TEA TOWELS", and re-billed 12 minutes later at lower prices as
  550461 (£21,535.90, the largest invoice here).
- `B-14911`: a September 2010 invoice of £1,687.17 (524139) is credited twice by manual credit
  notes on 2011-03-11 and re-issued twice as manual invoices 546328 and 546329.
- `B-16029`: a £8,142.75 "POSTAGE" credit (C551685, 12:51) comes 55 minutes before the invoice
  it matches (551697); the same afternoon a £6,930.00 manual credit reverses a December bulk
  invoice (539101).
- `B-17340`: a 10% discount credit note (C537857) four minutes after a £2,671.27 invoice.
- `B-17850`: the same two-line £22.20 invoice raised again and again on one day.

## Reproduce

```sh
cd tools/data_b
./fetch_raw.sh                    # curl download into data/companyB/raw/, SHA-256 check, unzip
uv sync                           # Python 3.12, pandas 3.1.0, openpyxl 3.1.5, pytest 9.1.1 (uv.lock)
uv run python build_company_b.py  # about 100 s the first time (xlsx parse, then cached), about 10 s after
uv run pytest                     # 12 tests, about 45 s (re-reads the xlsx independently)
```

Options: `--start 2010-12-01 --end 2011-05-31 --top 120 --min-invoices 3 --out DIR --no-cache`.
The output depends only on the xlsx and the options; reruns are byte-identical (checked across
cached and uncached runs and different hash seeds).

## Licence

Derived from: Chen, D. (2012). Online Retail II [Dataset]. UCI Machine Learning Repository.
https://doi.org/10.24432/C5CG6D. Licensed CC BY 4.0. Changes: selection of a window and of
customers, aggregation into documents, and the derived fields listed above.
