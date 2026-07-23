import { supabase } from "./supabaseClient.js";
import { requireSession, showError, signOut } from "./auth.js";
import { wirePageHeaderMenu, closeAllPageHeaderMenus } from "./pageHeaderMenu.js";
import { contactActionIcons, stopContactActionPropagation } from "./contactIcons.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile } = session;

const els = {
  errorBox: document.getElementById("errorBox"),
  pageMenuToggle: document.getElementById("pageMenuToggle"),
  pageHeaderMenu: document.getElementById("pageHeaderMenu"),
  menuEditProfileBtn: document.getElementById("menuEditProfileBtn"),
  menuCallsViewBtn: document.getElementById("menuCallsViewBtn"),
  avatarFileInput: document.getElementById("avatarFileInput"),
  avatarInitials: document.getElementById("avatarInitials"),
  profileName: document.getElementById("profileName"),
  profileRole: document.getElementById("profileRole"),
  profilePhone: document.getElementById("profilePhone"),
  profileEmail: document.getElementById("profileEmail"),
  outreachCallsSection: document.getElementById("outreachCallsSection"),
  introCallsSection: document.getElementById("introCallsSection"),
  callsThisWeekText: document.getElementById("callsThisWeekText"),
  callsChart: document.getElementById("callsChart"),
  introCallsThisWeekText: document.getElementById("introCallsThisWeekText"),
  introCallsChart: document.getElementById("introCallsChart"),
  teamsBtn: document.getElementById("teamsBtn"),
  teamsModal: document.getElementById("teamsModal"),
  teamsCloseBtn: document.getElementById("teamsCloseBtn"),
  teamsAddBtn: document.getElementById("teamsAddBtn"),
  teamsEditBtn: document.getElementById("teamsEditBtn"),
  teamsAddMenu: document.getElementById("teamsAddMenu"),
  teamsAddAccountBtn: document.getElementById("teamsAddAccountBtn"),
  teamsAddTeamBtn: document.getElementById("teamsAddTeamBtn"),
  teamsWrap: document.getElementById("teamsWrap"),
  profileSignOutBtn: document.getElementById("profileSignOutBtn"),
  addAccountModal: document.getElementById("addAccountModal"),
  newAccountFirstName: document.getElementById("newAccountFirstName"),
  newAccountLastName: document.getElementById("newAccountLastName"),
  newAccountEmailError: document.getElementById("newAccountEmailError"),
  addAccountError: document.getElementById("addAccountError"),
  newAccountPhone: document.getElementById("newAccountPhone"),
  newAccountEmail: document.getElementById("newAccountEmail"),
  newAccountPassword: document.getElementById("newAccountPassword"),
  addAccountCreateBtn: document.getElementById("addAccountCreateBtn"),
  addAccountCancelBtn: document.getElementById("addAccountCancelBtn"),
  addTeamModal: document.getElementById("addTeamModal"),
  addTeamError: document.getElementById("addTeamError"),
  newTeamNameInput: document.getElementById("newTeamNameInput"),
  addTeamCreateBtn: document.getElementById("addTeamCreateBtn"),
  addTeamCancelBtn: document.getElementById("addTeamCancelBtn"),
  confirmDeleteTeamModal: document.getElementById("confirmDeleteTeamModal"),
  confirmDeleteAccountModal: document.getElementById("confirmDeleteAccountModal"),
};

// Generic "are you sure" confirm popup wiring — same pattern as js/dials.js's
// openConfirmModal, duplicated locally rather than shared since these two
// modules don't otherwise import from each other.
function openConfirmModal(modalEl, yesId, noId, onConfirm, onClose) {
  modalEl.classList.remove("hidden");
  const yesBtn = document.getElementById(yesId);
  const noBtn = document.getElementById(noId);
  const cleanup = () => {
    modalEl.classList.add("hidden");
    yesBtn.removeEventListener("click", onYes);
    noBtn.removeEventListener("click", onNo);
  };
  const onYes = () => {
    cleanup();
    onConfirm();
  };
  const onNo = () => {
    cleanup();
    if (onClose) onClose();
  };
  yesBtn.addEventListener("click", onYes);
  noBtn.addEventListener("click", onNo);
}

function initials(name) {
  return (name || "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("") || "?";
}

// Shows the uploaded photo if there is one (profile.avatar_url), otherwise
// falls back to the initials circle exactly as before — see
// handleAvatarFileSelected() below for how avatar_url gets set.
function renderAvatar() {
  if (profile.avatar_url) {
    els.avatarInitials.innerHTML = `<img src="${profile.avatar_url}" alt="" />`;
  } else {
    els.avatarInitials.textContent = initials(profile.full_name);
  }
}

function renderProfileHeader() {
  els.profileName.textContent = profile.full_name;
  els.profileRole.textContent = profile.role === "admin" ? "Admin" : "Intern";
  renderAvatar();

  // Own account's phone + email, right below the listed position (role) and
  // above the weekly call-count section. Either line is simply omitted if
  // that field isn't on file (e.g. older accounts created before phone was
  // required at signup).
  if (profile.phone) {
    els.profilePhone.textContent = profile.phone;
    els.profilePhone.classList.remove("hidden");
  } else {
    els.profilePhone.classList.add("hidden");
  }
  if (profile.email) {
    els.profileEmail.textContent = profile.email;
    els.profileEmail.classList.remove("hidden");
  } else {
    els.profileEmail.classList.add("hidden");
  }
}
renderProfileHeader();

// ---------------------------------------------------------------------------
// Profile edit mode — "Edit" in the header triangle dropdown swaps the name/
// phone/email display elements for text inputs (same input-swap idiom as
// startRenameTeam() below); pressing "Edit" again, or clicking anywhere else
// on the page, commits whatever was typed back to the account and reverts to
// plain text. The avatar circle also becomes clickable (see
// handleAvatarFileSelected) for exactly as long as edit mode is on.
// ---------------------------------------------------------------------------
let profileEditMode = false;
let profileEditInputs = null; // { nameInput, phoneInput, emailInput } while editing

function openAvatarPicker() {
  if (!profileEditMode) return;
  els.avatarFileInput.click();
}
els.avatarInitials.addEventListener("click", openAvatarPicker);

function enterProfileEditMode() {
  if (profileEditMode) return;
  profileEditMode = true;
  els.avatarInitials.classList.add("editable");

  const nameInput = document.createElement("input");
  nameInput.className = "profile-edit-input profile-edit-name";
  nameInput.value = profile.full_name || "";
  nameInput.placeholder = "Name";
  els.profileName.replaceWith(nameInput);

  const phoneInput = document.createElement("input");
  phoneInput.type = "tel";
  phoneInput.className = "profile-edit-input";
  phoneInput.value = profile.phone || "";
  phoneInput.placeholder = "Phone number";
  els.profilePhone.classList.remove("hidden");
  els.profilePhone.replaceWith(phoneInput);

  const emailInput = document.createElement("input");
  emailInput.type = "email";
  emailInput.className = "profile-edit-input";
  emailInput.value = profile.email || "";
  emailInput.placeholder = "Email";
  els.profileEmail.classList.remove("hidden");
  els.profileEmail.replaceWith(emailInput);

  profileEditInputs = { nameInput, phoneInput, emailInput };
  nameInput.focus();
  nameInput.select();
}

async function exitProfileEditMode() {
  if (!profileEditMode) return;
  profileEditMode = false;
  els.avatarInitials.classList.remove("editable");
  const { nameInput, phoneInput, emailInput } = profileEditInputs;
  profileEditInputs = null;

  const newName = nameInput.value.trim() || profile.full_name;
  const newPhone = phoneInput.value.trim();
  const newEmail = emailInput.value.trim();
  nameInput.replaceWith(els.profileName);
  phoneInput.replaceWith(els.profilePhone);
  emailInput.replaceWith(els.profileEmail);

  const changed = newName !== profile.full_name || newPhone !== (profile.phone || "") || newEmail !== (profile.email || "");
  if (changed) {
    const { error } = await supabase
      .from("profiles")
      .update({ full_name: newName, phone: newPhone || null, email: newEmail || null })
      .eq("id", profile.id);
    if (error) {
      showError(els.errorBox, error);
    } else {
      profile.full_name = newName;
      profile.phone = newPhone;
      profile.email = newEmail;
    }
  }
  renderProfileHeader();
}

els.menuEditProfileBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  closeAllPageHeaderMenus();
  if (profileEditMode) exitProfileEditMode();
  else enterProfileEditMode();
});

