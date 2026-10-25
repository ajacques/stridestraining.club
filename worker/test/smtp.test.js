import test from "node:test";
import assert from "node:assert/strict";
import { buildMessage, createSmtpClient, escapeHtml } from "../src/smtp.js";

const CRLF = "\r\n";
const encoder = new TextEncoder();

/**
 * Fake SMTP server: yields scripted replies as they are read, and records
 * everything the client writes. `replies` is consumed one per read.
 */
function fakeConnection(replies) {
  const written = [];
  const queue = [...replies];
  if (queue.length === 0) throw new Error("no replies scripted");

  let controller;
  const readable = new ReadableStream({
    start(c) {
      controller = c;
      for (const reply of queue) controller.enqueue(encoder.encode(reply + CRLF));
    },
  });

  const writable = new WritableStream({
    write(chunk) {
      written.push(new TextDecoder().decode(chunk));
    },
  });

  return { socket: { readable, writable, opened: Promise.resolve({}), close: async () => {} }, written };
}

const connectWith = (replies) => {
  const { socket, written } = fakeConnection(replies);
  return { connect: () => socket, written };
};

test("performs EHLO, AUTH, MAIL, RCPT, DATA and QUIT in order", async () => {
  const { connect, written } = connectWith([
    "220 fake ESMTP",
    "250-fake", // EHLO
    "250 AUTH PLAIN",
    "235 2.7.0 Authentication successful", // AUTH
    "250 2.1.0 Ok", // MAIL FROM
    "250 2.1.5 Ok", // RCPT TO
    "354 End data with <CR><LF>.<CR><LF>", // DATA
    "250 2.0.0 Ok: queued as ABC123", // end of data
    "221 2.0.0 Bye", // QUIT
  ]);

  const sendMail = createSmtpClient(connect);
  await sendMail({
    host: "smtp.example.com",
    port: 587,
    username: "user@example.com",
    password: "hunter2",
    secure: "off",
    from: "noreply@example.com",
    to: "coach@example.com",
    subject: "Hello",
    text: "plain body",
    html: "<p>html body</p>",
    replyTo: "visitor@example.com",
  });

  const sent = written.join("");
  assert.match(sent, /^EHLO /);
  assert.match(sent, /AUTH PLAIN /);
  assert.ok(!sent.includes("hunter2"), "password must be base64 encoded, not plaintext");
  assert.match(sent, /MAIL FROM:<noreply@example\.com>/);
  assert.match(sent, /RCPT TO:<coach@example\.com>/);
  assert.match(sent, /Reply-To: visitor@example\.com/);
  assert.match(sent, /\r\n\.\r\n/, "message must be terminated by a lone dot");
  assert.ok(sent.trimEnd().endsWith("QUIT"), "QUIT should be the final command");
});

test("throws with the server code when a command is rejected", async () => {
  const { connect } = connectWith([
    "220 fake ESMTP",
    "250 ok", // EHLO
    "250 ok", // MAIL FROM
    "550 5.1.1 No such user", // RCPT TO
  ]);

  const sendMail = createSmtpClient(connect);
  await assert.rejects(
    sendMail({
      host: "smtp.example.com",
      port: 587,
      secure: "off",
      from: "noreply@example.com",
      to: "missing@example.com",
      subject: "Hi",
      text: "body",
      html: "<p>body</p>",
    }),
    (error) => {
      assert.equal(error.code, 550);
      assert.match(error.message, /No such user/);
      return true;
    },
  );
});

