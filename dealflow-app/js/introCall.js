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
import { resolveCalendlyLink } from "./mainAdmin.js";

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
// opts: { client, prefill, profile, logToGraph, onCalendlyClosed(client), onScheduled(client) }
//   - client: an already-existing client row ({full_name,email,client_type,id,...}).
//   - prefill: alternative to `client` — a plain {full_name, email,
//     client_type} object, used only to pre-fill Calendly's popup and to tag
//     the intro_call_log credit below. No client record is created by this
//     module at all in this mode; the caller is expected to create the real
//     client itself later (see the Dials "Schedule Intro Call" flow —
//     handleScheduleIntroCallFromDial/createClientFromDial/
//     openIntroCallTimeConfirmModal in js/dials.js — which defers actual
//     creation all the way until the date/time/timezone confirmation step
//     right after Calendly closes, bundled together with logging that
//     client's first Timeline entry, so nothing about the client exists in
//     the database at all until that step is completed).
//   - profile: the signed-in profile row (id, role, team_id) — used both to
//     log intro_call_log (so the Profile page's "Intro calls" tracker can
//     count every time this flow is used, from either Dials or Clients,
//     independent of client_events/Timeline) and to resolve which Calendly
//     link to open (see resolveCalendlyLink in js/mainAdmin.js: the main
//     admin's own link for anyone who isn't an intern, otherwise the
//     signed-in intern's own team lead's link, falling back to the main
//     admin's).
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
//     comment). Receives `client` as-is (undefined in `prefill` mode, since
//     no client exists yet — Dials' own handler doesn't need it, it already
//     has the dial in its own closure).
//   - onScheduled(client): fired after onCalendlyClosed, same as before.
export function wireIntroCallForm(container, opts) {
  const { client: initialClient, prefill, profile, logToGraph = true, onCalendlyClosed, onScheduled } = opts;
  const userId = profile?.id;
  const btn = container.querySelector("#scheduleCallBtn");
  const skipBtn = container.querySelector("#skipCalendlyBtn");
  const errEl = container.querySelector("#introCallError");
  const successEl = container.querySelector("#introCallSuccess");

  // Whichever of `client`/`prefill` the caller passed — used for Calendly's
  // pre-fill and the intro_call_log credit below. Never both at once.
  const name = initialClient?.full_name || prefill?.full_name || "";
  const email = initialClient?.email || prefill?.email || "";
  const clientType = initialClient?.client_type || prefill?.client_type || "seller";

  // Tracks whichever "message" listener the MOST RECENT "Open Calendly"
  // click registered — see below for why this has to be cleaned up on every
  // new click, not just on a completed booking.
  let activeOnMessage = null;

  btn.addEventListener("click", async () => {
    errEl.classList.add("hidden");
    successEl.classList.add("hidden");

    if (!email) {
      errEl.textContent = "This client doesn't have an email on file, so Calendly can't be pre-filled. Add one first.";
      errEl.classList.remove("hidden");
      return;
    }

    const calendlyUrl = await resolveCalendlyLink(profile);
    if (!calendlyUrl) {
      errEl.textContent = "Scheduling isn't set up yet — no Calendly link on file.";
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

    // Going in and out of Calendly — opening it, backing out without
    // booking, then opening it again — used to leave the PREVIOUS attempt's
    // "message" listener still registered below: Calendly only ever tells
    // the page "a booking was confirmed" (calendly.event_scheduled), never
    // "the popup was closed without one", so nothing cleaned up an abandoned
    // attempt's listener on its own. Real, confirmed symptom: booking on
    // (say) the 4th attempt broadcast ONE calendly.event_scheduled message
    // that reached all 4 still-live listeners at once (postMessage fires
    // every registered listener, not just the newest), logging the intro
    // call multiple times for a single actual booking. Removing whatever the
    // previous attempt left behind before registering a new one guarantees
    // at most one listener is ever live, no matter how many times "Open
    // Calendly" gets clicked before an actual booking happens.
    if (activeOnMessage) {
      window.removeEventListener("message", activeOnMessage);
      activeOnMessage = null;
    }

    window.Calendly.initPopupWidget({
      url: calendlyUrl,
      prefill: { name, email },
    });

    // One-shot: Calendly broadcasts this via postMessage the instant a
    // booking is confirmed inside the popup. Removing the listener right
    // away means a second, unrelated Calendly embed elsewhere on the page
    // (there isn't one today, but this keeps it safe) can't double-fire this
    // handler.
    const onMessage = async (e) => {
      if (e.data?.event !== "calendly.event_scheduled") return;
      window.removeEventListener("message", onMessage);
      activeOnMessage = null;
      window.Calendly.closePopupWidget();

      successEl.textContent = "Intro call scheduled.";
      successEl.classList.remove("hidden");

      // Counts toward the Profile page's "Intro calls" weekly tracker — see
      // loadIntroCallsChart() in js/profile.js. clientType lets that tracker
      // filter to just the currently-active Sellers/Buyers side, resolved
      // above from whichever of client/prefill was passed (falls back to
      // "seller" so this never violates the column's NOT NULL constraint).
      if (userId && logToGraph) {
        await supabase.from("intro_call_log").insert({ user_id: userId, client_type: clientType });
      }

      if (onCalendlyClosed) await onCalendlyClosed(initialClient);
      if (onScheduled) await onScheduled(initialClient);
    };
    activeOnMessage = onMessage;
    window.addEventListener("message", onMessage);
  });

  // "Skip Calendly, just log it" — same end result (onScheduled fires, the
  // graph gets credited) minus actually opening Calendly, and without
  // requiring the client to have an email on file (Calendly's pre-fill is
  // the only reason that was ever needed). See the allowSkip comment on
  // buildIntroCallFormHTML above for when this button even exists — always
  // paired with a real `client`, never `prefill` (Dials never passes
  // allowSkip at all, since it always needs a real Calendly booking to get
  // the real date/time — see handleScheduleIntroCallFromDial).
  if (skipBtn) {
    skipBtn.addEventListener("click", async () => {
      errEl.classList.add("hidden");
      successEl.classList.add("hidden");

      if (!initialClient) return;

      successEl.textContent = "Logged the intro call.";
      successEl.classList.remove("hidden");

      if (userId && logToGraph) {
        await supabase.from("intro_call_log").insert({ user_id: userId, client_type: clientType });
      }

      if (onScheduled) await onScheduled(initialClient);
    });
  }
}
