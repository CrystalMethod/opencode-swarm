/**
 * Coverage for the #2504 "Defaults changes (v8)" doctor report section
 * (PRR-011 from the PR #2797 review round): the defaults-flip findings must
 * render their own markdown section, and must not when absent.
 */
import { describe, expect, test } from 'bun:test';
import { formatDoctorMarkdown } from '../../../src/commands/doctor';
import type { ConfigDoctorResult } from '../../../src/services/config-doctor';

function makeResult(
	findings: ConfigDoctorResult['findings'],
): ConfigDoctorResult {
	return {
		findings,
		summary: {
			info: findings.filter((f) => f.severity === 'info').length,
			warn: findings.filter((f) => f.severity === 'warn').length,
			error: findings.filter((f) => f.severity === 'error').length,
		},
		hasAutoFixableIssues: false,
		timestamp: 0,
		configSource: 'defaults',
	};
}

const FLIP_FINDING = {
	id: 'defaults-flip',
	title: 'v8 default change pending for "auto_review.enabled"',
	description:
		'Default flips from false (opt-in) to release-gated true (advisory). ' +
		'Kill switch: set auto_review.enabled: false. ' +
		'Restore all v7 defaults with preset: "conservative". ' +
		'Evidence and rollback: docs/defaults-governance.md (#2504).',
	severity: 'info' as const,
	path: 'auto_review.enabled',
	currentValue: 'v7 default',
	autoFixable: false,
};

describe('formatDoctorMarkdown — Defaults changes (v8) section (#2504)', () => {
	test('renders the section for defaults-flip findings', () => {
		const markdown = formatDoctorMarkdown(makeResult([FLIP_FINDING]));
		expect(markdown).toContain('### Defaults changes (v8)');
		expect(markdown).toContain('auto_review.enabled: false');
		expect(markdown).toContain('preset: "conservative"');
		expect(markdown).toContain('docs/defaults-governance.md');
	});

	test('omits the section when no defaults-flip findings exist', () => {
		const markdown = formatDoctorMarkdown(makeResult([]));
		expect(markdown).not.toContain('Defaults changes (v8)');
	});
});
