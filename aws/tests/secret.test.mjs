/**
 * The site key, fetched from Secrets Manager rather than carried in a header.
 *
 * @description Cache behaviour, and that every failure degrades to null.
 *
 * The contract that matters is the failure one: getSiteKey must never throw, and
 * an expired key answers only while a refresh runs and for at most an hour
 * past its TTL (0.6.9). A rotated-out key is refused by NORG, which stops the
 * install diverting until the refresh lands — the safe direction. A null means the router serves the
 * customer's origin, so a Secrets Manager outage degrades the product without
 * breaking the site — rule 1.
 */

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import {
  __expireSecretCache,
  __primeSecretCache,
  __resetSecretCache,
  EDGE_REGIONS,
  getSiteKey,
  localReadRegion,
  parseSecret,
  regionalArn,
} from "../lambda/lib/secret.js";

const ARN = "arn:aws:secretsmanager:us-east-1:1:secret:norg-AbCdEf";

const realFetch = globalThis.fetch;
const CRED_VARS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
const savedCreds = Object.fromEntries(CRED_VARS.map((k) => [k, process.env[k]]));

afterEach(() => {
  __resetSecretCache();
  globalThis.fetch = realFetch;
  for (const k of CRED_VARS) {
    if (savedCreds[k] === undefined) delete process.env[k];
    else process.env[k] = savedCreds[k];
  }
});

/**
 * Stand in for Secrets Manager and the function role's credentials.
 *
 * 0.6.10 signs GetSecretValue itself and sends it with fetch, so a test sets
 * the reserved AWS_* variables Lambda provides and answers the HTTPS call.
 *
 * @param {Function} answer Resolves each call to {SecretString} (or throws).
 * @returns {{sends: number, requests: Array}} Live call record.
 */
function stubAws(answer) {
  const calls = { sends: 0, requests: [] };
  process.env.AWS_ACCESS_KEY_ID = "AKIDTEST";
  process.env.AWS_SECRET_ACCESS_KEY = "secret-test";
  process.env.AWS_SESSION_TOKEN = "session-test";
  globalThis.fetch = async (url, init) => {
    calls.sends += 1;
    calls.requests.push({ url: String(url), init });
    const body = await answer();
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return calls;
}

test("no ARN configured means no key, and no attempt to fetch one", async () => {
  assert.equal(await getSiteKey({}), null);
  assert.equal(await getSiteKey(undefined), null);
});

test("a primed cache is served without touching the network", async () => {
  __primeSecretCache("nek_live_cached");
  assert.equal(await getSiteKey({ NORG_SECRET_ARN: ARN }), "nek_live_cached");
});

test("a failed fetch returns null rather than throwing", async () => {
  // No AWS credentials and no stub here, so the signed call cannot be made.
  // Whatever the reason, the caller must get null and the site must survive.
  const result = await getSiteKey({ NORG_SECRET_ARN: ARN });
  assert.equal(result, null);
});

test("a failure is not cached, so the next request retries", async () => {
  await getSiteKey({ NORG_SECRET_ARN: ARN });
  __primeSecretCache("nek_live_recovered");
  assert.equal(await getSiteKey({ NORG_SECRET_ARN: ARN }), "nek_live_recovered");
});

test("an expired key answers while one background refresh runs", async () => {
  // 0.6.9: only a container's first agent request waits on Secrets Manager.
  __primeSecretCache("nek_live_stale");
  const calls = stubAws(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return { SecretString: "nek_live_fresh" };
  });
  __expireSecretCache();

  assert.equal(await getSiteKey({ NORG_SECRET_ARN: ARN }), "nek_live_stale");
  assert.equal(await getSiteKey({ NORG_SECRET_ARN: ARN }), "nek_live_stale");
  assert.equal(calls.sends, 1, "concurrent callers share one refresh");

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(await getSiteKey({ NORG_SECRET_ARN: ARN }), "nek_live_fresh");
});

test("a key more than an hour past its TTL is not served", async () => {
  __primeSecretCache("nek_live_stale");
  // 15-minute TTL plus the one-hour stale window; reach past both.
  const realNow = Date.now;
  Date.now = () => realNow() + 76 * 60 * 1000;
  try {
    // The refetch fails (no AWS here), and the stale value must NOT be returned.
    assert.equal(await getSiteKey({ NORG_SECRET_ARN: ARN }), null);
  } finally {
    Date.now = realNow;
  }
});