// Clicking anywhere outside the profile card while editing also commits +
// exits — same "tap outside" idiom used by Dials' select mode.
document.addEventListener("click", (e) => {
  if (!profileEditMode) return;
  if (e.target.closest(".profile-card") || e.target.closest("#pageHeaderMenu") || e.target.closest("#pageMenuToggle")) return;
  exitProfileEditMode();
});

// ---------------------------------------------------------------------------
// Avatar upload — stored in the public "avatars" Storage bucket at
// "<profile id>/avatar.<ext>" (see supabase/schema.sql), one file per
// account (upsert overwrites the previous photo). profiles.avatar_url just
// caches the public URL (with a cache-busting query string so a re-upload
// shows immediately instead of the browser serving a stale cached image).
// ---------------------------------------------------------------------------
els.avatarFileInput.addEventListener("change", async () => {
  const file = els.avatarFileInput.files?.[0];
  els.avatarFileInput.value = "";
  if (!file) return;

  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${profile.id}/avatar.${ext}`;
  const { error: upErr } = await supabase.storage.from("avatars").upload(path, file, {
    upsert: true,
    contentType: file.type || "image/jpeg",
  });
  if (upErr) return showError(els.errorBox, upErr);

  const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
  const avatar_url = `${pub.publicUrl}?t=${Date.now()}`;
  const { error: updErr } = await supabase.from("profiles").update({ avatar_url }).eq("id", profile.id);
  if (updErr) return showError(els.errorBox, updErr);

  profile.avatar_url = avatar_url;
  renderAvatar();
});

// ---------------------------------------------------------------------------
// Outreach calls / Intro calls toggle — the header menu's second option.
// Defaults to "Outreach calls" (the existing weekly people-called chart);
// clicking it switches the label to "Intro calls" and swaps in a separate
// tracker (loadIntroCallsChart, built the first time it's shown); clicking
// again switches back. Purely a view toggle — nothing is persisted, so it
// always starts back on Outreach calls next time the page loads.
// ---------------------------------------------------------------------------
let introCallsChartLoaded = false;

els.menuCallsViewBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  closeAllPageHeaderMenus();
  const showingOutreach = els.menuCallsViewBtn.dataset.view === "outreach";
  const label = els.menuCallsViewBtn.querySelector(".menu-item-label");
  if (showingOutreach) {
    els.menuCallsViewBtn.dataset.view = "intro";
    label.textContent = "Intro calls";
    els.outreachCallsSection.classList.add("hidden");
    els.introCallsSection.classList.remove("hidden");
    if (!introCallsChartLoaded) {
      introCallsChartLoaded = true;
      loadIntroCallsChart();
    }
  } else {
    els.menuCallsViewBtn.dataset.view = "outreach";
    label.textContent = "Outreach calls";
    els.introCallsSection.classList.add("hidden");
    els.outreachCallsSection.classList.remove("hidden");
  }
});

// ---------------------------------------------------------------------------
// Teams popup — Admins + Unassigned interns are virtual groups (derived from
// role='admin' / team_id is null, not real rows), and admins can create any
// number of named teams in between (the `teams` table). See the ADMIN ROLE /
// TEAMS section of supabase/schema.sql for the underlying columns/RLS.
// ---------------------------------------------------------------------------
const ADMINS_KEY = "admins";
const UNASSIGNED_KEY = "unassigned";

let allMembers = []; // every profiles row
let customTeams = []; // every teams row (sort_order asc)
let teamMembersByGroup = {}; // groupKey -> members[]
let isAdmin = false;
let editMode = false;
// Group keys the user has explicitly collapsed — see renderTeams() and the
// accordion-header click handler. A group not in this set renders open, so
// entering/exiting edit mode (which re-renders) no longer resets everything
// back to "only the first section open". Cleared to empty (i.e. everything
// open) each time the Teams popup is freshly opened via els.teamsBtn.
let closedGroupKeys = new Set();
// profile_id -> temp password string, admin-only (RLS on profile_temp_passwords
// restricts select to admins — see supabase/schema.sql). Populated in
// loadTeams(); non-admins simply get an empty result from the query, no error.
let tempPasswordsByMemberId = {};
// Which members currently have their stored temp password revealed inline
// (see memberCardHTML / toggleTempPasswordReveal) — a Set of profile ids,
// persisted across re-renders the same way closedGroupKeys is.
let revealedPasswordMemberIds = new Set();

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function memberPositionLabel(m) {
  return m.role === "admin" ? "Admin" : "Intern";
}

// Which group (key) a given profile row currently belongs to. Admins always
// show under the virtual Admins group regardless of team_id; everyone else
// shows under their team_id's group, or Unassigned interns if that's null
// (or points at a team that no longer exists).
function groupKeyForMember(m) {
  if (m.role === "admin") return ADMINS_KEY;
  if (m.team_id && customTeams.some((t) => t.id === m.team_id)) return m.team_id;
  return UNASSIGNED_KEY;
}

// Admins first, then every custom team (in sort_order), then Unassigned
// interns last — a newly-created team lands right before Unassigned (see
// createNewTeam()), matching "between the last listed team and unassigned
// interns".
function buildGroupDefs() {
  return [
    { key: ADMINS_KEY, label: "Admins", locked: true },
    ...customTeams.map((t) => ({ key: t.id, label: t.name, locked: false })),
    { key: UNASSIGNED_KEY, label: "Unassigned interns", locked: true },
  ];
}

async function loadTeams() {
  const [{ data: profiles, error: profErr }, { data: teamsData, error: teamsErr }, { data: tempPwData }] = await Promise.all([
    supabase.from("profiles").select("id, full_name, role, phone, email, team_id, avatar_url").order("full_name", { ascending: true }),
    supabase.from("teams").select("*").order("sort_order", { ascending: true }),
    // Non-admins are simply denied by RLS here and get back an empty array
    // (or an error we can safely ignore) rather than blocking the rest of
    // Teams from loading — so no error-checking on this one.
    supabase.from("profile_temp_passwords").select("profile_id, temp_password"),
  ]);
  if (profErr) return showError(els.errorBox, profErr);
  if (teamsErr) return showError(els.errorBox, teamsErr);
  tempPasswordsByMemberId = {};
  (tempPwData || []).forEach((row) => {
    tempPasswordsByMemberId[row.profile_id] = row.temp_password;
  });

  allMembers = profiles || [];
  customTeams = teamsData || [];

  // Recompute from the freshly-loaded data (not the possibly-stale session
  // profile) so an admin who just got promoted/demoted sees the +/edit
  // controls appear/disappear without having to reload the whole page.
  const me = allMembers.find((m) => m.id === profile.id);
  isAdmin = me?.role === "admin";
  els.teamsAddBtn.classList.toggle("hidden", !isAdmin);
  els.teamsEditBtn.classList.toggle("hidden", !isAdmin);
  if (!isAdmin) editMode = false;

  teamMembersByGroup = {};
  buildGroupDefs().forEach((g) => (teamMembersByGroup[g.key] = []));
  allMembers.forEach((m) => {
    teamMembersByGroup[groupKeyForMember(m)].push(m);
  });
  renderTeams();
}

function renderTeams() {
  const groups = buildGroupDefs();
  els.teamsEditBtn.classList.toggle("active", editMode);

  els.teamsWrap.innerHTML = groups
    .map((g) => {
      const members = teamMembersByGroup[g.key] || [];
      const nameHTML =
        editMode && !g.locked
          ? `<span class="team-group-name renamable" data-team-id="${g.key}">${escapeHtml(g.label)}</span>`
          : `<span class="team-group-name">${escapeHtml(g.label)}</span>`;
      // Open/closed state persists across re-renders (entering/exiting edit
      // mode, drag-and-drop, renames, etc.) via closedGroupKeys — a group is
      // only closed if the user explicitly collapsed it (see the
      // accordion-header click handler below). Groups never touched (or
      // newly created) default to open. Opening the Teams popup fresh always
      // clears closedGroupKeys first (see els.teamsBtn's click handler).
      return `
      <div class="accordion-section team-group ${closedGroupKeys.has(g.key) ? "" : "open"}" data-group="${g.key}">
        <div class="accordion-header">
          <span class="team-group-name-wrap">${nameHTML} <span class="team-group-count">(${members.length})</span></span>
          <div class="accordion-header-right">
            ${editMode && !g.locked ? `<button type="button" class="team-trash-btn" data-team-id="${g.key}" title="Delete team">&#128465;</button>` : ""}
            <span class="chevron">&#9662;</span>
          </div>
        </div>
        <div class="accordion-body team-group-body">
          ${
            members.length
              ? `<div class="team-member-list">${members.map(memberCardHTML).join("")}</div>`
              : `<div class="empty-state">No one here yet.</div>`
          }
        </div>
      </div>`;
    })
    .join("");

  els.teamsWrap.querySelectorAll(".accordion-header").forEach((header) => {
    header.addEventListener("click", (e) => {
      if (e.target.closest(".team-group-name.renamable") || e.target.closest(".team-trash-btn")) return;
      const section = header.parentElement;
      const nowOpen = section.classList.toggle("open");
      const key = section.dataset.group;
      if (key) {
        if (nowOpen) closedGroupKeys.delete(key);
        else closedGroupKeys.add(key);
      }
    });
  });

  els.teamsWrap.querySelectorAll(".team-group-name.renamable").forEach((nameEl) => {
    nameEl.addEventListener("click", (e) => {
      e.stopPropagation();
      startRenameTeam(nameEl);
    });
  });
  els.teamsWrap.querySelectorAll(".team-trash-btn[data-team-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleDeleteTeam(btn.dataset.teamId);
    });
  });

  els.teamsWrap.querySelectorAll(".team-member-card").forEach((card) => {
    const memberId = card.dataset.memberId;
    card.addEventListener("click", () => {
      if (memberDragState.suppressClick) {
        memberDragState.suppressClick = false;
        return;
      }
      // While editMode is on, the card's right side shows a delete-account
      // trash icon instead of the contact-actions icons — expanding phone/
      // email here would just have to be immediately collapsed again to see
      // that icon, so the expand/collapse gesture is disabled for the
      // duration of edit mode instead.
      if (editMode) return;
      const member = allMembers.find((m) => m.id === memberId);
      if (member) toggleMemberDetail(card, member);
    });
    if (isAdmin) wireMemberDrag(card, memberId);
  });

  els.teamsWrap.querySelectorAll(".position-toggle").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePositionMenu(el);
    });
  });
  els.teamsWrap.querySelectorAll(".position-option").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = btn.closest(".position-menu");
      moveMemberToGroup(menu.dataset.memberId, btn.dataset.role === "admin" ? ADMINS_KEY : UNASSIGNED_KEY);
    });
  });
  els.teamsWrap.querySelectorAll(".member-trash-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleDeleteAccount(btn.dataset.memberId, btn.dataset.memberName);
    });
  });
  els.teamsWrap.querySelectorAll(".temp-pw-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wrap = btn.closest(".team-member-card-wrap");
      toggleTempPasswordReveal(wrap, btn.dataset.memberId);
    });
  });

  stopContactActionPropagation(els.teamsWrap);
}

function memberCardHTML(m) {
  const isMemberAdmin = m.role === "admin";
  const positionLabel = memberPositionLabel(m);
  const positionHTML = isAdmin
    ? `
    <div class="mc-sub-wrap">
      <span class="mc-sub position-toggle" data-member-id="${m.id}">${escapeHtml(positionLabel)}</span>
      <div class="position-menu hidden" data-member-id="${m.id}">
        <button type="button" class="position-option" data-role="intern">Intern</button>
        <button type="button" class="position-option" data-role="admin">Admin</button>
      </div>
    </div>`
    : `<div class="mc-sub">${escapeHtml(positionLabel)}</div>`;

  const rightHTML =
    editMode && !isMemberAdmin
      ? `<button type="button" class="team-trash-btn member-trash-btn" data-member-id="${m.id}" data-member-name="${escapeHtml(m.full_name)}" title="Remove account">&#128465;</button>`
      : // Wrapped together (rather than left as two separate flex children of
        // .team-member-card) so the key icon sits directly against the
        // instant-contact icons instead of getting pushed apart by the row's
        // justify-content: space-between.
        `<div class="mc-right-icons">${isAdmin ? keyIconButtonHTML(m.id) : ""}${contactActionIcons({ phone: m.phone, email: m.email })}</div>`;

  const pwRevealed = revealedPasswordMemberIds.has(m.id);
  return `
    <div class="team-member-card-wrap">
      <div class="team-member-card clickable-row ${pwRevealed ? "expanded" : ""}" data-member-id="${m.id}">
        <div class="mc-left">
          ${memberAvatarHTML(m)}
          <div class="mc-main">
            <div class="mc-name">${escapeHtml(m.full_name)}</div>
            ${positionHTML}
          </div>
        </div>
        ${rightHTML}
      </div>
      ${pwRevealed ? tempPasswordRevealHTML(m.id) : ""}
    </div>`;
}

// Small photo (or initials, if none uploaded) shown left of each member's
// name in Teams — see the "profile picture" feature in js/profile.js's own
// avatar upload above. Purely cosmetic, no click behavior of its own.
function memberAvatarHTML(m) {
  if (m.avatar_url) {
    return `<div class="mc-avatar"><img src="${m.avatar_url}" alt="" /></div>`;
  }
  return `<div class="mc-avatar">${escapeHtml(initials(m.full_name))}</div>`;
}

// Small key-icon button, admin-only — sits directly left of the
// text/call/email instant-contact icons (and stays put, at the top-right of
// the card, once the card is expanded to show phone/email — see
// toggleMemberDetail, which only removes the .contact-actions cluster, not
// this button). Clicking it reveals/hides the employee's stored temp
// password directly below the card (see toggleTempPasswordReveal).
const KEY_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>';

function keyIconButtonHTML(memberId) {
  return `<button type="button" class="contact-action-btn temp-pw-toggle-btn" data-member-id="${memberId}" title="Show temp password">${KEY_ICON_SVG}</button>`;
}

function tempPasswordRevealHTML(memberId) {
  const pw = tempPasswordsByMemberId[memberId];
  return `
    <div class="temp-pw-reveal" data-member-id="${memberId}">
      <span class="temp-pw-label">Temp password:</span>
      <span class="temp-pw-value">${pw ? escapeHtml(pw) : "Not on record"}</span>
    </div>`;
}

// Toggles the temp-password reveal block for one member card. Kept in sync
// with revealedPasswordMemberIds so it survives a full renderTeams() re-render
// (e.g. toggling edit mode) the same way closedGroupKeys does for accordions.
function toggleTempPasswordReveal(wrap, memberId) {
  const existing = wrap.querySelector(".temp-pw-reveal");
  if (existing) {
    existing.remove();
    revealedPasswordMemberIds.delete(memberId);
  } else {
    revealedPasswordMemberIds.add(memberId);
    wrap.insertAdjacentHTML("beforeend", tempPasswordRevealHTML(memberId));
  }
  updateCardCornerSquaring(wrap);
}

// Tapping a team member's rectangle used to open a separate centered popup
// for their phone/email — but that popup rendered behind the Teams
// full-screen modal (a lower z-index than .fullscreen-modal), so it looked
// like it "pulled up underneath" the Teams view. Replaced with an inline
// expand: the phone/email rows (each with its own instant-contact icons,
// aligned with that row) appear directly below the tapped card, pushing the
// rest of the list down; tapping the same card again collapses them back.
// This mutates the DOM directly (rather than re-rendering the whole
// #teamsWrap via renderTeams()) so expanding/collapsing a card never
// resets which team-group accordions happen to be open.
// Squares off the card's bottom corners whenever ANYTHING is showing flush
// underneath it (phone/email detail, temp-password reveal, or both) so there's
// never a visible rounded corner poking out above a flush-attached block.
function updateCardCornerSquaring(wrap) {
  const card = wrap.querySelector(".team-member-card");
  if (!card) return;
  const hasBelow = wrap.querySelector(".team-member-detail") || wrap.querySelector(".temp-pw-reveal");
  card.classList.toggle("expanded", !!hasBelow);
}

function toggleMemberDetail(card, member) {
  const wrap = card.closest(".team-member-card-wrap");
  const existingDetail = wrap.querySelector(".team-member-detail");
  if (existingDetail) {
    existingDetail.remove();
    if (!card.querySelector(".contact-actions")) {
      // Restore into .mc-right-icons (the wrapper the key icon also lives
      // in — see memberCardHTML) rather than appending straight onto `card`,
      // so the row goes back to exactly two flex children (name + icons)
      // instead of three.
      const iconsWrap = card.querySelector(".mc-right-icons") || card;
      iconsWrap.insertAdjacentHTML("beforeend", contactActionIcons({ phone: member.phone, email: member.email }));
      stopContactActionPropagation(card);
    }
    updateCardCornerSquaring(wrap);
    return;
  }
  const iconsSlot = card.querySelector(".contact-actions");
  if (iconsSlot) iconsSlot.remove();
  wrap.insertAdjacentHTML(
    "beforeend",
    `<div class="team-member-detail">
      ${memberDetailRow("Phone number", member.phone, "phone")}
      ${memberDetailRow("Email", member.email, "email")}
    </div>`
  );
  wireTapCopy(wrap);
  stopContactActionPropagation(wrap);
  updateCardCornerSquaring(wrap);
}

// Briefly shows "Copied" next to a value after tapping it copies it — same
// lightweight pattern as the call-notes "Saved" indicator on Dials. Used to
// be a 500ms long-press/hold before copying; a plain tap is faster and less
// surprising (a hold no longer does anything special here).
function wireTapCopy(container) {
  container.querySelectorAll(".copyable").forEach((el) => {
    el.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(el.dataset.copy || "");
        const toast = el.parentElement.querySelector(".copy-toast");
        if (toast) {
          toast.classList.remove("hidden");
          setTimeout(() => toast.classList.add("hidden"), 1200);
        }
      } catch {
        // Clipboard access can fail (permissions, insecure context, etc.)
        // — silently ignore, nothing to fall back to here.
      }
    });
  });
}

