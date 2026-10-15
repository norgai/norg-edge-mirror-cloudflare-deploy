/**
 * A stand-in for NORG's API and render receptionist, for the e2e run.
 *
 * Serves the authenticated feed, one render (/products/widget/), an
 * llms.txt, accepts heartbeats, and records every request so run.sh can
 * assert on what the middleware actually sent.
 *
 * Usage: node mock-norg.mjs <port> <log-file>
 */

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [port, logFile] = process.argv.slice(2);
const SITE_ID = "e2e-site";
const SITE_KEY = "nek_live_e2e";

const FEED = {
  patterns: [{ pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "divert" }],
  cidr_ranges: { openai: { cidrs: ["20.171.0.0/16"] } },
  agentic_path_prefix: "/ai",
  skip_paths: [],
  cache_ttl: 3600,
};

const RENDERS = {
  [`/${SITE_ID}/products/widget/index.html`]: "<html><body><h1>NORG render of widget</h1></body></html>",
  [`/${SITE_ID}/llms.txt`]: "# NORG llms.txt\n",
};

/**
 * Answer one request and log it.
 *
 * @param {import("node:http").IncomingMessage} req Request.
 * @param {import("node:http").ServerResponse} res Response.
 * @param {string} body Request body.
 * @returns {void}
 */
function answer(req, res, body) {
  appendFileSync(
    logFile,
    `${JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body })}\n`,
  );
  if (req.headers["x-norg-site-key"] !== SITE_KEY) return send(res, 401, "");
  if (req.url === "/api/v1/edge/bot-patterns") return send(res, 200, JSON.stringify(FEED), "application/json");
  if (req.url === "/api/v1/edge/heartbeat") return send(res, 200, '{"status":"ok"}', "application/json");
  const render = RENDERS[req.url];
  if (render) return send(res, 200, render, req.url.endsWith(".txt") ? "text/plain" : "text/html");
  return send(res, 404, "");
}

/**
 * Write a response.
 *
 * @param {import("node:http").ServerResponse} res Response.
 * @param {number} status Status.
 * @param {string} body Body.
 * @param {string} [type] Content type.
 * @returns {void}
 */
function send(res, status, body, type = "text/plain") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => answer(req, res, body));
}).listen(Number(port), "127.0.0.1");
