// ---------------------------------------------------------------------------
// Skeleton-screen loading placeholders — shown the instant a list starts
// fetching, instead of a blank area or a spinner, so the page's shape is
// visible immediately and nothing shifts around once the real content
// arrives. See css/style.css's .skeleton-bar / @keyframes skeleton-shimmer
// for the actual shimmer animation these bars use.
//
// Both Dials (#dialsTableWrap) and Clients (#tableWrap) render the exact
// same shape for real data — a desktop <table> and a mobile .mobile-list of
// .mobile-card rows side by side, with CSS (html.is-mobile-device/
// is-desktop-device) hiding whichever doesn't apply — so one shared helper
// covers both instead of each page needing its own. The mobile card's icon
// cluster reuses .contact-action-btn's own sizing directly (see
// skeletonMobileCard below) so the placeholder circles land at the exact
// same size as the real instant-contact icons they stand in for.
// ---------------------------------------------------------------------------

// Cycled per row so the bars read as organic varying-length text instead of
// a rigid, identical grid — real content naturally varies row to row (some
// names longer than others), and a skeleton that doesn't at least gesture
// at that looks visibly fake.
const ROW_WIDTH_FACTORS = [1, 0.82, 0.93, 0.7, 1, 0.88];

function scaleWidth(pct, factor) {
  const num = parseFloat(pct);
  return `${Math.max(20, Math.round(num * factor))}%`;
}

function skeletonTableRow(columnWidths, rowIndex) {
  const factor = ROW_WIDTH_FACTORS[rowIndex % ROW_WIDTH_FACTORS.length];
  return `<tr class="skeleton-row">${columnWidths.map((w) => `<td><span class="skeleton-bar" style="width:${scaleWidth(w, factor)}"></span></td>`).join("")}</tr>`;
}

function skeletonMobileCard(rowIndex) {
  const factor = ROW_WIDTH_FACTORS[rowIndex % ROW_WIDTH_FACTORS.length];
  // Fixed pixel widths here, not percentages — .mc-main has no explicit
  // width of its own (it's a flex item sized by its content, exactly like
  // the real .mc-name/.mc-sub text it stands in for), so a percentage-width
  // child creates a circular dependency: the browser can't size .mc-main
  // from a child that's itself sized as "% of .mc-main". Confirmed as a
  // real bug visually — the bars collapsed to almost nothing. The real
  // .mc-name/.mc-sub avoid this because actual text has an intrinsic width;
  // these placeholder bars have no content to size themselves from, so they
  // need an absolute width instead.
  const nameWidth = Math.round(150 * factor);
  const subWidth = Math.round(100 * factor);
  return `
    <div class="mobile-card skeleton-card">
      <div class="mc-main">
        <div class="skeleton-bar skeleton-bar-name" style="width:${nameWidth}px"></div>
        <div class="skeleton-bar skeleton-bar-sub" style="width:${subWidth}px"></div>
      </div>
      <div class="contact-actions">
        <span class="contact-action-btn skeleton-bar"></span>
        <span class="contact-action-btn skeleton-bar"></span>
        <span class="contact-action-btn skeleton-bar"></span>
      </div>
    </div>`;
}

// Full replacement for a list page's table+mobile-list wrapper. `rows`
// (default 6) is how many placeholder rows to show; `columnWidths` is one
// base width per real column, in the same order the real <table> renders
// them (see the call sites in dials.js/clients.js) — the mobile card
// ignores this (it only ever shows a name bar + a subtitle bar, regardless
// of how many desktop columns exist).
export function skeletonListHtml({ rows = 6, columnWidths = ["55%", "60%", "45%", "50%"] } = {}) {
  const tableRows = Array.from({ length: rows }, (_, i) => skeletonTableRow(columnWidths, i)).join("");
  const cards = Array.from({ length: rows }, (_, i) => skeletonMobileCard(i)).join("");
  return `
    <table>
      <tbody>${tableRows}</tbody>
    </table>
    <div class="mobile-list">${cards}</div>
  `;
}
