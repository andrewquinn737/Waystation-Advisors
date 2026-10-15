// "Granola calling" — a per-user setting (Dials settings menu,
// profiles.granola_calling_enabled). Granola can only place calls from inside
// its own iPhone app and has no link/Shortcuts/API way to start one, so when
// this is ON the app's call icon (every `a.contact-action-tel`, app-wide)
// copies the number to the clipboard and opens Granola instead of dialing;
// the user taps Granola's phone icon and pastes the number. When it's OFF
// nothing here does anything and the icon is the plain tel: link as always.
//
// Loaded by js/contactIcons.js (every page imports that), and switched on/off
// from js/auth.js at sign-in (setGranolaCalling) and from the Dials menu
// toggle (wireGranolaCallingToggle).

import { supabase } from "./supabaseClient.js";

let enabled = false;

export function setGranolaCalling(flag) {
  enabled = !!flag;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older/locked-down WebViews: fall back to a hidden textarea.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// Capture phase, so it runs before any row/button handler; it only cancels the
// tel: navigation — it never stops propagation, so everything else a tap on
// the call icon already did (e.g. marking a dial contacted) still happens.
document.addEventListener(
  "click",
  (e) => {
    if (!enabled) return;
    const link = e.target.closest?.("a.contact-action-tel");
    if (!link) return;
    const number = decodeURIComponent((link.getAttribute("href") || "").replace(/^tel:/i, "")).trim();
    if (!number) return;
    e.preventDefault();
    copyToClipboard(number).finally(() => {
      window.location.href = "granola://";
    });
  },
  true
);

// Menu row in the Dials settings gear: "Granola calling: On/Off".
export function wireGranolaCallingToggle(toggleBtn, labelEl, profile) {
  if (!toggleBtn || !labelEl) return;
  const render = () => {
    labelEl.textContent = profile.granola_calling_enabled ? "Granola calling: On" : "Granola calling: Off";
    toggleBtn.classList.toggle("is-on", !!profile.granola_calling_enabled);
  };
  render();
  toggleBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const next = !profile.granola_calling_enabled;
    profile.granola_calling_enabled = next;
    setGranolaCalling(next);
    render();
    const { error } = await supabase.from("profiles").update({ granola_calling_enabled: next }).eq("id", profile.id);
    if (error) {
      console.error("Failed to update granola_calling_enabled", error);
      profile.granola_calling_enabled = !next;
      setGranolaCalling(!next);
      render();
    }
  });
}
