// Shared "quick contact" icons (text / call / email) — used by clients.js and
// dials.js, both in the detailed read-only field rows (rfContact) and in the
// compact list/card rows (contactActionIcons).

import { escapeHtml } from "./clientForm.js";

export const CONTACT_ICONS = {
  sms: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
  tel: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  mailto: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
};

// ---------------------------------------------------------------------------
// Which of the signed-in user's own mail accounts the "Email" instant-contact
// icon should try to send from. Set once at page load (see setOwnEmail() call
// in requireSession(), js/auth.js) from the signed-in profile's own `email`
// column — every page (Profile/Clients/Dials) shares this same module-scoped
// value rather than threading it through every single call site.
//
// There is no cross-provider way for a web page to choose which configured
// mail account (or which phone line, for tel:/sms:) the device actually
// sends from — that's controlled entirely by the OS/app's own default-account
// setting, with no override available to page content. Gmail is the one
// concrete exception: its own compose URL accepts an `authuser` hint that
// preselects a matching signed-in Google account instead of falling back to
// whichever one the Gmail app/site currently treats as default. So this is a
// best-effort upgrade that only kicks in when the signed-in user's own email
// is a Gmail address (gmail.com/googlemail.com, including Google Workspace
// domains that are Gmail-hosted isn't reliably detectable from the address
// alone, so those still fall back to plain mailto:); everyone else keeps the
// exact same mailto: link as before. Phone/text (tel:/sms:) have no Gmail-
// style equivalent on any platform, so those are unchanged.
// ---------------------------------------------------------------------------
let ownEmail = null;

export function setOwnEmail(email) {
  ownEmail = email || null;
}

function isGmailAddress(email) {
  return /@(gmail\.com|googlemail\.com)$/i.test(email || "");
}

// Builds the href for the "Email" instant-contact icon. Plain `mailto:` for
// everyone, except when the signed-in user's own profile email is a Gmail
// address — then this opens Gmail's own compose view instead, with
// `authuser` set to that address so Gmail preselects the matching account
// rather than whichever Google account happens to be default.
function buildEmailHref(targetEmail) {
  if (isGmailAddress(ownEmail)) {
    const params = new URLSearchParams({ view: "cm", fs: "1", to: targetEmail, authuser: ownEmail });
    return `https://mail.google.com/mail/?${params.toString()}`;
  }
  return `mailto:${targetEmail}`;
}

// Small pin icon shown next to a dial/client's location — opens that
// city/state in Google Maps in a new tab. Returns "" if there's no city/state
// to map. `extraClass` (optional) adds a modifier class for contexts that
// need slightly different positioning than the default (e.g. sitting in a
// flex row next to a "Location" field, vs. tucked inline after a header
// subtitle's text) — see .location-pin-link.pin-body-row in css/style.css.
export function locationPinLink(city, state, extraClass = "") {
  const loc = [city, state].filter(Boolean).join(", ");
  if (!loc) return "";
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc)}`;
  const cls = extraClass ? `location-pin-link ${extraClass}` : "location-pin-link";
  return `<a href="${url}" target="_blank" rel="noopener" class="${cls}" title="Open in Google Maps" onclick="event.stopPropagation()">${CONTACT_ICONS.pin}</a>`;
}

// Full labeled read-only row with quick-action icons (Timeline/Profile-style
// detail views). Only used in view mode — actions are hidden while editing.
export function rfContact(label, value, kind) {
  const v = value ? String(value) : "";
  const actionsHTML = v ? contactActionIcons(kind === "phone" ? { phone: v } : { email: v }) : "";
  return `
    <div class="readonly-field">
      <div class="rf-label">${escapeHtml(label)}</div>
      <div class="rf-value-row">
        <div class="rf-value ${v ? "" : "empty"}">${v ? escapeHtml(v) : "Not provided"}</div>
        ${actionsHTML}
      </div>
    </div>`;
}

// One phone number's own labeled row (used by buildPhoneNumbersHTML below) —
// same layout as rfContact but with a fixed "(Mobile)"/"(Company)" suffix
// instead of a left-hand label, since both numbers share one "Phone numbers"
// section instead of each getting their own readonly-field.
function phoneNumberRow(number, kind) {
  return `
    <div class="rf-value-row" style="margin-bottom: 8px;">
      <div class="rf-value">${escapeHtml(number)} <span class="help-text" style="display:inline;">(${kind})</span></div>
      ${contactActionIcons({ phone: number })}
    </div>`;
}

// Shared "Phone numbers" read-only section — shows whichever of
// mobile_phone/company_phone are present on `entity` (a dial OR a client;
// both use these same two column names), each with its own instant-contact
// icons. Mobile is still the one used everywhere else for instant call/text
// (list rows, cards) — this is only about what's displayed here.
export function buildPhoneNumbersHTML(entity) {
  const rows = [];
  if (entity.mobile_phone) rows.push(phoneNumberRow(entity.mobile_phone, "Mobile"));
  if (entity.company_phone) rows.push(phoneNumberRow(entity.company_phone, "Company"));
  return `
    <div class="readonly-field">
      <div class="rf-label">Phone numbers</div>
      ${rows.length ? rows.join("") : `<div class="rf-value empty">Not provided</div>`}
    </div>`;
}

// Compact icon-only cluster (no label), for list/card rows. `phone` gets a
// text + call icon; `email` gets a mail icon. Either can be omitted.
export function contactActionIcons({ phone, email } = {}) {
  const parts = [];
  if (phone) {
    parts.push(`<a class="contact-action-btn" href="sms:${escapeHtml(phone)}" title="Text">${CONTACT_ICONS.sms}</a>`);
    // contact-action-tel: hidden on desktop via CSS (html.is-desktop-device)
    // since a computer can't actually place a phone call through a tel: link.
    parts.push(`<a class="contact-action-btn contact-action-tel" href="tel:${escapeHtml(phone)}" title="Call">${CONTACT_ICONS.tel}</a>`);
  }
  if (email) {
    parts.push(`<a class="contact-action-btn" href="${escapeHtml(buildEmailHref(email))}" title="Email">${CONTACT_ICONS.mailto}</a>`);
  }
  return parts.length ? `<div class="contact-actions">${parts.join("")}</div>` : "";
}

// Wires up stopPropagation on any contact-action-btn links inside `container`
// so tapping "call"/"text"/"email" inside a clickable list row doesn't also
// trigger the row's own click handler (which opens the detail view).
export function stopContactActionPropagation(container) {
  container.querySelectorAll(".contact-action-btn").forEach((a) => {
    a.addEventListener("click", (e) => e.stopPropagation());
  });
}
