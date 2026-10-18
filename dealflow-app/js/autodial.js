// "Autodial" — a per-user setting in the Dials page's Advanced settings popup
// (profiles.autodial_enabled). When on, choosing a dial's category (js/dials.js status dropdown)
// immediately moves to the next "uncontacted" (white) dial in the list being worked and starts the
// call to its first listed number. It does not run for "Accepted intro call" (the form may still be
// open) or when a call is still in progress. The behaviour itself lives in dials.js
// (autodialTarget / runAutodial); this is just the on/off switch row, same look as the other
// Advanced-settings rows.
import { supabase } from "./supabaseClient.js";

export function wireAutodialToggle(rowBtn, switchEl, profile) {
  if (!rowBtn || !switchEl) return;
  const render = () => {
    const on = profile.autodial_enabled === true;
    switchEl.classList.toggle("on", on);
    switchEl.setAttribute("aria-checked", String(on));
  };
  render();
  rowBtn.addEventListener("click", async () => {
    const next = profile.autodial_enabled !== true;
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
