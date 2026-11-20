// Minimal hand-rolled IMAP4rev1 client over Deno.connectTls. Deliberately NOT
// using npm:imapflow — confirmed (see build notes) that its connect() call
// crashes the Edge Function isolate outright, uncatchable even wrapped in
// try/catch + a race timeout. This only implements the handful of commands
// email-sync actually needs: LOGIN, SELECT, UID SEARCH, UID FETCH, LOGOUT.

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
    const litMatch = line.match(/\{(\d+)\}\r\n$/);
    if (litMatch) {
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
      const restNlIdx = c.buf.data.indexOf(10);
      if (restNlIdx !== -1) {
        line += new TextDecoder().decode(c.buf.data.slice(0, restNlIdx + 1));
        c.buf.data = c.buf.data.slice(restNlIdx + 1);
      }
    }
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

export async function imapLogin(c: ImapConn, user: string, pass: string) {
  const tag = nextTag(c);
  await sendCmd(c, tag, `LOGIN ${escapeImapString(user)} ${escapeImapString(pass)}`);
  const lines = await readUntilTagged(c, tag);
  const last = lines[lines.length - 1];
  if (!new RegExp(`^${tag} OK`).test(last)) throw new Error("IMAP login failed: " + last.trim());
}

export async function imapSelect(c: ImapConn, mailbox: string): Promise<{ exists: number; uidValidity: number }> {
  const tag = nextTag(c);
  await sendCmd(c, tag, `SELECT ${escapeImapString(mailbox)}`);
  const lines = await readUntilTagged(c, tag);
  const last = lines[lines.length - 1];
  if (!new RegExp(`^${tag} OK`).test(last)) throw new Error("IMAP SELECT failed: " + last.trim());
  let exists = 0;
  let uidValidity = 0;
  for (const line of lines) {
    const existsMatch = line.match(/^\* (\d+) EXISTS/);
    if (existsMatch) exists = parseInt(existsMatch[1], 10);
    const uvMatch = line.match(/UIDVALIDITY (\d+)/);
    if (uvMatch) uidValidity = parseInt(uvMatch[1], 10);
  }
  return { exists, uidValidity };
}

export async function imapSearchUidsSince(c: ImapConn, sinceUid: number): Promise<number[]> {
  const tag = nextTag(c);
  const range = sinceUid > 0 ? `${sinceUid + 1}:*` : `1:*`;
  await sendCmd(c, tag, `UID SEARCH UID ${range}`);
  const lines = await readUntilTagged(c, tag);
  const uids: number[] = [];
  for (const line of lines) {
    const m = line.match(/^\* SEARCH(.*)/);
    if (m) {
      for (const tok of m[1].trim().split(/\s+/)) {
        const n = parseInt(tok, 10);
        if (!isNaN(n)) uids.push(n);
      }
    }
  }
  return [...new Set(uids)].sort((a, b) => a - b);
}

// `section` is the IMAP BODY section: "" for the whole message, or e.g.
// "HEADER.FIELDS (SUBJECT)" to pull just the Subject header.
export async function imapFetchRaw(c: ImapConn, uid: number, section = ""): Promise<Uint8Array> {
  const tag = nextTag(c);
  await sendCmd(c, tag, `UID FETCH ${uid} (BODY.PEEK[${section}])`);
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
  const total = chunks.reduce((sum, ch) => sum + ch.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const ch of chunks) {
    out.set(ch, offset);
    offset += ch.length;
  }
  return out;
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