function memberDetailRow(label, value, kind) {
  const v = value ? String(value) : "";
  return `
    <div class="readonly-field">
      <div class="rf-label">${escapeHtml(label)}</div>
      <div class="rf-value-row">
        <div class="rf-value-row" style="gap:8px;">
          <div class="rf-value ${v ? "copyable" : "empty"}" ${v ? `data-copy="${escapeHtml(v)}"` : ""}>${v ? escapeHtml(v) : "Not provided"}</div>
          <span class="copy-toast hidden">Copied</span>
        </div>
        ${v ? contactActionIcons(kind === "phone" ? { phone: v } : { email: v }) : ""}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Position toggle ("Intern"/"Admin" under a name) — admin-only. Clicking it
// opens a tiny 2-option dropdown right below (same look/positioning family
// as the dial-status-menu in js/dials.js); picking one calls
// moveMemberToGroup with the same logic a drag-drop into the Admins or
// Unassigned interns box would use.
// ---------------------------------------------------------------------------
function closeAllPositionMenus() {
  els.teamsWrap.querySelectorAll(".position-menu").forEach((m) => m.classList.add("hidden"));
}

function togglePositionMenu(toggleEl) {
  const menu = toggleEl.parentElement.querySelector(".position-menu");
  if (!menu) return;
  const opening = menu.classList.contains("hidden");
  closeAllPositionMenus();
  if (opening) {
    // .position-menu is position:fixed (see style.css) so it isn't clipped by
    // the accordion section's overflow:hidden — compute its on-screen
    // position here instead of relying on CSS top/left, which only work
    // relative to an offset-parent for position:absolute.
    const rect = toggleEl.getBoundingClientRect();
    menu.classList.remove("hidden");
    const menuRect = menu.getBoundingClientRect();
    let left = rect.left;
    if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - 8 - menuRect.width;
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${rect.bottom + 4}px`;
  }
}

