// Shared "Schedule Intro Call" button — used from the Clients Timeline
// ("+" > Intro Call) and from the Dials "Create client" flow's
// "Schedule intro call" button.
//
// Uses Calendly's public popup widget (assets/external/widget.js), loaded as
// an overlay on top of the current page, instead of the old window.open()
// new-tab link — that had no way back into the app at all, so nothing could
// auto-close it or know what got booked. The widget's own postMessage
// broadcasts "calendly.event_scheduled" the moment a booking is confirmed;
// we use that to auto-close the popup immediately. That message only ever
// carries the created event/invitee's *URI*, never the actual start
// time/timezone (a Calendly platform limitation — resolving those requires
// the Calendly API + a Personal Access Token), which is why the real
// date/time/timezone still has to be captured separately — see
// onCalendlyClosed below, wired only by Dials (js/dials.js), which opens its
// own confirmation step for that right after the popup closes.
//
// No Calendly API token or server-side secrets are required for any of
// this — same trust level as a client clicking a public "Book a call" link
// themselves.

import { supabase } from "./supabaseClient.js";

// Public Calendly link for the 30-minute intro call event. Update this if
// the Calendly account or event type ever changes.
const CALENDLY_BOOKING_URL = "https://calendly.com/mason-waystationadvisors/30min";

// Lazily injects Calendly's embed script/stylesheet once per page load and
// resolves once window.Calendly is ready to use. Safe to call repeatedly —
// every caller shares the same in-flight/resolved promise.
let calendlyLoadPromise = null;
function loadCalendlyWidget() {
  if (window.Calendly) return Promise.resolve();
  if (calendlyLoadPromise) return calendlyLoadPromise;
  calendlyLoadPromise = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://assets.calendly.com/assets/external/widget.css";
    document.head.appendChild(link);

    const script = document.createElement("script");
    script.src = "https://assets.calendly.com/assets/external/widget.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Calendly"));
    document.head.appendChild(script);
  });
  return calendlyLoadPromise;
}

// allowSkip: shows a secondary "Log without Calendly" option beneath the
// main button — used by the Clients Timeline's "+" > Intro call flow (see
// openTimelineIntroCall in js/clients.js), where the call may already be
// known to have happened (or be getting logged after the fact) and opening
// Calendly to actually book it doesn't make sense. Not passed (so omitted)
// by the Dials "Schedule Intro Call" flow, which is always booking a call
// that hasn't happened yet.
export function buildIntroCallFormHTML({ allowSkip = false } = {}) {
  return `
    <div class="intro-call-form">
      <p class="help-text">This opens Calendly right here, pre-filled with the client's name and email, so you can pick a time together.</p>
      <div id="introCallError" class="error-msg hidden"></div>
      <div id="introCallSuccess" class="help-text hidden" style="color: var(--gold, #7a5c00);"></div>
      <div class="form-actions">
        <button type="button" class="btn yellow" id="scheduleCallBtn">Open Calendly</button>
        ${allowSkip ? `<button type="button" class="btn secondary" id="skipCalendlyBtn">Skip Calendly, just log it</button>` : ""}
      </div>
    </div>
  `;
}

