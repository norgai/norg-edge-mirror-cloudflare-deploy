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
  --parameter-overrides SiteId=<your-site-id> SiteKey=<your-site-key> \
                        ProbeToken=<your-probe-token>
# The stack puts SiteKey into a Secrets Manager secret and passes only its ARN
# to the functions. To keep the key out of CloudFormation entirely, create the
# secret yourself and pass SecretArn=<arn> instead of SiteKey.

# 2. See exactly what would change on your live distribution. This is a DRY RUN.
node aws/install/attach.mjs \
  --distribution-id EXXXXXXXXXXXX \
  --stack norg-edge

# 3. Apply it, after choosing what happens to your cache key (see below).
node aws/install/attach.mjs \
  --distribution-id EXXXXXXXXXXXX \
  --stack norg-edge \
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
  so CloudFront honours the `Cache-Control` your origin already sends, and its
  cache key carries **only** `x-norg-agent`, the `agent` query string and the
  encoding. **The CLI refuses `replace` if your current policy keys on cookies,
  headers or query strings** — collapsing a session cache or a per-variant
  cache into one entry would serve one visitor's page to the next, and that is
  not a warning, it is a stop. Use `keep`.
- **`--cache-policy=keep`** — keep yours, and add `x-norg-agent` to its cache
  key yourself. A CloudFront **managed** policy cannot be edited, so "keep"
  means copying it to a custom policy first.

This splits your cache into at most two variants per URL. Diverted responses are
`private, no-store` and are never cached at all.

### The cache guard, and why only humans may cache

The `x-norg-agent` stamp is a deliberate **superset** of the agents the router
will divert: a spoofed `curl -A GPTBot`, a crawler NORG has marked
`never_divert`, and a headless browser all land in the `agent=1` bucket. On a
cache miss they reach the router, fail verification, and are passed through to
your origin. Without anything else, CloudFront would then cache **your origin
page** under `(url, agent=1)` for whatever TTL your origin declares — and every
later, genuinely verified crawler would be a cache *hit* on that entry. The
router would never run, and the mirror would be suppressed for the TTL by the
first bot-shaped request to arrive. Anyone could force it.

So the install carries a second, tiny Lambda@Edge function on
**origin-response**: it marks every response in a non-human bucket
`private, no-store` unless NORG served it. Only the confidently-human `agent=0`
bucket may ever cache origin bytes. The router itself cannot do this —
origin-request functions cannot touch the response — which is why it is a
separate function. It runs only when the origin is actually fetched for a
non-human bucket, at 128 MB for a few milliseconds; a mirror served by the
router never triggers it.

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
its access logs — on every path, including the failure ones.

**The site key is not among them.** It lives in Secrets Manager and the router
fetches it at the edge, so it is not readable from your distribution's
configuration, and rotating it is one operation rather than two. What the
distribution carries is the secret's ARN, which is an address, not a credential.

| Header | Default | Meaning |
|---|---|---|
| `x-norg-site-id` | *(required)* | `edge_sites.id` — identifies this install to NORG |
| `x-norg-secret-arn` | *(required)* | ARN of the Secrets Manager secret holding the site key |
| `x-norg-probe-token` | *(optional)* | Authorises the health probe and nothing else |
| `x-norg-api-url` | NORG's production API | Point at a different NORG environment |
| `x-norg-content-base` | NORG's edge-content service | Point at a different render source |
| `x-norg-env` | `unknown` | `production` or `test` — a test-bound install serves TEST content |
| `x-norg-strip-fallback` | `true` | `false` disables the stripped-origin fallback |
| `x-norg-disabled` | `false` | The kill switch (stack parameter `EdgeDisabled`). Every request passes straight through. **Not instant** — see Operational notes |
| `x-norg-lazy-render` | `true` | `false` serves the strip without asking NORG to render |
| `x-norg-events-verbose` | *(off)* | `true` also reports plain origin passthroughs |

### Carve-outs: what the router is never invoked for

There are now three groups of generated behaviours, matched in this order:

1. **MCP paths** (`/.well-known/mcp.json`, `*/mcp`, `*/sse`) — the full router,
   and the **only** behaviours with `IncludeBody: true`. Everywhere else the
   router receives no request body at all (see Operational notes).
2. **Dynamic paths** (`/api/*`, `/wp-json/*`, `/wp-admin/*`, `/wp-login.php`,
   `/cart`, `/cart/*`, `/checkout`, `/checkout/*`) — no Lambda and **no cache**:
   CloudFront's managed `CachingDisabled` + `AllViewerExceptHostHeader`, every
   method allowed. Your origin sees exactly what it would have without the
   router — including its *own* `Host`, which is why it is not plain
   `AllViewer`: that forwards the viewer's `Host`, and a host-routed origin
   (Vercel, API Gateway) answers it with 403. A 24-hour
   default TTL on `/cart` would serve one visitor's page to the next, which is
   why these do not share the static policy. `/account*` and `/login*` are
   deliberately absent — they also match marketing slugs like `/accounting`.