document.addEventListener("click", () => closeAllPositionMenus());

// Moves a member into `groupKey` (either ADMINS_KEY, UNASSIGNED_KEY, or a
// custom team's id) — shared by the position dropdown and the drag-drop
// gesture below. Moving into Admins always sets role='admin'; moving
// anywhere else always sets role='intern' (an admin dragged out becomes an
// intern again, per spec) plus that destination's team_id.
async function moveMemberToGroup(memberId, groupKey) {
  const updates =
    groupKey === ADMINS_KEY
      ? { role: "admin" }
      : { role: "intern", team_id: groupKey === UNASSIGNED_KEY ? null : groupKey };
  const { error } = await supabase.from("profiles").update(updates).eq("id", memberId);
  if (error) return showError(els.errorBox, error);
  await loadTeams();
}

// ---------------------------------------------------------------------------
// Hold-and-drag a member card into a different team box (admin-only). Same
// long-press-then-drag shape as the dial-tab reorder gesture in js/dials.js —
// a timer distinguishes a hold from a normal tap, then a floating "ghost"
// clone follows the pointer and whichever accordion section it's currently
// over is highlighted as the drop target.
// ---------------------------------------------------------------------------
const LONG_PRESS_MS = 350;
const DRAG_CANCEL_PX = 10;

