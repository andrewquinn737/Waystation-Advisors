// Minimal hand-rolled SMTP client over Deno.connectTls (SMTPS). Same
// reasoning as imap.ts in email-sync: npm socket libraries crashed the Edge
// Function isolate outright in testing.

async function readLine(reader: ReadableStreamDefaultReader<Uint8Array>, buf: { data: Uint8Array }): Promise<string> {
  const decoder = new TextDecoder();
  while (true) {
    const nlIdx = buf.data.indexOf(10);
    if (nlIdx !== -1) {
      const line = buf.data.slice(0, nlIdx + 1);
      buf.data = buf.data.slice(nlIdx + 1);
      return decoder.decode(line);
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("SMTP connection closed unexpectedly");
    const combined = new Uint8Array(buf.data.length + value.length);
    combined.set(buf.data, 0);
    combined.set(value, buf.data.length);
    buf.data = combined;
  }
}

export async function smtpSend(opts: {
  host: string;
  port: number;
  username: string;
  password: string;
  raw: string;
}): Promise<{ ok: boolean; log: string[]; rejected: string[]; accepted: string[] }> {
  const log: string[] = [];
  const rejected: string[] = [];
  const accepted: string[] = [];
  // 465 = implicit TLS (SMTPS). 587/25 = plain connect, then STARTTLS upgrade
  // (Microsoft 365 only offers 587 + STARTTLS).
  const startTls = opts.port === 587 || opts.port === 25;
  let conn: Deno.Conn | Deno.TlsConn = startTls
    ? await Deno.connect({ hostname: opts.host, port: opts.port })
    : await Deno.connectTls({ hostname: opts.host, port: opts.port });
  try {
    let reader = conn.readable.getReader();
    let writer = conn.writable.getWriter();
    const buf = { data: new Uint8Array(0) };
    const encoder = new TextEncoder();
    async function send(line: string) {
      await writer.write(encoder.encode(line + "\r\n"));
    }
    async function readMulti(): Promise<string> {
      let all = "";
      while (true) {
        const line = await readLine(reader, buf);
        all += line;
        if (/^\d{3} /.test(line)) break;
      }
      return all;
    }

    log.push("greeting: " + (await readMulti()).trim());
    await send("EHLO waystation-advisors.app");
    log.push("ehlo");
    const ehlo = await readMulti();

    if (startTls) {
      if (!/STARTTLS/i.test(ehlo)) throw new Error("Server on port " + opts.port + " does not offer STARTTLS");
      await send("STARTTLS");
      const ready = await readMulti();
      if (!/^220/.test(ready)) throw new Error("STARTTLS refused: " + ready.trim());
      reader.releaseLock();
      writer.releaseLock();
      buf.data = new Uint8Array(0);
      conn = await Deno.startTls(conn as Deno.Conn, { hostname: opts.host });
      reader = conn.readable.getReader();
      writer = conn.writable.getWriter();
      await send("EHLO waystation-advisors.app");
      await readMulti();
      log.push("starttls ok");
    }

    await send("AUTH LOGIN");
    await readMulti();
    await send(btoa(opts.username));
    await readMulti();
    await send(btoa(opts.password));
    const authResult = await readMulti();
    if (!/^235/.test(authResult)) throw new Error("SMTP auth failed: " + authResult.trim());

    const headerEnd = opts.raw.indexOf("\r\n\r\n");
    const headers = opts.raw.slice(0, headerEnd === -1 ? opts.raw.length : headerEnd);
    const fromMatch = headers.match(/^From:\s*.*?<?([^\s<>]+@[^\s<>]+)>?\s*$/im);
    const toMatches = [...headers.matchAll(/^(?:To|Cc):\s*(.+)$/gim)].flatMap((m) =>
      [...m[1].matchAll(/([^\s<>,]+@[^\s<>,]+)/g)].map((x) => x[1])
    );
    if (!fromMatch) throw new Error("Could not determine From address from message headers");
    if (!toMatches.length) throw new Error("Could not determine any recipient from message headers");

    await send(`MAIL FROM:<${fromMatch[1]}>`);
    await readMulti();
    for (const to of toMatches) {
      await send(`RCPT TO:<${to}>`);
      const rcptResult = await readMulti();
      if (/^2\d\d/.test(rcptResult)) {
        accepted.push(to);
      } else {
        rejected.push(to);
        log.push(`rcpt ${to} rejected: ${rcptResult.trim()}`);
      }
    }
    if (!accepted.length) {
      // Every recipient refused — nothing would be delivered, so fail loudly
      // instead of sending DATA to an envelope with no valid recipient.
      await send("QUIT");
      return { ok: false, log, rejected, accepted };
    }
    await send("DATA");
    await readMulti();

    const stuffed = opts.raw.replace(/\r\n\./g, "\r\n..");
    await writer.write(encoder.encode(stuffed + "\r\n.\r\n"));
    const sendResult = await readMulti();
    log.push("send result: " + sendResult.trim());

    await send("QUIT");
    await readMulti().catch(() => {});

    return { ok: /^250/.test(sendResult), log, rejected, accepted };
  } finally {
    try {
      conn.close();
    } catch {
      // ignore
    }
  }
}
