import { describe, expect, test } from 'bun:test';
import {
	MAX_URL_LEN,
	sanitizeUrl,
	validateAndSanitizeGithubUrl,
} from '../../../src/commands/_shared/url-security.js';
import { isForgePrUrl } from '../../../src/providers/forge-provider.js';

/**
 * Issue #2733: GitLab issue/MR URLs are first-class through the REAL
 * validateAndSanitizeGithubUrl pipeline — every GitHub security control
 * (HTTPS-only, private-host rejection, IDN rejection, credential stripping,
 * bounded length, control characters) applies identically to GitLab hosts.
 * Pure-function tests: no fs, no subprocess.
 */

describe('validateAndSanitizeGithubUrl — GitLab acceptance (#2733)', () => {
	test('gitlab.com MR URL is accepted for the pull resource (sanitized === input)', () => {
		expect(
			validateAndSanitizeGithubUrl(
				'https://gitlab.com/acme/app/-/merge_requests/155',
				'pull',
			),
		).toEqual({
			sanitized: 'https://gitlab.com/acme/app/-/merge_requests/155',
		});
	});

	test('gitlab.com issue URL is accepted for the issues resource', () => {
		expect(
			validateAndSanitizeGithubUrl(
				'https://gitlab.com/acme/app/-/issues/42',
				'issues',
			),
		).toEqual({ sanitized: 'https://gitlab.com/acme/app/-/issues/42' });
	});

	test('self-hosted nested-namespace MR URL is accepted', () => {
		expect(
			validateAndSanitizeGithubUrl(
				'https://gitlab.acme.test/ops/infra/platform/-/merge_requests/7',
				'pull',
			),
		).toEqual({
			sanitized:
				'https://gitlab.acme.test/ops/infra/platform/-/merge_requests/7',
		});
	});

	test('self-hosted nested-namespace issue URL is accepted', () => {
		expect(
			validateAndSanitizeGithubUrl(
				'https://gitlab.acme.test/ops/infra/app/-/issues/9',
				'issues',
			),
		).toEqual({
			sanitized: 'https://gitlab.acme.test/ops/infra/app/-/issues/9',
		});
	});

	test('resource kind is still enforced: MR URL for issues → error, issue URL for pull → error', () => {
		expect(
			validateAndSanitizeGithubUrl(
				'https://gitlab.com/acme/app/-/merge_requests/1',
				'issues',
			).error,
		).toBeDefined();
		expect(
			validateAndSanitizeGithubUrl(
				'https://gitlab.com/acme/app/-/issues/1',
				'pull',
			).error,
		).toBeDefined();
	});
});

describe('validateAndSanitizeGithubUrl — provider-neutral errors (#2733)', () => {
	test('wrong-shape URL error mentions BOTH GitHub and GitLab (pull)', () => {
		const result = validateAndSanitizeGithubUrl(
			'https://example.com/owner/repo/pull/1',
			'pull',
		);
		expect(result.error).toContain('GitHub');
		expect(result.error).toContain('GitLab');
	});

	test('wrong-shape URL error mentions BOTH GitHub and GitLab (issues)', () => {
		const result = validateAndSanitizeGithubUrl(
			'https://example.com/owner/repo/issues/1',
			'issues',
		);
		expect(result.error).toContain('GitHub');
		expect(result.error).toContain('GitLab');
	});
});

