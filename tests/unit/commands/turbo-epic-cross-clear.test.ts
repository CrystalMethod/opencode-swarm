/**
 * /swarm turbo ↔ Epic Mode provenance and config gate — regression coverage
 * for the Epic catch-up review (F-CrossClear, F-TurboEpicGate).
 * File: tests/unit/commands/turbo-epic-cross-clear.test.ts
 *
 * Previously `disableTurbo` ALWAYS called `disableEpicMode` and cleared
 * `session.epicModeActive`, even when Epic had been enabled standalone via
 * `/swarm epic on` and even when Turbo was never on; and `/swarm turbo epic
 * on` ignored the `turbo.epic.mode.enabled` master gate.
 *
 * Isolation: `_internals` DI on turbo.ts (no mock.module), real temp dir +
 * real durable state modules.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	handleTurboCommand,
	_internals as turboInternals,
} from '../../../src/commands/turbo';
import type { PluginConfig } from '../../../src/config/schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	getAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { EPIC_MODE_CONFIG_DISABLED_MESSAGE } from '../../../src/turbo/epic/config-gate';
import {
	enableEpicMode,
	isEpicModeActive,
	loadEpicSessionState,
} from '../../../src/turbo/epic/state';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SID = 'sess-turbo-epic-xclear';
const originalLoader = turboInternals.loadPluginConfigWithMeta;
const originalDisableEpic = turboInternals.disableEpicMode;
let tmpDir: string;
let epicEnabledInConfig: boolean;

function useConfig(): void {
	turboInternals.loadPluginConfigWithMeta = (() => ({
		config: {
			turbo: {
				strategy: 'lean',
				epic: { mode: { enabled: epicEnabledInConfig } },
			},
		} as unknown as PluginConfig,
	})) as unknown as typeof originalLoader;
}

beforeEach(() => {
	tmpDir = canonicalMkdtemp('turbo-epic-xclear-');
	resetSwarmState();
	startAgentSession(SID, 'architect');
	epicEnabledInConfig = true;
	useConfig();
});

afterEach(() => {
	turboInternals.loadPluginConfigWithMeta = originalLoader;
	turboInternals.disableEpicMode = originalDisableEpic;
	resetSwarmState();
	closeAllProjectDbs();
	safeRmRecursive(tmpDir);
});

/** Simulates `/swarm epic on` (standalone; src/commands/epic.ts). */
function enableEpicStandalone(): void {
	enableEpicMode(tmpDir, SID);
	const session = getAgentSession(SID);
	if (session) session.epicModeActive = true;
}

