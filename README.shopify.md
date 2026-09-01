# NORG Edge Router on Shopify — Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/norgai/norg-edge-mirror-cloudflare-deploy)

This is the **Shopify install guide** for this repo's edge-mirroring worker:
it puts the exact same worker documented in [README.md](README.md) in front
of a **Shopify storefront**, using your own Cloudflare zone and Cloudflare's
officially supported **Orange-to-Orange (O2O)** integration with Shopify.
This separate guide exists because getting the worker in front of a Shopify
store requires one extra layer of setup (O2O) and has two Shopify-specific
rules you must not break, both covered below. (Not on Shopify? Use
[README.md](README.md) instead.)

Click the button, answer two prompts, and the worker deploys straight into
**your own** Cloudflare account — NORG never receives an API token, and never
gets deploy access to anything in your account.

If you'd rather NORG handle the deploy and keep it automatically up to date,
ask your NORG contact about the **API-token install** instead — see
[Trade-offs vs. the API-token install](#trade-offs-vs-the-api-token-install).

> **Is this install right for your store?** It requires (a) a **custom
> domain** (a store reachable only at `*.myshopify.com` cannot use this), and
> (b) that domain's DNS being managed in **your own Cloudflare account**. If
> your DNS is managed by Shopify and you don't want to move it, this repo is
> not your path — ask your NORG contact about the Shopify App Proxy
> integration instead.

---

## What this worker does

Installed on your zone at `{your-shop-domain}/*`, it inspects every request
and decides who's asking:

| Visitor | What they get |
|---|---|
| A person in a browser | Your storefront, byte-for-byte unchanged |
| Googlebot, Bingbot, and other web-index crawlers | Your storefront, byte-for-byte unchanged |
| An AI agent (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, …) asking for a page NORG has already rendered | The NORG render, fetched behind the scenes and served **at your own URL** — no redirect, the address bar never changes |
| An AI agent asking for a page NORG hasn't rendered yet | Your own page, stripped down to the token-dense facts, while NORG is asked in the background to render it properly |
| Anyone on `/checkout` | Your Shopify checkout, untouched — Cloudflare disables Workers on the `/checkout` path in an O2O setup, so this worker physically cannot run there |

Two rules are built into the worker and have no off switch:

1. **It must never break your store.** Every failure path — NORG's API down,
   its storage unreachable, a bug in the worker itself — falls back to your
   Shopify-served response, unmodified.
2. **Search engines always see exactly what humans see.** Serving Googlebot
   different content than a real visitor is cloaking and would put your search
   rankings at risk, so traditional search crawlers are always passed straight
   through, unconditionally.

Buying from your store behaves exactly as it did before: every human visitor
passes straight through on every path, and `/checkout` is excluded from the
worker entirely at the Cloudflare platform level. NORG only ever mirrors
pages from your store's sitemap — commerce endpoints like `/cart` are never
rendered or mirrored.

---

## Before you start

- [ ] **Your store uses a custom domain** (e.g. `your-shop.com`), connected in
      Shopify under **Settings → Domains**. A store reachable only at
      `something.myshopify.com` has no domain of yours to route through
      Cloudflare, so this install cannot work for it.
- [ ] **That domain's DNS is managed in your own Cloudflare account** — the
      domain's nameservers point at Cloudflare and the zone appears in *your*
      dashboard. If Shopify (or another registrar) currently manages the DNS,
      you must move DNS management to Cloudflare first — see
      [Setting up Orange-to-Orange](#setting-up-orange-to-orange-o2o).
- [ ] **The domain's record is a proxied CNAME to `shops.myshopify.com`**
      (the orange cloud icon). This is the O2O setup itself — a grey-cloud
      (DNS-only) record never reaches Cloudflare's network, so the worker can
      never run.
- [ ] **"Always Use HTTPS" is OFF in your Cloudflare zone.** This one is not
      optional and not obvious: with it on, Shopify silently loses the ability
      to renew your domain's SSL certificate. Details and the safe alternative
      are in the O2O section below.
- [ ] **You have a Cloudflare account that can create Workers.** The free plan
      is enough to get started — read
      [The one caveat: the Workers free plan](#the-one-caveat-the-workers-free-plan)
      before pointing it at a high-traffic store.
- [ ] **You have a `SITE_ID` and a `NORG_SITE_KEY`.** NORG issues both when you
      register the site for edge routing. The key is shown to you **once** —
      NORG stores only a hash of it, so if you lose it, ask NORG to rotate it.
- [ ] **No other Worker is already routed on `{your-shop-domain}/*`.** Nothing
      here detects a conflict; see [Limitations](#limitations).

---

## Setting up Orange-to-Orange (O2O)

O2O is Cloudflare's supported way to put your own Cloudflare zone *in front
of* Shopify's: traffic hits your zone first (where this worker runs), then
flows on to Shopify's infrastructure, which serves your storefront exactly as
before. It works on **every Cloudflare plan, including free**. If your domain
is already on Cloudflare with a proxied CNAME to Shopify, skip to
[Quick start](#quick-start).

1. **Put the domain on Cloudflare** (skip if already there): add the domain
   as a zone in your Cloudflare account and switch the domain's nameservers
   to the ones Cloudflare assigns. DNS records are usually imported
   automatically; verify them before switching.
2. **Create the Shopify CNAME, proxied:**

   ```
   Type:    CNAME
   Name:    your-shop.com        (or the subdomain your store lives on)
   Target:  shops.myshopify.com
   Proxy:   Proxied (orange cloud)
   ```

3. **Connect the domain in Shopify** under **Settings → Domains → Connect
   existing domain**, if it isn't already, and wait until Shopify shows the
   domain as connected with SSL active.
4. **Leave "Always Use HTTPS" OFF** (Cloudflare → your zone → SSL/TLS → Edge
   Certificates). Shopify provisions and renews your certificate with
   Let's Encrypt HTTP-01 challenges against
   `/.well-known/acme-challenge/*` — a blanket HTTPS redirect breaks those
   challenges, and the failure shows up weeks later as an expired
   certificate. If you want HTTP→HTTPS redirects at the Cloudflare layer,
   create a **Redirect Rule** that excludes
   `/.well-known/acme-challenge/*` instead of using the global toggle.
5. **Sanity-check the storefront** in a browser before installing anything:
   your store should look and behave exactly as before, and Shopify's admin
   should show no domain errors. (If Shopify's admin shows a warning about a
   Cloudflare proxy on your domain, see
   [Troubleshooting](#troubleshooting) — a proxied CNAME to
   `shops.myshopify.com` is the supported O2O shape; the warning targets
   other proxy setups.)

Only move on to the worker install once the store serves correctly through
your Cloudflare zone.

---

## Quick start

1. Complete the [O2O setup](#setting-up-orange-to-orange-o2o) above and
   confirm your storefront serves normally through your Cloudflare zone.
2. Click **Deploy to Cloudflare** above.
3. Sign in and authorize Cloudflare to fork this repository into your own
   GitHub/GitLab account (Cloudflare clones it — NORG is never involved in
   this step and receives nothing from it).
4. When prompted, fill in the two values from [Configuration](#configuration)
   below. Everything else has a sensible default baked into the worker.
5. Cloudflare builds and deploys the Worker into your account.
6. **Add the route manually** — see [next section](#manual-step-attach-the-route).
   This is the one step the button doesn't do for you.
7. Run the checks in [Verifying the install](#verifying-the-install).

---

## Configuration

Cloudflare prompts for these during the button flow. Both are also editable
afterwards under **Workers & Pages → the worker → Settings → Variables**.

| Name | Kind | Example | Meaning |
|---|---|---|---|
| `SITE_ID` | Plain variable | `9f1c2e4a-…` | `edge_sites.id` — identifies this install to NORG |
| `NORG_SITE_KEY` | **Secret** — never a plain variable | `nek_live_…` | Per-site key authenticating this install to NORG's API. Also the credential for the health probe below. |

⚠️ **`NORG_SITE_KEY` must be set as an encrypted variable** (Settings →
Variables → *Add variable* → toggle **Encrypt**, or `wrangler secret put
NORG_SITE_KEY` from the CLI) — never pasted into `wrangler.jsonc`'s `vars`
block or committed anywhere. It is the one credential this install has, and
it is scoped to this site only.

### Advanced overrides

Everything below is baked into the worker as a default. Add one of these vars
**only** to change its default behaviour — most installs never touch this
table.

| Name | Default | Set it to… |
|---|---|---|
| `NORG_API_URL` | NORG's production API | Point the worker at a different NORG environment |
| `NORG_CONTENT_BASE` | NORG's edge-content service | Point at a different render source |
| `STRIP_FALLBACK_ENABLED` | `true` | `false` to disable the stripped-origin fallback on a render miss |
| `EDGE_DISABLED` | `false` | `true` to switch the worker off instantly without removing it (every request passes straight through to Shopify) |
| `LAZY_RENDER_ENABLED` | `true` | `false` to serve the stripped origin on a miss without asking NORG to render it |

There is no content-prefix or bucket-path variable — the worker authenticates
with `SITE_ID` + `NORG_SITE_KEY` and NORG resolves which content belongs to
your site entirely server-side. A misconfigured install cannot read another
site's content.

---

## Manual step: attach the route

The button deploys the script, but Cloudflare does **not** attach it to any
traffic automatically. Someone with access to the zone has to do this once:

**Workers & Pages → the worker → Settings → Domains & Routes → Add route**

```
Route:  your-shop.com/*
Zone:   your-shop.com
```

Use `{your-shop-domain}/*`, not a narrower path — the worker is written to
see every request and pass through the ones it doesn't handle itself. You do
**not** need to carve out `/checkout`: Cloudflare disables Workers on that
path in an O2O setup regardless of the route pattern.

---

## Verifying the install

Run these against a real page on your store — a product or collection page
works well.

### 1. An AI agent gets the NORG treatment

```bash
curl -sI -H "User-Agent: GPTBot" https://your-shop.com/products/some-product | grep -i x-norg-edge
```

| Result | Meaning |
|---|---|
| `X-Norg-Edge: mirror` | A NORG render exists and was served. Fully working. |
| `X-Norg-Edge: stripped` | Nothing rendered yet — your page was served stripped, and a render was requested. Re-check in a few minutes. |
| *(no header at all)* | The worker never saw the request — jump to [Troubleshooting](#troubleshooting). |

### 2. A normal visitor is untouched

```bash
curl -sI -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36" \
  https://your-shop.com/products/some-product | grep -i x-norg-edge
```

Expect **no output at all** — a real browser user-agent must get your
unmodified storefront response, with no NORG headers added. Load the page in
an actual browser too; it should look identical to before the install.

### 3. Search engines are untouched

```bash
curl -sI -H "User-Agent: Googlebot/2.1 (+http://www.google.com/bot.html)" \
  https://your-shop.com/products/some-product | grep -i x-norg-edge
```

Expect **no output**, same as a browser. Googlebot, Bingbot, Applebot,
DuckDuckBot, Baiduspider, and YandexBot are always passed straight through.

### 4. Checkout is untouched

Add a product to the cart in a real browser and walk through to the payment
step of checkout (you can abandon it there). Everything should behave exactly
as before the install. Then confirm Cloudflare's checkout exclusion is in
effect even for an AI user-agent:

```bash
curl -sI -H "User-Agent: GPTBot" https://your-shop.com/checkout | grep -i x-norg-edge
```

Expect **no output** — Cloudflare never invokes Workers on `/checkout` in an
O2O setup, so the worker cannot touch it.

### Optional: is the worker alive at all?

```bash
curl -s -H "x-norg-edge-check: <your-site-key>" https://your-shop.com/ | head -c 200
# {"site_id":"…","version":"…","disabled":false,"ts":…}
```

A JSON response confirms the script is deployed, routed, and holding the
correct key. Omit the header and the same path behaves completely normally —
this can never shadow a real page on your store.

---

## If this route doesn't work out

If the button flow fails, your Cloudflare/GitHub setup can't support it, or
you get stuck on any step above, you don't need to debug it alone — fall back
to the **API-token install** instead. You give NORG a scoped Cloudflare API
token (Workers Scripts: Edit, Workers Routes: Edit, Zone WAF: Edit, Zone/DNS:
Read) and NORG deploys the worker, creates the route, and verifies the install
for you end to end — including the Shopify-specific checks (O2O CNAME shape,
"Always Use HTTPS" off) that this manual route leaves to you. Full
walkthrough, including how to create the scoped token:
[app.norg.ai/help/cloudflare-worker](https://app.norg.ai/help/cloudflare-worker) —
see also [Trade-offs vs. the API-token install](#trade-offs-vs-the-api-token-install)
below, or ask your NORG contact to switch you to that route.

## Troubleshooting

**No `X-Norg-Edge` header for any user-agent, and the health probe returns
your storefront instead of JSON**
The worker isn't running on that request. Check, in order of likelihood: the
CNAME to `shops.myshopify.com` is grey-clouded (must be proxied); the route
was never added, or was added narrower than `{your-shop-domain}/*`; another
Worker already owns `{your-shop-domain}/*` and wins on route precedence; the
Worker was deployed into a different Cloudflare account than the one that
owns the zone.

**Shopify admin shows a warning about a Cloudflare proxy on your domain**
Shopify's blanket warning covers proxy setups it can't reason about. The
specific shape this install requires — your own Cloudflare zone with a
**proxied CNAME to `shops.myshopify.com`** — is the Orange-to-Orange
configuration that Cloudflare documents and supports for Shopify. What is
genuinely unsupported (and genuinely breaks stores) is proxying Shopify
behind other CDNs or pointing proxied records at Shopify IPs directly. If
the warning appears alongside real symptoms — SSL errors, pages not loading —
treat it seriously and check the next item.

**SSL certificate errors, or Shopify says it can't provision/renew the
domain's certificate**
Almost always "Always Use HTTPS" (or an equivalent blanket redirect) at the
Cloudflare layer. Shopify renews your certificate via HTTP requests to
`/.well-known/acme-challenge/*`; a forced redirect breaks them. Turn the
global toggle off and, if you want redirects, use a Redirect Rule that
excludes that path. Renewal can take a while to recover after you fix it —
if the certificate has already expired, contact Shopify support to re-trigger
provisioning.

**The worker never fires on `/checkout` — is something broken?**
No. Cloudflare disables Workers and Snippets on the `/checkout` path in O2O
setups, by design. AI agents requesting checkout URLs simply get Shopify's
normal response.

**Health probe (or any request) returns HTTP 403 before your worker's own
logic runs**
Cloudflare evaluates **WAF Managed Rules** and **Bot Fight Mode** *before* a
Worker route fires, so a zone with either enabled can block the health probe
— and real agent traffic — before your code ever sees it. Ask your NORG
contact about the `waf_skip_rule` action, which creates a single scoped WAF
Custom Rule that only skips the managed WAF for known AI-agent user agents
plus the health probe carrying your exact site key — never a blanket
all-traffic skip. It needs a Cloudflare API token with **Zone → Zone WAF →
Edit**.

**Always `stripped`, never `mirror`**
Nothing has been rendered for that path yet. Renders run at low priority and
a first pass over a large store can take a while. If it persists more than a
day, check whether NORG's crawler can actually reach your storefront at all —
Shopify's own bot protection challenging it means nothing will ever render.
Ask NORG to check the site's reachability status.

**Everything returns an error, humans included**
Check your Cloudflare Workers request usage first — see the free-plan caveat
below. To restore service immediately, set `EDGE_DISABLED` to `true`, or
remove the route; your storefront is unaffected either way.

**`/mcp` or `/.well-known/mcp.json` returns a Shopify 404 page**
Same "not rendered yet" condition as above — it resolves the same way. Note
Shopify also publishes its own MCP endpoint at `/api/mcp`; the two coexist —
NORG's serves your mirrored content, Shopify's serves its commerce tools, and
the worker never touches `/api/mcp`.

---

## The one caveat: the Workers free plan

The worker is written so that anything going wrong *inside* it falls back to
your storefront. There is exactly one failure it cannot protect you from,
because it happens **before** the worker's own code runs at all.

**On the Cloudflare Workers free plan, an account is capped at 100,000 Worker
requests per day.** Once that's hit, Cloudflare stops invoking the Worker
entirely and returns its own error for every request matching the route.
Because the route is `{your-shop-domain}/*`, that means **every request to
your store** — shoppers included — and the Worker's fall-back logic never
gets the chance to run. For a revenue-generating storefront this is a real
outage risk, so treat the free plan as evaluation-only:

- Comfortably under ~100k requests/day account-wide, the free plan is fine
  for trying it out.
- On any store where an outage costs you sales — which is most stores —
  move to **Workers Paid** (a small flat monthly fee) before adding the
  route; it removes the cliff entirely.
- The limit is your whole Cloudflare **account's** total Worker requests, so
  other Workers you run count against it too.

If you ever need to stop the Worker in a hurry without touching the route,
set `EDGE_DISABLED` to `true` in its variables.

---

## Security and privacy

- **The Worker is a single self-contained file with zero imports and zero
  third-party dependencies.** What you deploy is exactly `src/edge-router-worker.js`
  in this repo — read it before you deploy it.
- **No NORG-internal credential of any kind is in this code.** The only secret
  the Worker holds is the `NORG_SITE_KEY` you configure yourself, scoped to
  this one site.
- **NORG never has deploy access to your Cloudflare account,** and never any
  access of any kind to your Shopify admin. The button forks this repo into
  *your* account and Cloudflare's own CI/CD deploys it from there.
- **The worker never sees checkout traffic** — Cloudflare withholds the
  `/checkout` path from Workers in an O2O setup — and human visitors pass
  straight through unmodified on every other path.
- **What leaves your Cloudflare account:** the `SITE_ID`, the classified
  visitor type (bot name / "human"), and the requested path, sent to NORG's
  API so it knows what to render next and can report you visit analytics.
  Full page content of *your own store* is never sent to NORG by this Worker —
  it only reads NORG's own previously-rendered pages back.

---

## Limitations

Installing this way trades NORG's ability to maintain the install for you
never having to hand over an API token. That trade is real:

- **A button install is a fork NORG cannot update.** Cloudflare deploys from
  the clone in *your* account. When NORG ships a Worker fix — a classification
  bug, a new bot-pattern shape, a safety fix — every button-installed site
  keeps running the old version until someone in your account redeploys it.
  Heartbeats report the deployed version, so NORG can *see* the drift and will
  email you about it, but cannot act on it directly.
- **NORG's only remote control is invalidating your Site Key.** Rotating or
  revoking it makes this Worker's calls back to NORG start failing — which,
  because every failure path here ends at your storefront, degrades the
  install to "always serve Shopify." That's a safe stop, not an uninstall:
  the script keeps running and the route stays attached until you remove it.
- **There's no route-conflict detection.** If your zone already has a Worker
  on `{your-shop-domain}/*`, Cloudflare's route precedence silently decides
  which one runs, and the other is never invoked.
- **Config drift is invisible from NORG's side.** Editing `NORG_CONTENT_BASE`
  or clearing `NORG_SITE_KEY` in your dashboard produces an install that looks
  deployed but serves nothing but your storefront.
- **`/checkout` is never mirrored** — a platform rule, not a NORG choice.
  AI shopping agents that want to *transact* with your store are served by
  Shopify's own agentic-commerce surfaces (its `/api/mcp` endpoint and
  catalog feeds), which this install complements rather than replaces.
- **This install requires DNS in your own Cloudflare account.** If your
  domain's DNS must stay with Shopify, ask your NORG contact about the
  Shopify App Proxy integration instead.

### Trade-offs vs. the API-token install

With a scoped Cloudflare API token, NORG can upload the script and create the
route itself. That keeps the update path open: a new Worker version reaches
your zone automatically, the route is created correctly and verified — with
the Shopify O2O preflight checks run for you — and the install can be
genuinely paused or removed remotely by NORG on your request.

Use this button-based install when you'd rather not issue an API token —
just budget for redeploying it yourself when NORG tells you a new version is
available.

---

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in your own SITE_ID / NORG_SITE_KEY, never commit this file
npm run dev                       # wrangler dev
```

`.dev.vars` is gitignored. Never put a real `NORG_SITE_KEY` in `wrangler.jsonc`
or any committed file — it belongs in `.dev.vars` locally, and as an
**encrypted** variable once deployed.

---

## Keeping this repo in sync with NORG's worker source

This repo — this file included — is generated, not hand-authored. If you're
a NORG engineer updating the worker: edit
`infrastructure/cloudflare/workers/edge-router-worker.js` (+ `workers/lib/`)
in the `content-craft` repo, run
`node infrastructure/cloudflare/build.mjs`, then
`node infrastructure/cloudflare/deploy-template/extract.mjs <dir>` to
produce a fresh checkout of this repo's contents (both READMEs ship
together), and push it here. Bump `EDGE_SCRIPT_VERSION` (in the worker
source) and `EDGE_WORKER_VERSION` (NORG's backend setting) together first,
or every already-installed site is told forever that an update is
available.

Customers on this install route do **not** receive worker updates
automatically — see [Limitations](#limitations) above.

---

## Support

Questions about your install, your Site ID/Key, the O2O setup, or whether the
API-token route would suit you better — reach out to your NORG account
contact.