3. **Static assets** — no Lambda, cached 24 h by default.

**If you already have a behaviour for one of these patterns, yours is kept and
ours is skipped** — most importantly `/api/*`, which often points at a
different origin. The one exception is an MCP pattern, where the router *is*
the point, so a collision is refused. Detaching removes only behaviours that
match our shape on your default origin; a function-free `*.css` behaviour of
your own on the same origin is indistinguishable and would be removed with
ours — copy your patterns out first if that describes you.

The distribution ships with cache behaviours that carry **no Lambda
association**, so the router is never invoked — and never billed — for paths
that could never be a mirrored page. This is the same mechanism NORG uses on
Cloudflare, where each exclusion becomes a route with no Worker attached.

Two groups, both generated by `npm run build:aws` so they cannot drift:

- **Framework asset prefixes** — `/_next/*` and `/_vercel/*` by default, which
  is what NORG's own platform detection selects for a Next.js/Vercel origin.
  Serving a different stack? Replace them in the template's generated block
  (Shopify and WordPress equivalents are in `core/exclusions.mjs`).
- **Every static-asset extension** the router would have waved through anyway —
  `*.css`, `*.js`, `*.woff2`, and 46 more, from the same list the router itself
  uses.

On a typical Next.js page (~30 asset requests plus the document) this removes
roughly 95% of router invocations.

Two things worth knowing:

- **`.xml`, `.txt` and `.json` are deliberately absent** from the asset list.
  NORG's own surfaces use them — `/llms.txt`, `/tree.json`, `/openapi.json` — so
  a blanket rule would stop serving them. The build **fails** if a carve-out
  would shadow a NORG path.
- **Path patterns are case-sensitive.** `*.jpg` does not match `LOGO.JPG`; those
  fall through to the router, which lowercases and handles them correctly. A
  cost miss, never a correctness one.

Attaching to an existing distribution adds a curated ten suffixes instead of all
49, because the 75-behaviour budget is yours; the CLI refuses rather than
exceeding it.

### What your origin sees as `Host`

CloudFront requires an origin-request function to send the origin its **own**
hostname, so your origin always sees the origin domain — never the hostname the
visitor typed. This is not configurable: a mismatch is rejected with a 403
before your origin is contacted.

It matters if your origin is host-aware. Absolute URLs, canonical tags, cookie
domains and especially **auth middleware** will be built from the origin's
hostname. An auth layer that redirects to its own host will bounce visitors off
the CloudFront domain entirely. If that affects you, the fix is at the origin —
have it serve the CloudFront-facing hostname directly, or stop emitting
host-absolute redirects.

> **Where the site key is visible.** In Secrets Manager, and nowhere else in
> your account. Reading it needs `secretsmanager:GetSecretValue` on that one
> secret, and every read is recorded in CloudTrail. The router's and the
> heartbeat's execution roles are scoped to that ARN alone. It is a credential
> for this one site, and revoking it degrades the install to "always serve
> origin" — a safe stop, not an outage.
>
> Before 0.4.0 it sat in the distribution's configuration and again in the
> heartbeat's environment, readable to anyone with `cloudfront:GetDistributionConfig`
> or `lambda:GetFunctionConfiguration`. If you are upgrading, rotate the key:
> the old value was visible to a much wider set of principals.

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
curl -s -H "x-norg-edge-check: <your-probe-token>" https://your-domain.com/ | jq
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

**There is no mirror response cache.** Not because the cache key is too coarse
— it does include `x-norg-agent`, so agent and human traffic already occupy
different entries. The reason is what that header can mean: it is stamped by a
viewer-request function that has no network access, so it cannot check the
authenticated feed or verify a source IP, and it is deliberately a *superset* of
what actually gets diverted. A spoofed `curl -A GPTBot` from any address lands
in the same bucket as a real, verified GPTBot.

That is harmless today, because everything in that bucket still reaches the
router, which then applies classification, serving policy and IP verification.
Caching a mirror there would not be: a cache hit skips the router entirely, and
the spoofer would be served a mirror a genuine crawler had warmed.

Making it cacheable needs exact classification at viewer-request, which means
putting the bot feed in a CloudFront KeyValueStore — possible, but it places a
local copy of the patterns at the edge and means a revoked site key stops
diverting only when entries expire rather than at once. NORG's edge-content
service caches behind its own auth check regardless, so what is lost today is a
hop, not correctness.

---

## Operational notes

- **us-east-1, always.** Lambda@Edge is a us-east-1-only resource.
- **Rollback is slow.** Budget 5–15 minutes for any distribution change to
  propagate, and up to ~30 minutes before a Lambda@Edge replica can be deleted.
  If the site matters, attach to a
  [CloudFront continuous-deployment](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/continuous-deployment.html)
  staging distribution first and shift traffic gradually. "Degrades safely" and
  "reverts quickly" are not the same property, and this install has the first.
