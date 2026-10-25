# samilee.me contact form Worker

Receives the contact form POST from the static Hugo site hosted on Cloudflare
Pages and sends it to you over SMTP using the Worker's outbound TCP sockets
(`cloudflare:sockets`), with STARTTLS on port 587.

Workers cannot connect to port 25, but 465 (implicit TLS) and 587 (STARTTLS)
both work. Set `SMTP_SECURE = "tls"` for 465.

## Configuration

Edit `[vars]` in `wrangler.toml`:

| Variable | Meaning |
| --- | --- |
| `SITE_URL` | Base URL used to resolve the redirect targets |
| `ALLOWED_ORIGINS` | Comma-separated origins allowed to call the Worker |
| `SUCCESS_REDIRECT` | Page to send the browser to after a successful send (`/thanks/`) |
| `ERROR_REDIRECT` | Page to send the browser to on failure |
| `SUBJECT_TEMPLATE` | Email subject; `{name}` is replaced with the sender's name |
| `SMTP_HOST` / `SMTP_PORT` | Your mail server |
| `SMTP_SECURE` | `starttls` (587), `tls` (465), or `off` |
| `SMTP_AUTH` | `plain` (default), `login`, or `none` |
| `SMTP_USERNAME` | SMTP login (env var; leave blank to skip AUTH) |
| `SMTP_PASSWORD` | SMTP password (env var, **secret**) |
| `FROM_EMAIL` | From header, e.g. `Sami Lee <noreply@samilee.me>` |
| `TO_EMAIL` | Where enquiries are delivered |

Both SMTP credentials are read from environment variables. Only the password
needs to be a secret; the username can live in `[vars]`.

```sh
cd worker
npx wrangler secret put SMTP_PASSWORD
npx wrangler deploy
```

Deliverability: publish SPF/DKIM for the sending domain with your mail
provider, otherwise messages will land in spam.

## Front-end

The Hugo contact form posts as a normal HTML form, so it works without
JavaScript. When JS is available, `layouts/partials/contact-script.html`
intercepts it and POSTs JSON instead, skipping the browser round-trip.

Set the endpoint in `hugo.toml` (or per environment):

```toml
[params]
  contactEndpoint = "https://samilee-contact.<your-subdomain>.workers.dev"
```

Pointing the form at `action="#"` while `contactEndpoint` is empty leaves the
form inert — set the param before deploying.

## Local development with docker compose

`docker-compose.yml` defines a `wrangler` service that serves this Worker on
<http://localhost:8787> alongside the Hugo dev server on :1313.

1. Copy the example env file and fill in your SMTP details:

   ```sh
   cp worker/.dev.vars.example worker/.dev.vars
   ```

   `.dev.vars` is gitignored. It supplies `SMTP_*`, `FROM_EMAIL` and `TO_EMAIL`;
   the compose command overrides `ALLOWED_ORIGINS` and `SITE_URL` for local use.

2. Start both services:

   ```sh
   docker compose up
   ```

3. Outbound SMTP **does not work in wrangler's local runtime** — it fails with
   `proxy request failed, cannot connect to the specified address`. To send real
   mail, run the Worker on Cloudflare's network:

   ```sh
   WRANGLER_REMOTE=1 CLOUDFLARE_API_TOKEN=<token> docker compose up
   ```

   Create a token at <https://dash.cloudflare.com/profile/api-tokens> with the
   **Edit Cloudflare Workers** template. With `WRANGLER_REMOTE=1`, mail leaves
   from Cloudflare's egress IPs, so your SMTP provider must accept them.

The Hugo form points at the Worker automatically (`HUGO_PARAMS_CONTACTENDPOINT`
in `docker-compose.yml`), so submitting the form on :1313 sends a real email.

## Tests

```sh
cd worker
npm test
```

The SMTP client tests run the real client code against a fake socket, so they
do not touch the network.
