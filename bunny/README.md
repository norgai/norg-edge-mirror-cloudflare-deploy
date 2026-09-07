# NORG Edge Router — Bunny Edge Scripting

Install NORG's edge-mirroring router on **your own** bunny.net pull zone.
Everything runs in your Bunny account; NORG never receives your credentials.

This is the Bunny port of the Cloudflare Worker in the root of this repo. The
runtime is Deno 2.7 on V8, with standard `Request`/`Response`, a real `fetch`,
`AbortSignal.timeout`, `Bunny.v1.waitUntil` and a 128 MB heap — so the whole of
`core/` runs here **unchanged**, and this port is three small adapters plus a
pipeline that is the Cloudflare pipeline in the same order.

One structural difference dominates everything else, and it is not a detail:
**a Bunny middleware script runs on a cache MISS only.** Read
["The cache is the hazard"](#the-cache-is-the-hazard) before you install.

---

## What this does

| Visitor | What they get |
|---|---|
| A person in a browser | Your site, byte-for-byte unchanged |
| Googlebot, Bingbot, and other web-index crawlers | Your site, byte-for-byte unchanged |
| An AI agent asking for a page NORG has rendered | The NORG render, served **at your own URL** |
| An AI agent asking for a page NORG hasn't rendered | Your own page, stripped to the token-dense facts |

Three rules are built in with no off switch: it must never break your site,
search engines always see what humans see, and nothing happens until NORG has
authenticated the install.

---

## Before you start

- [ ] **A bunny.net account** and an API key with pull-zone and Scripting access.
- [ ] **A `SITE_ID` and a `NORG_SITE_KEY`** from NORG. The key is shown once.
- [ ] **DNS you control** for the hostname the router will answer on, able to
      publish a plain CNAME. It must be **DNS-only** — a proxying provider (an
      orange-clouded Cloudflare record, for instance) intercepts the ACME
      challenge and Bunny's AutoSSL never completes.
- [ ] Node 22, to run the installer and the tests. Nothing to `npm install`.

---

## Install

```bash
node bunny/build.mjs            # refresh dist/edge-router-bunny.js

BUNNY_API_KEY=...        \
SITE_ID=...              \
NORG_SITE_KEY=...        \
NORG_API_URL=https://content-craft-api.norg.ai      \
NORG_CONTENT_BASE=https://edge-content.norg.ai      \
EDGE_ENV=production      \
ORIGIN_URL=https://www.example.com                  \
PULL_ZONE_NAME=example-norg                         \
EDGE_HOSTNAME=agents.example.com                    \
node bunny/install.mjs
```

The installer is idempotent — run it again to push a new bundle or change a
setting. It prints the pull zone's system hostname; publish that as a CNAME for
`EDGE_HOSTNAME`, then **run the installer once more**. Bunny cannot issue a
certificate until the hostname already resolves to the zone, so the first run
reports `hostname_ssl_not_enabled` and skips that step by design.

What it creates:

1. A **middleware** edge script (`ScriptType: 2`) holding
   `dist/edge-router-bunny.js`, published so it actually runs — an unpublished
   script is inert.
2. Environment **variables** for the plain configuration and an environment
   **secret** for `NORG_SITE_KEY`.
3. A pull zone pointed at your origin, with `OriginHostHeader` set to the
   origin's own host, and the script linked as its middleware.
4. The hostname, a Let's Encrypt certificate, and Force SSL.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SITE_ID` | *(required)* | Identifies this install to NORG |
| `NORG_SITE_KEY` | *(required, secret)* | Authenticates this install |
| `EDGE_ENV` | `unknown` | `production` or `test` |
| `NORG_API_URL` | NORG's production API | Point at a different NORG environment |
| `NORG_CONTENT_BASE` | NORG's edge-content service | Point at a different render source |
| `STRIP_FALLBACK_ENABLED` | `true` | `false` disables the stripped-origin fallback |
| `EDGE_DISABLED` | `false` | `true` switches the router off without removing it |
| `LAZY_RENDER_ENABLED` | `true` | `false` serves the strip without requesting a render |
| `EDGE_EVENTS_VERBOSE` | *(off)* | `true` also reports plain origin passthroughs |

A Bunny variable that is declared but left blank arrives as `""`, not
`undefined`, so the adapter treats blank as absent and the baked default
applies. Values are capped at 2 KB, and a script may hold 128 of them.

### Where the site key lives, and who can read it

`NORG_SITE_KEY` is written as an **environment secret**, not a variable.
`GET /compute/script/{id}/secrets` returns `{"Secrets": [{Id, Name,
LastModified}]}` — names, ids and timestamps, never plaintext. Once written it
can be replaced or deleted but not read back, through the API or the dashboard.

That is the same guarantee as Fastly's Secret Store, stronger than a Cloudflare
worker secret, and far stronger than CloudFront, where the key travels as an
origin custom header visible to anyone who can read the distribution.

Who can still reach it:

- **Anyone holding the account API key**, who can overwrite the secret — and
  who could in any case replace the script's code entirely. The key is the
  trust boundary; scope and rotate it accordingly.
- **The running script**, via `process.env`. `dist/edge-router-bunny.js` is
  downloadable with `GET /compute/script/{id}/code` by anyone with the API key,
  which is exactly why the key is not in it. `bunny/tests/bundle.test.mjs`
  fails the build if any credential appears in the bundle.

---

## The cache is the hazard

**Bunny middleware runs at `onOriginRequest`, which fires on a cache MISS
only.** On a HIT the CDN answers from cache and the script never executes. So
if your origin serves cacheable HTML, a page warmed by one visitor is replayed
to everyone — and an AI agent is served that cached page instead of the mirror.
The failure is *safe* (nobody is cloaked, nothing breaks) but the product does
not work.

Bunny does have before-cache hooks — `onClientRequest` / `onClientResponse`,
which run on every request — but they are a **preview** feature gated per pull
zone. On an account without it, registering `onClientRequest` makes the SDK
throw at startup, and a middleware script that fails to start makes the zone
answer **HTTP 400 for every request**. That was observed directly on a live
zone. This artifact therefore registers `onOriginRequest` only, and
`bunny/tests/bundle.test.mjs` asserts that the client hooks never appear in the
bundle. When before-cache execution becomes generally available, moving to
`onClientRequest` removes this whole section.

Until then the installer measures rather than assumes: it fetches your origin
and reports its `Cache-Control`. If the HTML is uncacheable (`no-store`,
`no-cache`, `private` or `max-age=0` — the normal case for a dynamic site) the
router already runs on every request and there is nothing to do.

If it is cacheable, re-run with `CACHE_BYPASS=true`. **Understand the cost
first.** Forcing the cache off is a pull-zone setting
(`CacheControlMaxAgeOverride: 0`), and Bunny then rewrites the *client-facing*
`Cache-Control` on **every** response, including your own. Measured on a live
zone:

| | Without `CACHE_BYPASS` | With `CACHE_BYPASS=true` |
|---|---|---|
| Your HTML (`private, no-cache, no-store, …`) | unchanged | `public, max-age=0` |
| Your assets (`public, max-age=31536000, immutable`) | unchanged, cached (`cdn-cache: HIT`) | `public, max-age=0`, not cached |
| A NORG mirror response | `private, no-store` | `private, no-store`, via an edge rule the installer adds |

Losing `immutable` on a year-long asset is a real regression on your site, which
is why this is opt-in rather than the default.

Two narrower fixes were tried on Bunny and **do not work** — do not re-derive
them:

- Stamping `CDN-Cache-Control: private, no-store` from the script in
  `onOriginResponse` is ignored: the response was cached anyway (`cdn-cache:
  HIT` on four consecutive requests).
- An edge rule that bypasses the cache for everything *except* asset extensions
  is refused — `edgerule.invalid: Maximum 5 triggers are allowed per
  condition`, and the asset list has about fifty entries.

---

## Verifying the install

Distinguish the mirror from the origin **by body size**, not by headers alone.

```bash
HOST=https://agents.example.com
CHROME='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

# 1. The router is alive. `entitled` reports whether THIS isolate holds a feed,
#    so a cold one answers false — ask twice.
curl -s -H "x-norg-edge-check: <your-site-key>" $HOST/ | jq

# 2. A normal visitor is untouched — expect your full page and NO x-norg-edge.
curl -s -D - -o /dev/null -w 'SIZE:%{size_download}\n' -A "$CHROME" $HOST/

# 3. Force the mirror for a page NORG has rendered — expect a much smaller body
#    and `x-norg-edge: mirror`.
curl -s -D - -o /dev/null -w 'SIZE:%{size_download}\n' "$HOST/?agent=true"

# 4. The search-engine floor, which nothing overrides — expect your full page.
curl -s -o /dev/null -w 'SIZE:%{size_download}\n' \
  -A 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' \
  "$HOST/?agent=true"

# 5. A static asset is never diverted.
curl -s -o /dev/null -w 'SIZE:%{size_download} ' $HOST/path/to/app.css
```

A plain `curl -A GPTBot` will **not** divert, and that is correct: the router
verifies the source IP against the crawler operator's published ranges, so a
spoofed user-agent from an arbitrary address is refused. Bunny **replaces**
`x-real-ip` and `x-forwarded-for` with the address it observed rather than
appending to them — a request sending `X-Forwarded-For: 1.2.3.4` and
`X-Real-IP: 5.6.7.8`, and one sending a comma list, both arrived at the script
with the true client address in both headers. That is what makes this gate
sound here.

To see the verified path end to end you therefore have to be the crawler, or
run `handleRequest` against the live feed with a synthetic address in the
operator's range.

---

## Differences from the other providers

| | Cloudflare | Fastly | **Bunny** | CloudFront |
|---|---|---|---|---|
| Runs before cache | ✅ | ✅ | ⚠️ **preview only** — MISS-only today | ⚠️ cache-miss only |
| `waitUntil` | ✅ | ✅ | ✅ `Bunny.v1.waitUntil` | ❌ emulated by a deferred queue |
| Generated-response cap | none | none | **none** | 1 MB |
| HTML rewriter | HTMLRewriter | same engine | **HTMLRewriter present** (unused — `core/strip.js` is provider-neutral) | hand-rolled |
| Secret storage | Worker secret | write-only Secret Store | **write-only secret** | ⚠️ origin custom header |
| Host sent to origin | the visitor's | the visitor's | the pull zone's `OriginHostHeader` | ⚠️ forced to the origin's own |
| Verified-bot signal | `cf.verifiedBotCategory` | ❌ CIDR only | ❌ **CIDR only** | ❌ CIDR only |
| Scheduled heartbeat | cron trigger | ❌ external ping | ❌ **external ping** | ❌ separate scheduled Lambda |
| Install shape | additive to your zone | needs a Compute service | **a pull zone in front of your origin** | additive to a distribution |

**No cron.** Bunny isolates exist for the life of a request, so the 30-minute
liveness beat is driven by NORG pinging the install. Traffic-driven heartbeats
work normally.

**No verified-bot signal.** Bunny publishes the client IP, an ISO country
(`cdn-requestcountrycode`), a state code, the answering PoP and a JA4 TLS
fingerprint — but nothing equivalent to Cloudflare's `verifiedBotCategory`.
Source verification is CIDR-only, so a crawler whose operator publishes no CIDR
ranges is not diverted here. That is a capability gap, and the direction of the
failure is the safe one.

---

## Divergences from `core/`

`core/` is imported unchanged. Everything Bunny-shaped lives in `src/lib/`:

| Divergence | Why |
|---|---|
| `lib/request.js` rebuilds the **visitor's** URL from `cdn-host` | Bunny points `ctx.request.url` at the origin before the hook runs. Without this, every visit event, canonical Link and render request would carry the origin's hostname instead of the customer's. |
| Blank environment values are treated as absent (`lib/config.js`) | Bunny declares variables up front, so an unset optional one arrives as `""`. Core's `binding()` only falls back on `undefined`, so `""` would defeat every baked default. |
| Passthrough is a **sentinel**, not a fetch (`lib/origin.js`) | The hook returns either a `Response` or a `Request`; returning the request is how you say "carry on to the origin". Strictly better than CloudFront's version, because Bunny's own origin machinery — retries, host header, shield — still applies. |
| `logEdgeEvent` reports null geo | `core/telemetry.js` reads `cloudfront-viewer-*` headers. Bunny publishes the same facts under `cdn-*` names, so `ip_country`, `asn`, `http_protocol` and `tls_version` are null on this provider, exactly as they are on Fastly. Fixing it means changing `core/`, which this port deliberately did not do. |
| Only `onOriginRequest` is registered | See ["The cache is the hazard"](#the-cache-is-the-hazard). |

---

## Cost and limits

Billing has two components, charged in whole increments across the whole
account: **$0.02 per 1,000 s of CPU time** and **$0.20 per million requests**.
The floor is $0.22/month, which you pay from the first request. CDN bandwidth is
billed separately at the normal rate.

The script runs on **every cache MISS**, which includes static assets: the
pipeline returns them to the origin at `isStaticAssetPath`, before any network
call, but they still count as requests. On a cacheable origin without
`CACHE_BYPASS` assets are served from cache and never reach the script at all.
At 10 M requests/month and ~10 ms CPU each the bill is about $4.

Runtime limits that matter here: **30 s CPU** per request (the pipeline's own
budgets are 3–5 s per network call, and a 15 s watchdog sits under it),
**128 MB** of active memory (the strip buffers one page), **50 subrequests**
per request (the pipeline makes at most three), **10 MB** of script (the bundle
is ~40 KB), and **500 ms** of startup.

---

## Development

```bash
npm run test:bunny      # the decision path, no toolchain needed
npm run build:bunny     # -> bunny/dist/edge-router-bunny.js
```

Bunny documents `deno run -A <script>` for local middleware development, and
`src/index.js` is written to survive it — `LOCAL_DEV_ORIGIN_URL` supplies the
origin and `keepAlive` degrades gracefully when the `Bunny` global is absent.
That path is **untested here**: the bare `@bunny.net/edgescript-sdk@0.12.1`
specifier is resolved by Bunny's runtime, and plain Deno needs it rewritten to
`npm:@bunny.net/edgescript-sdk@0.12.1` or mapped in an import map. Verify it
before relying on it.

`src/router.js` holds the pipeline and imports no Bunny module, so the whole
decision path is testable under `node --test`. `src/index.js` is the only file
that touches the SDK.

`dist/edge-router-bunny.js` is a **committed build artifact** — Bunny's API
takes the script as one string, so the bundle *is* the deployable, and
`install.mjs` uploads exactly that file. `bunny/tests/bundle.test.mjs` rebuilds
it and fails on any diff.
