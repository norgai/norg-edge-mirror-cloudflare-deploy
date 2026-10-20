// NORG edge gate — the CloudFront Function that replaces the Lambda@Edge
// router. Source of the deployed artifact: the build prepends
// `import cf from 'cloudfront';` and minifies; this file must stay plain,
// self-contained ES5-ish JavaScript with no imports (CloudFront Functions
// runtime 2.0, 10 KB code limit, no network, no timers).
//
// What it does, in order, for every request on the behaviours it is attached to:
//   1. NORG-owned surface    -> receptionist (served identically to everyone)
//   2. static file           -> customer's origin, untouched
//   3. traditional search engine -> customer's origin (rule 2: never cloaked)
//   4. ordinary browser without ?agent=true or a signature header -> origin
//   5. everything else       -> receptionist origin group, which answers the
//      mirror for a verified AI agent and 404 for anyone else, and CloudFront
//      then fails over to the customer's origin.
// Every branch returns the request; a thrown error would make CloudFront
// answer 503, so the whole body is guarded and falls back to the untouched
// request: a bug here can only let a request through, never break the site.
//
// __PLACEHOLDERS__ are filled by the installer per distribution.
var SITE_ID = "__SITE_ID__";
var RECEPTIONIST_HOST = "__RECEPTIONIST_HOST__";
var RECEPTIONIST_ORIGIN_ID = "__RECEPTIONIST_ORIGIN_ID__";
var CUSTOMER_ORIGIN_ID = "__CUSTOMER_ORIGIN_ID__";

var STATIC = /\.(css|js|mjs|map|png|jpe?g|gif|webp|svg|ico|avif|bmp|tiff|heic|woff2?|ttf|eot|otf|mp4|webm|mov|avi|mkv|m4v|ogv|mp3|wav|ogg|m4a|aac|flac|weba|vtt|srt|pdf|docx?|xlsx?|pptx?|zip|gz|rar|tar|7z|webmanifest)$/i;
var SEARCH = ["googlebot", "bingbot", "applebot", "duckduckbot", "baiduspider", "yandex", "slurp"];
var BROWSER = ["chrome/", "safari/", "firefox/", "edg/", "opr/", "trident/"];
var BOTISH = ["bot", "crawl", "spider", "slurp", "scrape", "fetch", "agent", "compatible;", "http://", "https://", "headless", "preview", "python", "curl", "wget", "java/", "okhttp", "axios", "node-fetch", "go-http", "ruby", "perl", "libwww", "httpx", "aiohttp"];
var SIBLINGS = ["index.md", "index.json", "index.jsonld", "index.pdf", "index.openai.json", "webmcp.js"];
var EXACT_NORG = ["/llms.txt", "/llms-full.txt", "/tree.json", "/graph.jsonld", "/agents.md", "/.well-known/mcp.json", "/.well-known/ai-plugin.json", "/openapi.json", "/openapi.yaml"];

function has(list, s) {
  for (var i = 0; i < list.length; i++) if (s.indexOf(list[i]) !== -1) return true;
  return false;
}

function isNorgSurface(uri) {
  if (EXACT_NORG.indexOf(uri) !== -1) return true;
  if (uri.indexOf("/.norg/") === 0) return true;
  if (/\/(mcp|sse)$/.test(uri)) return true;
  var last = uri.slice(uri.lastIndexOf("/") + 1);
  return SIBLINGS.indexOf(last) !== -1;
}

function isBrowser(ua) {
  return ua.indexOf("mozilla/5.0") === 0 && !has(BOTISH, ua) && has(BROWSER, ua);
}

function handler(event) {
  try {
    var req = event.request;
    var uri = req.uri;
    // NORG surfaces first, as the router does: /.norg/ assets are NORG's own
    // static files, so the static check must not send them to the origin.
    var norg = isNorgSurface(uri);
    if (!norg && STATIC.test(uri)) return req;
    var uaHeader = req.headers["user-agent"];
    var ua = uaHeader && uaHeader.value ? uaHeader.value : "";
    var low = ua.toLowerCase();
    if (!norg) {
      if (has(SEARCH, low)) return req;
      var q = req.querystring || {};
      var override = q.agent && q.agent.value === "true";
      var signed = req.headers["signature-agent"] || req.headers["signature-input"];
      if (isBrowser(low) && !override && !signed) return req;
    }
    req.headers["x-norg-gate"] = { value: "cloudfront" };
    req.headers["x-norg-ua"] = { value: ua };
    req.headers["x-norg-viewer-ip"] = { value: (event.viewer && event.viewer.ip) || "" };
    req.uri = "/" + SITE_ID + uri;
    cf.createRequestOriginGroup({
      originIds: [
        { originId: RECEPTIONIST_ORIGIN_ID, originOverrides: { hostHeader: RECEPTIONIST_HOST, sni: RECEPTIONIST_HOST } },
        { originId: CUSTOMER_ORIGIN_ID }
      ],
      failoverCriteria: { statusCodes: [404] }
    });
    return req;
  } catch (e) {
    return event.request;
  }
}
