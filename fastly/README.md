# NORG Edge Router — Fastly Compute

Install NORG's edge-mirroring router on **your own** Fastly service. Everything
runs in your Fastly account; NORG never receives your credentials.

This is the Fastly port of the Cloudflare Worker in the root of this repo. Of
the ports it is the closest to the original — Fastly's runtime speaks standard
`Request`/`Response`, has a real `waitUntil`, and ships the **same `lol-html`
engine** behind Cloudflare's HTMLRewriter.

Three things hold on every port since 0.2.0, and are worth knowing before you
install: **your page is never cached at the edge** (every page request reaches
your origin; only assets keep Fastly's cache), **a human request makes no call
to NORG**, and **the router sends no analytics of its own** — NORG's content
service records each agent visit from a header on the mirror fetch.

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

- [ ] **A Fastly account that can create a Compute service.**
- [ ] **A `SITE_ID` and a `NORG_SITE_KEY`** from NORG. The key is shown once.
- [ ] **The Fastly CLI**, for `fastly compute publish`.
- [ ] Awareness of one structural point: a Fastly service is **either VCL or
      Compute**. If your site is already delivered by a VCL service you cannot
      attach this to it — you either migrate that service to Compute or put a
      Compute service in front via
      [service chaining](https://www.fastly.com/documentation/guides/concepts/service-chaining/).

---

## Install

```bash
# 1. Create the two stores.
fastly config-store create --name norg_edge_config
fastly config-store-entry create --store-id <id> --key site_id       --value <your-site-id>
fastly config-store-entry create --store-id <id> --key edge_env      --value production

fastly secret-store create --name norg_edge_secrets
fastly secret-store-entry create --store-id <id> --name norg_site_key --file -   # paste the key

# 2. Publish, linking the stores and the three backends when prompted.
cd fastly && fastly compute publish
```

Backends to declare — all three are static on purpose, so the set of hosts this
router can reach stays auditable in your own service config and no
account-level dynamic-backends toggle is needed:

| Backend | Host |
|---|---|
| `customer_origin` | your origin |
| `norg_api` | `content-craft-api.norg.ai` |
| `norg_content` | `edge-content.norg.ai` |

Everything else has a baked default. Terraform is supported via
`fastly_service_compute` + `fastly_configstore` + `fastly_secretstore`.

---

## Configuration

| Config Store key | Default | Meaning |
|---|---|---|
| `site_id` | *(required)* | Identifies this install to NORG |
| `edge_env` | `unknown` | `production` or `test` |
| `norg_api_url` | NORG's production API | Point at a different NORG environment |
| `norg_content_base` | NORG's edge-content service | Point at a different render source |
| `strip_fallback_enabled` | `true` | `false` disables the stripped-origin fallback |
| `edge_disabled` | `false` | `true` switches the router off without removing it |
| `lazy_render_enabled` | `true` | `false` serves the strip without requesting a render |
| `events_verbose` | *(off)* | `true` also reports plain origin passthroughs, behind the response via `waitUntil` |

**`norg_site_key` goes in the Secret Store, never the Config Store.** Fastly's
Secret Store is write-only through the API — the plaintext cannot be read back,
only decrypted at the edge during a request. That is a stronger guarantee than
any other provider here. The key is read **once per request**; the store allows
five reads per request, so do not add more.

---

## Verifying the install

```bash
# 1. The router is alive and entitled
curl -s -H "x-norg-edge-check: <your-site-key>" https://your-domain.com/ | jq

# 2. A normal visitor is untouched — expect NO output, and `x-cache: MISS`
#    on every run: a page is never cached at the edge, your origin answered.
curl -sI -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
  (KHTML, like Gecko) Chrome/125.0 Safari/537.36" https://your-domain.com/ | grep -i "x-norg-edge\|x-cache"

# 3. Force the mirror for a page NORG has rendered
curl -sI "https://your-domain.com/some-page/?agent=true" | grep -i x-norg-edge
```

A plain `curl -A GPTBot` will **not** divert, and that is correct — the router
verifies the source IP against the crawler operator's published ranges, so a
spoofed user-agent from an arbitrary address is refused.

---

## Differences from the other providers

| | Cloudflare | **Fastly** | CloudFront |
|---|---|---|---|
| Runs | before the cache, every request | **every request** | every page request; the page is never cached |
| Page cache at the edge | as your origin's headers say | **none — a pass override on every page; assets cached** | none — managed `CachingDisabled` |
| Who records an agent visit | the worker, via `ctx.waitUntil` | **NORG's content service, from a header on the mirror fetch** | NORG's content service, the same way |
| Background work | `ctx.waitUntil` | **`event.waitUntil`** (stale-feed refresh, opt-in passthrough event) | none possible; refresh inline, passthrough event best-effort |
| Generated-response cap | none | **none** | 1 MB |
| HTML rewriter | HTMLRewriter (lol-html) | **same engine available** | hand-rolled |
| Secret storage | Worker secret | **write-only Secret Store** | Secrets Manager, replicated per region |
| Host sent to origin | the visitor's | **the visitor's** | ⚠️ forced to the origin's own |
| Scheduled heartbeat | cron trigger | ❌ external ping | ❌ separate scheduled Lambda |
| Install shape | additive to your zone | **needs a Compute service** | additive to a distribution |

**Your page is never cached at the edge.** A Compute `fetch` to a backend goes
through Fastly's cache by default, so a cacheable origin page would be stored
and replayed — and every replay is a request this code never saw. The router
therefore fetches every page with a pass override and your origin answers
every page request exactly as it would without a CDN. Static assets are the
one exception and keep Fastly's normal caching. The trade is deliberate: a
cached page needs a cache key that keeps agents and humans apart and a guard to
keep origin bytes out of the agent's copy, and a mistake in either serves the
wrong page to the wrong visitor, silently. Not caching the page removes the
class of failure.

**A human request makes no call to NORG.** An ordinary browser, a search
crawler and a static asset are passed through before the policy feed is
touched, so a person never waits on NORG — not even on a cold instance. Only a
bot-shaped request, a Web Bot Auth signature or the `?agent=true` override pays
for the feed.

**The router sends no analytics of its own.** The details of an agent visit —
user agent, classification, what was served — travel as one request header on
the mirror fetch the router was going to make anyway, and NORG's content
service records the event after answering, through its own deferred-work
primitive. On a miss the same header asks it to enqueue the render. Two
consequences: a page served from your origin because NORG had no render is
recorded as `stripped` (or `origin`, if the strip fallback is off) without the
`origin_thin` distinction; and the geographic and TLS fields are empty on this
provider, because core reads them from CloudFront's viewer headers and Fastly
publishes them differently. The one call the router still makes for itself is
the opt-in human passthrough event, handed to `event.waitUntil` so it lands
after the response.

**No cron.** Fastly Compute instances exist only for the life of a request, so
the 30-minute liveness beat is driven by NORG pinging the install rather than
by anything in your account. An agent visit recorded by NORG's content service
also marks the install alive.

---

## Development

```bash
# From the repository root — the decision path, no toolchain needed.
npm run test:fastly

# From this directory — compile to Wasm and serve it locally.
npm install             # @fastly/js-compute
npm run build           # -> bin/main.wasm
fastly compute serve    # Viceroy, on http://127.0.0.1:7676
```

`src/router.js` holds the pipeline and imports no `fastly:` modules, so the
whole decision path is testable without the Fastly toolchain. `src/index.js` is
the only file that touches the platform SDK.

**Run it under Viceroy before you trust it.** `npm run test:fastly` runs under
Node, where the whole web platform exists; the Wasm runs on a deliberate subset.
Two bugs lived behind twelve green tests until the compiled module served its
first real request — `AbortSignal`, which Fastly does not implement, and a
backend error rejecting where Cloudflare's would have resolved. Both are covered
now by `tests/runtime-gaps.test.mjs`, and that file is the right home for the
next one.

**Before adding a web API to `core/`, check Fastly implements it.** `core/` is
shared with Cloudflare, CloudFront and Bunny, all of which are more complete
than Compute. A call that is unremarkable on the others can throw here, and
because the call sites sit inside their own `try/catch` the failure is silent —
it looks like a network problem, not a missing global. `core/http.js` shows the
shape of the fix: probe for the capability, degrade to the platform's own
mechanism, and say in a comment which mechanism took over. Every outbound NORG
call in `core/` goes through `edgeFetch`/`timeoutSignal` from that file, which
is what lets `index.js` route them to named backends.

Provider-neutral logic lives in **`core/`** at the repository root and is shared
with the other providers — the strip rewriter, bot classification, the feed and
entitlement gate, the fast path, the visit header, path predicates, constants
and exclusions. Fastly adds only two adapters: `lib/config.js` (Config + Secret
stores) and `lib/origin.js` (backends and the page-cache pass override), and
`index.js` wires three hooks onto the config object — `EDGE_FETCH`,
`EDGE_PASS_CACHE` (a `CacheOverride("pass")` from `fastly:cache-override`) and
`EDGE_KEEPALIVE` (`event.waitUntil`) — so the router never imports a `fastly:`
module.
