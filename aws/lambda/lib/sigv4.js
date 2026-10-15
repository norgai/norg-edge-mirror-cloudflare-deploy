/**
 * Secrets Manager's GetSecretValue as one signed HTTPS call, without the SDK.
 *
 * @description AWS Signature Version 4 over node:crypto, for one API call.
 *
 * 0.6.9's timing logs showed the first agent request in a region spending
 * 1.5 s in the site key step on a 192 MB Lambda, almost all of it loading the
 * AWS SDK — a module tree far larger than the router — before a single byte
 * went on the wire. The router makes exactly one AWS call, so it signs that
 * call itself: a canonical request, a string to sign, an HMAC chain. Nothing
 * else changes: same action, same IAM permission, same credentials (the
 * function role's, which Lambda places in the reserved AWS_* variables).
 */

import { createHash, createHmac } from "node:crypto";

const SERVICE = "secretsmanager";

/** Hex SHA-256 of a string. */
const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** HMAC-SHA256 of a string under a key (string or Buffer). */
const hmac = (key, text) => createHmac("sha256", key).update(text, "utf8").digest();

/**
 * The function role's credentials, from Lambda's reserved variables.
 *
 * @returns {?{accessKeyId: string, secretAccessKey: string, sessionToken: ?string}}
 *   Credentials, or null when the runtime provides none.
 */
export function runtimeCredentials() {
  // eslint-disable-next-line no-undef
  const env = typeof process !== "undefined" ? process.env : {};
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN || null,
  };
}

/**
 * Build the signed request for one GetSecretValue call.
 *
 * Pure apart from its inputs, so a test can pin it against a signature AWS's
 * own signer produced for the same request.
 *
 * @param {string} arn Secret ARN.
 * @param {string} region Region to call.
 * @param {Object} creds accessKeyId, secretAccessKey, optional sessionToken.
 * @param {Date} now Signing time.
 * @returns {{url: string, headers: Object, body: string}} The request.
 */
export function signGetSecretValue(arn, region, creds, now) {
  const host = `${SERVICE}.${region}.amazonaws.com`;
  const body = JSON.stringify({ SecretId: arn });
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);

  const headers = {
    "content-type": "application/x-amz-json-1.1",
    host,
    "x-amz-date": amzDate,
    "x-amz-target": "secretsmanager.GetSecretValue",
  };
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;

  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonical = [
    "POST",
    "/",
    "",
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    signedHeaders,
    sha256Hex(body),
  ].join("\n");

  const scope = `${day}/${region}/${SERVICE}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
  const key = ["aws4_request"].reduce(
    (k, part) => hmac(k, part),
    hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), region), SERVICE),
  );
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: `https://${host}/`, headers, body };
}

/**
 * Call GetSecretValue and return the raw SecretString.
 *
 * Throws on any failure (no credentials, HTTP error, timeout) so the caller's
 * replica-then-primary logic sees the same failure the SDK used to raise.
 *
 * @param {string} arn Secret ARN in that region.
 * @param {string} region Region to call.
 * @param {number} timeoutMs Abort after this long.
 * @returns {Promise<?string>} SecretString, possibly undefined.
 */
export async function getSecretValue(arn, region, timeoutMs) {
  const creds = runtimeCredentials();
  if (!creds) throw new Error("no runtime credentials");
  const { url, headers, body } = signGetSecretValue(arn, region, creds, new Date());
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GetSecretValue ${response.status} ${payload.__type || ""}`.trim());
  }
  return payload.SecretString;
}
