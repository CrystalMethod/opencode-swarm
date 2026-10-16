/**
 * Issue #3323 (PR #3326 review follow-up): the `shell` tool's inherited
 * Windows grammar is keyed on the PLATFORM (not just the tool name), and `;`
 * ends a `>&<descriptor>` token in the cmd redirect scanner.
 * @jest-environment node
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resolveWindowsWriteAuthority } from '../../../src/hooks/guardrails/tool-before';
import { detectWindowsWrites } from '../../../src/hooks/shell-write-detect';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('shell-tool-grammar-3323-');
const OUTSIDE_DENIAL = /AUTHORITY_ROOT_ESCAPE|SCOPE_VIOLATION/;

// Every value of NodeJS.Platform: the shell-tool rule is win32-only, so it must
// hold for each non-Windows platform, not just linux and darwin.
const ALL_PLATFORMS: NodeJS.Platform[] = [
	'aix',
	'android',
	'cygwin',
	'darwin',
	'freebsd',
	'haiku',
	'linux',
	'netbsd',
	'openbsd',
	'sunos',
	'win32',
];
const NON_WINDOWS_PLATFORMS = ALL_PLATFORMS.filter((x) => x !== 'win32');

function defaultConfig(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
	};
}

describe('resolveWindowsWriteAuthority — shell tool grammar by platform (#3323)', () => {
	it('does not classify a POSIX `echo` command as cmd for the shell tool off Windows', () => {
		for (const platform of NON_WINDOWS_PLATFORMS) {
			expect(
				resolveWindowsWriteAuthority(
					'shell',
					'echo hello > src/out.txt',
					'cmd',
					false,
					platform,
				),
			).toBeNull();
		}
	});

	it('does not inherit PowerShell content detection for the shell tool off Windows', () => {
		for (const platform of NON_WINDOWS_PLATFORMS) {
			expect(
				resolveWindowsWriteAuthority(
					'shell',
					'Get-Content a.txt',
					'powershell',
					false,
					platform,
				),
			).toBeNull();
		}
	});

	it('keeps inherited cmd detection for the shell tool on Windows', () => {
		expect(
			resolveWindowsWriteAuthority(
				'shell',
				'copy a.txt ..\\outside.txt',
				'cmd',
				false,
				'win32',
			),
		).toBe('cmd');
		expect(
			resolveWindowsWriteAuthority(
				'shell',
				'Get-Content a.txt',
				'powershell',
				false,
				'win32',
			),
		).toBe('powershell');
	});

	it('never inherits Windows grammar for the bash tool on any platform', () => {
		for (const platform of ALL_PLATFORMS) {
			expect(
				resolveWindowsWriteAuthority(
					'bash',
					'copy a.txt b.txt',
					'cmd',
					false,
					platform,
				),
			).toBeNull();
		}
	});

	it('still honors an explicit wrapper or a shaped body for the shell tool off Windows', () => {
		expect(
			resolveWindowsWriteAuthority(
				'shell',
				'cmd /c echo hi > out.txt',
				'posix',
				false,
				'linux',
			),
		).toBe('cmd');
		expect(
			resolveWindowsWriteAuthority(
				'shell',
				'powershell -Command "echo hi > out.txt"',
				'posix',
				false,
				'linux',
			),
		).toBe('powershell');
		expect(
			resolveWindowsWriteAuthority(
				'shell',
				'Set-Content out.txt hi',
				'posix',
				true,
				'linux',
			),
		).toBe('powershell');
	});

	it('pins the full inheritance table: tool x platform x detected shell type', () => {
		const platforms = ALL_PLATFORMS;
		const detected = ['cmd', 'powershell'] as const;
		for (const platform of platforms) {
			for (const shellType of detected) {
				const command = shellType === 'cmd' ? 'copy a b' : 'Get-Content a';
				// bash is a POSIX executor on every platform: never inherits.
				expect(
					resolveWindowsWriteAuthority(
						'bash',
						command,
						shellType,
						false,
						platform,
					),
				).toBeNull();
				// shell inherits the content-detected grammar on Windows only.
				expect(
					resolveWindowsWriteAuthority(
						'shell',
						command,
						shellType,
						false,
						platform,
					),
				).toBe(platform === 'win32' ? shellType : null);
				// Any other tool name keeps the pre-#3323 behavior: always inherits.
				expect(
					resolveWindowsWriteAuthority(
						'other',
						command,
						shellType,
						false,
						platform,
					),
				).toBe(shellType);
			}
			// A POSIX-detected body never inherits a Windows grammar.
			for (const tool of ['bash', 'shell', 'other']) {
				expect(
					resolveWindowsWriteAuthority(
						tool,
						'ls -la',
						'posix',
						false,
						platform,
					),
				).toBeNull();
			}
		}
	});

	it('pins the authority ladder order: wrapper declaration > shaped body > inherited', () => {
		const platforms = ALL_PLATFORMS;
		const tools = ['bash', 'shell', 'other'];
		for (const platform of platforms) {
			for (const tool of tools) {
				// Step 1: an explicit cmd wrapper outranks a PowerShell-shaped body
				// and any content-detected grammar.
				expect(
					resolveWindowsWriteAuthority(
						tool,
						'cmd /c "Get-ChildItem | Out-File x"',
						'powershell',
						true,
						platform,
					),
				).toBe('cmd');
				// Step 1: an explicit PowerShell wrapper outranks a cmd-detected body.
				expect(
					resolveWindowsWriteAuthority(
						tool,
						'powershell -Command "copy a b"',
						'cmd',
						false,
						platform,
					),
				).toBe('powershell');
				// Step 2: a shaped body is PowerShell even when content says cmd.
				expect(
					resolveWindowsWriteAuthority(
						tool,
						'Get-ChildItem | Out-File x',
						'cmd',
						true,
						platform,
					),
				).toBe('powershell');
				// No wrapper, not shaped, POSIX content: never a Windows grammar.
				expect(
					resolveWindowsWriteAuthority(
						tool,
						'ls -la',
						'posix',
						false,
						platform,
					),
				).toBeNull();
			}
		}
	});

	it('defaults the platform to the running host', () => {
		const expected = process.platform === 'win32' ? 'cmd' : null;
		expect(
			resolveWindowsWriteAuthority('shell', 'copy a b', 'cmd', false),
		).toBe(expected);
	});
});

describe('shell tool cmd-grammar write gate (Windows host only, #3323)', () => {
	afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));
	beforeEach(() => {
		resetSwarmState();
	});

	// The #3323 item 1 symptom on a POSIX host: the shell tool's `echo ... 2>/dev/null`
	// was read as cmd.exe syntax and rejected. Off Windows it must be allowed.
	it.skipIf(process.platform === 'win32')(
		'allows a POSIX null-device redirect via the shell tool off Windows',
		async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			startAgentSession('s3323-posix', 'coder');
			installActiveScopeBinding({
				directory: TEST_DIR,
				childSessionId: 's3323-posix',
				taskId: '1.1',
				files: ['src/'],
				dispatchCallId: 'call-1',
			});

			await expect(
				hooks.toolBefore(
					{ tool: 'shell', sessionID: 's3323-posix', callID: 'call-1' },
					{ args: { command: 'echo hi 2>/dev/null' } },
				),
			).resolves.toBeUndefined();
		},
	);

	it.skipIf(process.platform !== 'win32')(
		'blocks cmd `copy` to a path outside scope via the shell tool',
		async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			startAgentSession('s3323-a', 'coder');
			installActiveScopeBinding({
				directory: TEST_DIR,
				childSessionId: 's3323-a',
				taskId: '1.1',
				files: ['src/'],
				dispatchCallId: 'call-1',
			});

			await expect(
				hooks.toolBefore(
					{ tool: 'shell', sessionID: 's3323-a', callID: 'call-1' },
					{ args: { command: 'copy src\\a.txt ..\\outside.txt' } },
				),
			).rejects.toThrow(OUTSIDE_DENIAL);
		},
	);
});

describe('cmd redirect scanner — semicolon ends a >&<descriptor> token (#3323)', () => {
	it('treats `>&1;` as pure descriptor duplication, not an unresolved target', () => {
		for (const command of [
			'echo x >&1; echo y',
			'echo x >&1;echo y',
			'git status 2>&1; ls -la',
		]) {
			expect(detectWindowsWrites(command, 'cmd').writes).toEqual([]);
		}
	});

	it('still fails closed on a non-numeric duplication target before a semicolon', () => {
		const { writes } = detectWindowsWrites('echo x >&foo; echo y', 'cmd');
		expect(writes.length).toBe(1);
		expect(writes[0]?.path).toBeNull();
	});

	it('still detects a real redirect that follows the semicolon', () => {
		const { writes } = detectWindowsWrites(
			'echo x >&1; echo y > out.txt',
			'cmd',
		);
		expect(writes.map((w) => w.path)).toEqual(['out.txt']);
	});
});
