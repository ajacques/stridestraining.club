const CRLF = "\r\n";

const encoder = new TextEncoder();

const toBase64 = (value) => {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

class SmtpError extends Error {
  constructor(message, { code = null, stage = null } = {}) {
    super(message);
    this.name = "SmtpError";
    this.code = code;
    this.stage = stage;
  }
}

/**
 * Buffers raw socket bytes and exposes them as SMTP reply lines.
 * SMTP replies may span several lines: "250-first", "250-second", "250 last".
 */
class ReplyReader {
  constructor(readable) {
    this.reader = readable.getReader();
    this.decoder = new TextDecoder();
    this.buffer = "";
  }

  async readReply() {
    const lines = [];
    for (;;) {
      let index;
      while ((index = this.buffer.indexOf(CRLF)) === -1) {
        const { value, done } = await this.reader.read();
        if (done) {
          throw new SmtpError("Connection closed while awaiting SMTP reply");
        }
        this.buffer += this.decoder.decode(value, { stream: true });
      }
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + CRLF.length);
      lines.push(line);
      if (line.length < 4 || line[3] !== "-") break;
    }

    const last = lines[lines.length - 1];
    const code = Number.parseInt(last.slice(0, 3), 10);
    return { code, lines, text: lines.map((line) => line.slice(4)).join("\n") };
  }
}

/**
 * Minimal SMTP client over cloudflare:sockets.
 *
 * `connect` is injected so the client can be exercised against a fake socket
 * in tests; in a Worker it is the runtime `connect` from "cloudflare:sockets".
 */
export function createSmtpClient(connect, { timeoutMs = 15000 } = {}) {
  return async function sendMail(config) {
    const { host, port, username, password, auth = "plain", secure, from, to, subject, text, html, replyTo } = config;

    const transport = secure === "tls" ? "on" : secure === "starttls" ? "starttls" : "off";
    let socket = connect({ hostname: host, port }, { secureTransport: transport });

    let writer = socket.writable.getWriter();
    let reader = new ReplyReader(socket.readable);
    const deadline = Date.now() + timeoutMs;

    const withTimeout = async (promise, description) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SmtpError(`Timed out during ${description}`);
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SmtpError(`Timed out during ${description}`)), remaining);
      });
      try {
        return await Promise.race([promise, timeout]);
      } finally {
        clearTimeout(timer);
      }
    };

    const command = async (line, expected, { redact = false } = {}) => {
      await withTimeout(writer.write(encoder.encode(line + CRLF)), redact ? "AUTH" : line.slice(0, 4));
      const reply = await withTimeout(reader.readReply(), redact ? "AUTH" : line.slice(0, 4));
      if (!expected.includes(reply.code)) {
        throw new SmtpError(`Unexpected SMTP reply: ${reply.code} ${reply.text}`, {
          code: reply.code,
          stage: redact ? "AUTH" : line.slice(0, 4),
        });
      }
      return reply;
    };

    try {
      await socket.opened;
      // Server greeting must arrive before the client may speak.
      const greeting = await withTimeout(reader.readReply(), "greeting");
      if (greeting.code !== 220) {
        throw new SmtpError(`Server refused connection: ${greeting.code} ${greeting.text}`, {
          code: greeting.code,
          stage: "greeting",
        });
      }
      await command("EHLO samilee.me", [250]);

      if (secure === "starttls") {
        await command("STARTTLS", [220]);
        writer.releaseLock();
        reader.reader.releaseLock();
        socket = socket.startTls();
        writer = socket.writable.getWriter();
        reader = new ReplyReader(socket.readable);
        await command("EHLO samilee.me", [250]);
      }

      if (auth === "plain" && username) {
        const encoded = toBase64(`\u0000${username}\u0000${password}`);
        await command(`AUTH PLAIN ${encoded}`, [235], { redact: true });
      } else if (auth === "login" && username) {
        await command("AUTH LOGIN", [334], { redact: true });
        await command(toBase64(username), [334], { redact: true });
        await command(toBase64(password), [235], { redact: true });
      }

      await command(`MAIL FROM:<${from}>`, [250]);
      await command(`RCPT TO:<${to}>`, [250, 251]);
      await command("DATA", [354]);

      const message = buildMessage({ from, to, subject, text, html, replyTo });
      await withTimeout(writer.write(encoder.encode(message + CRLF + "." + CRLF)), "DATA body");
      await command("", [250]);
      await command("QUIT", [221]);
    } finally {
      try {
        await socket.close();
      } catch {
        /* already closed */
      }
    }
  };
}

export function buildMessage({ from, to, subject, text, html, replyTo, date = new Date() }) {
  const boundary = `strides-${date.getTime().toString(36)}`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString()}`,
    "MIME-Version: 1.0",
  ];
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(html),
    `--${boundary}--`,
  ];

  return headers.concat(body).join(CRLF);
}

function encodeHeader(value) {
  const ascii = /^[\x20-\x7e]*$/.test(value);
  if (ascii) return value;
  // RFC 2047 B-encoding for non-ASCII subjects.
  return `=?UTF-8?B?${toBase64(value)}?=`;
}

function encodeQuotedPrintable(value) {
  const bytes = encoder.encode(value);
  let out = "";
  let lineLength = 0;

  for (const byte of bytes) {
    let token;
    if (byte === 0x0a) {
      out += CRLF;
      lineLength = 0;
      continue;
    }
    if (byte === 0x0d) continue;

    const printable = byte >= 0x21 && byte <= 0x7e && byte !== 0x3d;
    token = printable ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;

    // Keep lines under the 76-character limit with room for a soft break.
    if (lineLength + token.length > 74) {
      out += `=${CRLF}`;
      lineLength = 0;
    }
    out += token;
    lineLength += token.length;
  }

  return out;
}

/** Escapes user input for safe interpolation into the HTML email body. */
export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