- **Cost.** Every cache miss invokes Lambda@Edge, which has **no free tier**
  (unlike CloudFront requests and Functions). Measured on a live install over a
  week — mean 126 ms, peak 116 MB — at the 192 MB this ships with:

  | | per 1M router invocations |
  |---|---|
  | Lambda@Edge (192 MB) | ~$1.80 |
  | CloudFront requests | $1.00 (first 10M/month free) |
  | CloudFront Functions | $0.10 (first 2M/month free) |

  The install keeps that number small by **not invoking the router for static
  assets at all** — see below.
- **Request bodies never reach the router except on MCP paths.** `IncludeBody`
  is set per association, and on the default behaviour it delivered every
  cache-miss POST body on your site — logins, checkouts, forms — into the
  router's memory, even though the router discards them. It is now **off** on
  the default behaviour and on only for the three MCP behaviours, the one
  surface that forwards a body. Access there is read-only; your origin still
  receives the full original body.
- **There is no instant off switch on CloudFront, and this README used to say
  there was.** Set the `EdgeDisabled` stack parameter to `"true"` (or the
  `x-norg-disabled` origin header) and the router passes everything through on
  its very first check — but that is a distribution update, and it takes
  **5–15 minutes** to propagate. So does detaching. The remote lever is NORG
  revoking your site key, which the router notices on its next feed refresh —
  up to an hour on a warm container, one minute on a cold one.
- **Where your site key is readable.** One place: the Secrets Manager secret
  the stack creates (or the one you pass as `SecretArn`). Reading it needs
  `secretsmanager:GetSecretValue` on that ARN, and CloudTrail records every
  read. **Rotating is a single call** and needs no redeploy — the edge picks up
  a new value within fifteen minutes, and the heartbeat within its next run:

  ```bash
  aws secretsmanager put-secret-value --secret-id <SecretArn> \
    --secret-string '<new-key>'
  ```

  If you would rather the key never entered a CloudFormation parameter at all,
  create the secret yourself and pass `SecretArn`; leave `SiteKey` blank.
- **The probe token is not your site key.** `x-norg-edge-check` compares against
  a token that authorises reading install status and nothing else. It is
  stripped from the request before the origin sees it, so a mistyped probe
  cannot land in your access logs either.
- **Logs are scattered and, by default, kept forever.** Lambda@Edge writes its
  logs to CloudWatch in the **region nearest the edge that ran it**, under
  `/aws/lambda/us-east-1.<function-name>` — a single install accumulates log
  groups in several regions with no retention set. Set one:

  ```bash
  for r in us-east-1 us-west-2 eu-west-1 ap-southeast-2; do
    aws logs put-retention-policy --region $r --retention-in-days 30 \
      --log-group-name /aws/lambda/us-east-1.<EdgeRouterFunction name>
  done
  ```

  Distribution access logging is **off** by default; if you need a record of
  what was served to whom, enable standard logging to S3 on the distribution.
  The stack creates two alarms — router errors (a 502 to a visitor) and
  heartbeat failures (NORG rejected the install) — give them somewhere to go
  with the `AlarmTopicArn` parameter.
- **Rate limiting is available and off by default.** Every cache miss on the
  default behaviour is a Lambda invocation on your bill, and unique paths never
  hit the cache, so a scraper can run the meter: roughly $1.80 per million
  invocations plus CloudFront's own fees. Set `EnableRateLimit=true` for a
  single per-IP rate-based WAF rule (`RateLimitPerFiveMinutes`, default 2000).
  It costs about $6/month; if you already run WAF, add the rule to your own ACL
  instead.
- **Verify what you deployed.** Every deployable artifact is digested in full
  in [`aws/src/DIGESTS.json`](../aws/src/DIGESTS.json), committed alongside the
  source it was built from, so you can check what you are about to run against
  what this repository publishes:

  ```bash
  sha256sum aws/src/edge-router-lambda.cjs aws/src/heartbeat-lambda.cjs \
    aws/src/cache-guard-lambda.cjs aws/src/viewer-classifier.js
  cat aws/src/DIGESTS.json
  ```

  Always pin `ArtifactObjectVersion` and `HeartbeatObjectVersion`, and check the
  zip's digest before launching:

  ```bash
  aws s3api list-object-versions --bucket <ArtifactBucket> --prefix edge-router-lambda/
  aws s3api get-object --bucket <ArtifactBucket> --key <ArtifactKey> \
    --version-id <ArtifactObjectVersion> router.zip && sha256sum router.zip
  ```

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

Provider-neutral logic lives in **`core/`** at the repository root, not under
`aws/`. Roughly 1,280 of the ~1,690 lines are neutral — the strip rewriter, bot
classification, the feed and entitlement gate, telemetry, path predicates,
constants and exclusions are identical on any CDN. Only the adapter is
CloudFront-specific.

| Path | What it is |
|---|---|
| `core/` | **Provider-neutral.** strip, agent, paths, feed, telemetry, deferred, norg, constants, exclusions, config helpers |
| `lambda/edge-router-lambda.js` | The router pipeline, same order as `workers/edge-router-worker.js` |
| `lambda/lib/` | **CloudFront adapters only** — `event.js`, `origin.js`, `config.js` |
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
