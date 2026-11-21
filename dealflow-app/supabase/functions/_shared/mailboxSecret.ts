// Mailbox passwords live in Supabase Vault (email_accounts.password_secret_id). Plain-text email_accounts.password
// is only a rollout fallback: read it if Vault has nothing, and never rely on it where the migration has run.
// get_mailbox_password / set_mailbox_password are executable by service_role only.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export async function getMailboxPassword(admin: SupabaseClient, account: { id: string; password?: string | null }): Promise<string> {
  try {
    const { data, error } = await admin.rpc("get_mailbox_password", { p_account: account.id });
    if (!error && typeof data === "string" && data) return data;
  } catch { /* fall through to the legacy column */ }
  return account.password || "";
}

// Stores the password in Vault. Only if the function does not exist yet (migration not applied) does it write the legacy column.
export async function setMailboxPassword(admin: SupabaseClient, id: string, password: string): Promise<void> {
  const { error } = await admin.rpc("set_mailbox_password", { p_account: id, p_password: password });
  if (!error) return;
  if (error.code === "PGRST202" || error.code === "42883") {
    const { error: e2 } = await admin.from("email_accounts").update({ password }).eq("id", id);
    if (e2) throw new Error(e2.message);
    return;
  }
  throw new Error(error.message);
}