describe('validateAndSanitizeGithubUrl — security negatives hold for GitLab hosts (#2733)', () => {
	test('http scheme on a gitlab.com MR URL → rejected', () => {
		const result = validateAndSanitizeGithubUrl(
			'http://gitlab.com/acme/app/-/merge_requests/1',
			'pull',
		);
		expect(result.error).toBe('URL must use HTTPS scheme');
	});

	test('localhost / loopback / private-range hosts → rejected', () => {
		for (const host of ['localhost', '127.0.0.1', '10.0.0.1', '192.168.1.1']) {
			const result = validateAndSanitizeGithubUrl(
				`https://${host}/acme/app/-/merge_requests/1`,
				'pull',
			);
			expect(result.error).toBe('Private or localhost URLs are not allowed');
		}
	});

	test('non-ASCII IDN host (Cyrillic homograph of gitlab) → rejected', () => {
		// The WHATWG URL parser punycodes the non-ASCII hostname before the
		// guards run, so the host no longer looks gitlab-indicating — the
		// rejection lands in the host-shape guard. Either way: fail-closed.
		const result = validateAndSanitizeGithubUrl(
			`https://gitl${'а'}b.com/acme/app/-/merge_requests/1`,
			'pull',
		);
		expect(result.error).toBeDefined();
		expect('sanitized' in result).toBe(false);
	});

	test('credentials are stripped before validation', () => {
		expect(
			validateAndSanitizeGithubUrl(
				'https://user:pass@gitlab.com/acme/app/-/merge_requests/1',
				'pull',
			),
		).toEqual({ sanitized: 'https://gitlab.com/acme/app/-/merge_requests/1' });
	});

	test('URL exceeding MAX_URL_LEN → rejected', () => {
		const longOwner = 'a'.repeat(MAX_URL_LEN + 100);
		const result = validateAndSanitizeGithubUrl(
			`https://gitlab.com/${longOwner}/app/-/merge_requests/1`,
			'pull',
		);
		expect(result.error).toBeDefined();
	});

	test('raw C0 control byte in the path → rejected', () => {
		const result = validateAndSanitizeGithubUrl(
			'https://gitlab.com/acme/ap\x01p/-/merge_requests/1',
			'pull',
		);
		expect(result.error).toBeDefined();
	});
});

describe('validateAndSanitizeGithubUrl — GitHub behavior preserved (#2733)', () => {
	test('github PR URL still accepted for pull', () => {
		expect(
			validateAndSanitizeGithubUrl(
				'https://github.com/owner/repo/pull/42',
				'pull',
			),
		).toEqual({ sanitized: 'https://github.com/owner/repo/pull/42' });
	});

	test('github issue URL still accepted for issues', () => {
		expect(
			validateAndSanitizeGithubUrl(
				'https://github.com/owner/repo/issues/42',
				'issues',
			),
		).toEqual({ sanitized: 'https://github.com/owner/repo/issues/42' });
	});

	test('empty URL error unchanged', () => {
		expect(validateAndSanitizeGithubUrl('', 'pull')).toEqual({
			error: 'Empty URL',
		});
	});
});

describe('forge guard regressions (PRR-01/02/03/07/09/10, PR #2884 review)', () => {
	const validate = (
		raw: string,
		resource: 'issues' | 'pull',
	): { sanitized?: string; error?: string } =>
		validateAndSanitizeGithubUrl(raw, resource);

	test('punycode gitlab-prefixed host rejected (PRR-01)', () => {
		const result = validate(
			'https://gitlab.xn--80ak6aa92e.com/o/r/-/merge_requests/1',
			'pull',
		);
		expect(result.error).toBeDefined();
	});

	test('gitlab.localhost rejected as private (PRR-03)', () => {
		const result = validate(
			'https://gitlab.localhost/o/r/-/merge_requests/1',
			'pull',
		);
		expect(result.error).toBeDefined();
	});

	test('malformed gitlab. host rejected (PRR-09)', () => {
		expect(
			(
				validate('https://gitlab./o/r/-/issues/1', 'issues') as {
					error?: string;
				}
			).error,
		).toBeDefined();
		expect(
			(
				validate('https://gitlab..com/o/r/-/merge_requests/1', 'pull') as {
					error?: string;
				}
			).error,
		).toBeDefined();
	});

	test('percent-encoded NUL rejected (PRR-10)', () => {
		const result = validate(
			'https://gitlab.com/owner%00injected/repo/-/merge_requests/1',
			'pull',
		);
		expect(result.error).toBeDefined();
	});

	test('credentialed GitLab URL sanitized + store-side rejected (PRR-02)', () => {
		const result = validate(
			'https://user:glpat-x@gitlab.com/o/r/-/merge_requests/1',
			'pull',
		);
		expect(result.sanitized).toBeDefined();
		expect(result.sanitized).not.toContain('glpat-x');
		// Store-side (schema superRefine via isForgePrUrl) rejects the RAW
		// credentialed URL — hostname strips userinfo, so the raw string must
		// never reach a durable record.
		expect(
			isForgePrUrl('https://user:glpat-x@gitlab.com/o/r/-/merge_requests/1'),
		).toBe(false);
	});

	test('MODE-wrapped credentials stripped before MODE removal (PRR-07)', () => {
		const sanitized = sanitizeUrl(
			'https://[MODE: X]/user:glpat-token@gitlab.com/o/r/-/merge_requests/1',
		);
		expect(sanitized).not.toContain('glpat-token');
	});
});
