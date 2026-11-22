export interface ImapConn {
  conn: Deno.TlsConn;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  buf: { data: Uint8Array };
  tagCounter: number;
}
async function readLine(c: ImapConn): Promise<string> {
  const decoder = new TextDecoder();
  while (true) {
    const nlIdx = c.buf.data.indexOf(10);
    if (nlIdx !== -1) {
      const line = c.buf.data.slice(0, nlIdx + 1);
      c.buf.data = c.buf.data.slice(nlIdx + 1);
      return decoder.decode(line);
    }
    const { value, done } = await c.reader.read();
    if (done) throw new Error("IMAP connection closed unexpectedly");
    const combined = new Uint8Array(c.buf.data.length + value.length);
    combined.set(c.buf.data, 0);
    combined.set(value, c.buf.data.length);
    c.buf.data = combined;
  }
}
async function readUntilTagged(c: ImapConn, tag: string): Promise<string[]> {
  const lines: string[] = [];
  while (true) {
    const line = await readLine(c);
    lines.push(line);
    if (line.startsWith(tag + " ")) break;
  }
  return lines;
}
function nextTag(c: ImapConn): string { c.tagCounter += 1; return `A${c.tagCounter}`; }
async function sendCmd(c: ImapConn, tag: string, cmd: string) { await c.writer.write(new TextEncoder().encode(`${tag} ${cmd}\r\n`)); }
function q(s: string): string { return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
export async function imapConnect(host: string, port: number): Promise<ImapConn> {
  const conn = await Deno.connectTls({ hostname: host, port });
  const c: ImapConn = { conn, reader: conn.readable.getReader(), writer: conn.writable.getWriter(), buf: { data: new Uint8Array(0) }, tagCounter: 0 };
  await readLine(c);
  return c;
}
export async function imapLogin(c: ImapConn, user: string, pass: string) {
  const tag = nextTag(c);
  await sendCmd(c, tag, `LOGIN ${q(user)} ${q(pass)}`);
  const lines = await readUntilTagged(c, tag);
  if (!new RegExp(`^${tag} OK`).test(lines[lines.length - 1])) throw new Error("IMAP login failed: " + lines[lines.length - 1].trim());
}
export async function imapLogout(c: ImapConn) {
  try { const tag = nextTag(c); await sendCmd(c, tag, "LOGOUT"); await readUntilTagged(c, tag); } catch { /* ignore */ }
  try { c.conn.close(); } catch { /* ignore */ }
}

// XOAUTH2 (Microsoft 365 app-only). `xoauth` is the base64 SASL string from _shared/msOauth.ts.
export async function imapAuthXoauth2(c: ImapConn, xoauth: string) {
  const tag = nextTag(c);
  await sendCmd(c, tag, "AUTHENTICATE XOAUTH2");
  const first = await readLine(c);
  if (first.startsWith(tag + " ")) throw new Error("IMAP login failed: " + first.trim());
  await c.writer.write(new TextEncoder().encode(xoauth + "\r\n"));
  while (true) {
    const line = await readLine(c);
    if (line.startsWith(tag + " ")) {
      if (!new RegExp(`^${tag} OK`).test(line)) throw new Error("IMAP login failed: " + line.trim());
      return;
    }
    if (line.startsWith("+")) await c.writer.write(new TextEncoder().encode("\r\n"));
  }
}
