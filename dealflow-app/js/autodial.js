// "Autodial" — a per-user setting in the Dials settings menu (profiles.autodial_enabled). When on,
// choosing a dial's category (js/dials.js status dropdown) immediately moves to the next
// "uncontacted" (white) dial in the list being worked and starts the call to its first listed
// number. It does not run for "Accepted intro call" (the form may still be open) or when a call is
// still in progress. The behaviour itself lives in dials.js (autodialTarget / runAutodial); this is
// just the on/off menu row, same shape as the Notifications toggle.
import { supabase } from "./supabaseClient.js";

export function wireAutodialToggle(toggleBtn, labelEl, profile) {
  if (!toggleBtn || !labelEl) return;
  const render = () => {
    labelEl.textContent = profile.autodial_enabled ? "Autodial: On" : "Autodial: Off";
    toggleBtn.classList.toggle("is-on", !!profile.autodial_enabled);
  };
  render();
  toggleBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const next = !profile.autodial_enabled;
    profile.autodial_enabled = next;
    render();
    const { error } = await supabase.from("profiles").update({ autodial_enabled: next }).eq("id", profile.id);
    if (error) {
      console.error("Failed to update autodial_enabled", error);
      profile.autodial_enabled = !next;
      render();
    }
  });
}
