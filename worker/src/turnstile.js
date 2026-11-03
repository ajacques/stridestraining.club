const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verify a Turnstile token with Cloudflare's siteverify endpoint.
 *
 * Returns true when verification is not configured (no secret), so the Worker
 * keeps working on deployments that have not opted in yet.
 */
export function createTurnstileVerifier(fetchImpl = fetch) {
  return async function verifyTurnstile(env, token, remoteIp) {
    const secret = env.TURNSTILE_SECRET;
    if (!secret) return true;
    if (!token) return false;

    const body = new FormData();
    body.append("secret", secret);
    body.append("response", token);
    if (remoteIp) body.append("remoteip", remoteIp);

    try {
      const response = await fetchImpl(TURNSTILE_URL, { method: "POST", body });
      const result = await response.json();
      return Boolean(result.success);
    } catch (error) {
      console.error("turnstile verification failed", { message: error.message });
      return false;
    }
  };
}
