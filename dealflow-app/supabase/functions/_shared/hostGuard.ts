// Never connect a mail client to a private / loopback / link-local address (SSRF). Resolves A and AAAA and
// rejects if ANY answer is private. A host that does not resolve is not "private" (the connect fails by itself).

export function isPrivateIp(ip: string): boolean {
  const s = ip.trim().toLowerCase();
  const m4 = s.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4) {
    const [a, b] = [Number(m4[1]), Number(m4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || a >= 224;
  }
  if (s.includes(":")) {
    if (s === "::" || s === "::1") return true;
    if (/^f[cd]/.test(s) || /^fe[89ab]/.test(s)) return true;
    const mapped = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) { const hi = parseInt(mapped[1], 16); return isPrivateIp(`${hi >> 8}.${hi & 255}.0.0`); }
    return false;
  }
  return false;
}

export const isIpLiteral = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");

export async function hostIsPrivate(host: string): Promise<boolean> {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (isIpLiteral(h)) return isPrivateIp(h);
  for (const type of ["A", "AAAA"] as const) {
    try {
      const ips = await Deno.resolveDns(h, type);
      if (ips.some((ip) => isPrivateIp(String(ip)))) return true;
    } catch { /* no records of this type */ }
  }
  return false;
}
