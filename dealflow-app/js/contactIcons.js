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
// concrete exception: its own compose URL (a real https://mail.google.com/
// link, not a mailto: — this is what lets it sidestep the OS's mail-app
// picker entirely) accepts an `authuser` hint that preselects a matching
// signed-in Google account instead of falling back to whichever one the
// Gmail app/site currently treats as default. So this is a best-effort
// upgrade that only kicks in for a Gmail address. Auto-detected for a plain
// gmail.com/googlemail.com address; a Google Workspace domain that's
// actually Gmail-hosted behind a custom work address isn't reliably
// detectable from the address string alone, so that case instead relies on
// the signed-in user explicitly flagging it (profiles.email_is_gmail, set
// via Dials' Advanced settings — see setOwnEmailIsGmail()/its call site in
// js/auth.js). Everyone else (including every non-Gmail provider, e.g.
// Yahoo/Outlook — there's no equivalent trick for those) keeps the exact
// same mailto: link as before. Phone/text (tel:/sms:) have no Gmail-style
// equivalent on any platform, so those are unchanged.
// ---------------------------------------------------------------------------
let ownEmail = null;
// Three states, not a boolean — null means the user has never touched the
// "My email is Gmail" toggle (auto-detect from the address applies, see
// isGmailAddress below); true/false is their own explicit override once
// they have, and wins either direction. Confirmed as a real bug: coercing
// this to a plain boolean (via !!flag) made "explicitly off" indistinguishable
// from "never set", so a user with a genuine gmail.com/googlemail.com
// address had no way to turn OFF the Gmail-compose routing at all — the
// auto-detect regex kept firing regardless of the toggle, since the old
// isGmailAddress() only ever OR'd the flag in (could force Gmail on for a
// non-Gmail-looking address, but could never force it off for one that
// genuinely is Gmail-looking).
let ownEmailIsGmail = null;

export function setOwnEmail(email) {
  ownEmail = email || null;
}

export function setOwnEmailIsGmail(flag) {
  ownEmailIsGmail = flag === true || flag === false ? flag : null;
}

// Explicit override (true or false) always wins over the address itself;
// only when the user has never set the toggle (null) does this fall back
// to guessing from the address.
function isGmailAddress(email) {
  if (ownEmailIsGmail === true) return true;
  if (ownEmailIsGmail === false) return false;
  return /@(gmail\.com|googlemail\.com)$/i.test(email || "");
}

// Builds the href for the "Email" instant-contact icon. Plain `mailto:` for
// everyone, except when the signed-in user's own profile email is a Gmail
// address — then this opens Gmail's own compose view instead, with
// `authuser` set to that address so Gmail preselects the matching account
// rather than whichever Google account happens to be default. `body`/
// `subject` (both optional) — see js/dials.js's "Personalized email"
// feature: pre-fills the mail app's message body and/or subject line with
// that dial's own resolved template text, instead of leaving them blank.
// Omitted everywhere else. Gmail's compose URL names the subject param `su`
// rather than `subject` — everything else about it is identical.
//
// Both are percent-encoded by hand (encodeURIComponent, "%20" for a space)
// rather than via URLSearchParams — real, confirmed bug: URLSearchParams
// encodes a space as "+", which is correct HTML form-encoding but wrong for
// a mailto: URI (RFC 6068), where mail clients treat "+" as a literal plus
// sign rather than decoding it back to a space, so every space in the
// template showed up as a literal "+" in the composed message.
function buildEmailHref(targetEmail, body, subject) {
  const bodyParam = body ? `body=${encodeURIComponent(body)}` : "";
  if (isGmailAddress(ownEmail)) {
    const params = new URLSearchParams({ view: "cm", fs: "1", to: targetEmail, authuser: ownEmail });
    const subjectParam = subject ? `su=${encodeURIComponent(subject)}` : "";
    const extra = [subjectParam, bodyParam].filter(Boolean).join("&");
    return `https://mail.google.com/mail/?${params.toString()}${extra ? `&${extra}` : ""}`;
  }
  const subjectParam = subject ? `subject=${encodeURIComponent(subject)}` : "";
  const query = [subjectParam, bodyParam].filter(Boolean).join("&");
  return `mailto:${targetEmail}${query ? `?${query}` : ""}`;
}