const memberDragState = {
  active: false,
  memberId: null,
  startX: 0,
  startY: 0,
  timer: null,
  ghost: null,
  dropTarget: null,
  suppressClick: false,
};

function cancelMemberLongPressTimer() {
  if (memberDragState.timer) {
    clearTimeout(memberDragState.timer);
    memberDragState.timer = null;
  }
}

function startMemberDragVisuals(card, e) {
  memberDragState.active = true;
  // Force every group open so there's always somewhere visible to drop into,
  // even if that group was collapsed when the drag started.
  els.teamsWrap.querySelectorAll(".accordion-section").forEach((sec) => sec.classList.add("open"));

  const rect = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add("team-drag-ghost");
  ghost.style.width = `${rect.width}px`;
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  document.body.appendChild(ghost);
  memberDragState.ghost = ghost;
  memberDragState.offsetX = e.clientX - rect.left;
  memberDragState.offsetY = e.clientY - rect.top;

  card.closest(".team-member-card-wrap").classList.add("dragging-source");
}

// Area (px^2) that two DOMRects overlap by — 0 if they don't touch at all.
function rectOverlapArea(a, b) {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return w * h;
}

function moveMemberDragGhost(e) {
  if (!memberDragState.ghost) return;
  memberDragState.ghost.style.left = `${e.clientX - memberDragState.offsetX}px`;
  memberDragState.ghost.style.top = `${e.clientY - memberDragState.offsetY}px`;

  els.teamsWrap.querySelectorAll(".accordion-section.drag-over").forEach((sec) => sec.classList.remove("drag-over"));

  // Whichever team/admin/unassigned box the ghost currently overlaps MOST
  // (by area) is the drop target — not just whatever's directly under the
  // pointer/finger tip, so a card that's mostly over one box but with the
  // pointer itself briefly crossing into a neighbor's edge still drops where
  // it visually looks like it's going. No overlap at all -> no drop target,
  // which snaps the card back to its original box on release.
  const ghostRect = memberDragState.ghost.getBoundingClientRect();
  let best = null;
  let bestArea = 0;
  els.teamsWrap.querySelectorAll(".accordion-section.team-group").forEach((sec) => {
    const area = rectOverlapArea(ghostRect, sec.getBoundingClientRect());
    if (area > bestArea) {
      bestArea = area;
      best = sec;
    }
  });
  if (best) best.classList.add("drag-over");
  memberDragState.dropTarget = best ? best.dataset.group : null;
}