// container: element the form HTML above was injected into.
// opts: { client, createClient, internEmail, userId, logToGraph, onCalendlyClosed(client), onScheduled(client) }
//   - client: an already-existing client row ({first_name,last_name,email,id,...}).
//   - createClient: alternative to `client` — an async function called the
//     moment "Open Calendly" is clicked, which should create the client
//     record and return it (or throw/return null on failure, showing its own
//     error). Used by the Dials "Schedule Intro Call" flow so the client
//     isn't actually created in the database until Calendly is opened —
//     clicking "Schedule Intro Call" itself only validates the dial's info
//     and opens this form, it no longer creates anything.
//   - userId: the signed-in profile's id — logged to intro_call_log (see
//     supabase/schema.sql) so the Profile page's "Intro calls" tracker can
//     count every time this flow is used, from either Dials or Clients,
//     independent of client_events/Timeline.
//   - logToGraph: defaults to true. The Clients Timeline's "+" > Intro call
//     flow passes false when the chosen date is in the future — a call that
//     hasn't happened yet shouldn't count toward the graph until its date
//     arrives (see the logToGraph comment in js/clients.js's
//     openTimelineIntroCall). Every other caller schedules "now", so the
//     default of true is correct for them without passing anything.
//   - onCalendlyClosed(client): fired right after the popup auto-closes on a
//     confirmed booking, before onScheduled. Only Dials passes this (see
//     handleScheduleIntroCallFromDial in js/dials.js) — it opens its own
//     date/time/timezone confirmation step there, since Calendly's
//     postMessage doesn't expose the actual chosen time (see the top-of-file
//     comment).
//   - onScheduled(client): fired after onCalendlyClosed, same as before.
// (internEmail is accepted but unused in this simplified version — the
// booking link isn't per-intern.)
export function wireIntroCallForm(container, opts) {
  const { client: initialClient, createClient, userId, logToGraph = true, onCalendlyClosed, onScheduled } = opts;
  const btn = container.querySelector("#scheduleCallBtn");
  const skipBtn = container.querySelector("#skipCalendlyBtn");
  const errEl = container.querySelector("#introCallError");
  const successEl = container.querySelector("#introCallSuccess");

  // Shared by both the normal "Open Calendly" click and the "Skip Calendly"
  // click below — resolves/creates the client record, same as before.
  async function resolveClient() {
    let client = initialClient;
    if (!client && createClient) {
      try {
        client = await createClient();
      } catch (err) {
        errEl.textContent = err?.message || "Could not create the client record.";
        errEl.classList.remove("hidden");
        return null;
      }
      if (!client) return null; // createClient already showed its own error and bailed
    }
    return client;
  }

  btn.addEventListener("click", async () => {
    errEl.classList.add("hidden");
    successEl.classList.add("hidden");

    const client = await resolveClient();
    if (!client) return;

    if (!client?.email) {
      errEl.textContent = "This client doesn't have an email on file, so Calendly can't be pre-filled. Add one first.";
      errEl.classList.remove("hidden");
      return;
    }

    try {
      await loadCalendlyWidget();
    } catch {
      errEl.textContent = "Could not load Calendly. Check your connection and try again.";
      errEl.classList.remove("hidden");
      return;
    }

    const name = `${client.first_name || ""} ${client.last_name || ""}`.trim();
    window.Calendly.initPopupWidget({
      url: CALENDLY_BOOKING_URL,
      prefill: { name, email: client.email },
    });

    // One-shot: Calendly broadcasts this via postMessage the instant a
    // booking is confirmed inside the popup. Removing the listener right
    // away means a second, unrelated Calendly embed elsewhere on the page
    // (there isn't one today, but this keeps it safe) can't double-fire this
    // handler.
    const onMessage = async (e) => {
      if (e.data?.event !== "calendly.event_scheduled") return;
      window.removeEventListener("message", onMessage);
      window.Calendly.closePopupWidget();

      successEl.textContent = "Intro call scheduled.";
      successEl.classList.remove("hidden");

      // Counts toward the Profile page's "Intro calls" weekly tracker — see
      // loadIntroCallsChart() in js/profile.js. client_type is the client's
      // own client_type (seller/buyer), letting that tracker filter to just
      // the currently-active Sellers/Buyers side. Falls back to "seller" on
      // the off chance a caller ever passes a client-like object without
      // one, so this never violates the column's NOT NULL constraint.
      if (userId && logToGraph) {
        await supabase.from("intro_call_log").insert({ user_id: userId, client_type: client?.client_type || "seller" });
      }

      if (onCalendlyClosed) await onCalendlyClosed(client);
      if (onScheduled) await onScheduled(client);
    };
    window.addEventListener("message", onMessage);
  });

  // "Skip Calendly, just log it" — same end result (onScheduled fires, the
  // graph gets credited) minus actually opening Calendly, and without
  // requiring the client to have an email on file (Calendly's pre-fill is
  // the only reason that was ever needed). See the allowSkip comment on
  // buildIntroCallFormHTML above for when this button even exists — Dials
  // never passes allowSkip, so it never wires onCalendlyClosed through this
  // path either.
  if (skipBtn) {
    skipBtn.addEventListener("click", async () => {
      errEl.classList.add("hidden");
      successEl.classList.add("hidden");

      const client = await resolveClient();
      if (!client) return;

      successEl.textContent = "Logged the intro call.";
      successEl.classList.remove("hidden");

      if (userId && logToGraph) {
        await supabase.from("intro_call_log").insert({ user_id: userId, client_type: client?.client_type || "seller" });
      }

      if (onScheduled) await onScheduled(client);
    });
  }
}
