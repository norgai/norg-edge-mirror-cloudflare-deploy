/**
 * The site key, fetched from Secrets Manager rather than carried in a header.
 *
 * @description Cache behaviour, and that every failure degrades to null.
 *
 * The contract that matters is the failure one: getSiteKey must never throw and
 * must never return a stale-but-wrong value. A null means the router serves the
 * customer's origin, so a Secrets Manager outage degrades the product without
 * breaking the site — rule 1.
 */

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import {
  __primeSecretCache,
  __resetSecretCache,
  EDGE_REGIONS,
  getSiteKey,
  localReadRegion,
  parseSecret,
  regionalArn,
} from "../lambda/lib/secret.js";

const ARN = "arn:aws:secretsmanager:us-east-1:1:secret:norg-AbCdEf";

afterEach(() => __resetSecretCache());

test("no ARN configured means no key, and no attempt to fetch one", async () => {
  assert.equal(await getSiteKey({}), null);
  assert.equal(await getSiteKey(undefined), null);
});

test("a primed cache is served without touching the network", async () => {
  __primeSecretCache("nek_live_cached");
  assert.equal(await getSiteKey({ NORG_SECRET_ARN: ARN }), "nek_live_cached");
});

test("a failed fetch returns null rather than throwing", async () => {
  // No AWS credentials and no SDK stub here, so the require or the call fails.
  // Whatever the reason, the caller must get null and the site must survive.
  const result = await getSiteKey({ NORG_SECRET_ARN: ARN });
  assert.equal(result, null);
});

test("a failure is not cached, so the next request retries", async () => {
  await getSiteKey({ NORG_SECRET_ARN: ARN });
  __primeSecretCache("nek_live_recovered");
  assert.equal(await getSiteKey({ NORG_SECRET_ARN: ARN }), "nek_live_recovered");
});

test("an expired cache entry is not served", async () => {
  __primeSecretCache("nek_live_stale");
  // 15-minute TTL; reach past it without waiting.
  const realNow = Date.now;
  Date.now = () => realNow() + 16 * 60 * 1000;
  try {
    // The refetch fails (no AWS here), and the stale value must NOT be returned.
    assert.equal(await getSiteKey({ NORG_SECRET_ARN: ARN }), null);
  } finally {
    Date.now = realNow;
  }
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
    // No SDK here, so the replica read throws, then the primary read throws.
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