function endMemberDrag(card) {
  if (memberDragState.pointerId != null && card.releasePointerCapture && card.hasPointerCapture && card.hasPointerCapture(memberDragState.pointerId)) {
    card.releasePointerCapture(memberDragState.pointerId);
  }
  if (memberDragState.ghost) {
    memberDragState.ghost.remove();
    memberDragState.ghost = null;
  }
  const wrap = card.closest(".team-member-card-wrap");
  if (wrap) wrap.classList.remove("dragging-source");
  els.teamsWrap.querySelectorAll(".accordion-section.drag-over").forEach((sec) => sec.classList.remove("drag-over"));
}

function wireMemberDrag(card, memberId) {
  card.addEventListener("pointerdown", (e) => {
    // Ignore drags started from the position toggle, contact-action icons,
    // or the delete-account trash button — those have their own click
    // behavior already wired above.
    if (
      e.target.closest(".position-toggle") ||
      e.target.closest(".position-menu") ||
      e.target.closest(".contact-action-btn") ||
      e.target.closest(".member-trash-btn") ||
      e.target.closest(".temp-pw-reveal")
    ) {
      return;
    }
    memberDragState.memberId = memberId;
    memberDragState.pointerId = e.pointerId;
    memberDragState.startX = e.clientX;
    memberDragState.startY = e.clientY;
    memberDragState.active = false;
    cancelMemberLongPressTimer();
    memberDragState.timer = setTimeout(() => {
      // Route all subsequent pointer events for this pointer to `card`
      // regardless of what element is physically under it — without this,
      // once the finger/mouse moves off the card's own bounds (exactly what
      // happens when dragging it into a different team box), the browser
      // stops sending pointermove/pointerup here and the drag "gets stuck".
      if (card.setPointerCapture) card.setPointerCapture(e.pointerId);
      startMemberDragVisuals(card, e);
    }, LONG_PRESS_MS);
  });

  card.addEventListener("pointermove", (e) => {
    if (memberDragState.memberId !== memberId) return;
    if (!memberDragState.active) {
      const dx = e.clientX - memberDragState.startX;
      const dy = e.clientY - memberDragState.startY;
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_CANCEL_PX) cancelMemberLongPressTimer();
      return;
    }
    e.preventDefault();
    moveMemberDragGhost(e);
  });

  const endDrag = async () => {
    cancelMemberLongPressTimer();
    if (memberDragState.memberId !== memberId) return;
    const wasActive = memberDragState.active;
    const dropTarget = memberDragState.dropTarget;
    endMemberDrag(card);
    memberDragState.memberId = null;
    memberDragState.active = false;
    memberDragState.dropTarget = null;
    if (wasActive) {
      memberDragState.suppressClick = true;
      const currentGroup = groupKeyForMember(allMembers.find((m) => m.id === memberId) || {});
      if (dropTarget && dropTarget !== currentGroup) {
        await moveMemberToGroup(memberId, dropTarget);
      } else {
        renderTeams();
      }
    }
  };
  card.addEventListener("pointerup", endDrag);
  card.addEventListener("pointercancel", endDrag);
}

// ---------------------------------------------------------------------------
// Rename a custom team — click its name while editMode is on. "Admins" and
// "Unassigned interns" never get the renamable class (see renderTeams), so
// this is never reachable for them. Same input-swap pattern as
// startRenameTab() in js/dials.js.
// ---------------------------------------------------------------------------
function startRenameTeam(nameEl) {
  const teamId = nameEl.dataset.teamId;
  const team = customTeams.find((t) => t.id === teamId);
  if (!team) return;
  const input = document.createElement("input");
  input.className = "dial-tab-rename-input";
  input.value = team.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    if (newName && newName !== team.name) {
      const { error } = await supabase.from("teams").update({ name: newName }).eq("id", team.id);
      if (error) showError(els.errorBox, error);
    }
    await loadTeams();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") {
      input.value = team.name;
      input.blur();
    }
  });
}

// Deleting a team just deletes the row — profiles.team_id references
// teams(id) ON DELETE SET NULL (see supabase/schema.sql), so every member in
// it automatically falls back to Unassigned interns with no extra query
// needed here.
function handleDeleteTeam(teamId) {
  openConfirmModal(els.confirmDeleteTeamModal, "confirmDeleteTeamYesBtn", "confirmDeleteTeamNoBtn", async () => {
    const { error } = await supabase.from("teams").delete().eq("id", teamId);
    if (error) return showError(els.errorBox, error);
    await loadTeams();
  });
}

// Removing an account calls the admin-delete-account Edge Function (needs
// the service-role key to actually delete the auth user — see
// supabase/functions/admin-delete-account) which reassigns every client/dial
// the departing user owned to whichever admin is signed in right now, then
// deletes their auth user (cascading their profile row).
function handleDeleteAccount(memberId, memberName) {
  const textEl = document.querySelector("#confirmDeleteAccountModal .help-text");
  if (textEl) {
    textEl.textContent = `${memberName || "Their"} clients and dials will be reassigned to you. This cannot be undone.`;
  }
  openConfirmModal(els.confirmDeleteAccountModal, "confirmDeleteAccountYesBtn", "confirmDeleteAccountNoBtn", async () => {
    const { data, error } = await supabase.functions.invoke("admin-delete-account", {
      body: { user_id: memberId },
    });
    if (error || data?.error) return showError(els.errorBox, error || new Error(data.error));
    await loadTeams();
  });
}