test("upgrades the socket with STARTTLS before authenticating", async () => {
  const calls = [];
  const { socket } = fakeConnection([
    "220 fake ESMTP",
    "250-fake",
    "250 STARTTLS", // EHLO
    "220 Go ahead", // STARTTLS
    "250-fake",
    "250 AUTH PLAIN", // EHLO again after upgrade
    "235 ok", // AUTH
    "250 ok", // MAIL
    "250 ok", // RCPT
    "354 go", // DATA
    "250 queued",
    "221 bye",
  ]);

  const secureSocket = {
    readable: socket.readable,
    writable: socket.writable,
    opened: Promise.resolve({}),
    close: async () => {},
  };

  const connect = (address, options) => {
    calls.push({ address, options });
    return { ...socket, startTls: () => (calls.push("starttls"), { ...secureSocket, startTls() {} }) };
  };

  const sendMail = createSmtpClient(connect);
  await sendMail({
    host: "smtp.example.com",
    port: 587,
    username: "user@example.com",
    password: "secret",
    secure: "starttls",
    from: "noreply@example.com",
    to: "coach@example.com",
    subject: "Hi",
    text: "body",
    html: "<p>body</p>",
  });

  assert.equal(calls[0].options.secureTransport, "starttls");
  assert.ok(calls.includes("starttls"), "socket should be upgraded via startTls()");
});

test("supports AUTH LOGIN from credentials", async () => {
  const { connect, written } = connectWith([
    "220 fake ESMTP",
    "250 ok", // EHLO
    "334 VXNlcm5hbWU6", // AUTH LOGIN
    "334 UGFzc3dvcmQ6", // username
    "235 ok", // password
    "250 ok", // MAIL
    "250 ok", // RCPT
    "354 go", // DATA
    "250 queued",
    "221 bye",
  ]);

  const sendMail = createSmtpClient(connect);
  await sendMail({
    host: "smtp.example.com",
    port: 587,
    username: "user@example.com",
    password: "hunter2",
    auth: "login",
    secure: "off",
    from: "noreply@example.com",
    to: "coach@example.com",
    subject: "Hi",
    text: "body",
    html: "<p>body</p>",
  });

  const sent = written.join("");
  assert.match(sent, /AUTH LOGIN/);
  assert.ok(sent.includes(Buffer.from("user@example.com").toString("base64")));
  assert.ok(sent.includes(Buffer.from("hunter2").toString("base64")));
});

test("skips AUTH when auth is none", async () => {
  const { connect, written } = connectWith([
    "220 fake ESMTP",
    "250 ok",
    "250 ok",
    "250 ok",
    "354 go",
    "250 queued",
    "221 bye",
  ]);

  const sendMail = createSmtpClient(connect);
  await sendMail({
    host: "smtp.example.com",
    port: 25,
    username: "user@example.com",
    password: "hunter2",
    auth: "none",
    secure: "off",
    from: "noreply@example.com",
    to: "coach@example.com",
    subject: "Hi",
    text: "body",
    html: "<p>body</p>",
  });

  assert.ok(!written.join("").includes("AUTH"));
});

test("buildMessage emits multipart alternative with both parts", () => {
  const message = buildMessage({
    from: "a@example.com",
    to: "b@example.com",
    subject: "Ünïcode subject",
    text: "plain",
    html: "<b>rich</b>",
    replyTo: "c@example.com",
    date: new Date("2026-01-01T00:00:00Z"),
  });

  assert.match(message, /Content-Type: multipart\/alternative/);
  assert.match(message, /text\/plain/);
  assert.match(message, /text\/html/);
  assert.match(message, /Reply-To: c@example\.com/);
  assert.match(message, /Subject: =\?UTF-8\?B\?/);
  assert.match(message, /Content-Transfer-Encoding: quoted-printable/);
});

test("quoted-printable escapes reserved characters and keeps lines short", () => {
  const message = buildMessage({
    from: "a@example.com",
    to: "b@example.com",
    subject: "x",
    text: "line=with=equals " + "and a very long run of characters ".repeat(10),
    html: "<p>hi</p>",
  });

  assert.match(message, /=3D/, "equals sign should be encoded");
  for (const line of message.split(CRLF)) {
    assert.ok(line.length <= 76, `line too long: ${line.length}`);
  }
});

test("escapeHtml neutralises markup in user input", () => {
  assert.equal(
    escapeHtml(`<script>"x"&'y'</script>`),
    "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;",
  );
});
