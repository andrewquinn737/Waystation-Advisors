// ---------------------------------------------------------------------------
// "Advanced" settings — 4th settings-gear item, every role AND every page
// (Dials/Clients/Profile all wire this the same way, same pattern as
// js/notifications.js's wireNotificationsToggle — one shared implementation,
// each page passes its own DOM elements/profile rather than this module
// assuming a specific page's global ids). Deliberately NOT gated by
// isAdmin/isTeamLead like Accounts visible/Sellers-Buyers are, since
// everything in here is a personal preference, not an admin/team-lead
// capability.
//
// Three rows: Personalized email, an on/off preference
// (profiles.personalized_email_enabled) plus free-text subject/body
// templates (personalized_email_subject/personalized_email_template) — see
// resolvePersonalizedEmailBody/resolvePersonalizedEmailSubject below.
// Personalized texting is the sms: equivalent — same on/off shape
// (profiles.personalized_texting_enabled) with a single free-text body
// template (personalized_texting_template, no subject — sms: has no
// subject line) — see resolvePersonalizedTextingBody below. Both rows' on/
// off toggles and editors are reachable from every page, but only Dials
// actually APPLIES either to its own instant-Email/Text icons (see
// contactActionIcons calls in js/dials.js) — that scope was explicit
// ("instead of instant email having the regular function in the dials
// section"), so Clients'/Profile's own icons are untouched even though the
// settings themselves are editable from anywhere.
//
// "My email is Gmail" (profiles.email_is_gmail) is a plain standalone
// toggle with no editor of its own — unlike the two template rows, this
// one's EFFECT (see setOwnEmailIsGmail's own comment in contactIcons.js)
// already applies app-wide the moment it's set, regardless of which page it
// was toggled from.
// ---------------------------------------------------------------------------

import { supabase } from "./supabaseClient.js";
import { showError } from "./auth.js";
import { setOwnEmailIsGmail } from "./contactIcons.js";