// ---------------------------------------------------------------------------
// "+" popup (Account / Team) — shown right under the + icon, dismissed by
// clicking anywhere else (same escape-the-clip fixed-position pattern as
// js/dials.js's categories submenu).
// ---------------------------------------------------------------------------
function positionTeamsAddMenu() {
  const rect = els.teamsAddBtn.getBoundingClientRect();
  els.teamsAddMenu.style.left = `${Math.max(8, rect.right - 140)}px`;
  els.teamsAddMenu.style.top = `${rect.bottom + 6}px`;
}

els.teamsAddBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const opening = els.teamsAddMenu.classList.contains("hidden");
  els.teamsAddMenu.classList.toggle("hidden");
  if (opening) positionTeamsAddMenu();
});
document.addEventListener("click", (e) => {
  if (els.teamsAddMenu.classList.contains("hidden")) return;
  if (e.target.closest("#teamsAddMenu") || e.target.closest("#teamsAddBtn")) return;
  els.teamsAddMenu.classList.add("hidden");
});

els.teamsEditBtn.addEventListener("click", () => {
  editMode = !editMode;
  renderTeams();
});

// ---------------------------------------------------------------------------
// Add account (admin-only signup, replaces the old public one on login.html)
// ---------------------------------------------------------------------------
els.teamsAddAccountBtn.addEventListener("click", () => {
  els.teamsAddMenu.classList.add("hidden");
  els.addAccountError.classList.add("hidden");
  els.newAccountEmailError.classList.add("hidden");
  els.newAccountFirstName.value = "";
  els.newAccountLastName.value = "";
  els.newAccountPhone.value = "";
  els.newAccountEmail.value = "";
  els.newAccountPassword.value = "";
  els.addAccountModal.classList.remove("hidden");
  els.newAccountFirstName.focus();
});
els.addAccountCancelBtn.addEventListener("click", () => els.addAccountModal.classList.add("hidden"));

els.addAccountCreateBtn.addEventListener("click", async () => {
  const first_name = els.newAccountFirstName.value.trim();
  const last_name = els.newAccountLastName.value.trim();
  const full_name = `${first_name} ${last_name}`.trim();
  const phone = els.newAccountPhone.value.trim();
  const email = els.newAccountEmail.value.trim();
  const password = els.newAccountPassword.value;
  els.addAccountError.classList.add("hidden");
  els.newAccountEmailError.classList.add("hidden");
  if (!first_name || !last_name || !email || !password) {
    els.addAccountError.textContent = "First name, last name, email, and password are required.";
    els.addAccountError.classList.remove("hidden");
    return;
  }
  els.addAccountCreateBtn.disabled = true;
  const { data, error } = await supabase.functions.invoke("admin-create-account", {
    body: { full_name, phone, email, password },
  });
  els.addAccountCreateBtn.disabled = false;

  // On a non-2xx response, supabase-js's invoke() returns `data: null` and an
  // error object whose `.context` is the raw Response — the JSON body (with
  // our custom `code: "email_exists"` field) has to be read from there
  // instead of `data`.
  let errBody = data && data.error ? data : null;
  if (!errBody && error && error.context && typeof error.context.json === "function") {
    try {
      errBody = await error.context.json();
    } catch {
      errBody = null;
    }
  }

  if (error || errBody?.error) {
    if (errBody?.code === "email_exists") {
      els.newAccountEmailError.classList.remove("hidden");
      return;
    }
    els.addAccountError.textContent = (errBody && errBody.error) || error?.message || "Could not create the account.";
    els.addAccountError.classList.remove("hidden");
    return;
  }
  els.addAccountModal.classList.add("hidden");
  await loadTeams();
});

// ---------------------------------------------------------------------------
// Add team — new box lands right before Unassigned interns (see
// buildGroupDefs(): custom teams are ordered by sort_order, so appending at
// customTeams.length always lands last among teams, i.e. immediately before
// the Unassigned interns box which is always rendered last of all).
// ---------------------------------------------------------------------------
els.teamsAddTeamBtn.addEventListener("click", () => {
  els.teamsAddMenu.classList.add("hidden");
  els.addTeamError.classList.add("hidden");
  els.newTeamNameInput.value = "";
  els.addTeamModal.classList.remove("hidden");
  els.newTeamNameInput.focus();
});
els.addTeamCancelBtn.addEventListener("click", () => els.addTeamModal.classList.add("hidden"));

async function createNewTeam() {
  const name = els.newTeamNameInput.value.trim();
  if (!name) {
    els.addTeamError.textContent = "Please enter a name for the team.";
    els.addTeamError.classList.remove("hidden");
    return;
  }
  const { error } = await supabase.from("teams").insert({ name, sort_order: customTeams.length });
  if (error) {
    els.addTeamError.textContent = error.message;
    els.addTeamError.classList.remove("hidden");
    return;
  }
  els.addTeamModal.classList.add("hidden");
  await loadTeams();
}
els.addTeamCreateBtn.addEventListener("click", createNewTeam);
els.newTeamNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") createNewTeam();
});

// ---------------------------------------------------------------------------
// "X people called this week" + 6-week chart. A row is inserted into
// call_status_changes (see updateDialStatus() in js/dials.js) the first time
// a dial moves off its default "Uncontacted" status — this counts how many
// distinct dials this intern has contacted, bucketed into Monday-Sunday weeks.
// ---------------------------------------------------------------------------

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday, 1 = Monday, ...
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  d.setHours(0, 0, 0, 0);
  return d;
}

function fmtShortDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// Weekly quota — also drives the "(N more calls to reach quota)" /
// "(Quota met)" text under the calls-this-week heading.
const WEEKLY_QUOTA = 50;

// Picks a "nice" gridline step (1/2/5 x a power of 10) for a given rough
// spacing target, same approach most charting libraries use so the
// gridlines land on round numbers instead of awkward ones.
function niceStep(roughStep) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep || 1)));
  const residual = roughStep / magnitude;
  let step;
  if (residual > 5) step = 10;
  else if (residual > 2) step = 5;
  else if (residual > 1) step = 2;
  else step = 1;
  return step * magnitude;
}

