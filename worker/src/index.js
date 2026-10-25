import { connect } from "cloudflare:sockets";
import { createSmtpClient, escapeHtml } from "./smtp.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_NAME = 120;
const MAX_EMAIL = 254;
const MAX_MESSAGE = 5000;
const MIN_FILL_MS = 1500;

const sendMail = createSmtpClient(connect);

const parseList = (value) =>
  (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

function corsHeaders(env, request) {
  const allowed = parseList(env.ALLOWED_ORIGINS);
  const origin = request.headers.get("Origin");
  const headers = { Vary: "Origin" };
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "1800";
  }
  return headers;
}

function redirectTarget(env, key, fallback) {
  return new URL(env[key] || fallback, env.SITE_URL).toString();
}

const wantsHtml = (request) =>
  request.headers.get("Accept")?.includes("text/html") ?? false;

function successResponse(env, request) {
  const target = redirectTarget(env, "SUCCESS_REDIRECT", "/thanks/");
  if (wantsHtml(request)) {
    return Response.redirect(target, 303);
  }
  return Response.json({ ok: true, redirect: target }, { headers: corsHeaders(env, request) });
}

function errorResponse(env, request, status, message) {
  const target = redirectTarget(env, "ERROR_REDIRECT", "/contact/#contact");
  if (wantsHtml(request)) {
    const url = new URL(target);
    url.searchParams.set("error", message);
    return Response.redirect(url.toString(), 303);
  }
  return Response.json({ ok: false, error: message }, { status, headers: corsHeaders(env, request) });
}

async function readFields(request) {
  const contentType = request.headers.get("Content-Type") || "";
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw Object.assign(new Error("Request body too large"), { status: 413 });
  }

  if (contentType.includes("application/json")) {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") throw new Error("Invalid JSON body");
    return data;
  }

  const data = Object.fromEntries(new URLSearchParams(raw));
  return data;
}

function validate(fields) {
  const name = String(fields.name ?? "").trim();
  const email = String(fields.email ?? "").trim();
  const message = String(fields.message ?? "").trim();
  const elapsed = Number(fields.elapsed ?? 0);

  if (fields.company) return { spam: true };
  if (Number.isFinite(elapsed) && elapsed > 0 && elapsed < MIN_FILL_MS) return { spam: true };

  if (!name || name.length > MAX_NAME) {
    return { error: "Please enter your name." };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > MAX_EMAIL) {
    return { error: "Please enter a valid email address." };
  }
  if (!message || message.length > MAX_MESSAGE) {
    return { error: "Please enter a message." };
  }

  return { name, email, message };
}

function composeEmail({ name, email, message }) {
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safeMessage = escapeHtml(message).replaceAll("\n", "<br>");

  const text = [
    `New contact form submission from samilee.me`,
    "",
    `Name:    ${name}`,
    `Email:   ${email}`,
    "",
    "Message:",
    message,
  ].join("\n");

  const html = [
    `<h2>New contact form submission</h2>`,
    `<p><strong>Name:</strong> ${safeName}<br>`,
    `<strong>Email:</strong> ${safeEmail}</p>`,
    `<p><strong>Message:</strong></p>`,
    `<p>${safeMessage}</p>`,
  ].join("\n");

  return { text, html };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST, OPTIONS" },
      });
    }

    let fields;
    try {
      fields = await readFields(request);
    } catch (error) {
      return errorResponse(env, request, error.status || 400, "We couldn't read your message. Please try again.");
    }

    const result = validate(fields);
    if (result.spam) {
      // Pretend success so bots get no signal.
      return successResponse(env, request);
    }
    if (result.error) {
      return errorResponse(env, request, 400, result.error);
    }

    const { text, html } = composeEmail(result);
    const subject = env.SUBJECT_TEMPLATE
      ? env.SUBJECT_TEMPLATE.replaceAll("{name}", result.name)
      : `New coaching enquiry from ${result.name}`;

    try {
      await sendMail({
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT || 587),
        username: env.SMTP_USERNAME || "",
        password: env.SMTP_PASSWORD || "",
        auth: (env.SMTP_AUTH || "plain").toLowerCase(),
        secure: env.SMTP_SECURE || "starttls",
        from: env.FROM_EMAIL,
        to: env.TO_EMAIL,
        subject,
        text,
        html,
        replyTo: result.email,
      });
    } catch (error) {
      console.error("contact form send failed", {
        name: error.name,
        message: error.message,
        code: error.code,
        stage: error.stage,
      });
      return errorResponse(env, request, 502, "We couldn't send your message right now. Please try again later.");
    }

    return successResponse(env, request);
  },
};