// opts: { profile, els, closePageHeaderMenu }
//   - profile: the signed-in profile row (mutated in place as settings
//     change, same as every other settings toggle in this app).
//   - els: the calling page's own element map — must include
//     menuAdvancedBtn, advancedSettingsPopup, advancedSettingsClose,
//     personalizedEmailRow, personalizedEmailToggle, useGmailForEmailRow,
//     useGmailForEmailToggle, personalizedEmailEditorPopup,
//     personalizedEmailEditorToggle, personalizedEmailSubjectInput,
//     personalizedEmailTextarea, personalizedEmailTokenCompany,
//     personalizedEmailTokenSeller, personalizedEmailError,
//     personalizedEmailEditorClose, personalizedTextingRow,
//     personalizedTextingToggle, personalizedTextingEditorPopup,
//     personalizedTextingEditorToggle, personalizedTextingTextarea,
//     personalizedTextingTokenCompany, personalizedTextingTokenSeller,
//     personalizedTextingError, personalizedTextingEditorClose — same ids
//     on every page that wires this (see dials.html/clients.html/
//     profile.html), so each page's own document.getElementById calls just
//     slot straight in here unchanged.
//   - closePageHeaderMenu: closes whatever triangle/settings menu is
//     currently open before showing the popup (see js/pageHeaderMenu.js).
export function wireAdvancedSettingsPopup({ profile, els, closePageHeaderMenu }) {
  els.menuAdvancedBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (closePageHeaderMenu) closePageHeaderMenu();
    renderPersonalizedEmailToggles();
    renderUseGmailForEmailToggle();
    renderPersonalizedTextingToggles();
    els.advancedSettingsPopup.classList.remove("hidden");
  });
  els.advancedSettingsClose.addEventListener("click", () => els.advancedSettingsPopup.classList.add("hidden"));
  els.advancedSettingsPopup.addEventListener("click", (e) => {
    if (e.target === els.advancedSettingsPopup) els.advancedSettingsClose.click();
  });

  // Keeps both switches (the Advanced-settings row's own, and the editor
  // popup's mirrored copy at the top of its text box) showing the same
  // state — either one can flip the SAME underlying preference.
  function renderPersonalizedEmailToggles() {
    const on = profile.personalized_email_enabled === true;
    [els.personalizedEmailToggle, els.personalizedEmailEditorToggle].forEach((el) => {
      el.classList.toggle("on", on);
      el.setAttribute("aria-checked", String(on));
    });
  }

  async function togglePersonalizedEmailEnabled(e) {
    e.stopPropagation(); // don't also trigger personalizedEmailRow's own click (which opens the editor)
    const next = !(profile.personalized_email_enabled === true);
    profile.personalized_email_enabled = next;
    renderPersonalizedEmailToggles();
    const { error } = await supabase.from("profiles").update({ personalized_email_enabled: next }).eq("id", profile.id);
    if (error) {
      console.error("Failed to update personalized_email_enabled", error);
      profile.personalized_email_enabled = !next;
      renderPersonalizedEmailToggles();
    }
  }
  els.personalizedEmailToggle.addEventListener("click", togglePersonalizedEmailEnabled);
  els.personalizedEmailEditorToggle.addEventListener("click", togglePersonalizedEmailEnabled);

  // sms: equivalent of the Personalized email toggle above — same shape,
  // one fewer field (no subject line).
  function renderPersonalizedTextingToggles() {
    const on = profile.personalized_texting_enabled === true;
    [els.personalizedTextingToggle, els.personalizedTextingEditorToggle].forEach((el) => {
      el.classList.toggle("on", on);
      el.setAttribute("aria-checked", String(on));
    });
  }

  async function togglePersonalizedTextingEnabled(e) {
    e.stopPropagation(); // don't also trigger personalizedTextingRow's own click (which opens the editor)
    const next = !(profile.personalized_texting_enabled === true);
    profile.personalized_texting_enabled = next;
    renderPersonalizedTextingToggles();
    const { error } = await supabase.from("profiles").update({ personalized_texting_enabled: next }).eq("id", profile.id);
    if (error) {
      console.error("Failed to update personalized_texting_enabled", error);
      profile.personalized_texting_enabled = !next;
      renderPersonalizedTextingToggles();
    }
  }
  els.personalizedTextingToggle.addEventListener("click", togglePersonalizedTextingEnabled);
  els.personalizedTextingEditorToggle.addEventListener("click", togglePersonalizedTextingEnabled);

  els.personalizedTextingRow.addEventListener("click", () => {
    els.personalizedTextingTextarea.value = profile.personalized_texting_template || "";
    renderPersonalizedTextingToggles();
    els.personalizedTextingError.classList.add("hidden");
    els.personalizedTextingEditorPopup.classList.remove("hidden");
  });

  async function savePersonalizedTextingField() {
    const bodyVal = els.personalizedTextingTextarea.value.trim() || null;
    if (bodyVal === (profile.personalized_texting_template || null)) return;
    const { error } = await supabase.from("profiles").update({ personalized_texting_template: bodyVal }).eq("id", profile.id);
    if (error) return showError(els.personalizedTextingError, error);
    profile.personalized_texting_template = bodyVal;
  }
  els.personalizedTextingTextarea.addEventListener("blur", savePersonalizedTextingField);

  els.personalizedTextingEditorClose.addEventListener("click", async () => {
    await savePersonalizedTextingField();
    els.personalizedTextingEditorPopup.classList.add("hidden");
  });
  els.personalizedTextingEditorPopup.addEventListener("click", (e) => {
    if (e.target === els.personalizedTextingEditorPopup) els.personalizedTextingEditorClose.click();
  });

  function renderUseGmailForEmailToggle() {
    const on = profile.email_is_gmail === true;
    els.useGmailForEmailToggle.classList.toggle("on", on);
    els.useGmailForEmailToggle.setAttribute("aria-checked", String(on));
  }

  // No editor to open here (unlike Personalized email's row) — the whole
  // row just flips the one setting it has. setOwnEmailIsGmail updates the
  // shared contactIcons.js module immediately so the very next "Email" tap
  // (on ANY page) already reflects the change, with no reload needed.
  els.useGmailForEmailRow.addEventListener("click", async () => {
    const next = !(profile.email_is_gmail === true);
    profile.email_is_gmail = next;
    renderUseGmailForEmailToggle();
    setOwnEmailIsGmail(next);
    const { error } = await supabase.from("profiles").update({ email_is_gmail: next }).eq("id", profile.id);
    if (error) {
      console.error("Failed to update email_is_gmail", error);
      profile.email_is_gmail = !next;
      renderUseGmailForEmailToggle();
      setOwnEmailIsGmail(!next);
    }
  });

  // Tapping the ROW (not the switch — see stopPropagation above) opens the
  // fuller editor, "over" the Advanced settings popup rather than replacing
  // it — see #personalizedEmailEditorPopup's own comment in dials.html for
  // why that works from plain DOM order with no extra z-index needed.
  els.personalizedEmailRow.addEventListener("click", () => {
    els.personalizedEmailSubjectInput.value = profile.personalized_email_subject || "";
    els.personalizedEmailTextarea.value = profile.personalized_email_template || "";
    renderPersonalizedEmailToggles();
    els.personalizedEmailError.classList.add("hidden");
    els.personalizedEmailEditorPopup.classList.remove("hidden");
  });

  // Saves both fields together in one update — simpler than tracking which
  // of the two changed, and blur/drag-insert on either one triggers it the
  // same way (see below).
  async function savePersonalizedEmailFields() {
    const subjectVal = els.personalizedEmailSubjectInput.value.trim() || null;
    const bodyVal = els.personalizedEmailTextarea.value.trim() || null;
    if (subjectVal === (profile.personalized_email_subject || null) && bodyVal === (profile.personalized_email_template || null)) return;
    const { error } = await supabase
      .from("profiles")
      .update({ personalized_email_subject: subjectVal, personalized_email_template: bodyVal })
      .eq("id", profile.id);
    if (error) return showError(els.personalizedEmailError, error);
    profile.personalized_email_subject = subjectVal;
    profile.personalized_email_template = bodyVal;
  }
  // Same blur-triggered autosave as the Call notes field elsewhere on the
  // Dials page (see flushCallNotes/wireCallNotesAutosave) — no separate
  // Save button.
  els.personalizedEmailSubjectInput.addEventListener("blur", savePersonalizedEmailFields);
  els.personalizedEmailTextarea.addEventListener("blur", savePersonalizedEmailFields);

  els.personalizedEmailEditorClose.addEventListener("click", async () => {
    await savePersonalizedEmailFields();
    els.personalizedEmailEditorPopup.classList.add("hidden");
  });
  els.personalizedEmailEditorPopup.addEventListener("click", (e) => {
    if (e.target === els.personalizedEmailEditorPopup) els.personalizedEmailEditorClose.click();
  });

  // (Company name)/(Seller name) tokens, drag-and-drop into whichever field
  // the drop lands on — no limit on how many times either can be inserted.
  // Plain literal-string substrings rather than a hidden token syntax,
  // since there's no rich-text rendering inside a plain text field/textarea
  // anyway — what you see IS exactly what gets substituted later (see
  // resolvePersonalizedEmailBody/resolvePersonalizedEmailSubject/
  // resolvePersonalizedTextingBody below). Shared between the Personalized
  // email editor (2 possible drop targets: subject + body) and the
  // Personalized texting editor (1: body only) — `onInserted` is whichever
  // editor's own save function, since the two editors persist to different
  // profile columns.
  function insertPersonalizedToken(label, target, onInserted) {
    // Inserted at wherever the target field's own cursor/selection
    // currently sits (replacing any selected range) — neither a plain text
    // input nor a textarea exposes a reliable pixel-to-character mapping
    // for "exactly where the pointer was released" the way a
    // contenteditable element would, so this is the standard, well-
    // understood way template editors handle a drag-to-insert onto a plain
    // field. Only trusted while the field is actually focused, though — an
    // UNFOCUSED field's selectionStart/End both report 0 (a real browser
    // quirk, not "no selection"), which would insert at the very START of
    // any existing text on a first-ever drag before ever clicking in;
    // falls back to the end in that case instead.
    const focused = document.activeElement === target;
    const start = focused ? target.selectionStart : target.value.length;
    const end = focused ? target.selectionEnd : target.value.length;
    target.value = target.value.slice(0, start) + label + target.value.slice(end);
    const newPos = start + label.length;
    target.focus();
    target.setSelectionRange(newPos, newPos);
    onInserted();
  }

  // Custom pointer-based drag (not native HTML5 drag-and-drop, which has no
  // real touch/mobile support in virtually any mobile browser) — same
  // long-press-then-drag technique already established in this app for
  // exactly this class of interaction, see wireMemberDrag in js/profile.js
  // (dragging a team member card between team boxes). LONG_PRESS_MS/
  // DRAG_CANCEL_PX below deliberately match that implementation's own
  // values.
  const TOKEN_LONG_PRESS_MS = 350;
  const TOKEN_DRAG_CANCEL_PX = 10;
  const tokenDragState = { token: null, pointerId: null, startX: 0, startY: 0, active: false, timer: null, ghost: null, offsetX: 0, offsetY: 0 };

  function cancelTokenLongPressTimer() {
    if (tokenDragState.timer) {
      clearTimeout(tokenDragState.timer);
      tokenDragState.timer = null;
    }
  }

  function startTokenDragVisuals(chip, e) {
    tokenDragState.active = true;
    const rect = chip.getBoundingClientRect();
    const ghost = chip.cloneNode(true);
    ghost.classList.add("personalized-email-drag-ghost");
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    document.body.appendChild(ghost);
    tokenDragState.ghost = ghost;
    tokenDragState.offsetX = e.clientX - rect.left;
    tokenDragState.offsetY = e.clientY - rect.top;
  }

  function moveTokenDragGhost(e) {
    if (!tokenDragState.ghost) return;
    tokenDragState.ghost.style.left = `${e.clientX - tokenDragState.offsetX}px`;
    tokenDragState.ghost.style.top = `${e.clientY - tokenDragState.offsetY}px`;
  }

  // `dropTargets` — the fields this chip can land on; `onInserted` — that
  // editor's own save function (see insertPersonalizedToken above).
  function wirePersonalizedEmailTokenDrag(chip, label, dropTargets, onInserted) {
    chip.addEventListener("pointerdown", (e) => {
      tokenDragState.token = label;
      tokenDragState.pointerId = e.pointerId;
      tokenDragState.startX = e.clientX;
      tokenDragState.startY = e.clientY;
      tokenDragState.active = false;
      cancelTokenLongPressTimer();
      tokenDragState.timer = setTimeout(() => {
        // Same reasoning as wireMemberDrag's own setPointerCapture call —
        // keeps pointermove/pointerup routed here even once the pointer
        // moves off the chip's own bounds (which is the whole point of
        // dragging it).
        if (chip.setPointerCapture) chip.setPointerCapture(e.pointerId);
        startTokenDragVisuals(chip, e);
      }, TOKEN_LONG_PRESS_MS);
    });

    chip.addEventListener("pointermove", (e) => {
      if (tokenDragState.token !== label) return;
      if (!tokenDragState.active) {
        const dx = e.clientX - tokenDragState.startX;
        const dy = e.clientY - tokenDragState.startY;
        if (Math.sqrt(dx * dx + dy * dy) > TOKEN_DRAG_CANCEL_PX) cancelTokenLongPressTimer();
        return;
      }
      e.preventDefault();
      moveTokenDragGhost(e);
    });

    const endDrag = (e) => {
      cancelTokenLongPressTimer();
      if (tokenDragState.token !== label) return;
      const wasActive = tokenDragState.active;
      if (tokenDragState.ghost) {
        tokenDragState.ghost.remove();
        tokenDragState.ghost = null;
      }
      tokenDragState.token = null;
      tokenDragState.active = false;
      if (!wasActive) return;
      // Whichever of dropTargets the pointer is actually over at release —
      // checked in array order, though real drop targets never overlap so
      // order doesn't matter in practice.
      const dropTarget = dropTargets.find((el) => {
        const rect = el.getBoundingClientRect();
        return e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      });
      if (dropTarget) insertPersonalizedToken(label, dropTarget, onInserted);
    };
    chip.addEventListener("pointerup", endDrag);
    chip.addEventListener("pointercancel", endDrag);
  }
  wirePersonalizedEmailTokenDrag(els.personalizedEmailTokenCompany, "(Company name)", [els.personalizedEmailSubjectInput, els.personalizedEmailTextarea], savePersonalizedEmailFields);
  wirePersonalizedEmailTokenDrag(els.personalizedEmailTokenSeller, "(Seller name)", [els.personalizedEmailSubjectInput, els.personalizedEmailTextarea], savePersonalizedEmailFields);
  wirePersonalizedEmailTokenDrag(els.personalizedTextingTokenCompany, "(Company name)", [els.personalizedTextingTextarea], savePersonalizedTextingField);
  wirePersonalizedEmailTokenDrag(els.personalizedTextingTokenSeller, "(Seller name)", [els.personalizedTextingTextarea], savePersonalizedTextingField);
}

