// Just enough IMAP to file a sent copy: connect, LOGIN, LIST (find the Sent
// folder), APPEND, LOGOUT. Hand-rolled over Deno.connectTls for the same
// reason as email-sync's (npm:imapflow crashes the isolate).

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

function nextTag(c: ImapConn): string {
  c.tagCounter += 1;
  return `A${c.tagCounter}`;
}

async function sendCmd(c: ImapConn, tag: string, cmd: string) {
  await c.writer.write(new TextEncoder().encode(`${tag} ${cmd}\r\n`));
}

function escapeImapString(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export async function imapConnect(host: string, port: number): Promise<ImapConn> {
  const conn = await Deno.connectTls({ hostname: host, port });
  const c: ImapConn = {
    conn,
    reader: conn.readable.getReader(),
    writer: conn.writable.getWriter(),
    buf: { data: new Uint8Array(0) },
    tagCounter: 0,
  };
  await readLine(c);
  return c;
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
    if (line.startsWith("+")) await c.writer.write(new TextEncoder().encode("\r\n")); // error challenge: cancel, tagged NO follows
  }
}

export async function imapLogin(c: ImapConn, user: string, pass: string) {
  const tag = nextTag(c);
  await sendCmd(c, tag, `LOGIN ${escapeImapString(user)} ${escapeImapString(pass)}`);
  const lines = await readUntilTagged(c, tag);
  const last = lines[lines.length - 1];
  if (!new RegExp(`^${tag} OK`).test(last)) throw new Error("IMAP login failed: " + last.trim());
}

export async function imapLogout(c: ImapConn) {
  try {
    const tag = nextTag(c);
    await sendCmd(c, tag, "LOGOUT");
    await readUntilTagged(c, tag);
  } catch {
    // ignore
  }
  try {
    c.conn.close();
  } catch {
    // ignore
  }
}

// Prefers the server's \Sent special-use flag, then common names, then "Sent".
export async function imapFindSentFolder(c: ImapConn): Promise<string> {
  const tag = nextTag(c);
  await sendCmd(c, tag, 'LIST "" "*"');
  const lines = await readUntilTagged(c, tag);
  const names: { name: string; attrs: string }[] = [];
  for (const line of lines) {
    const m = line.match(/^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (?:"((?:[^"\\]|\\.)*)"|(\S+))\r?\n?$/);
    if (m) names.push({ attrs: m[1], name: (m[2] ?? m[3]).replace(/\\(.)/g, "$1") });
  }
  const special = names.find((n) => /\\Sent\b/i.test(n.attrs));
  if (special) return special.name;
  const byName = names.find((n) => /^(inbox[./])?sent( items| messages| mail)?$/i.test(n.name));
  return byName ? byName.name : "Sent";
}

// SMTP only delivers a message; it never saves a sent copy. Every mail client
// files its own copy via IMAP APPEND afterwards — this is that step.
export async function imapAppend(c: ImapConn, folder: string, raw: Uint8Array, flags = "\\Seen") {
  const tag = nextTag(c);
  await sendCmd(c, tag, `APPEND ${escapeImapString(folder)} (${flags}) {${raw.length}}`);
  const cont = await readLine(c);
  if (!cont.startsWith("+")) throw new Error("IMAP APPEND rejected: " + cont.trim());
  const out = new Uint8Array(raw.length + 2);
  out.set(raw, 0);
  out[raw.length] = 13;
  out[raw.length + 1] = 10;
  await c.writer.write(out);
  const lines = await readUntilTagged(c, tag);
  const last = lines[lines.length - 1];
  if (!new RegExp(`^${tag} OK`).test(last)) throw new Error("IMAP APPEND failed: " + last.trim());
}
