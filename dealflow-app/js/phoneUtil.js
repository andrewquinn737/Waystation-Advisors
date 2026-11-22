// US phone numbers in +1XXXXXXXXXX form (what Telnyx needs, and what the database keeps in
// profiles.phone — see the profiles_normalize_phone trigger). null = not a valid US number.
export function toE164(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (/^[2-9]\d{9}$/.test(d)) return "+1" + d;
  if (/^1[2-9]\d{9}$/.test(d)) return "+" + d;
  return null;
}

// Display only: a bare 10-digit US number reads as (301) 852-1617. Anything else (extensions, +44, text) is shown as typed.
export function formatPhoneDisplay(raw) {
  const t = String(raw ?? "").trim();
  const d = t.replace(/\D/g, "");
  if (/^\+?1?[\s.-]*\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}$/.test(t) && /^1?[2-9]\d{9}$/.test(d) && !/^\(\d{3}\) \d{3}-\d{4}$/.test(t)) {
    const n = d.length === 11 ? d.slice(1) : d;
    return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
  }
  return t;
}
