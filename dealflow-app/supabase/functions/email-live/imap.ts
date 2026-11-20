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
    let line = await readLine(c);
    let litMatch = line.match(/\{(\d+)\}\r\n$/);
    while (litMatch) {
      const n = parseInt(litMatch[1], 10);
      let literal = new Uint8Array(0);
      while (literal.length < n) {
        if (c.buf.data.length === 0) {
          const { value, done } = await c.reader.read();
          if (done) throw new Error("IMAP connection closed mid-literal");
          c.buf.data = value;
        }
        const need = n - literal.length;
        const take = c.buf.data.slice(0, need);
        c.buf.data = c.buf.data.slice(take.length);
        const combined = new Uint8Array(literal.length + take.length);
        combined.set(literal, 0);
        combined.set(take, literal.length);
        literal = combined;
      }
      line += new TextDecoder().decode(literal);
      const rest = await readLine(c);
      line += rest;
      litMatch = rest.match(/\{(\d+)\}\r\n$/);
    }
    lines.push(line);
    if (line.startsWith(tag + " ")) break;
  }
  return lines;
}
function nextTag(c: ImapConn): string { c.tagCounter += 1; return `A${c.tagCounter}`; }
async function sendCmd(c: ImapConn, tag: string, cmd: string) { await c.writer.write(new TextEncoder().encode(`${tag} ${cmd}\r\n`)); }
function q(s: string): string { return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
function ok(lines: string[], tag: string): boolean { return new RegExp(`^${tag} OK`).test(lines[lines.length - 1]); }
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
  if (!ok(lines, tag)) throw new Error("IMAP login failed: " + lines[lines.length - 1].trim());
}
export async function imapList(c: ImapConn): Promise<{ name: string; attrs: string }[]> {
  const tag = nextTag(c);
  await sendCmd(c, tag, 'LIST "" "*"');
  const lines = await readUntilTagged(c, tag);
  const out: { name: string; attrs: string }[] = [];
  for (const line of lines) {
    const m = line.match(/^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (?:"((?:[^"\\]|\\.)*)"|(\S+))\r?\n?$/);
    if (m) out.push({ attrs: m[1], name: (m[2] ?? m[3]).replace(/\\(.)/g, "$1") });
  }
  return out;
}
export async function imapStatus(c: ImapConn, mailbox: string): Promise<{ messages: number; unseen: number }> {
  const tag = nextTag(c);
  await sendCmd(c, tag, `STATUS ${q(mailbox)} (MESSAGES UNSEEN)`);
  const lines = await readUntilTagged(c, tag);
  if (!ok(lines, tag)) throw new Error("STATUS failed: " + lines[lines.length - 1].trim());
  const m = lines.join("").match(/MESSAGES (\d+)/);
  const u = lines.join("").match(/UNSEEN (\d+)/);
  return { messages: m ? parseInt(m[1], 10) : 0, unseen: u ? parseInt(u[1], 10) : 0 };
}
export async function imapExamine(c: ImapConn, mailbox: string) {
  const tag = nextTag(c);
  await sendCmd(c, tag, `EXAMINE ${q(mailbox)}`);
  const lines = await readUntilTagged(c, tag);
  if (!ok(lines, tag)) throw new Error("IMAP EXAMINE failed: " + lines[lines.length - 1].trim());
}
export async function imapSearchAll(c: ImapConn): Promise<number[]> {
  const tag = nextTag(c);
  await sendCmd(c, tag, "UID SEARCH ALL");
  const lines = await readUntilTagged(c, tag);
  const uids: number[] = [];
  for (const line of lines) {
    const m = line.match(/^\* SEARCH(.*)/);
    if (m) for (const tok of m[1].trim().split(/\s+/)) if (tok) uids.push(parseInt(tok, 10));
  }
  return [...new Set(uids.filter((n) => !isNaN(n)))];
}
export async function imapFetchHeaders(c: ImapConn, uids: number[]): Promise<{ uid: number; flags: string; header: string }[]> {
  const tag = nextTag(c);
  await sendCmd(c, tag, `UID FETCH ${uids.join(",")} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])`);
  const lines = await readUntilTagged(c, tag);
  const out: { uid: number; flags: string; header: string }[] = [];
  for (const line of lines) {
    if (!/^\* \d+ FETCH/.test(line)) continue;
    const uid = line.match(/UID (\d+)/);
    const flags = line.match(/FLAGS \(([^)]*)\)/);
    const litStart = line.indexOf("}\r\n");
    if (!uid || litStart === -1) continue;
    out.push({ uid: parseInt(uid[1], 10), flags: flags ? flags[1] : "", header: line.slice(litStart + 3).replace(/\)\r?\n?$/, "") });
  }
  return out;
}
export async function imapFetchRaw(c: ImapConn, uid: number): Promise<Uint8Array> {
  const tag = nextTag(c);
  await sendCmd(c, tag, `UID FETCH ${uid} (BODY.PEEK[])`);
  const chunks: Uint8Array[] = [];
  while (true) {
    const line = await readLine(c);
    const litMatch = line.match(/\{(\d+)\}\r\n$/);
    if (litMatch) {
      const n = parseInt(litMatch[1], 10);
      let got = 0;
      while (got < n) {
        if (c.buf.data.length === 0) {
          const { value, done } = await c.reader.read();
          if (done) throw new Error("IMAP connection closed mid-fetch");
          c.buf.data = value;
        }
        const need = n - got;
        const take = c.buf.data.slice(0, need);
        c.buf.data = c.buf.data.slice(take.length);
        chunks.push(take);
        got += take.length;
      }
      continue;
    }
    if (line.startsWith(tag + " ")) {
      if (!new RegExp(`^${tag} OK`).test(line)) throw new Error("IMAP FETCH failed: " + line.trim());
      break;
    }
  }
  const total = chunks.reduce((s, ch) => s + ch.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const ch of chunks) { out.set(ch, offset); offset += ch.length; }
  return out;
}
export async function imapLogout(c: ImapConn) {
  try { const tag = nextTag(c); await sendCmd(c, tag, "LOGOUT"); await readUntilTagged(c, tag); } catch { /* ignore */ }
  try { c.conn.close(); } catch { /* ignore */ }
}
