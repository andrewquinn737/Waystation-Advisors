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

// One representative zone per whole-hour UTC offset, -11 through +12 — the
// classic "24 time zones" list, rather than the full ~400-entry IANA list
// (too long to scan for picking a call time). Each option shows that zone's
// current local time alongside its label (see timezoneOptionsHTML) so
// picking the right one doesn't require doing the math yourself.
const CURATED_ZONES = [
  "Pacific/Niue", "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles",
  "America/Denver", "America/Chicago", "America/New_York", "America/Halifax",
  "America/Sao_Paulo", "Atlantic/South_Georgia", "Atlantic/Azores", "Europe/London",
  "Europe/Paris", "Europe/Athens", "Europe/Moscow", "Asia/Dubai", "Asia/Karachi",
  "Asia/Dhaka", "Asia/Bangkok", "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney",
  "Pacific/Noumea", "Pacific/Auckland",
];
const ZONE_LABELS = {
  "Pacific/Niue": "Niue",
  "Pacific/Honolulu": "Hawaii",
  "America/Anchorage": "Alaska",
  "America/Los_Angeles": "Pacific Time (US)",
  "America/Denver": "Mountain Time (US)",
  "America/Chicago": "Central Time (US)",
  "America/New_York": "Eastern Time (US)",
  "America/Halifax": "Atlantic Time (Canada)",
  "America/Sao_Paulo": "São Paulo",
  "Atlantic/South_Georgia": "South Georgia",
  "Atlantic/Azores": "Azores",
  "Europe/London": "London",
  "Europe/Paris": "Paris",
  "Europe/Athens": "Athens",
  "Europe/Moscow": "Moscow",
  "Asia/Dubai": "Dubai",
  "Asia/Karachi": "Karachi",
  "Asia/Dhaka": "Dhaka",
  "Asia/Bangkok": "Bangkok",
  "Asia/Shanghai": "Shanghai",
  "Asia/Tokyo": "Tokyo",
  "Australia/Sydney": "Sydney",
  "Pacific/Noumea": "New Caledonia",
  "Pacific/Auckland": "Auckland",
};

// Maps any IANA zone to whichever of the 24 curated options currently shares
// its UTC offset (returns it unchanged if it's already one of them) — used
// both for the device's own default zone and for prefilling an existing
// event's stored timezone if it's ever something outside the curated list
// (e.g. from before this list existed, or a zone like America/Detroit that
// currently reads the same as America/New_York but isn't itself curated).
export function nearestCuratedZone(zone) {
  if (CURATED_ZONES.includes(zone)) return zone;
  const targetOffset = getOffsetMs(new Date(), zone);
  let best = "America/Chicago";
  let bestDiff = Infinity;
  for (const z of CURATED_ZONES) {
    const diff = Math.abs(getOffsetMs(new Date(), z) - targetOffset);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = z;
    }
  }
  return best;
}

// The device's own current IANA zone, mapped to its nearest curated
// equivalent — used as the picker's default so nobody has to think about
// timezones unless they're deliberately scheduling something for someone
// else's zone.
export function defaultTimezone() {
  let deviceZone;
  try {
    deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago";
  } catch {
    deviceZone = "America/Chicago";
  }
  return nearestCuratedZone(deviceZone);
}

// The 24 curated zones above, each option's label showing that zone's
// current local time appended at the end.
export function timezoneOptionsHTML(selected = "") {
  const now = new Date();
  return CURATED_ZONES.map((z) => {
    const time = now.toLocaleTimeString(undefined, { timeZone: z, hour: "numeric", minute: "2-digit" });
    const label = `${(ZONE_LABELS[z] || z).padEnd(22)}— ${time}`;
    return `<option value="${z}"${z === selected ? " selected" : ""}>${label}</option>`;
  }).join("");
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
