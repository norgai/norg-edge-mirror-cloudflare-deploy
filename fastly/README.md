# NORG Edge Router — Fastly Compute

Install NORG's edge-mirroring router on **your own** Fastly service. Everything
runs in your Fastly account; NORG never receives your credentials.

This is the Fastly port of the Cloudflare Worker in the root of this repo. Of
the three ports so far it is the closest to the original — Fastly's runtime
speaks standard `Request`/`Response`, has a real `waitUntil`, and ships the
**same `lol-html` engine** behind Cloudflare's HTMLRewriter.

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
| `events_verbose` | *(off)* | `true` also reports plain origin passthroughs |

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

# 2. A normal visitor is untouched — expect NO output
curl -sI -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
  (KHTML, like Gecko) Chrome/125.0 Safari/537.36" https://your-domain.com/ | grep -i x-norg-edge

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
| Runs before cache | ✅ | ✅ | ⚠️ cache-miss only |
| `waitUntil` | ✅ | ✅ | ❌ emulated by a deferred queue |
| Generated-response cap | none | **none** | 1 MB |
| HTML rewriter | HTMLRewriter (lol-html) | **same engine available** | hand-rolled |
| Secret storage | Worker secret | **write-only Secret Store** | ⚠️ origin custom header |
| Host sent to origin | the visitor's | **the visitor's** | ⚠️ forced to the origin's own |
| Scheduled heartbeat | cron trigger | ❌ external ping | ❌ separate scheduled Lambda |
| Install shape | additive to your zone | **needs a Compute service** | additive to a distribution |

**No cron.** Fastly Compute instances exist only for the life of a request, so
the 30-minute liveness beat is driven by NORG pinging the install rather than
by anything in your account. Traffic-driven heartbeats work normally.

---

## Development

```bash
npm run test:fastly     # node:test, nothing to install
```

`src/router.js` holds the pipeline and imports no `fastly:` modules, so the
whole decision path is testable without the Fastly toolchain. `src/index.js` is
the only file that touches the platform SDK.

Provider-neutral logic lives in **`core/`** at the repository root and is shared
with the other providers — the strip rewriter, bot classification, the feed and
entitlement gate, telemetry, path predicates, constants and exclusions. Fastly
adds only two adapters: `lib/config.js` (Config + Secret stores) and
`lib/origin.js` (backends).