test("the key is read with one signed call, not the AWS SDK", async () => {
  // 0.6.10: loading the SDK cost ~1.5 s on a cold container; the call is signed
  // in lib/sigv4.js and sent to the region's endpoint directly.
  const calls = stubAws(async () => ({ SecretString: "nek_live_signed" }));
  assert.equal(await getSiteKey({ NORG_SECRET_ARN: ARN }), "nek_live_signed");
  assert.equal(calls.sends, 1);
  const { url, init } = calls.requests[0];
  assert.equal(url, "https://secretsmanager.us-east-1.amazonaws.com/");
  assert.equal(init.headers["x-amz-target"], "secretsmanager.GetSecretValue");
  assert.equal(init.headers["x-amz-security-token"], "session-test");
  assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/secretsmanager\/aws4_request, /);
  assert.equal(JSON.parse(init.body).SecretId, ARN);
});

test("an AWS error is a failed read: null, never a partial key", async () => {
  process.env.AWS_ACCESS_KEY_ID = "AKIDTEST";
  process.env.AWS_SECRET_ACCESS_KEY = "secret-test";
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ __type: "AccessDeniedException" }), { status: 400 });
  assert.equal(await getSiteKey({ NORG_SECRET_ARN: ARN }), null);
});

test("a bare-string secret is the key", () => {
  assert.equal(parseSecret("nek_live_plain"), "nek_live_plain");
  assert.equal(parseSecret("  nek_live_padded  "), "nek_live_padded");
});

test("a JSON secret is read from either field the console produces", () => {
  assert.equal(parseSecret('{"NORG_SITE_KEY":"nek_live_json"}'), "nek_live_json");
  assert.equal(parseSecret('{"site_key":"nek_live_alt"}'), "nek_live_alt");
});

test("an unusable secret is null, never a partial value", () => {
  assert.equal(parseSecret(""), null);
  assert.equal(parseSecret(null), null);
  assert.equal(parseSecret("{not json"), null);
  assert.equal(parseSecret('{"unrelated":"x"}'), null);
});

test("a replica's ARN is the primary's with only the region changed", () => {
  assert.equal(
    regionalArn(ARN, "ap-southeast-2"),
    "arn:aws:secretsmanager:ap-southeast-2:1:secret:norg-AbCdEf",
  );
  assert.equal(regionalArn("not-an-arn", "ap-southeast-2"), null);
  assert.equal(regionalArn("arn:aws:lambda:us-east-1:1:function:x", "ap-southeast-2"), null);
});

test("the local region is read first only when it is an edge region other than the primary", () => {
  const saved = process.env.AWS_REGION;
  try {
    process.env.AWS_REGION = "ap-southeast-2";
    assert.equal(localReadRegion(ARN), "ap-southeast-2");
    process.env.AWS_REGION = "us-east-1";
    assert.equal(localReadRegion(ARN), null, "the primary is not a replica");
    process.env.AWS_REGION = "ca-central-1";
    assert.equal(localReadRegion(ARN), null, "no regional edge cache there, so no replica to read");
    delete process.env.AWS_REGION;
    assert.equal(localReadRegion(ARN), null);
  } finally {
    if (saved === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = saved;
  }
});

test("a failed replica read is remembered, and the primary is used from then on", async () => {
  const saved = process.env.AWS_REGION;
  try {
    process.env.AWS_REGION = "eu-west-1";
    assert.equal(localReadRegion(ARN), "eu-west-1");
    // No credentials here, so the replica read throws, then the primary read throws.
    assert.equal(await getSiteKey({ NORG_SECRET_ARN: ARN }), null);
    assert.equal(localReadRegion(ARN), null, "an install without replicas pays for the miss once per container");
  } finally {
    if (saved === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = saved;
  }
});

test("the edge region list is the thirteen regional edge caches", () => {
  assert.equal(EDGE_REGIONS.size, 13);
  assert.ok(EDGE_REGIONS.has("us-east-1"));
});
