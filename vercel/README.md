# @norg-ai/edge-router-vercel

Serve [NORG](https://norg.ai)'s AI-optimised version of your pages to **verified AI agents**, at your own URLs, from your Vercel project's middleware. People and search engines always get your site unchanged.

Works with **Next.js** (`middleware.ts` on 13–15, `proxy.ts` on 16, Edge or Node.js runtime) and with **any other Vercel project** through Vercel Routing Middleware.

```bash
npm i @norg-ai/edge-router-vercel
# or: pnpm add @norg-ai/edge-router-vercel   ·   yarn add @norg-ai/edge-router-vercel
```

---

## What it does

| Visitor | What they get |
|---|---|
| A person in a browser | Your site, unchanged. No NORG call is made. |
| Googlebot, Bingbot and other search crawlers | Your site, unchanged. Always; there is no setting to change this. |
| A verified AI agent (GPTBot, ClaudeBot, PerplexityBot, …) on a page NORG has rendered | The NORG render, served at your own URL with no redirect |
| A verified AI agent on a page not rendered yet | Your page, stripped down to its text, while NORG is asked to render it |

Three rules are built in and can't be switched off:

1. **It never breaks your site.** If anything fails (NORG is unreachable, a timeout, a bug), the request continues to your app as if the package weren't installed.
2. **Search engines see exactly what people see.** Serving them anything else would be cloaking.
3. **Nothing happens without an authenticated feed from NORG.** The package has no built-in bot list. Agents are verified by source IP against the ranges their operators publish; a user agent alone is never trusted.

Responses served to agents are marked `private, no-store`, so no cache can show a NORG render to a person.

---

## Setup

### 1. Get a Site ID and Site Key

In NORG, open **Publishing › CDN & Edge › Vercel** and create the install. The Site Key is shown **once**, because NORG stores only a hash of it.

### 2. Add them to your Vercel project

Go to **Vercel › your project › Settings › Environment Variables** and add these for Production (and Preview, if you want previews served too):

| Name | Value | Notes |
|---|---|---|
| `NORG_SITE_ID` | your Site ID | |
| `NORG_SITE_KEY` | your Site Key | Mark it **Sensitive** |

Redeploy afterwards: Vercel only applies environment variables to new deployments.

### 3a. Next.js: wrap your middleware

**Already have a `middleware.ts`?** Wrap it. NORG runs first, and your middleware runs exactly as before for everyone NORG doesn't answer:

```ts
// middleware.ts  (Next.js 16: proxy.ts)
import { clerkMiddleware } from '@clerk/nextjs/server' // or whatever you use
import { withNorgEdge } from '@norg-ai/edge-router-vercel/next'

export default withNorgEdge(clerkMiddleware())

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
```

**No middleware yet?**

```ts
// middleware.ts  (Next.js 16: proxy.ts)
import { norgEdgeMiddleware } from '@norg-ai/edge-router-vercel/next'

export default norgEdgeMiddleware()

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
  ],
}
```

> **About the matcher:** it must still match `.txt`, `.md`, `.json` and `.xml` paths, because NORG answers `/llms.txt`, `/agents.md`, `/.well-known/mcp.json` and per-page `index.md` files. A matcher like `'/((?!.*\\..*|_next).*)'` excludes every path with a dot and quietly switches those off. Next.js requires `config` to be a literal in the file, so copy it rather than importing it.

### 3b. Any other Vercel project: Routing Middleware

Add a `middleware.ts` (or `.js`) at the project root:

```ts
import { createNorgEdge } from '@norg-ai/edge-router-vercel'

export default createNorgEdge()

export const config = {
  matcher: ['/((?!_next|_vercel|[^?]*\\.(?:css|js|jpe?g|webp|png|gif|svg|ttf|woff2?|ico)$).*)'],
}
```

Returning nothing tells Vercel to continue to your site; returning a response serves NORG's. `createNorgEdge()` is a plain `(request, context) => Promise<Response | undefined>`, so you can also call it from your own routing middleware.

### 4. Check it

```bash
# Is it deployed, configured and entitled?
curl -s -H "x-norg-edge-check: <your-site-key>" https://your-site.example/ | head -c 200
# {"site_id":"…","version":"0.1.0","env":"production","disabled":false,"platform":"vercel","entitled":true,…}

# People get the site unchanged: expect no output
curl -sI https://your-site.example/some-page/ | grep -i x-norg-edge
```

The first check also tells NORG the install is live; it shows as active in NORG within seconds.

A curl with a `GPTBot` user agent from your own computer gets your normal page. That's by design: your IP isn't OpenAI's, so the request isn't verified. To see a NORG render yourself, add `?agent=true` to a page URL. Search engines never get it, even with that parameter.

---

## Configuration

Each option can be set as an environment variable or passed to the factory: `withNorgEdge(mw, { … })`, `norgEdgeMiddleware({ … })` or `createNorgEdge({ … })`. An option passed in code wins over the environment variable.

| Variable | Option | Default | Meaning |
|---|---|---|---|
| `NORG_SITE_ID` | `siteId` | — | Required |
| `NORG_SITE_KEY` | `siteKey` | — | Required. Keep it in a Sensitive variable |
| `NORG_EDGE_DISABLED` | `disabled` | `false` | Kill switch: every request goes to your site |
| `NORG_STRIP_FALLBACK_ENABLED` | `stripFallback` | `true` | Serve unrendered pages to agents stripped to their text |
| `NORG_LAZY_RENDER_ENABLED` | `lazyRender` | `true` | Ask NORG to render pages agents request |
| `NORG_API_URL` / `NORG_CONTENT_BASE` | `apiUrl` / `contentBase` | NORG production | Point at another NORG environment |
| `NORG_EDGE_ENV` | `env` | derived from the API host | `production` / `test` |
| — | `getClientIp` | Vercel's `x-real-ip` | Read the visitor's IP yourself; only needed off Vercel |

Without `NORG_SITE_ID` and `NORG_SITE_KEY` the package does nothing at all, so it's safe to deploy before you have them.

### Self-hosting Next.js (not on Vercel)

On Vercel, the visitor's IP comes from `x-real-ip`, which Vercel sets and overwrites. Off Vercel, that header is whatever the client sent, so the package **ignores it** unless the `VERCEL` system variable is present. In that case no agent is verified and nothing is served differently. If you run behind a proxy you trust, give the package the address it reports:

```ts
export default withNorgEdge(myMiddleware, {
  getClientIp: (request) => request.headers.get('cf-connecting-ip'), // e.g. behind Cloudflare
})
```

---

## How it behaves on Vercel

- **Cost and latency for people:** browsers, search engines and static assets are answered before any lookup: no network call, no added latency. Only bot-shaped requests make NORG calls.
- **Background work** (refreshing the agent list, the liveness heartbeat) runs after the response through `waitUntil`, so no visitor waits for it.
- **Timeouts:** every NORG call has its own short timeout, and a 10-second watchdog sits over the whole pipeline. Either one ends in your site, never an error.
- **Caching:** NORG responses are `private, no-store`. Your own pages keep whatever caching they had.
- **Verification is IP-based only.** Vercel exposes no verified-bot signal to middleware, so a crawler whose operator publishes no IP ranges isn't diverted.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Health probe returns your page, not JSON | The middleware isn't running for `/` (check the matcher), the deployment predates the env vars (redeploy), or the key doesn't match (watch for a trailing space) |
| `"entitled": false` | NORG refused the key, or isn't reachable from your region. Check the Site ID/Key pair in NORG |
| `/llms.txt` is your 404 page | Your matcher excludes dotted paths. Use the matcher above |
| Always `stripped`, never `mirror` | Nothing has been rendered for that path yet; the first pass over a large site takes a while |
| Switch it off now | Set `NORG_EDGE_DISABLED=true` and redeploy, or remove the wrapper |

## Privacy

- **What it sends to NORG:**
  - Requests for the authenticated agent feed (about hourly).
  - A heartbeat with the package version and the Vercel edge region.
  - For verified agent visits only: the path, the agent's user agent, and Vercel's country/city headers.
- **Your page content is never sent to NORG.** NORG crawls your public pages itself.
- **Ordinary visitors' requests are never reported.**
- **No credential other than your Site Key is in this package,** and that key is scoped to your one site.

## Licence

MIT © NORG.ai. Source: [github.com/norgai/norg-edge-mirror-cloudflare-deploy](https://github.com/norgai/norg-edge-mirror-cloudflare-deploy/tree/feature/vercel-middleware/vercel)
