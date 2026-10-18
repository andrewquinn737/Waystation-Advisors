// US phone numbers in +1XXXXXXXXXX form (what Telnyx needs, and what the database keeps in
// profiles.phone — see the profiles_normalize_phone trigger). null = not a valid US number.
export function toE164(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (/^[2-9]\d{9}$/.test(d)) return "+1" + d;
  if (/^1[2-9]\d{9}$/.test(d)) return "+" + d;
  return null;
}
