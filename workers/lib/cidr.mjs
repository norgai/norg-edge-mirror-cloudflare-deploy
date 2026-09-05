/**
 * Family-aware CIDR matching for source-IP verification.
 *
 * Single source of truth for parsing a client address (IPv4 or IPv6) and
 * testing it against an operator's published CIDR set. Imported by the
 * Cloudflare worker (inlined at build) and, through core/agent.js, by every
 * other provider adapter. Each router previously carried its own IPv4-only
 * copy, so an IPv6 client was unparseable there and silently fell through to
 * the platform's verified-bot signal — or, on a platform with no such signal,
 * was refused outright.
 *
 * The verdict contract is deliberately conservative, and it is what keeps
 * behaviour identical for today's feeds, which publish IPv4 only:
 *
 *   - no published set for the operator        -> null  (nothing to measure)
 *   - client address unparseable               -> null  (nothing to measure)
 *   - set has no ranges of the client's family -> null  (unmeasurable — NOT a
 *     mismatch; answering false would refuse every IPv6 crawler of an operator
 *     that publishes IPv4 only)
 *   - set has ranges of the client's family    -> true / false, strictly
 *
 * "Ranges of the client's family" is judged on the network part alone, so a
 * block with an invalid prefix length ("203.0.113.0/99") still counts as the
 * operator having published that family — the verdict stays strict and the
 * broken block simply never matches. Corrupt feed data fails closed rather
 * than quietly widening to the platform fallback.
 *
 * Callers treat null as "fall back to whatever the platform offers" and a
 * boolean as authoritative.
 */

const V4_BITS = 32n;
const V6_BITS = 128n;

/**
 * Parse an IPv4 dotted quad.
 * @param {string} ip Candidate address.
 * @returns {?bigint} Value, or null when not valid IPv4.
 */
function parseIpv4(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

/**
 * Rewrite an embedded IPv4 tail ("::ffff:192.0.2.1") as two hex groups so the
 * address parses like any other IPv6 literal.
 * @param {string} ip Candidate address.
 * @returns {?string} Rewritten address, or null when the tail is malformed.
 */
function expandEmbeddedIpv4(ip) {
  const idx = ip.lastIndexOf(":");
  const last = ip.slice(idx + 1);
  if (!last.includes(".")) return ip;
  const v4 = parseIpv4(last);
  if (v4 === null) return null;
  return `${ip.slice(0, idx + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
}

/**
 * Parse an IPv6 address, including "::" compression and an embedded IPv4
 * tail. Zone identifiers ("%eth0") are rejected: no CDN presents one.
 * @param {string} raw Candidate address.
 * @returns {?bigint} Value, or null when not valid IPv6.
 */
function parseIpv6(raw) {
  if (raw.includes("%")) return null;
  const ip = expandEmbeddedIpv4(raw);
  if (ip === null) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  // "::" must stand for at least one group; without it all eight must be present.
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/**
 * Parse an IPv4 or IPv6 address.
 * @param {?string} ip Candidate address.
 * @returns {?{family: 4|6, value: bigint}} Parsed address, or null.
 */
export function parseIp(ip) {
  const text = String(ip || "").trim();
  if (!text) return null;
  if (text.includes(":")) {
    const value = parseIpv6(text);
    return value === null ? null : { family: 6, value };
  }
  const value = parseIpv4(text);
  return value === null ? null : { family: 4, value };
}

/**
 * The address family of a CIDR block.
 * @param {string} cidr Block in "network/len" form.
 * @returns {?(4|6)} Family, or null when the network part does not parse.
 */
export function cidrFamily(cidr) {
  const net = parseIp(String(cidr).split("/")[0]);
  return net ? net.family : null;
}

/**
 * Is an address inside a CIDR block?
 *
 * False on any family mismatch or malformed input — a block that cannot be
 * evaluated must never read as a match.
 *
 * @param {string|{family: number, value: bigint}} ip Address, raw or parsed.
 * @param {string} cidr Block in "network/len" form ("/len" optional).
 * @returns {boolean} True when the address falls inside the block.
 */
export function cidrContains(ip, cidr) {
  const addr = typeof ip === "object" && ip !== null ? ip : parseIp(ip);
  if (!addr) return false;
  const [network, bitsRaw, extra] = String(cidr).split("/");
  if (extra !== undefined) return false;
  const net = parseIp(network);
  if (!net || net.family !== addr.family) return false;
  const width = addr.family === 4 ? V4_BITS : V6_BITS;
  const bits = bitsRaw === undefined ? width : /^\d{1,3}$/.test(bitsRaw) ? BigInt(bitsRaw) : -1n;
  if (bits < 0n || bits > width) return false;
  const mask = bits === 0n ? 0n : ((1n << bits) - 1n) << (width - bits);
  return (addr.value & mask) === (net.value & mask);
}

/**
 * Verify a client address against the operator's published CIDR set.
 *
 * @param {?string} clientIp Client address as the platform reports it.
 * @param {Object} cidrRanges Per-operator ranges from the feed.
 * @param {Object} classification Classification from classifyAgent.
 * @returns {?boolean} Verdict, or null when no usable set applies (see the
 *   module header for the exact contract).
 */
export function cidrVerdictFor(clientIp, cidrRanges, classification) {
  const entry = (cidrRanges || {})[classification && classification.company];
  const cidrs = entry && Array.isArray(entry.cidrs) ? entry.cidrs : null;
  if (!cidrs || !cidrs.length) return null;
  const addr = parseIp(clientIp);
  if (!addr) return null;
  const sameFamily = cidrs.filter((cidr) => cidrFamily(cidr) === addr.family);
  if (!sameFamily.length) return null;
  return sameFamily.some((cidr) => cidrContains(addr, cidr));
}
