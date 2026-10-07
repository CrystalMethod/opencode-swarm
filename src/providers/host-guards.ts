/**
 * Shared host/URL-component guards for forge-provider URL validation
 * (issue #2733).
 *
 * Extracted verbatim from `src/commands/_shared/url-security.ts` so the
 * provider layer can apply the identical private-host, IPv4-mapped-private,
 * zero-network, IDN-homograph, and control-character guards WITHOUT a
 * circular import (url-security imports the forge shape matcher; the forge
 * layer imports these leaf guards). url-security re-exports its previous
 * public surface from here, so its API is unchanged.
 */

const IPV4_PRIVATE = /^10\./;
const IPV4_LOOPBACK = /^127\./;
const IPV4_LINK_LOCAL = /^169\.254\./;
const IPV4_PRIVATE_172 = /^172\.(1[6-9]|2\d|3[0-1])\./;
const IPV4_PRIVATE_192 = /^192\.168\./;
const IPV4_ZERO_NETWORK = /^0\./;
const IPV6_LINK_LOCAL = /^fe80:/i;
const IPV6_UNIQUE_LOCAL = /^f[cd][0-9a-f]{2}:/i;

/** True when any code point is a C0/DEL control character. */
export function containsControlCharacters(value: string): boolean {
	for (const ch of value) {
		const cp = ch.codePointAt(0);
		if (cp !== undefined && (cp <= 0x1f || cp === 0x7f)) {
			return true;
		}
	}
	return false;
}

/**
 * Returns true if the hostname contains any non-ASCII code point (IDN
 * homograph protection).
 */
export function hasNonAsciiHostname(hostname: string): boolean {
	for (const ch of hostname) {
		const cp = ch.codePointAt(0);
		if (cp !== undefined && cp > 0x7f) return true;
	}
	return false;
}

export function isIpv4MappedPrivateHost(inner: string): boolean {
	if (
		IPV4_PRIVATE.test(inner) ||
		IPV4_LOOPBACK.test(inner) ||
		IPV4_LINK_LOCAL.test(inner) ||
		IPV4_PRIVATE_172.test(inner) ||
		IPV4_PRIVATE_192.test(inner) ||
		IPV4_ZERO_NETWORK.test(inner)
	) {
		return true;
	}

	const firstSegment = inner.split(':', 1)[0];
	if (!firstSegment) return false;
	const firstWord = Number.parseInt(firstSegment, 16);
	if (!Number.isFinite(firstWord)) return false;

	return (
		(firstWord >= 0x0000 && firstWord <= 0x00ff) ||
		(firstWord >= 0x0a00 && firstWord <= 0x0aff) ||
		(firstWord >= 0x7f00 && firstWord <= 0x7fff) ||
		firstWord === 0xa9fe ||
		(firstWord >= 0xac10 && firstWord <= 0xac1f) ||
		firstWord === 0xc0a8
	);
}

/**
 * Blocklist of private/localhost hostnames and IP ranges.
 */
export function isPrivateHost(url: URL): boolean {
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

	if (
		host === 'localhost' ||
		host === '::1' ||
		host === '0.0.0.0' ||
		IPV4_LOOPBACK.test(host) ||
		IPV4_ZERO_NETWORK.test(host)
	) {
		return true;
	}

	if (host.startsWith('localhost') || host === 'localhost.com') {
		return true;
	}

	// RFC 6761: any name under the pseudo-TLD `.localhost` resolves to the
	// loopback and must never be treated as a public forge host (a prefix
	// rule like `gitlab.` would otherwise smuggle `gitlab.localhost` past
	// the bare-localhost checks).
	if (host.endsWith('.localhost')) {
		return true;
	}

	if (
		IPV4_PRIVATE.test(host) ||
		IPV4_LINK_LOCAL.test(host) ||
		IPV4_PRIVATE_172.test(host) ||
		IPV4_PRIVATE_192.test(host) ||
		IPV6_LINK_LOCAL.test(host) ||
		IPV6_UNIQUE_LOCAL.test(host)
	) {
		return true;
	}

	if (host.startsWith('::ffff:')) {
		const inner = host.slice(7);
		if (isIpv4MappedPrivateHost(inner)) {
			return true;
		}
	}

	return false;
}

/**
 * True when any DNS label is a punycode label (xn--…). The WHATWG URL parser
 * silently converts non-ASCII (IDN) hosts to punycode, so a raw non-ASCII scan
 * on `url.hostname` cannot detect them; rejecting punycode labels is how the
 * IDN-homograph policy stays enforceable post-parse (issue #2733).
 */
export function hasPunycodeLabel(host: string): boolean {
	const lower = host.toLowerCase();
	return lower.split('.').some((label) => label.startsWith('xn--'));
}

export function isIPv4ZeroNetwork(host: string): boolean {
	return IPV4_ZERO_NETWORK.test(host);
}