describe('turbo off — regression: cross-cleared standalone Epic (F-CrossClear)', () => {
	test('`/swarm turbo off` leaves Epic enabled via `/swarm epic on` untouched', async () => {
		// Previously disableTurbo unconditionally disabled Epic here.
		enableEpicStandalone();
		await handleTurboCommand(tmpDir, ['lean', 'on'], SID);

		const out = await handleTurboCommand(tmpDir, ['off'], SID);

		expect(out).toBe('Turbo Mode disabled');
		expect(getAgentSession(SID)?.epicModeActive).toBe(true);
		expect(isEpicModeActive(tmpDir, SID)).toBe(true);
		expect(getAgentSession(SID)?.turboMode).toBe(false);
	});

	test('turbo off while Turbo was never on does not touch standalone Epic', async () => {
		enableEpicStandalone();
		await handleTurboCommand(tmpDir, ['standard', 'off'], SID);
		expect(isEpicModeActive(tmpDir, SID)).toBe(true);
		expect(getAgentSession(SID)?.epicModeActive).toBe(true);
	});

	test('switching lean → standard keeps standalone Epic but clears turbo-enabled Epic (and says so)', async () => {
		enableEpicStandalone();
		await handleTurboCommand(tmpDir, ['lean', 'on'], SID);
		const keep = await handleTurboCommand(tmpDir, ['standard', 'on'], SID);
		expect(keep).not.toContain('Epic Mode also disabled');
		expect(isEpicModeActive(tmpDir, SID)).toBe(true);
	});

	test('switching lean → standard clears turbo-enabled Epic (and says so)', async () => {
		await handleTurboCommand(tmpDir, ['epic', 'on'], SID);
		const cleared = await handleTurboCommand(tmpDir, ['standard', 'on'], SID);
		expect(cleared).toContain('Epic Mode also disabled');
		expect(isEpicModeActive(tmpDir, SID)).toBe(false);
	});

	test('`/swarm turbo epic on` after standalone `/swarm epic on` keeps enabledVia=epic (first enabler wins)', async () => {
		// Previously enableEpicMode overwrote enabledVia with 'turbo', so the
		// next turbo off silently cross-cleared the user's standalone Epic.
		enableEpicStandalone();
		await handleTurboCommand(tmpDir, ['epic', 'on'], SID);
		expect(loadEpicSessionState(tmpDir, SID)?.enabledVia).toBe('epic');
		const out = await handleTurboCommand(tmpDir, ['off'], SID);
		expect(out).toBe('Turbo Mode disabled');
		expect(isEpicModeActive(tmpDir, SID)).toBe(true);
		expect(getAgentSession(SID)?.epicModeActive).toBe(true);
	});

	test('`/swarm turbo epic on` records enabledVia=turbo; turbo off then clears it with a notice', async () => {
		await handleTurboCommand(tmpDir, ['epic', 'on'], SID);
		expect(loadEpicSessionState(tmpDir, SID)?.enabledVia).toBe('turbo');
		const out = await handleTurboCommand(tmpDir, ['lean', 'off'], SID);
		expect(out).toContain('Epic Mode also disabled');
		expect(isEpicModeActive(tmpDir, SID)).toBe(false);
		expect(getAgentSession(SID)?.epicModeActive).toBe(false);
	});

	test('explicit `/swarm turbo epic off` clears Epic regardless of provenance', async () => {
		enableEpicStandalone();
		const out = await handleTurboCommand(tmpDir, ['epic', 'off'], SID);
		expect(out).toBe('Turbo Mode + Epic Mode disabled');
		expect(isEpicModeActive(tmpDir, SID)).toBe(false);
	});

	test('turbo off on a never-Epic project keeps the pre-catch-up side effects (inactive row, flag false, plain reply)', async () => {
		await handleTurboCommand(tmpDir, ['standard', 'on'], SID);
		const out = await handleTurboCommand(tmpDir, ['off'], SID);
		expect(out).toBe('Turbo Mode disabled');
		expect(loadEpicSessionState(tmpDir, SID)).toMatchObject({
			active: false,
		});
		expect(getAgentSession(SID)?.epicModeActive).toBe(false);
	});

	test('cross-clear write failure keeps the Epic flag and reports the error (F7c)', async () => {
		await handleTurboCommand(tmpDir, ['epic', 'on'], SID);
		turboInternals.disableEpicMode = () => {
			throw new Error('db locked');
		};
		const out = await handleTurboCommand(tmpDir, ['off'], SID);
		expect(out).toContain('Turbo Mode disabled');
		expect(out).toContain('Epic Mode was NOT disabled');
		expect(out).toContain('db locked');
		expect(out).not.toContain('Epic Mode also disabled');
		expect(getAgentSession(SID)?.epicModeActive).toBe(true);
		expect(isEpicModeActive(tmpDir, SID)).toBe(true);
		expect(getAgentSession(SID)?.turboMode).toBe(false);
	});

	test('explicit `/swarm turbo epic off` write failure is reported, not claimed as disabled', async () => {
		enableEpicStandalone();
		turboInternals.disableEpicMode = () => {
			throw new Error('db locked');
		};
		const out = await handleTurboCommand(tmpDir, ['epic', 'off'], SID);
		expect(out).not.toBe('Turbo Mode + Epic Mode disabled');
		expect(out).toContain('Epic Mode was NOT disabled');
		expect(getAgentSession(SID)?.epicModeActive).toBe(true);
	});
});

describe('`/swarm turbo epic on` — regression: ignored the config master gate (F-TurboEpicGate)', () => {
	test('refused with the config message when mode.enabled !== true; nothing half-enables', async () => {
		epicEnabledInConfig = false;
		const out = await handleTurboCommand(tmpDir, ['epic', 'on'], SID);
		expect(out).toContain(EPIC_MODE_CONFIG_DISABLED_MESSAGE);
		const session = getAgentSession(SID);
		expect(session?.leanTurboActive).toBe(false);
		expect(session?.turboMode).toBe(false);
		expect(session?.epicModeActive).toBe(false);
		expect(fs.existsSync(path.join(tmpDir, '.swarm'))).toBe(false);
	});

	test('bare `/swarm turbo epic` toggle-on is refused the same way', async () => {
		epicEnabledInConfig = false;
		const out = await handleTurboCommand(tmpDir, ['epic'], SID);
		expect(out).toContain(EPIC_MODE_CONFIG_DISABLED_MESSAGE);
		expect(getAgentSession(SID)?.leanTurboActive).toBe(false);
	});

	test('config read failure fails closed', async () => {
		turboInternals.loadPluginConfigWithMeta = (() => {
			throw new Error('unreadable config');
		}) as unknown as typeof originalLoader;
		const out = await handleTurboCommand(tmpDir, ['epic', 'on'], SID);
		expect(out).toContain(EPIC_MODE_CONFIG_DISABLED_MESSAGE);
		expect(getAgentSession(SID)?.leanTurboActive).toBe(false);
	});

	test('Epic durable-write failure rolls Lean Turbo back when it was not already on', async () => {
		// Sabotage only the Epic projection target (a directory), so Lean's
		// own durable write succeeds first.
		fs.mkdirSync(path.join(tmpDir, '.swarm', 'epic-state.json'), {
			recursive: true,
		});
		const out = await handleTurboCommand(tmpDir, ['epic', 'on'], SID);
		expect(out).toContain('Epic Mode could not be enabled');
		expect(out).toContain('rolled back');
		const session = getAgentSession(SID);
		expect(session?.leanTurboActive).toBe(false);
		expect(session?.turboMode).toBe(false);
		expect(session?.epicModeActive).toBe(false);
	});
});
