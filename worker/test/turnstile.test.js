import test from "node:test";
import assert from "node:assert/strict";
import { createTurnstileVerifier } from "../src/turnstile.js";

/** Fake fetch that records the request and returns a scripted JSON reply. */
function fakeFetch(result) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return { json: async () => result };
  };
  impl.calls = calls;
  return impl;
}

test("skips verification when no secret is configured", async () => {
  const fetchImpl = fakeFetch({ success: false });
  const verify = createTurnstileVerifier(fetchImpl);

  assert.equal(await verify({}, "", undefined), true);
  assert.equal(fetchImpl.calls.length, 0);
});

test("rejects an empty token when a secret is configured", async () => {
  const fetchImpl = fakeFetch({ success: true });
  const verify = createTurnstileVerifier(fetchImpl);

  assert.equal(await verify({ TURNSTILE_SECRET: "s" }, "", undefined), false);
  assert.equal(fetchImpl.calls.length, 0);
});

test("posts the token and secret to siteverify", async () => {
  const fetchImpl = fakeFetch({ success: true });
  const verify = createTurnstileVerifier(fetchImpl);

  const ok = await verify(
    { TURNSTILE_SECRET: "secret-key" },
    "token-value",
    "203.0.113.7",
  );

  assert.equal(ok, true);
  assert.equal(fetchImpl.calls.length, 1);

  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(options.method, "POST");
  assert.equal(options.body.get("secret"), "secret-key");
  assert.equal(options.body.get("response"), "token-value");
  assert.equal(options.body.get("remoteip"), "203.0.113.7");
});

test("returns false when Cloudflare reports failure", async () => {
  const verify = createTurnstileVerifier(fakeFetch({ success: false }));
  assert.equal(await verify({ TURNSTILE_SECRET: "s" }, "t", undefined), false);
});

test("returns false when the request throws", async () => {
  const verify = createTurnstileVerifier(async () => {
    throw new Error("network down");
  });
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(await verify({ TURNSTILE_SECRET: "s" }, "t", undefined), false);
  } finally {
    console.error = original;
  }
});
