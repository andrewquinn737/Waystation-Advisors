// ---------------------------------------------------------------------------
// Shared time/timezone picker pieces for anything that logs a client_events
// row with an optional time — Timeline's "+" flow and the edit-event modal
// (js/clients.js), and Dials' post-Calendly confirmation step (js/dials.js).
//
// The core idea: once a time is chosen, `event_date` itself becomes the real
// UTC instant (via zonedTimeToUtcIso below) instead of a noon-anchored
// placeholder with the real time stashed separately in details.time. That
// makes every viewer's own (already-existing) toLocaleDateString/
// toLocaleTimeString calls — which use the *browser's own* timezone whenever
// no explicit `timeZone` option is passed — automatically show the correctly
// converted local time, with no per-viewer conversion code needed anywhere
// downstream. details.time/details.timezone are kept only so a later edit
// can prefill the creator's original picks; they're not used for display.
// ---------------------------------------------------------------------------

// 7:00 AM through 7:00 PM, every 30 minutes — narrower than the old
// midnight-to-11:30pm range, since intro/client calls only ever happen
// during business hours. includeNoTime=false drops the "No time" option —
// used by Dials' post-Calendly confirmation step (js/dials.js), where a
// real time is always expected since it's confirming what was just booked.
export function timeOptionsHTML(selected = "", { includeNoTime = true } = {}) {
  const opts = includeNoTime ? ['<option value="">No time</option>'] : [];
  for (let h = 7; h <= 19; h++) {
    for (let m = 0; m < 60; m += 30) {
      if (h === 19 && m > 0) break; // stop exactly at 7:00 PM, not 7:30 PM
      const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const label = new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      opts.push(`<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`);
    }
  }
  return opts.join("");
}

// The device's own current IANA zone — used as the picker's default so
// nobody has to think about timezones unless they're deliberately
// scheduling something for someone else's zone.
export function defaultTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago";
  } catch {
    return "America/Chicago";
  }
}

// Full IANA zone list where supported (all evergreen browsers this PWA
// targets); a short curated fallback otherwise so the picker never ends up
// empty on an older engine.
const FALLBACK_ZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Anchorage", "Pacific/Honolulu", "America/Phoenix", "UTC",
];
export function timezoneOptionsHTML(selected = "") {
  let zones;
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = FALLBACK_ZONES;
  }
  if (!zones.includes(selected)) zones = [selected, ...zones];
  return zones.map((z) => `<option value="${z}"${z === selected ? " selected" : ""}>${z.replace(/_/g, " ")}</option>`).join("");
}

// Offset (ms) of `timeZone` from UTC at the instant `date` represents — how
// much to SUBTRACT from a UTC-labeled guess of a wall-clock time to land on
// the real UTC instant. Standard Intl-based offset-probing technique (no
// date library ships with this project): format `date` in `timeZone`, then
// diff that wall-clock reading against `date`'s own UTC value.
function getOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const hour = parts.hour === "24" ? "00" : parts.hour; // midnight edge case in some engines
  const asIfUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +hour, +parts.minute, +parts.second);
  return asIfUTC - date.getTime();
}

// dateStr: "YYYY-MM-DD", timeStr: "HH:MM" (24-hour), timeZone: IANA string.
// Returns the ISO instant for that wall-clock time in that zone.
export function zonedTimeToUtcIso(dateStr, timeStr, timeZone) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const asUTC = Date.UTC(y, mo - 1, d, hh, mm, 0);
  const offset = getOffsetMs(new Date(asUTC), timeZone);
  return new Date(asUTC - offset).toISOString();
}

// The "YYYY-MM-DD" an instant reads as in a given IANA zone — used to
// prefill the edit-event modal's date input in whatever zone the event was
// originally scheduled in (details.timezone), rather than the editor's own
// device zone, so reopening an event for editing shows the date the creator
// actually picked even if the two are in different timezones.
export function dateStrInZone(iso, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return dtf.format(new Date(iso)); // en-CA formats as YYYY-MM-DD directly
}
