# Design notes: row actions and data tables (Nov 2026)

Method: one web search on table design (sources below) plus working knowledge of Linear, Attio, HubSpot, Close,
Material 3 and Apple HIG list guidance (not re-fetched; treat those points as conventions, not quotes).

## List-row actions (Calls sheet)
- One primary action per row, visually quieter than a page-level CTA: a tonal (tinted) button, not a solid fill.
  Material 3 uses tonal/outlined for secondary emphasis; solid fills are for the single most important action per screen.
- Same width on every row, so actions form a column on the right edge and names get a predictable width.
- Icon plus short verb ("Call Dale", "LinkedIn", "Reply"): the icon speeds scanning, the word keeps it unambiguous.
- Low-priority actions (Done) become icon-only tertiary buttons with an aria-label; they gain colour only on hover.
- Tap targets: Apple HIG 44x44 pt, Material 48x48 dp. We use 44px height and width on every control.
- Keep the primary at a fixed edge and put optional controls to its left so the primary never shifts between rows.

## Data tables (Admin > Campaigns)
- Right-align numeric columns and use tabular figures (font-variant-numeric: tabular-nums) so digits stack.
- A header takes the alignment of its data (text left, numbers right); one shared grid template drives header,
  totals and rows so they cannot drift.
- Fixed widths for numeric/status/action columns; the name column takes the remaining space and truncates.
- Consistent row height; muted zeros so non-zero values stand out; status as a pill with a dot (colour is never the only cue).
- Totals sit in the same grid, as a tinted row under the header (Stripe-style).
- One primary action plus an overflow menu in a fixed-width trailing column.
- Narrow screens: collapse each row to a card of label/value pairs (the label returns, because headers disappear).

## Sources
- https://digitalcommons.nc.gov/guide/help-topics/numerical-data-right-aligned
- https://data.europa.eu/apps/data-visualisation-guide/table-design-scannability
- https://spectrum.adobe.com/page/table
- https://alistapart.com/article/web-typography-tables/
- https://design.alberta.ca/examples/display-numbers-in-a-table-so-they-can-be-scanned-easily