// Builds the href for the "Text" instant-contact icon. Plain `sms:` for
// everyone — unlike buildEmailHref there's no Gmail-style provider hook for
// SMS on any platform, so this only ever varies by whether there's a
// pre-filled message body (see js/dials.js's "Personalized texting" advanced
// setting, the sms: equivalent of Personalized email). `?body=` is the
// widely-supported de-facto convention both iOS Messages and Android honor
// (there's no RFC for sms: the way mailto: has RFC 6068). Same hand-rolled
// encodeURIComponent as buildEmailHref, not URLSearchParams — the same "+"-
// for-space bug would otherwise apply here too.
function buildSmsHref(phone, body) {
  const bodyParam = body ? `?body=${encodeURIComponent(body)}` : "";
  return `sms:${phone}${bodyParam}`;
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
// `extra` (optional) is raw HTML appended inside the same .contact-actions
// wrapper as the icons, after them — used by js/dials.js to add its own
// per-contact-method "contacted today" check circle without this shared
// module needing to know anything about that Dials-only feature. Every
// existing caller omits it, so output is unchanged for them.
// `personalizedEmailBody`/`personalizedEmailSubject` (optional, email kind
// only) / `personalizedTextingBody` (optional, phone kind only) — see
// contactActionIcons' own comment.
export function rfContact(label, value, kind, extra = "", personalizedEmailBody, personalizedEmailSubject, personalizedTextingBody) {
  const v = value ? String(value) : "";
  const actionsHTML = v
    ? contactActionIcons(kind === "phone" ? { phone: v, extra, personalizedTextingBody } : { email: v, extra, personalizedEmailBody, personalizedEmailSubject })
    : "";
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
// section instead of each getting their own readonly-field. `extra` — see
// rfContact's comment above. `personalizedTextingBody` (optional) — same
// resolved text for either number (the template doesn't vary by which phone
// it's sent to), see buildPhoneNumbersHTML's own comment.
function phoneNumberRow(number, kind, extra = "", personalizedTextingBody) {
  return `
    <div class="rf-value-row" style="margin-bottom: 8px;">
      <div class="rf-value">${escapeHtml(number)} <span class="help-text" style="display:inline;">(${kind})</span></div>
      ${contactActionIcons({ phone: number, extra, personalizedTextingBody })}
    </div>`;
}

// Shared "Phone numbers" read-only section — shows whichever of
// mobile_phone/company_phone are present on `entity` (a dial OR a client;
// both use these same two column names), each with its own instant-contact
// icons. Mobile is still the one used everywhere else for instant call/text
// (list rows, cards) — this is only about what's displayed here. `extraFor`
// (optional) — see rfContact's comment on `extra`; called once per present
// phone kind ("mobile"/"company") so a caller can give each its own extra
// HTML (js/dials.js uses this for its per-method check circle).
// `personalizedTextingBody` (optional) — see js/dials.js's "Personalized
// texting" advanced setting: when the signed-in user has it turned on,
// this is that dial's own resolved template text, pre-filling the Text
// icon's message body on BOTH numbers (mobile and company) instead of
// leaving it blank. Omitted everywhere else, same as
// personalizedEmailBody/-Subject on rfContact above.
export function buildPhoneNumbersHTML(entity, extraFor, personalizedTextingBody) {
  const rows = [];
  if (entity.mobile_phone) rows.push(phoneNumberRow(entity.mobile_phone, "Mobile", extraFor ? extraFor("mobile") : "", personalizedTextingBody));
  if (entity.company_phone) rows.push(phoneNumberRow(entity.company_phone, "Company", extraFor ? extraFor("company") : "", personalizedTextingBody));
  return `
    <div class="readonly-field">
      <div class="rf-label">Phone numbers</div>
      ${rows.length ? rows.join("") : `<div class="rf-value empty">Not provided</div>`}
    </div>`;
}

// Compact icon-only cluster (no label), for list/card rows. `phone` gets a
// text + call icon; `email` gets a mail icon. Either can be omitted. `extra`
// — see rfContact's comment above; only ever appended when at least one icon
// is actually rendered, since there's nothing to attach it to otherwise.
// `linkedin` (optional) is a fallback, not a fourth icon: only rendered when
// there's neither a phone NOR an email to instant-contact with at all, so a
// list row with nothing else still gets ONE quick action instead of an empty
// spot — never shown alongside a real phone/email icon. Same "no protocol"
// tolerance as rfWebsite (js/dials.js) — a bare "linkedin.com/in/..." value
// still gets a working link. `personalizedEmailBody`/`personalizedEmailSubject`
// (both optional) — see js/dials.js's "Personalized email" advanced setting:
// when the signed-in user has it turned on, these are that dial's own
// resolved template text (placeholders already substituted), pre-filling
// the mail app's message body and/or subject line instead of leaving them
// blank. `personalizedTextingBody` (optional) is the sms: equivalent, from
// the "Personalized texting" advanced setting — pre-fills the Text icon's
// message body the same way. Every other caller (Clients, and Dials' own
// detail-modal phone rows) omits these, so their output is unchanged.
export function contactActionIcons({ phone, email, linkedin, personalizedEmailBody, personalizedEmailSubject, personalizedTextingBody, extra = "" } = {}) {
  const parts = [];
  if (phone) {
    parts.push(`<a class="contact-action-btn" href="${escapeHtml(buildSmsHref(phone, personalizedTextingBody))}" title="Text">${CONTACT_ICONS.sms}</a>`);
    // contact-action-tel: hidden on desktop via CSS (html.is-desktop-device)
    // since a computer can't actually place a phone call through a tel: link.
    parts.push(`<a class="contact-action-btn contact-action-tel" href="tel:${escapeHtml(phone)}" title="Call">${CONTACT_ICONS.tel}</a>`);
  }
  if (email) {
    parts.push(
      `<a class="contact-action-btn" href="${escapeHtml(buildEmailHref(email, personalizedEmailBody, personalizedEmailSubject))}" title="Email">${CONTACT_ICONS.mailto}</a>`
    );
  }
  if (!phone && !email && linkedin) {
    const href = /^https?:\/\//i.test(linkedin) ? linkedin : `https://${linkedin}`;
    // The LinkedIn wordmark's own lowercase "in" lettermark, as plain text
    // rather than a hand-drawn SVG — more recognizable than an invented
    // glyph would be, and nothing to get subtly wrong.
    parts.push(`<a class="contact-action-btn" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="LinkedIn"><span class="linkedin-glyph">in</span></a>`);
  }
  return parts.length ? `<div class="contact-actions">${parts.join("")}${extra}</div>` : "";
}

// Wires up stopPropagation on any contact-action-btn links inside `container`
// so tapping "call"/"text"/"email" inside a clickable list row doesn't also
// trigger the row's own click handler (which opens the detail view).
export function stopContactActionPropagation(container) {
  container.querySelectorAll(".contact-action-btn").forEach((a) => {
    a.addEventListener("click", (e) => e.stopPropagation());
  });
}
