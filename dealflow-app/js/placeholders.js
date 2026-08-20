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
//
// Further down: skeletonDialsPage/skeletonClientsPage/skeletonProfilePage —
// one per page, each shaped to match that specific page's own real layout
// (tabs bar, search toolbar, profile card + chart + upcoming events) rather
// than every page's initial load showing the same generic list while its
// actual content looks nothing like one.
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
  // .list-table (see css/style.css) is what hides this <table> on mobile in
  // favor of .mobile-list below — a shared class rather than an id-scoped
  // rule, since this same markup shape is now reused outside #dialsTableWrap/
  // #tableWrap too (see the page-loading skeleton in dials.html/clients.html/
  // profile.html).
  return `
    <table class="list-table">
      <tbody>${tableRows}</tbody>
    </table>
    <div class="mobile-list">${cards}</div>
  `;
}

// ---------------------------------------------------------------------------
// Full-page loading skeletons — one per page, each built out of the same
// .skeleton-bar building block above but shaped to match THAT page's own
// real layout (tabs bar for Dials, search toolbar for Clients, profile
// card + chart + upcoming events for Profile), rather than every page
// showing the same generic list while its own real shape is completely
// different. Used only by #pageLoadingSkeleton (see dials.html/
// clients.html/profile.html) — the one-time skeleton shown before the
// initial session/profile fetch resolves, distinct from skeletonListHtml's
// own per-reload use inside each page's own list-loading functions.
// ---------------------------------------------------------------------------

// Matches .topnav-bar's real shape (brand text, 3 nav links, name + role
// badge + logout button) — see js/auth.js's renderNav(), which is what
// actually fills #topnav, and only runs once the session/profile fetch
// resolves (same moment #pageLoadingOverlay gets hidden). Until then #topnav
// is genuinely empty, so without this placeholder reserving its height the
// real topnav-bar appears out of nowhere and pushes everything below it
// down the instant loading finishes — confirmed as a real bug (desktop
// only; .topnav-bar is already display:none on mobile via the existing
// html.is-mobile-device rule, so mobile never had this gap). Rendered as a
// sibling of #pageLoadingSkeleton, not inside it — the real .topnav-bar is
// full-width outside <main>'s own max-width/padding box, so nesting it
// inside .skeleton-page-content would both indent it wrong and double up
// padding that doesn't exist in the real stack.
export function skeletonTopnavHtml() {
  // min-height is a measured value, not a guess: .brand's "Waystation
  // Advisors" text renders at ~43px tall (the brand font's own default line
  // metrics run much taller than its 16px font-size would suggest), which
  // makes the real .topnav-bar ~68px tall including its 12px/12px padding —
  // confirmed via getBoundingClientRect() side-by-side against this exact
  // markup. Reproducing that from individually-guessed child bar heights
  // was unreliable (font metrics aren't predictable from font-size alone),
  // so the container height is pinned directly instead.
  return `
    <div class="topnav-bar" style="min-height:68px; box-sizing:border-box;">
      <span class="skeleton-bar" style="width:150px; height:16px;"></span>
      <div class="links">
        <span class="skeleton-bar" style="width:46px; height:14px;"></span>
        <span class="skeleton-bar" style="width:46px; height:14px;"></span>
        <span class="skeleton-bar" style="width:46px; height:14px;"></span>
      </div>
      <div class="who">
        <span class="skeleton-bar" style="width:90px; height:13px;"></span>
        <span class="skeleton-bar" style="width:60px; height:20px; border-radius:999px;"></span>
        <span class="skeleton-bar" style="width:72px; height:24px; border-radius:6px;"></span>
      </div>
    </div>`;
}

// Matches .page-header's real shape (dropdown toggle + title on the left,
// settings icon on the right — see css/style.css, identical markup shape on
// all 3 pages, only the <h1> text differs). Unlike the topnav-bar above,
// the real .page-header is static markup already sitting in the DOM at the
// right position — it's only invisible because #pageLoadingOverlay's opaque
// background sits on top of it (z-index 500, full viewport). This
// placeholder exists purely to reserve the exact same height so nothing
// shifts once the overlay is removed, not to stand in for missing data.
function skeletonPageHeaderHtml() {
  return `
    <div class="page-header">
      <div class="page-header-left">
        <span class="skeleton-bar" style="width:26px; height:26px; border-radius:6px;"></span>
        <span class="skeleton-bar" style="width:70px; height:20px;"></span>
      </div>
      <span class="skeleton-bar" style="width:30px; height:30px; border-radius:6px;"></span>
    </div>`;
}

