=== NORG Edge Router ===
Contributors: norgai
Tags: ai, llms.txt, ai search, crawlers, chatgpt
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.1.2
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Serve NORG's AI-optimised version of your pages to verified AI agents at your own URLs. People and search engines always get your site, unchanged.

== Description ==

NORG Edge Router does inside WordPress what NORG's Cloudflare Worker does at the edge, for sites that do not use Cloudflare.

On every page request it decides who is asking:

* **A person in a browser** gets your site, byte for byte unchanged.
* **Googlebot, Bingbot and other search crawlers** always get your site unchanged. Serving them anything else would be cloaking, so there is no setting to change this.
* **A verified AI agent** (GPTBot, ClaudeBot and others NORG publishes) gets the NORG render of that page at your own URL, with no redirect.
* **An AI agent asking for a page NORG has not rendered yet** gets your page stripped to its text, and NORG is asked to render it.

Two rules are built in with no off switch:

1. **It must never break your site.** Any failure, NORG being unreachable, or a bug in the plugin, falls back to your normal page.
2. **Search engines see exactly what people see.**

AI agents are verified by their source IP address against ranges their operators publish. A user agent alone is never trusted.

= Page caches =

Most cache plugins answer from a saved copy before WordPress runs. The plugin registers NORG's AI user agents with WP Rocket, LiteSpeed Cache, WP Super Cache, WP Fastest Cache, W3 Total Cache and FlyingPress so those agents reach WordPress, and its self-check proves whether they do. Host-level caches (for example Kinsta or WP Engine) need a rule from your host; the status page tells you exactly what to ask for.

== Installation ==

1. Upload the plugin zip under Plugins > Add New > Upload Plugin, and activate it.
2. Open Settings > NORG Edge Router and paste the Site ID and Site Key NORG gave you. Hosts can instead define `NORG_SITE_ID` and `NORG_SITE_KEY` in wp-config.php, or run `wp norg-edge configure --site-id=... --site-key=...`.
3. Click **Run checks**. Every row should be green.

= Verify from your own computer =

    curl -sI -A "Mozilla/5.0 (compatible; GPTBot/1.2)" https://your-site.example/some-page/ | grep -i x-norg-edge

From your computer this shows nothing, because your IP is not OpenAI's. The plugin's **Run checks** button simulates a verified agent from the server itself.

== External services ==

This plugin connects to NORG, the service that produces the AI-optimised pages. It sends nothing until you enter a Site ID and Site Key from NORG.

* **content-craft-api.norg.ai** — the plugin fetches the list of AI agents and their published IP ranges (about once an hour), sends a heartbeat (at most every 15 minutes while agents visit, and every 30 minutes by cron) with the plugin, WordPress and PHP versions, asks NORG to render a page an AI agent requested, relays MCP (Model Context Protocol) requests addressed to your site, and checks for plugin updates.
* **edge-content.norg.ai** — the plugin fetches NORG's render of the requested page when a verified AI agent visits. The request describes that visit: the requested path, the agent's user agent and the classification.
* In record-only mode the plugin reports AI-agent visits, and visits from people who arrived from an AI answer (with a daily-rotating, non-reversible visitor hash; never cookies, names or emails).

Nothing is sent for ordinary visitors outside record-only mode. Your page content is never sent to NORG; NORG crawls your public pages itself.

NORG terms: https://norg.ai/terms — Privacy policy: https://norg.ai/privacy

== Frequently Asked Questions ==

= Will this hurt my SEO? =

No. Search-engine crawlers always get your unchanged site, and every page served to an AI agent is marked uncacheable so no cache can show it to anyone else.

= How do I switch it off quickly? =

Tick **Disable** in the settings, define `NORG_EDGE_DISABLED` as true in wp-config.php, or deactivate the plugin. Each takes effect on the next request.

= Does it work behind Cloudflare without the Worker? =

Yes. **Visitor IP comes from** defaults to *Detect automatically*, which uses Cloudflare's CF-Connecting-IP when the request comes from a Cloudflare address, and the last X-Forwarded-For (or X-Real-IP) hop when it comes from a private or shared-space proxy such as a load balancer or Azure Container Apps. Pick a fixed source only if detection reports the wrong one on the status page.

== Changelog ==

= 0.1.2 =
* **Visitor IP comes from** now defaults to *Detect automatically*. Behind a load balancer or managed proxy the plugin previously saw only the proxy's address, so no AI agent could be verified and none received the mirror. A setting saved explicitly is kept.

= 0.1.1 =
* REST endpoints `norg-edge/v1/status` and `norg-edge/v1/connect` (administrators, Application Password) so NORG's dashboard can connect the plugin without pasting the Site ID and Site Key; WP-CLI `configure` now runs the same checks.

= 0.1.0 =
* First release: verified AI-agent mirror serving, strip fallback with lazy render requests, MCP and discovery surfaces, record-only mode with citation tracking, page-cache adapters, self-check, Site Health tests, WP-CLI, and NORG-hosted updates.
