// Shared "Schedule Intro Call" form — used from the Clients Timeline
// ("+" > Intro Call) and from the Dials "Create client" flow's
// "Schedule intro call" button.
//
// This calls a Supabase Edge Function ("schedule-intro-call") that holds the
// Calendly API credentials server-side. The frontend never sees, stores, or
// sends any Calendly token — it only sends the call details, and the Edge
// Function does the actual Calendly booking. See supabase/functions/
// schedule-intro-call for that piece.

import { supabase } from "./supabaseClient.js";

// A reasonably short, common list — not exhaustive, but covers the US.
// Feel free to extend; the value sent to Calendly is a standard IANA zone.
export const TIMEZONES = [
  { value: "America/New_York", label: "Eastern (ET)" },
  { value: "America/Chicago", label: "Central (CT)" },
  { value: "America/Denver", label: "Mountain (MT)" },
  { value: "America/Phoenix", label: "Arizona (no DST)" },
  { value: "America/Los_Angeles", label: "Pacific (PT)" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
];

export function buildIntroCallFormHTML() {
  const today = new Date().toISOString().slice(0, 10);
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `
    <div class="intro-call-form">
      <label for="ic_date">Date</label>
      <input type="date" id="ic_date" min="${today}" />
      <label for="ic_time">Time</label>
      <input type="time" id="ic_time" />
      <label for="ic_timezone">Time zone</label>
      <select id="ic_timezone">
        ${TIMEZONES.map(
          (tz) => `<option value="${tz.value}" ${tz.value === localTz ? "selected" : ""}>${tz.label}</option>`
        ).join("")}
      </select>
      <div id="introCallError" class="error-msg hidden"></div>
      <div id="introCallSuccess" class="help-text hidden" style="color: var(--gold, #7a5c00);">Call scheduled.</div>
      <div class="form-actions">
        <button type="button" class="btn" id="scheduleCallBtn">Schedule call</button>
      </div>
    </div>
  `;
}

// container: element the form HTML above was injected into.
// opts: { client: {first_name,last_name,email}, internEmail, onScheduled(details) }
export function wireIntroCallForm(container, opts) {
  const { client, internEmail, onScheduled } = opts;
  const btn = container.querySelector("#scheduleCallBtn");
  const errEl = container.querySelector("#introCallError");
  const successEl = container.querySelector("#introCallSuccess");

  btn.addEventListener("click", async () => {
    errEl.classList.add("hidden");
    successEl.classList.add("hidden");
    const date = container.querySelector("#ic_date").value;
    const time = container.querySelector("#ic_time").value;
    const timezone = container.querySelector("#ic_timezone").value;

    if (!date || !time || !timezone) {
      errEl.textContent = "Please fill in date, time, and time zone.";
      errEl.classList.remove("hidden");
      return;
    }
    if (!client?.email) {
      errEl.textContent = "This client doesn't have an email on file, so an invite can't be sent.";
      errEl.classList.remove("hidden");
      return;
    }

    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = "Scheduling...";
    try {
      const { data, error } = await supabase.functions.invoke("schedule-intro-call", {
        body: {
          client_name: `${client.first_name || ""} ${client.last_name || ""}`.trim(),
          client_email: client.email,
          intern_email: internEmail,
          date,
          time,
          timezone,
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      successEl.classList.remove("hidden");
      btn.textContent = "Scheduled";
      if (onScheduled) await onScheduled({ date, time, timezone });
    } catch (err) {
      errEl.textContent = err?.message || "Could not schedule the call. Please try again.";
      errEl.classList.remove("hidden");
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
}
