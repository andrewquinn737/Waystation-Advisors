// Shared "Schedule Intro Call" button — used from the Clients Timeline
// ("+" > Intro Call) and from the Dials "Create client" flow's
// "Schedule intro call" button.
//
// TEMPORARY SIMPLIFIED VERSION: this just opens Waystation Advisors' public
// Calendly booking page in a new tab, pre-filled with the client's name and
// email, instead of booking through Calendly's API. No Calendly API token or
// server-side secrets are required for this — it's the same as a client
// clicking a "Book a call" link themselves.
//
// The previous version of this file called a Supabase Edge Function
// ("schedule-intro-call") that booked the call automatically via the
// Calendly API, which needs a CALENDLY_TOKEN + CALENDLY_EVENT_TYPE_URI
// secret set in Supabase. That Edge Function (supabase/functions/
// schedule-intro-call) is still deployed and ready to go — once those two
// secrets are set, this file can be swapped back to call it instead of
// opening Calendly directly.

// Public Calendly link for the 30-minute intro call event. Update this if
// the Calendly account or event type ever changes.
const CALENDLY_BOOKING_URL = "https://calendly.com/mason-waystationadvisors/30min";

export function buildIntroCallFormHTML() {
  return `
    <div class="intro-call-form">
      <p class="help-text">This opens Calendly in a new tab, pre-filled with the client's name and email, so you can pick a time together.</p>
      <div id="introCallError" class="error-msg hidden"></div>
      <div id="introCallSuccess" class="help-text hidden" style="color: var(--gold, #7a5c00);">Opened Calendly in a new tab.</div>
      <div class="form-actions">
        <button type="button" class="btn yellow" id="scheduleCallBtn">Open Calendly</button>
      </div>
    </div>
  `;
}

// container: element the form HTML above was injected into.
// opts: { client, createClient, internEmail, onScheduled(client) }
//   - client: an already-existing client row ({first_name,last_name,email,id,...}).
//   - createClient: alternative to `client` — an async function called the
//     moment "Open Calendly" is clicked, which should create the client
//     record and return it (or throw/return null on failure, showing its own
//     error). Used by the Dials "Schedule Intro Call" flow so the client
//     isn't actually created in the database until Calendly is opened —
//     clicking "Schedule Intro Call" itself only validates the dial's info
//     and opens this form, it no longer creates anything.
// (internEmail is accepted but unused in this simplified version — the
// booking link isn't per-intern.)
export function wireIntroCallForm(container, opts) {
  const { client: initialClient, createClient, onScheduled } = opts;
  const btn = container.querySelector("#scheduleCallBtn");
  const errEl = container.querySelector("#introCallError");
  const successEl = container.querySelector("#introCallSuccess");

  btn.addEventListener("click", async () => {
    errEl.classList.add("hidden");
    successEl.classList.add("hidden");

    let client = initialClient;
    if (!client && createClient) {
      try {
        client = await createClient();
      } catch (err) {
        errEl.textContent = err?.message || "Could not create the client record.";
        errEl.classList.remove("hidden");
        return;
      }
      if (!client) return; // createClient already showed its own error and bailed
    }

    if (!client?.email) {
      errEl.textContent = "This client doesn't have an email on file, so Calendly can't be pre-filled. Add one first.";
      errEl.classList.remove("hidden");
      return;
    }

    const params = new URLSearchParams();
    const name = `${client.first_name || ""} ${client.last_name || ""}`.trim();
    if (name) params.set("name", name);
    params.set("email", client.email);

    const separator = CALENDLY_BOOKING_URL.includes("?") ? "&" : "?";
    window.open(`${CALENDLY_BOOKING_URL}${separator}${params.toString()}`, "_blank", "noopener");

    successEl.classList.remove("hidden");
    if (onScheduled) await onScheduled(client);
  });
}
