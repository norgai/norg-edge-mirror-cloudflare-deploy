# NORG Edge Router — Vercel middleware

This branch holds **`@norg-ai/edge-router-vercel`**, the npm package version of NORG's edge router for sites hosted on **Vercel**. That covers Next.js apps (`middleware.ts`, or `proxy.ts` on Next.js 16) and any other Vercel project through Vercel Routing Middleware.

You don't change DNS, create an API token or deploy a worker. Install a package, wrap your middleware, and add two environment variables.

```bash
npm i @norg-ai/edge-router-vercel
```

```ts
// middleware.ts
import { withNorgEdge } from '@norg-ai/edge-router-vercel/next'

export default withNorgEdge(yourExistingMiddleware) // or: norgEdgeMiddleware()
```

**Install guide, configuration and troubleshooting: [`vercel/README.md`](vercel/README.md)**, also shown on [npmjs.com](https://www.npmjs.com/package/@norg-ai/edge-router-vercel).
Customer guide: [app.norg.ai/help/vercel-middleware](https://app.norg.ai/help/vercel-middleware).

> **On Cloudflare?** Use the Cloudflare Worker on [`main`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/tree/main) instead. Other platforms are listed under [Other platforms](#other-platforms).

---

## What it does

| Visitor | What they get |
|---|---|
| A person in a browser | Your site, unchanged. No NORG call is made. |
| Googlebot, Bingbot and other search crawlers | Your site, unchanged (always; there is no setting for this) |
| A verified AI agent, on a page NORG has rendered | The NORG render, at your own URL, with no redirect |
| A verified AI agent, on a page not rendered yet | Your page stripped to its text, while NORG renders it |

The three rules every NORG router follows hold here unchanged:
- **It never breaks your site.** Every failure continues to your app.
- **Search engines see what people see.**
- **Nothing happens without NORG's authenticated feed.** Agents are verified by source IP; a user agent alone is never trusted.

## Differences from the Cloudflare worker

| | Cloudflare worker | Vercel middleware |
|---|---|---|
| Install | Deploy button or API token, plus a route | `npm i`, wrap `middleware.ts`, two env vars, redeploy |
| Where it runs | Cloudflare's edge, before the origin | Vercel's middleware, before Vercel's cache and your app |
| Agent verification | CIDR, then Cloudflare's verified-bot signal | CIDR only. `x-real-ip` is trusted only on Vercel (the `VERCEL` system variable); off Vercel, pass `getClientIp` |
| Agent visit telemetry | Worker posts `/events` | The receptionist records it from the `X-Norg-Visit` header on the mirror fetch (as on CloudFront) |
| Background work | `ctx.waitUntil` | `waitUntil` from `NextFetchEvent` / Vercel's request context |
| Heartbeat | Cron trigger | After serving an agent (`traffic`) or answering a health probe (`probe`), throttled to one per 15 min per instance |
| Strip | HTMLRewriter (streaming) | core's buffered tokenizer, same output as CloudFront/Bunny |
| Response cache | Per colo | None (the receptionist's own cache absorbs repeats) |
| Kill switch | `EDGE_DISABLED` binding | `NORG_EDGE_DISABLED=true` and redeploy, or remove the wrapper |
| Updates | API-token push or redeploy | `npm update` and redeploy. NORG reports drift against `EDGE_WORKER_VERSION_VERCEL` |

---

## Layout

```
vercel/                    the npm package (@norg-ai/edge-router-vercel)
  src/index.js             createNorgEdge(): framework-neutral, usable as Vercel Routing Middleware
  src/next.js              withNorgEdge() / norgEdgeMiddleware() for Next.js
  src/router.js            the request pipeline (port of workers/edge-router-worker.js)
  src/lib/                 config (NORG_* env vars), client IP + geo, origin read, heartbeat
  types/                   hand-written .d.ts, copied into dist/
  build.mjs                esbuild (pinned, via npx) → dist/; two entries share one chunk
  tests/                   node:test — pipeline, adapters, built package
  e2e/                     real Next.js app (next build + next start) against a mock NORG
core/, workers/lib/        the provider-neutral core shared with CloudFront, Fastly and Bunny
```

## Development

```bash
cd vercel
node --test tests/*.test.mjs     # unit, pipeline and built-package tests (no install needed)
node build.mjs                   # dist/
bash e2e/run.sh                  # needs pnpm; packs the package into a real Next.js app
```

## Releasing

1. Bump `version` in `vercel/package.json` **and** `EDGE_SCRIPT_VERSION` in `vercel/src/lib/config.js` to the same value. A test fails if they differ.
2. Tag `vercel-vX.Y.Z` and push the tag. `.github/workflows/vercel-release.yml` checks that the tag and both versions agree, runs the tests, and publishes to npm with provenance (secret `NPM_TOKEN`).
3. In content-craft, set `EDGE_WORKER_VERSION_VERCEL` to the new version.

`dist/` is not committed: npm is the distribution, and `prepack` builds it.

---

## Other platforms

| Platform | Branch | Install guide |
|---|---|---|
| **Cloudflare** | [`main`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/tree/main) | [README](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/blob/main/README.md) |
| **AWS CloudFront** | [`feature/aws-cloudfront`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/tree/feature/aws-cloudfront) | [`aws/README.md`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/blob/feature/aws-cloudfront/aws/README.md) |
| **Fastly Compute** | [`feature/fastly-compute`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/tree/feature/fastly-compute) | [`fastly/README.md`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/blob/feature/fastly-compute/fastly/README.md) |
| **Bunny Edge Scripting** | [`feature/bunny-edge-scripting`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/tree/feature/bunny-edge-scripting) | [`bunny/README.md`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/blob/feature/bunny-edge-scripting/bunny/README.md) |
| **WordPress (no CDN)** | [`feature/wordpress-plugin`](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/tree/feature/wordpress-plugin) | [README](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/blob/feature/wordpress-plugin/README.md) |
| **Vercel** | `feature/vercel-middleware` (this branch) | [`vercel/README.md`](vercel/README.md) |

## Support

For questions about your install, your Site ID or Site Key, contact your NORG account contact.
