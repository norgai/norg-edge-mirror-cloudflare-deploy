# NORG Edge Router — AWS CloudFront

Install NORG's edge-mirroring router on **your own** CloudFront distribution.
Everything runs in your AWS account; NORG never receives AWS credentials.

This is the CloudFront port of the Cloudflare Worker in the root of this repo.
Same product, same rules, same NORG back-channel — but AWS is a different
platform, and some of the differences are visible to you. They are listed in
[Differences from the Cloudflare install](#differences-from-the-cloudflare-install),
and it is worth reading that section *before* you install rather than after.

---

## What this does

Installed on your distribution, it inspects every request and decides who's
asking:

| Visitor | What they get |
|---|---|
| A person in a browser | Your site, byte-for-byte unchanged |
| Googlebot, Bingbot, and other web-index crawlers | Your site, byte-for-byte unchanged |
| An AI agent (GPTBot, ClaudeBot, PerplexityBot, …) asking for a page NORG has already rendered | The NORG render, served **at your own URL** — no redirect, the address bar never changes |
| An AI agent asking for a page NORG hasn't rendered yet | Your own page, stripped to the token-dense facts, while NORG is asked in the background to render it |

Three rules are built in and have no off switch:

1. **It must never break your site.** Every failure path — NORG's API down, its
   storage unreachable, a bug in the router itself — ends at your origin.
2. **Search engines always see exactly what humans see.** Serving Googlebot
   different content is cloaking and would put your rankings at risk.
3. **Nothing happens without an authenticated feed.** Until NORG has
   authenticated the install, the router changes nothing at all. There is no
   local bot list to fall back on.

---

## Which install shape do you need?

|  | Your site is **already** served through CloudFront | Your site is **not** on CloudFront yet |
|---|---|---|
| Use | [`attach-existing.yaml`](cloudformation/attach-existing.yaml) + the attach CLI | [`new-distribution.yaml`](cloudformation/new-distribution.yaml) |
| DNS change | None | Yes — you repoint to the new distribution when ready |
| Touches production | Yes, it modifies your live distribution | No, until you cut DNS |
| Who chooses your caching | You (we refuse to guess) | The template, until you tune it |

Both require **us-east-1**. Lambda@Edge functions can only live there; the
distribution itself is global either way.

---

## Before you start

- [ ] **A `SITE_ID` and a `NORG_SITE_KEY`.** NORG issues both when you register
      the site. The key is shown **once** — NORG stores only a hash, so if you
      lose it, ask NORG to rotate it.
- [ ] **An origin hostname distinct from your public domain.** CloudFront must
      fetch your real pages from somewhere that is not the distribution itself,
      or requests loop.
- [ ] **Permission to create IAM roles, Lambda functions, CloudFront functions
      and policies** in us-east-1.
- [ ] **The artifact location NORG gives you** — S3 bucket, object keys, and
      (recommended) object versions. These parameters have **no defaults on
      purpose**: S3 bucket names are globally unique across all AWS accounts and
      this repository is public, so a default naming a bucket could be claimed
      by someone else and would install their code into your account. Verify the
      bucket NORG names is one they own, or mirror the objects into your own
      bucket and point the parameters at that — which is fully supported and the
      right call if your policy forbids deploying third-party code.
- [ ] For the attach path: **no other origin-request Lambda@Edge function or
      viewer-request CloudFront Function on the behaviour you're attaching to.**
      The installer refuses rather than replacing someone else's routing.

---

## Install: existing distribution

```bash
# 1. Create the functions and policies (no distribution is touched yet).
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name norg-edge \
  --template-file aws/cloudformation/attach-existing.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides SiteId=<your-site-id> SiteKey=<your-site-key>

# 2. See exactly what would change on your live distribution. This is a DRY RUN.
node aws/install/attach.mjs \
  --distribution-id EXXXXXXXXXXXX \
  --stack norg-edge \
  --site-key <your-site-key>

# 3. Apply it, after choosing what happens to your cache key (see below).
node aws/install/attach.mjs \
  --distribution-id EXXXXXXXXXXXX \
  --stack norg-edge \
  --site-key <your-site-key> \
  --cache-policy=replace \
  --apply
```

To remove it: the same command with `--detach --apply`.

### The cache-key decision you have to make

The router runs on **origin-request**, which CloudFront only fires on a cache
**miss**. So once a human has warmed the cache for a page, the next AI agent
asking for that URL is a cache *hit* — the router never runs, and the agent
quietly gets your ordinary page. The install looks healthy and does nothing, on
exactly your most popular pages.

The fix is the `x-norg-agent` header in your cache key, stamped by a
viewer-request CloudFront Function. Because your cache policy is tuned to your
application — and may be shared with other distributions — the installer will
not change it silently. Choose:

- **`--cache-policy=replace`** — use the stack's policy. It has `DefaultTTL 0`,
  so CloudFront honours the `Cache-Control` your origin already sends, and it
  forwards no cookies. Read it before choosing this if your app is
  cookie-sensitive.
- **`--cache-policy=keep`** — keep yours, and add `x-norg-agent` to its cache
  key yourself. A CloudFront **managed** policy cannot be edited, so "keep"
  means copying it to a custom policy first.

This splits your cache into at most two variants per URL. Diverted responses are
`private, no-store` and are never cached at all.

---

## Install: new distribution

Deploy [`new-distribution.yaml`](cloudformation/new-distribution.yaml) in
us-east-1. It creates the distribution, both functions, the policies and the
heartbeat schedule.

**Test on the `*.cloudfront.net` name first, before you point any DNS at it.**
Leave `AlternateDomainNames` blank for the first deploy; add it and an ACM
certificate once the checks below pass.

---

## Configuration

Config reaches the router as **CloudFront origin custom headers**, because
Lambda@Edge supports no environment variables at all. The router deletes them
from the request as it reads them, so they never reach your own web server or
its access logs.

| Header | Default | Meaning |
|---|---|---|
| `x-norg-site-id` | *(required)* | `edge_sites.id` — identifies this install to NORG |
| `x-norg-site-key` | *(required)* | Per-site key authenticating this install |
| `x-norg-api-url` | NORG's production API | Point at a different NORG environment |
| `x-norg-content-base` | NORG's edge-content service | Point at a different render source |
| `x-norg-env` | `unknown` | `production` or `test` — a test-bound install serves TEST content |
| `x-norg-strip-fallback` | `true` | `false` disables the stripped-origin fallback |
| `x-norg-disabled` | `false` | `true` switches the router off instantly without removing it |
| `x-norg-lazy-render` | `true` | `false` serves the strip without asking NORG to render |
| `x-norg-events-verbose` | *(off)* | `true` also reports plain origin passthroughs |

> **Where the site key is visible.** It sits in your distribution's
> configuration and in the heartbeat function's environment variables. Anyone
> who can read those in your AWS account can read it. It is scoped to this one
> site, and revoking it degrades the install to "always serve origin" — a safe
> stop, not an outage.

---

## Verifying the install

Wait for `Status: Deployed` (5–15 minutes), then run these against a real page.

### 1. An AI agent gets the NORG treatment

```bash
curl -sI -H "User-Agent: GPTBot" https://your-domain.com/some-page/ | grep -i x-norg-edge
```

| Result | Meaning |
|---|---|
| `X-Norg-Edge: mirror` | A NORG render exists and was served. Fully working. |
| `X-Norg-Edge: stripped` | Nothing rendered yet — your page was served stripped and a render was requested. Re-check in a few minutes. |
| *(no header)* | The router never ran — see [Troubleshooting](#troubleshooting). |

> A plain `curl -A GPTBot` from your laptop will **not** be diverted, and that
> is correct: the router verifies the source IP against the crawler operator's
> published ranges, so a spoofed user-agent from an arbitrary address is
> refused. Use the health probe below to prove the router is alive.

### 2. A normal visitor is untouched

```bash
curl -sI -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36" \
  https://your-domain.com/some-page/ | grep -i x-norg-edge
```

Expect **no output at all**. Run it twice — once cold, once against a warmed
cache — because the warm case is exactly what the cache-key stamp exists to get
right.

### 3. The router is alive and entitled

```bash
curl -s -H "x-norg-edge-check: <your-site-key>" https://your-domain.com/ | jq
```

```json
{ "site_id": "…", "version": "0.1.0", "env": "production",
  "disabled": false, "platform": "cloudfront", "entitled": true, "ts": 1730000000000 }
```

`entitled: false` is the first thing to check when an install "does nothing":
it means NORG has not authenticated this install, and rule 3 means the router
is deliberately inert.

---

## Differences from the Cloudflare install

These are platform constraints, not choices, and two of them change behaviour
you can observe.

| | Cloudflare | CloudFront |
|---|---|---|
| **Bot verification** | Operator CIDR ranges, falling back to Cloudflare's verified-bot signal | **CIDR ranges only** |
| **Where it runs** | Before the cache, on every request | On a cache **miss**, so the cache key must separate agents from humans |
| **Mirror response cache** | Cached in-colo under a tenant-unique key | **None** — see below |
| **Config** | Worker bindings | Origin custom headers |
| **Liveness cron** | Worker cron trigger | A separate scheduled Lambda |
| **Passthrough events** | Every visit | Diverted traffic only, unless `x-norg-events-verbose=true` |
| **Rollback speed** | Delete a route — seconds | 5–15 min propagation; a Lambda@Edge replica takes ~30 min to become deletable |
| **Install-size cliff** | Workers free plan: 100k requests/day | None — per-request Lambda@Edge cost instead |

**Bot verification is genuinely weaker here.** CloudFront exposes no
verified-bot signal (AWS's equivalent is AWS WAF Bot Control, a separate
product), so a crawler whose operator publishes no CIDR ranges will **not** be
diverted on CloudFront where it would be on Cloudflare. The failure direction is
the safe one — it under-serves agents rather than over-serving humans — but it
means fewer diverts on some crawlers.

**There is no mirror response cache.** On Cloudflare the render is cached in the
colo under a synthetic, tenant-unique key that no public request can reach. On
CloudFront the only cache available is your distribution's, keyed by your public
URL — where a cached mirror could be replayed to a human, the exact failure
`no-store` exists to prevent. NORG's own edge-content service still caches
behind its auth check, so what is lost is a hop, not correctness.

---

## Operational notes

- **us-east-1, always.** Lambda@Edge is a us-east-1-only resource.
- **Rollback is slow.** Budget 5–15 minutes for any distribution change to
  propagate, and up to ~30 minutes before a Lambda@Edge replica can be deleted.
  If the site matters, attach to a
  [CloudFront continuous-deployment](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/continuous-deployment.html)
  staging distribution first and shift traffic gradually. "Degrades safely" and
  "reverts quickly" are not the same property, and this install has the first.
- **Cost.** Every cache miss invokes Lambda@Edge. There is no free-tier cliff to
  fall off, but there is a per-request bill — model it against your miss rate
  before pointing it at high-traffic pages.
- **`IncludeBody` is on** for the origin-request association, because the MCP
  JSON-RPC transport is a POST whose body the router forwards to NORG. Access is
  read-only, so your origin still receives the full original body; the cost is
  that POST bodies on cache-miss requests are base64-encoded into the function
  event (truncated at 1 MB). If you do not use the MCP surface and your site is
  POST-heavy, turning it off is a reasonable trade.
- **The fastest off switch** is setting the `x-norg-disabled` origin header to
  `true`: the router passes everything through on its very first check, before
  it fetches anything. It still takes a distribution deploy to propagate. The
  *instant* remote lever is NORG revoking your site key, which degrades the
  install to origin-only within a minute.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No `X-Norg-Edge` header on any request, health probe also silent | The functions aren't associated with the behaviour serving that path, or the distribution hasn't finished deploying |
| Health probe works, agents still get the origin | `entitled: false` (NORG hasn't authenticated the install), or the agent's source IP isn't in the operator's published ranges |
| Works on a fresh URL, not on a popular one | `x-norg-agent` is missing from the cache key — a warm human entry is being served to agents |
| `X-Norg-Edge: stripped` forever | NORG hasn't rendered that page yet; check for `x-norg-lazy-render=false` |
| 502 from CloudFront | Should not happen — every router failure path ends at your origin. Check the function's CloudWatch logs in the region nearest the failing viewer, and tell NORG |
| Heartbeat never arrives at NORG | The scheduled function's `SITE_ID`/`NORG_SITE_KEY` env vars, or its CloudWatch error metric |

Lambda@Edge logs land in CloudWatch **in the region nearest the viewer**, not in
us-east-1 — a common surprise when a log group looks empty.

---

## Development

```bash
npm run test:aws     # node:test, nothing to install
npm run build:aws    # rebuild aws/src/ and re-embed the function in the templates
```

`aws/src/` holds committed build artifacts: the templates and the attach CLI
deploy exactly those files and NORG pins them by SHA-256, so CI rebuilds them
and fails on any diff. The CloudFront Function is embedded into both templates
by the build for the same reason — an inlined copy would otherwise drift.

Source layout:

| Path | What it is |
|---|---|
| `lambda/edge-router-lambda.js` | The router. Same pipeline as `workers/edge-router-worker.js` |
| `lambda/lib/` | Adapter, config, feed, telemetry, strip, paths, classification |
| `functions/viewer-classifier.js` | Viewer-request cache-key stamp (CloudFront Function) |
| `lambda/heartbeat-lambda.js` | Scheduled liveness beat |
| `cloudformation/` | The two install templates |
| `install/attach.mjs` | Attach/detach against an existing distribution |

`lambda/lib/constants.mjs` is a deliberate **copy** of the Cloudflare worker's
constant tables, not an import: that worker's bundle is SHA-256-pinned by NORG's
backend, and refactoring shared values out of it would change the shipped bytes
and tell every installed Cloudflare site an update is available. The copy is
kept honest by `tests/constants-parity.test.mjs`, which compares declaration
text and names any constant that drifts.
