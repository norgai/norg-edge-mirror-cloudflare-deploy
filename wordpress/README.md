# NORG Edge Router — WordPress plugin

The same edge router as the Cloudflare Worker in this repo, as a WordPress plugin,
for sites that will not put Cloudflare or another CDN in front of themselves.
Installed inside WordPress, it decides per request who is asking:

| Visitor | What they get |
|---|---|
| A person in a browser | Your site, unchanged |
| Googlebot, Bingbot and other search crawlers | Your site, unchanged (always; no setting) |
| A verified AI agent, page rendered by NORG | The NORG render at your own URL, no redirect |
| A verified AI agent, page not rendered yet | Your page stripped to its text, while NORG renders it |

The worker's rules hold unchanged: **it never breaks the site** (every failure path
returns and WordPress serves the page), **search engines see what people see**, and
**nothing happens without an authenticated feed** (no baked-in bot list).

Customer guide: [app.norg.ai/help/wordpress-plugin](https://app.norg.ai/help/wordpress-plugin).

## Install

1. In NORG: Publishing › CDN & Edge › **WordPress plugin** › Create WordPress install
   (or `manage_edge_routing(action='install_wordpress_plugin')`). You get the zip,
   a Site ID and a one-time Site Key.
2. In WordPress: Plugins › Add New › Upload Plugin, activate.
3. Settings › NORG Edge Router: paste both values, Save, **Run checks**.

Or in `wp-config.php` (keeps the key out of the database):

```php
define( 'NORG_SITE_ID', '…' );
define( 'NORG_SITE_KEY', 'nek_live_…' );
```

Or `wp norg-edge configure --site-id=… --site-key=… && wp norg-edge check`.

| Constant | Default | Meaning |
|---|---|---|
| `NORG_SITE_ID` / `NORG_SITE_KEY` | — | Required |
| `NORG_EDGE_ENV` | derived from the API host | `production` / `test` |
| `NORG_API_URL` / `NORG_CONTENT_BASE` | NORG production | Point at another NORG environment |
| `NORG_EDGE_DISABLED` | `false` | Kill switch: every visitor gets the normal site |
| `NORG_CAPTURE_ONLY` | `false` | Record-only: report agent visits and AI-referred human visits, serve nothing different |
| `NORG_STRIP_FALLBACK_ENABLED` / `NORG_LAZY_RENDER_ENABLED` | `true` | Strip unrendered pages for agents / ask NORG to render them |
| `NORG_TRUSTED_PROXY` | `auto` | `auto` (detect per request), `none` (REMOTE_ADDR), `cloudflare` (CF-Connecting-IP, only from Cloudflare IPs) or `header` |
| `NORG_TRUSTED_PROXY_HEADER` | — | Header for `header` mode (X-Forwarded-For takes the last hop) |
| `NORG_EDGE_CACHE_BYPASS` | `true` | Register AI user agents with detected page-cache plugins |
| `NORG_EDGE_HTACCESS_BLOCK` | `false` | Generic `.htaccess` bypass block (Apache/LiteSpeed) for caches with no API |
| `NORG_EDGE_ORIGIN_PROBE` | `true` | Let the site's own `llms.txt` etc. win over NORG's |
| `NORG_EDGE_AUTO_UPDATE` | `true` | Install plugin updates automatically |
| `NORG_EDGE_DEBUG` | `false` | Debug log to the PHP error log (never the key) |

## Differences from the Cloudflare install

| | Cloudflare worker | WordPress plugin |
|---|---|---|
| Where it runs | Before any cache | Inside WordPress, **after** any page cache. The plugin registers AI user agents with WP Rocket, LiteSpeed Cache, WP Super Cache, WP Fastest Cache, W3 Total Cache and FlyingPress, and **Run checks** proves whether agents reach it. Host caches (Kinsta, WP Engine, …) need the host to bypass the listed agents. Cache Enabler cannot be bypassed from a plugin. |
| Agent verification | CIDR, then Cloudflare's verified-bot signal | CIDR only; the client IP follows the trusted-proxy setting; fails closed |
| Telemetry on mirror hit/miss | Worker posts `/events` | The content receptionist records it from the `X-Norg-Visit` header on the mirror fetch; `raw_word_count` is not reported |
| Render requests | Worker posts `/render-requests` | Plugin posts them after the response, with the page path |
| Background work | `ctx.waitUntil` | After the response via `fastcgi_finish_request` / `litespeed_finish_request`; best-effort (non-blocking) on other SAPIs; WP-Cron heartbeat every 30 min |
| Strip | HTMLRewriter (streaming) | Buffered port of `core/strip.js`, same output as CloudFront/Bunny |
| Response cache | Per colo | None (the receptionist's own cache absorbs repeats) |
| Discovery files origin-first | Subrequest to origin | A real file in the docroot never reaches PHP; plugin-generated files are found with a cached loopback probe |
| MCP POST relay | Streamed | Buffered, 10 s |
| Root artifacts on a subdirectory install | n/a | `/llms.txt` never reaches a WordPress at `/blog/`; pages still work |
| Kill switch | Binding | Settings toggle, `NORG_EDGE_DISABLED`, or deactivate; immediate |
| Updates | API-token push / redeploy | Pulled from NORG's manifest, SHA-256 verified, automatic by default |

## Layout

```
norg-edge-router/        the plugin (what ships; zero runtime dependencies)
  includes/              one class per file; cache/ = page-cache adapters; admin/ = settings + status
bin/gen-vectors.mjs      regenerates tests/fixtures from the worker source (CI fails if stale)
bin/build-zip.sh         norg | wporg channel zips (wporg drops the updater and Update URI)
tests/unit/              PHPUnit against the shared vectors (paths, classify, CIDR, strip, …)
tests/e2e/               real WordPress (SQLite, PHP built-in server) + mock NORG:
  run.sh                 81 pipeline checks (both rules, every surface, revocation, outage, capture)
  cache-plugins.sh       WP Super Cache before/after proof; WP Fastest Cache + LiteSpeed config proofs
  updates.sh             self-hosted update channel: wrong checksum refused, right one installs
  ui.sh, ui/             Playwright admin journey in Chrome (headed unless HEADLESS=1)
```

## Development

```bash
cd wordpress
composer install                       # dev tools only
vendor/bin/phpunit                     # unit
vendor/bin/phpcs && vendor/bin/phpstan analyse
node bin/gen-vectors.mjs               # after any worker change
bash tests/e2e/setup.sh /tmp/wp-e2e && bash tests/e2e/run.sh /tmp/wp-e2e
bash tests/e2e/cache-plugins.sh /tmp/wp-e2e
bash tests/e2e/ui.sh /tmp/wp-e2e       # needs a display; HEADLESS=1 otherwise
```

## Releasing

1. Bump the version in `norg-edge-router.php` (header and `NORG_EDGE_ROUTER_VERSION`)
   and `readme.txt` (`Stable tag`, changelog); `build-zip.sh` refuses a mismatch.
2. Tag `wordpress-vX.Y.Z`. The release workflow builds both zips, publishes them,
   and prints the SHA-256.
3. In content-craft, bump `services/edge_routing/wordpress_pin.py` (`GA` version +
   sha256) and `EDGE_WORKER_VERSION_WORDPRESS` together. For a staged rollout set
   `CANARY` instead and move chosen sites with
   `manage_edge_routing(action='wordpress_update_channel_set', update_channel='canary')`.
