// Microsoft 365 app-only OAuth for IMAP (XOAUTH2). Secrets: MS_OAUTH_CLIENT_ID, MS_OAUTH_CLIENT_SECRET.
// Tenant = the mailbox's domain. Tokens are cached per tenant in the isolate for ~50 minutes.
const cache = new Map<string, { token: string; exp: number }>();

export function usesMsOauth(account: { auth_method?: string | null }): boolean {
  return account.auth_method === "ms_oauth";
}

export async function getMsToken(username: string): Promise<string> {
  const tenant = (username.split("@").pop() || "").trim().toLowerCase();
  const hit = cache.get(tenant);
  if (hit && hit.exp > Date.now()) return hit.token;
  const id = Deno.env.get("MS_OAUTH_CLIENT_ID") || "", secret = Deno.env.get("MS_OAUTH_CLIENT_SECRET") || "";
  if (!id || !secret) throw new Error("Microsoft OAuth is not configured (MS_OAUTH_CLIENT_ID / MS_OAUTH_CLIENT_SECRET).");
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, scope: "https://outlook.office365.com/.default" }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error(`Microsoft token request failed for ${tenant}: ${String(j.error_description || j.error || r.status).split("\n")[0].slice(0, 200)}`);
  }
  cache.set(tenant, { token: j.access_token, exp: Date.now() + Math.min(Number(j.expires_in || 3600) - 600, 3000) * 1000 });
  return j.access_token;
}

export function xoauth2String(user: string, token: string): string {
  return btoa(`user=${user}\x01auth=Bearer ${token}\x01\x01`);
}