// (Seller name) resolves to just the FIRST name — everything up to (not
// including) the first space in full_name — not the whole thing.
function firstNameOf(fullName) {
  return (fullName || "").trim().split(" ")[0];
}

function substitutePersonalizedTokens(text, dial) {
  return text.split("(Company name)").join(dial.company_name || "").split("(Seller name)").join(firstNameOf(dial.full_name));
}

// Applied wherever Dials builds an instant-Email link (see
// contactActionIcons/rfContact in js/contactIcons.js) — only Dials calls
// these (see the top-of-file comment for why). Returns null (regular
// mailto:, no pre-filled body) unless the signed-in user has both the
// toggle on AND an actual template saved. company_name/full_name come
// straight off the dial itself, so a placeholder a dial has no value for
// just becomes empty text rather than leaving the literal "(Company name)"
// in a sent email.
export function resolvePersonalizedEmailBody(profile, dial) {
  if (!profile.personalized_email_enabled || !profile.personalized_email_template) return null;
  return substitutePersonalizedTokens(profile.personalized_email_template, dial);
}

// Subject line is independent of the on/off toggle for the body — it's its
// own optional field (see #personalizedEmailSubjectInput), so this only
// requires the toggle itself plus an actual subject saved, same shape as
// resolvePersonalizedEmailBody just for the other field.
export function resolvePersonalizedEmailSubject(profile, dial) {
  if (!profile.personalized_email_enabled || !profile.personalized_email_subject) return null;
  return substitutePersonalizedTokens(profile.personalized_email_subject, dial);
}

// sms: equivalent of resolvePersonalizedEmailBody above — applied wherever
// Dials builds an instant-Text link (see contactActionIcons/rfContact/
// buildPhoneNumbersHTML in js/contactIcons.js). No subject counterpart —
// sms: has no subject line.
export function resolvePersonalizedTextingBody(profile, dial) {
  if (!profile.personalized_texting_enabled || !profile.personalized_texting_template) return null;
  return substitutePersonalizedTokens(profile.personalized_texting_template, dial);
}