// targetEl: the .profile-chart element to render into.
// quota: a fixed reference line to always draw (and to guarantee fits on the
// axis), or null/undefined to skip it entirely — used by the Outreach calls
// chart (WEEKLY_QUOTA) but not by the Intro calls chart (no quota).
function renderCallsChart(targetEl, weekStarts, counts, quota) {
  const w = 300;
  const h = 150;
  const padX = 18;
  const padTop = 22; // room for the value label above the tallest dot
  const padBottom = 16;
  const plotH = h - padTop - padBottom;

  // A quota line always has to fit on the chart, even in weeks where nobody's
  // close to it yet, so the axis max is never less than the quota (when
  // there is one).
  const rawMax = Math.max(quota || 0, 1, ...counts);
  const step = niceStep(rawMax / 4);
  const axisMax = Math.ceil(rawMax / step) * step;

  const yFor = (v) => padTop + plotH - (v / axisMax) * plotH;

  const stepX = counts.length > 1 ? (w - padX * 2) / (counts.length - 1) : 0;
  const points = counts.map((c, i) => ({
    x: padX + i * stepX,
    y: yFor(c),
  }));
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const dots = points.map((p) => `<circle class="profile-chart-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3"></circle>`).join("");
  const valueLabels = points
    .map((p, i) => `<text class="profile-chart-value" x="${p.x.toFixed(1)}" y="${(p.y - 7).toFixed(1)}" text-anchor="middle">${counts[i]}</text>`)
    .join("");
  const dateLabels = weekStarts
    .map((ws, i) => `<text class="profile-chart-label" x="${points[i].x.toFixed(1)}" y="${h - 2}" text-anchor="middle">${fmtShortDate(ws)}</text>`)
    .join("");

  // Adaptive gridlines (0, step, 2*step, ... up to axisMax), each with a
  // value label on the left.
  const gridlines = [];
  for (let v = 0; v <= axisMax + 0.001; v += step) {
    const y = yFor(v);
    gridlines.push(`<line class="profile-chart-grid" x1="${padX}" x2="${(w - padX).toFixed(1)}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"></line>`);
    gridlines.push(`<text class="profile-chart-grid-label" x="2" y="${(y + 3).toFixed(1)}">${Math.round(v)}</text>`);
  }

  // Fixed quota reference line, always green, regardless of the data — drawn
  // after the regular gridlines so it sits on top of them. Omitted entirely
  // when there's no quota (the Intro calls tracker).
  const quotaLine = quota
    ? (() => {
        const quotaY = yFor(quota);
        return `<line class="profile-chart-quota-line" x1="${padX}" x2="${(w - padX).toFixed(1)}" y1="${quotaY.toFixed(1)}" y2="${quotaY.toFixed(1)}"></line>`;
      })()
    : "";

  targetEl.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}">
      ${gridlines.join("")}
      ${quotaLine}
      <path class="profile-chart-line" d="${pathD}"></path>
      ${dots}
      ${valueLabels}
      ${dateLabels}
    </svg>
  `;
}

async function loadCallsChart() {
  const thisWeekStart = startOfWeek(new Date());
  const weekStarts = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(thisWeekStart);
    d.setDate(d.getDate() - i * 7);
    weekStarts.push(d);
  }
  const { data, error } = await supabase
    .from("call_status_changes")
    .select("changed_at")
    .eq("user_id", profile.id)
    .gte("changed_at", weekStarts[0].toISOString());
  if (error) return showError(els.errorBox, error);

  const rows = data || [];
  const counts = weekStarts.map((ws) => {
    const we = new Date(ws);
    we.setDate(we.getDate() + 7);
    return rows.filter((r) => {
      const t = new Date(r.changed_at);
      return t >= ws && t < we;
    }).length;
  });

  const thisWeekCount = counts[counts.length - 1];

  // Today's count is just a narrower slice of the same `rows` already
  // fetched above (which covers everything since the start of this week, so
  // today is included in there).
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const todayCount = rows.filter((r) => {
    const t = new Date(r.changed_at);
    return t >= startOfToday && t < startOfTomorrow;
  }).length;

  const remaining = WEEKLY_QUOTA - thisWeekCount;
  const quotaHTML =
    remaining <= 0
      ? `<div class="profile-quota-status profile-quota-met">(Quota met)</div>`
      : `<div class="profile-quota-status profile-quota-remaining">(${remaining} more call${remaining === 1 ? "" : "s"} to reach quota)</div>`;
  els.callsThisWeekText.innerHTML = `${thisWeekCount} ${thisWeekCount === 1 ? "person" : "people"} called this week, ${todayCount} today${quotaHTML}`;
  renderCallsChart(els.callsChart, weekStarts, counts, WEEKLY_QUOTA);
}

loadCallsChart();

// ---------------------------------------------------------------------------
// Intro calls scheduled per week — the toggled alternative view (see the
// Outreach/Intro toggle above). No quota line; just counts rows in
// intro_call_log (one inserted every time the shared Schedule Intro Call flow
// is used — see js/introCall.js) bucketed into the same Monday-Sunday weeks.
// Loaded lazily, the first time the Intro calls view is shown.
// ---------------------------------------------------------------------------
async function loadIntroCallsChart() {
  const thisWeekStart = startOfWeek(new Date());
  const weekStarts = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(thisWeekStart);
    d.setDate(d.getDate() - i * 7);
    weekStarts.push(d);
  }
  const { data, error } = await supabase
    .from("intro_call_log")
    .select("scheduled_at")
    .eq("user_id", profile.id)
    .gte("scheduled_at", weekStarts[0].toISOString());
  if (error) return showError(els.errorBox, error);

  const rows = data || [];
  const counts = weekStarts.map((ws) => {
    const we = new Date(ws);
    we.setDate(we.getDate() + 7);
    return rows.filter((r) => {
      const t = new Date(r.scheduled_at);
      return t >= ws && t < we;
    }).length;
  });

  const thisWeekCount = counts[counts.length - 1];
  els.introCallsThisWeekText.textContent = `${thisWeekCount} intro call${thisWeekCount === 1 ? "" : "s"} scheduled this week`;
  renderCallsChart(els.introCallsChart, weekStarts, counts, null);
}

els.teamsBtn.addEventListener("click", async () => {
  editMode = false;
  closedGroupKeys.clear(); // every section starts open each time the popup is (re)opened
  els.teamsModal.classList.remove("hidden");
  lockPageScroll();
  await loadTeams();
});
els.teamsCloseBtn.addEventListener("click", () => {
  els.teamsModal.classList.add("hidden");
  els.teamsAddMenu.classList.add("hidden");
  unlockPageScroll();
});
els.profileSignOutBtn.addEventListener("click", signOut);

wirePageHeaderMenu({ toggleBtn: els.pageMenuToggle, menuEl: els.pageHeaderMenu });
