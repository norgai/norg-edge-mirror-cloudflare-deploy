# NORG Edge Router — WordPress plugin

This branch holds the **WordPress plugin** version of NORG's edge router, for
WordPress sites with no Cloudflare or other CDN in front of them. You don't
change DNS, you don't create an API token, and you don't deploy a worker.
Install a plugin and give it two values.

> **On Cloudflare?** Use the Cloudflare Worker on
> [`main`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/tree/main)
> instead. It runs before any cache and needs no plugin. Other CDNs are listed
> under [Other CDNs](#other-cdns).

Customer guide: [app.norg.ai/help/wordpress-plugin](https://app.norg.ai/help/wordpress-plugin).

---

## What the plugin does

It runs inside WordPress. On every page request it works out who is asking:

| Visitor | What they get |
|---|---|
| A person in a browser | Your site, unchanged |
| Googlebot, Bingbot and other search crawlers | Your site, unchanged (always; there is no setting for this) |
| A verified AI agent (GPTBot, ClaudeBot, PerplexityBot, …) asking for a page NORG has rendered | The NORG render, served **at your own URL** with no redirect |
| A verified AI agent asking for a page NORG hasn't rendered yet | Your page stripped down to its text, while NORG is asked to render it |

Three rules are built in and have no off switch:

1. **It must never break your site.** If anything fails (NORG can't be
   reached, the feed is missing, the plugin hits a bug), the plugin steps
   aside and WordPress serves the page as normal.
2. **Search engines always see exactly what people see.** Serving Googlebot
   something different would be cloaking.
3. **A user agent alone is never trusted.** AI agents are verified by source
   IP against the ranges their operators publish, using an authenticated feed from
   NORG. The plugin has no built-in bot list. Without the feed, it serves
   nothing different to anyone.

---

## Before you start

- [ ] **WordPress 6.0+ and PHP 7.4+.**
- [ ] **A NORG install for the site.** In NORG, go to Publishing › CDN & Edge ›
      **WordPress plugin** › **Create WordPress install**. You get the plugin
      zip, a **Site ID** and a **Site Key**. The key is shown **once**
      because NORG stores only its hash. If you lose it, ask NORG to rotate it.
- [ ] **Know your page cache.** If a cache plugin or your host serves a saved
      copy of a page before WordPress runs, the plugin never sees the request.
      See [Page caches](#page-caches) before you go live.
- [ ] **Know whether a proxy sits in front of you.** If the site is behind
      Cloudflare (without the NORG worker) or a load balancer, set **Visitor
      IP comes from** to match. Otherwise no agent can be verified.

---

## Install

1. **Upload the plugin.** In WordPress, go to Plugins › Add New › Upload
   Plugin, upload the zip and activate it.
2. **Connect it.** Use any one of these four methods:

   **Settings page.** Open Settings › NORG Edge Router, paste the Site ID and
   Site Key, then save.

   **`wp-config.php`.** This keeps the key out of the database, so it suits
   hosts and agencies. Add the lines above `That's all, stop editing!`:

   ```php
   define( 'NORG_SITE_ID',  'your-site-id-from-norg' );
   define( 'NORG_SITE_KEY', 'nek_live_your_site_key' );
   ```

   **WP-CLI.**

   ```bash
   wp plugin install <plugin-zip-url> --activate
   wp norg-edge configure --site-id=<site-id> --site-key=<site-key>
   wp norg-edge check
   ```

   **Let NORG connect it for you.** On the NORG page, open *Let NORG connect
   the plugin for you*. Enter a WordPress administrator username and an
   **Application Password** (WordPress: Users › Profile › Application
   Passwords). NORG uses the plugin's admin-only REST endpoints
   (`norg-edge/v1/status`, `norg-edge/v1/connect`) to enter the two values
   itself. The key is accepted there and never returned. If your site blocks
   its REST API or Application Passwords, NORG says so and the other methods
   still work. You can revoke the Application Password once the plugin is
   connected.

3. **Run checks.** See the next section.

---

## Verifying the install

### 1. Run checks (the real test)

Click **Run checks** on Settings › NORG Edge Router, or run `wp norg-edge
check`. The plugin sends real requests to your own site and reports each one:

| Row | Passes when |
|---|---|
| Feed | The authenticated agent feed was fetched from NORG |
| Human | A browser request comes back untouched |
| Search engine | A Googlebot request comes back untouched |
| Cache reach | An AI-agent request gets past every page cache and reaches the plugin |
| AI agent | A simulated verified agent gets `mirror` (rendered) or `stripped` (render requested) |

Every row should be green. The same results appear in Tools › Site Health.
Within seconds the install shows as active in NORG.

### 2. From outside the site

```bash
# Is the plugin alive and holding the right key?
curl -s -H "x-norg-edge-check: <your-site-key>" https://your-site.example/ | head -c 200
# {"site_id":"…","version":"0.1.1","platform":"wordpress","entitled":true,…}

# People get the site unchanged: expect no output
curl -sI https://your-site.example/some-page/ | grep -i x-norg-edge
```

A curl with a `GPTBot` user agent from your own computer also shows **no**
`X-Norg-Edge` header. This is by design: your IP isn't OpenAI's, so the
request isn't verified. Use **Run checks** to simulate a verified agent.

---

## Page caches

Unlike the Cloudflare worker, the plugin runs **after** any page cache. If a
cache answers an AI agent from a saved copy, the plugin never runs for that
request.

- **Cache plugins it handles for you:** WP Rocket, LiteSpeed Cache, WP Super
  Cache, WP Fastest Cache, W3 Total Cache and FlyingPress. The plugin
  registers NORG's AI user agents with each one so those agents skip the
  cache. If a cache plugin's settings get reset, use **Re-apply cache
  bypass** (or `wp norg-edge apply-cache-bypass`).
- **Cache Enabler** can't be bypassed from another plugin.
- **Managed-host caches** (Kinsta, WP Engine, Flywheel, …) sit outside
  WordPress. Your host has to bypass the listed agents. The settings page
  lists the exact user agents to ask them for. On nginx FastCGI cache, for
  example:

  ```nginx
  if ($http_user_agent ~* "(gptbot|claudebot|perplexitybot)") { set $skip_cache 1; }
  ```

- **Apache / LiteSpeed with a cache that has no API:** set
  `NORG_EDGE_HTACCESS_BLOCK` to write a generic `.htaccess` bypass block.

Pages served to AI agents are always marked uncacheable, so no cache can
show a NORG render to a person or a search engine.

The **Cache reach** row in Run checks shows whether an agent actually got
through.

---

## Configuration

The settings page covers the common options. Each option also has a
`wp-config.php` constant, and a constant overrides the setting.

| Constant | Default | Meaning |
|---|---|---|
| `NORG_SITE_ID` / `NORG_SITE_KEY` | — | Required |
| `NORG_TRUSTED_PROXY` | `auto` | Where the visitor IP comes from: `auto` (per request: CF-Connecting-IP from a Cloudflare peer, the last X-Forwarded-For / X-Real-IP hop from a private or shared-space peer, otherwise REMOTE_ADDR), `none` (REMOTE_ADDR), `cloudflare` (CF-Connecting-IP, accepted only from Cloudflare IPs) or `header` |
| `NORG_TRUSTED_PROXY_HEADER` | — | The header to read in `header` mode (for X-Forwarded-For, the last hop is used) |
| `NORG_EDGE_DISABLED` | `false` | Kill switch: every visitor gets the normal site |
| `NORG_CAPTURE_ONLY` | `false` | Record-only mode: report AI-agent visits and AI-referred human visits, and serve nothing different |
| `NORG_STRIP_FALLBACK_ENABLED` | `true` | Serve unrendered pages to agents stripped to their text |
| `NORG_LAZY_RENDER_ENABLED` | `true` | Ask NORG to render pages agents request |
| `NORG_EDGE_CACHE_BYPASS` | `true` | Register AI user agents with detected page-cache plugins |
| `NORG_EDGE_HTACCESS_BLOCK` | `false` | Write the generic `.htaccess` cache-bypass block |
| `NORG_EDGE_ORIGIN_PROBE` | `true` | Let the site's own `llms.txt` (and similar files) take priority over NORG's |
| `NORG_EDGE_AUTO_UPDATE` | `true` | Install plugin updates automatically |
| `NORG_EDGE_ENV` | derived from the API host | `production` / `test` |
| `NORG_API_URL` / `NORG_CONTENT_BASE` | NORG production | Point at another NORG environment |
| `NORG_EDGE_DEBUG` | `false` | Write a debug log to the PHP error log (never includes the key) |

---

## Updates and switching it off

**Updates** come from NORG's own update manifest, not wordpress.org. They
install automatically by default, and each one is checked against its
published SHA-256 before it's installed. Set `NORG_EDGE_AUTO_UPDATE` to
`false` to update by hand from the Plugins screen instead.

**To switch it off instantly**, use any of these. Each takes effect on the
next request:

- Tick **Disable** in the plugin's settings.
- Add `define( 'NORG_EDGE_DISABLED', true );` to `wp-config.php`. This works
  without logging in.
- Deactivate the plugin.

---

## Troubleshooting

**Cache reach is red, or agents always get the normal page**
A page cache is answering before WordPress runs. See [Page caches](#page-caches).
Re-apply the bypass for cache plugins. Ask your host for host-level caches.

**AI agent row says `untouched`, and Cache reach is green**
The agent isn't being verified. This is usually a proxy in front of the
site that *Detect automatically* does not recognise (for example a proxy on
a public address), so the plugin sees the proxy's IP. Set **Visitor IP comes
from** to Cloudflare, or to the header your proxy sets.

**Feed row is red**
The plugin can't reach `content-craft-api.norg.ai`, or the Site ID / Site
Key is wrong. Check for a truncated paste, and check that outbound HTTPS
from the server isn't blocked. Until the feed loads, the plugin serves
nothing different to anyone.

**Always `stripped`, never `mirror`**
Nothing has been rendered for that path yet. A first pass over a large site
takes a while. If it lasts more than a day, check that NORG's crawler can
reach your site and isn't blocked by a firewall or security plugin.

**`/llms.txt` and other root files don't work on a subdirectory install**
A WordPress at `/blog/` never receives requests for `/llms.txt`. Pages under
`/blog/` still work.

**Need help from NORG?** Use **Download debug report** on the settings page
and send it to your NORG contact. It contains only a masked Site Key and no visitor data.

---

## Security and privacy

- **Zero runtime dependencies.** The plugin is plain PHP in
  [`wordpress/norg-edge-router/`](wordpress/norg-edge-router/). Read it
  before you install it.
- **The only credential is the Site Key you configure**, and it's scoped to
  this one site. It's never logged, never returned by the REST API, and only
  appears masked in the debug report.
- **What it sends to NORG:**
  - The agent feed fetch (about hourly).
  - A heartbeat with the plugin, WordPress and PHP versions.
  - Render requests for paths that agents asked for.
  - MCP requests addressed to your site.
  - Update checks.

  In record-only mode it also reports AI-agent visits and AI-referred visits,
  using a daily-rotating, non-reversible visitor hash. It never sends
  cookies, names or emails.
- **Nothing is sent for ordinary visitors** outside record-only mode. Your
  page content is never sent to NORG. NORG crawls your public pages itself.

Full detail is in the plugin's
[`readme.txt`](wordpress/norg-edge-router/readme.txt), under "External
services".

---

## For NORG engineers

The plugin's developer reference is [`wordpress/README.md`](wordpress/README.md).
It covers:

- How the plugin differs from the Cloudflare worker, line by line.
- The repository layout.
- Unit and end-to-end tests.
- The release steps: tag `wordpress-vX.Y.Z`, then pin the version and
  SHA-256 in content-craft's `services/edge_routing/wordpress_pin.py` and
  `EDGE_WORKER_VERSION_WORDPRESS`.

The worker source (`workers/`, `src/`) is also on this branch, because the
plugin's test vectors are generated from it (`wordpress/bin/gen-vectors.mjs`).
CI fails if the vectors are stale, so classification, paths and strip output
stay identical to the worker.

---

## Other CDNs

| Platform | Branch | Install guide |
|---|---|---|
| **Cloudflare** | [`main`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/tree/main) | [README](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/blob/main/README.md) |
| **AWS CloudFront** | [`feature/aws-cloudfront`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/tree/feature/aws-cloudfront) | [`aws/README.md`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/blob/feature/aws-cloudfront/aws/README.md) |
| **Fastly Compute** | [`feature/fastly-compute`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/tree/feature/fastly-compute) | [`fastly/README.md`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/blob/feature/fastly-compute/fastly/README.md) |
| **Bunny Edge Scripting** | [`feature/bunny-edge-scripting`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/tree/feature/bunny-edge-scripting) | [`bunny/README.md`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/blob/feature/bunny-edge-scripting/bunny/README.md) |
| **WordPress (no CDN)** | `feature/wordpress-plugin` (this branch) | this README |

---

## Support

For questions about your install, your Site ID or Site Key, or whether a CDN
install would suit you better, contact your NORG account contact.