// Pill-shaped placeholders matching .dial-tab's real shape (see
// css/style.css) — only Dials has a tabs bar, so only its own page skeleton
// needs this.
function skeletonTabsHtml() {
  const widths = [72, 96, 64, 104, 80];
  return `<div class="dials-tabs">${widths
    .map((w) => `<span class="skeleton-bar" style="width:${w}px; height:32px; border-radius:6px;"></span>`)
    .join("")}</div>`;
}

export function skeletonDialsPage() {
  return `
    ${skeletonPageHeaderHtml()}
    ${skeletonTabsHtml()}
    <div style="margin-top:16px;">
      ${skeletonListHtml({ rows: 5, columnWidths: ["55%", "65%", "45%", "50%", "70%"] })}
    </div>
  `;
}

// Search-bar + count-badge shaped placeholder matching .toolbar's real
// shape — only Clients has this row (Dials' tabs bar and Profile's card
// both replace it with their own thing).
function skeletonToolbarHtml() {
  return `
    <div class="toolbar">
      <span class="skeleton-bar" style="width:200px; height:34px; border-radius:6px;"></span>
      <span class="skeleton-bar" style="width:70px; height:14px;"></span>
    </div>`;
}

export function skeletonClientsPage() {
  return `
    ${skeletonPageHeaderHtml()}
    ${skeletonToolbarHtml()}
    ${skeletonListHtml({ rows: 6, columnWidths: ["55%", "60%", "45%", "40%"] })}
  `;
}

// Circular placeholder matching .profile-avatar's real 64px size — Dials/
// Clients cards use the smaller 28px contact-icon circles instead (see
// skeletonMobileCard above), so this is Profile's own shape, not a shared
// one.
function skeletonAvatarHtml() {
  return `<span class="skeleton-bar" style="width:64px; height:64px; border-radius:999px; display:block; margin-bottom:16px;"></span>`;
}

// Not attempting to be a literal preview of the real bar/line chart
// (.profile-chart) that eventually renders here — just enough of an
// uneven-bar-heights silhouette to read as "a chart is about to appear"
// rather than a stray row of identical rectangles.
function skeletonChartHtml() {
  const heights = [40, 65, 30, 80, 50, 70];
  return `
    <div class="profile-chart" style="display:flex; align-items:flex-end; gap:8px; height:90px;">
      ${heights.map((h) => `<span class="skeleton-bar" style="flex:1; height:${h}px; border-radius:4px 4px 0 0;"></span>`).join("")}
    </div>`;
}

// Matches .upcoming-event-row's real two-line shape (name, then a smaller
// meta line) inside the same .upcoming-events-box shell. skeleton-card
// reuses the same "never looks clickable" cursor override already defined
// for the list-row skeletons above, even though this isn't a <button>.
function skeletonUpcomingEventsHtml() {
  const nameWidths = [140, 108, 156];
  return `
    <div class="upcoming-events-box">
      ${nameWidths
        .map(
          (w) => `
        <div class="upcoming-event-row skeleton-card">
          <span class="skeleton-bar" style="width:${w}px; height:14px;"></span>
          <span class="skeleton-bar" style="width:100px; height:11px;"></span>
        </div>`
        )
        .join("")}
    </div>`;
}

export function skeletonProfilePage() {
  return `
    ${skeletonPageHeaderHtml()}
    <div class="profile-card">
      ${skeletonAvatarHtml()}
      <span class="skeleton-bar" style="width:150px; height:20px; display:block; margin-bottom:6px;"></span>
      <span class="skeleton-bar" style="width:90px; height:13px; display:block; margin-bottom:18px;"></span>
      <div class="profile-calls-section">
        <span class="skeleton-bar" style="width:180px; height:15px; display:block; margin-bottom:10px;"></span>
        ${skeletonChartHtml()}
      </div>
      <div class="profile-calls-section">
        <span class="skeleton-bar" style="width:140px; height:15px; display:block; margin-bottom:10px;"></span>
        ${skeletonUpcomingEventsHtml()}
      </div>
    </div>
  `;
}
