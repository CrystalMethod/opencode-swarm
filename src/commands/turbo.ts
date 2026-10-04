import { loadPluginConfigWithMeta } from '../config';
import { getAgentSession } from '../state';
import {
	EPIC_MODE_CONFIG_DISABLED_MESSAGE,
	isEpicModeConfigEnabled,
} from '../turbo/epic/config-gate';
import {
	disableEpicMode,
	enableEpicMode,
	peekEpicSessionState,
} from '../turbo/epic/state';
import {
	emptyRunState,
	isStateUnreadable,
	loadLeanTurboRunState,
	pauseLeanTurboRun,
	saveLeanTurboRunState,
} from '../turbo/lean/state';
import * as logger from '../utils/logger';
import { stripControlCharacters } from '../utils/sanitize-display.js';
import { TURBO_BYPASS_DISCLOSURE } from './turbo-constants.js';

/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.loadPluginConfigWithMeta(...)` so tests can replace the function
 * on this object without using `mock.module` from `bun:test`, which leaks
 * across files in Bun's shared test-runner process (AGENTS.md §7).
 * Mutating this local object is file-scoped and trivially restorable via afterEach.
 */
export const _internals: {
	loadPluginConfigWithMeta: typeof loadPluginConfigWithMeta;
	disableEpicMode: typeof disableEpicMode;
} = {
	loadPluginConfigWithMeta,
	disableEpicMode,
};

/**
 * Handles the /swarm turbo command.
 * Supports standard turbo toggle, lean turbo mode, and status reporting.
 *
 * @param directory - Project directory (used to persist Lean Turbo run state)
 * @param args - Arguments: (none) | "on" | "off" | "status" | "lean" ["on"|"off"] | "standard" ["on"|"off"] | "epic" ["on"|"off"]. Unknown arguments are rejected without changing state.
 * @param sessionID - Session ID for accessing active session state
 * @returns Feedback message about Turbo Mode state
 */
export async function handleTurboCommand(
	directory: string,
	args: string[],
	sessionID: string,
): Promise<string> {
	// Check for empty/blank sessionID - CLI context doesn't have session
	if (!sessionID || sessionID.trim() === '') {
		return 'Error: No active session context. Turbo Mode requires an active session. Use /swarm turbo from within an OpenCode session, or start a session first.';
	}

	// Validate session exists
	const session = getAgentSession(sessionID);
	if (!session) {
		return 'Error: No active session. Turbo Mode requires an active session to operate.';
	}

	// Parse arguments. Empty/whitespace-only tokens (trailing-space
	// invocations arriving as ['']) are argument-less: only non-empty tokens
	// steer dispatch.
	const tokens = args.filter((a) => a !== undefined && a.trim() !== '');
	const arg0 = tokens[0]?.toLowerCase();
	const arg1 = tokens[1]?.toLowerCase();

	// Handle status command
	if (arg0 === 'status') {
		return buildStatusMessage(session, directory, sessionID);
	}

	// Determine current turbo state
	const isTurboOn = session.turboMode;
	const isLeanActive = session.leanTurboActive === true;

	// Disable helper - pauses lean if needed and resets all turbo flags.
	//
	// Epic Mode is an independent toggle: it dispatches coders via `Task`,
	// not through Lean Turbo, so it does not need Turbo to stay on. Turbo off
	// therefore cross-clears an ACTIVE Epic row ONLY when Epic was enabled
	// through the combined `/swarm turbo epic on` toggle
	// (`enabledVia === 'turbo'`), or when the caller is an explicit
	// `/swarm turbo epic off|toggle` (`epic: 'always'`). An active standalone
	// `/swarm epic on` enablement is left untouched. When the session has NO
	// active Epic row (never-Epic projects included) the pre-Epic-catch-up
	// behaviour is preserved exactly: `disableEpicMode` is called and the
	// in-memory flag cleared, best-effort, so non-Epic durable state is
	// unchanged. Clearing an ACTIVE row is fail-consistent: if the durable
	// write throws, the in-memory flag is kept and the error is surfaced in
	// the reply instead of claiming Epic was disabled.
	type DisableTurboResult = { epicCleared: boolean; epicError?: string };
	const disableTurbo = (
		reason: string,
		epic: 'always' | 'if-enabled-via-turbo' = 'if-enabled-via-turbo',
	): DisableTurboResult => {
		if (isLeanActive) {
			try {
				pauseLeanTurboRun(directory, sessionID, reason);
			} catch (error) {
				logger.error(
					`[turbo] pauseLeanTurboRun failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		let rowRead = true;
		let rowActive = false;
		let rowViaTurbo = false;
		try {
			const row = peekEpicSessionState(directory, sessionID);
			rowActive = row?.active === true;
			rowViaTurbo = rowActive && row?.enabledVia === 'turbo';
		} catch (error) {
			rowRead = false;
			logger.warn(
				`[turbo] could not read Epic Mode state for cross-clear: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const result: DisableTurboResult = { epicCleared: false };
		const noActiveEpic = rowRead ? !rowActive : session.epicModeActive !== true;
		if (noActiveEpic && epic !== 'always') {
			// No active Epic row (or unreadable state for a session without the
			// Epic flag): identical to the pre-catch-up unconditional cross-clear
			// (inactive row write + flag reset), errors logged only. An
			// unreadable state with the Epic flag set is left alone — unknown
			// provenance must never cross-clear a standalone enablement.
			try {
				_internals.disableEpicMode(directory, sessionID);
			} catch (error) {
				logger.error(
					`[turbo] disableEpicMode (cross-clear) failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			session.epicModeActive = false;
		} else if (epic === 'always' || rowViaTurbo) {
			const epicWasActive = rowActive || session.epicModeActive === true;
			try {
				_internals.disableEpicMode(directory, sessionID);
				session.epicModeActive = false;
				result.epicCleared = epicWasActive;
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				logger.error(`[turbo] disableEpicMode (cross-clear) failed: ${msg}`);
				if (epicWasActive) {
					// Keep the in-memory flag consistent with the still-active
					// durable row and report the failure.
					result.epicError = msg;
				} else {
					session.epicModeActive = false;
				}
			}
		}
		session.turboMode = false;
		session.turboStrategy = undefined;
		session.leanTurboActive = false;
		session.leanTurboCurrentPhase = undefined;
		return result;
	};
	const epicAlsoDisabledSuffix = (r: DisableTurboResult): string => {
		if (r.epicError !== undefined) {
			return `\nEpic Mode was NOT disabled (durable state write failed: ${r.epicError}); it is still active. Retry \`/swarm epic off\`.`;
		}
		return r.epicCleared
			? '\nEpic Mode also disabled (it was enabled via `/swarm turbo epic on`).'
			: '';
	};

	// Combined `/swarm turbo epic on` enablement. Order of operations is
	// fail-closed so nothing half-enables:
	//   1. config master gate (`turbo.epic.mode.enabled`) — refused before
	//      ANY state changes, Lean Turbo included;
	//   2. Lean Turbo (durable run state first, then session flags);
	//   3. Epic Mode durable row (`enabledVia: 'turbo'`) + in-memory mirror.
	// A step-3 failure rolls step 2 back when Lean was not already on.
	const enableTurboEpic = (): string => {
		let configEnabled = false;
		try {
			configEnabled = isEpicModeConfigEnabled(
				_internals.loadPluginConfigWithMeta(directory).config,
			);
		} catch (error) {
			logger.warn(
				`[turbo] could not read config for Epic Mode gate (failing closed): ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!configEnabled) {
			return `${EPIC_MODE_CONFIG_DISABLED_MESSAGE}\nTurbo state is unchanged.`;
		}
		const prior = {
			turboMode: session.turboMode,
			turboStrategy: session.turboStrategy,
			leanTurboActive: session.leanTurboActive,
			leanTurboCurrentPhase: session.leanTurboCurrentPhase,
		};
		const leanMsg = enableLeanTurbo(session, directory, sessionID);
		if (!session.leanTurboActive) {
			return `${leanMsg}\nEpic Mode NOT enabled: \`/swarm turbo epic on\` enables Lean Turbo and Epic Mode together, and Lean Turbo failed to enable. Use \`/swarm epic on\` to enable Epic Mode alone.`;
		}
		try {
			enableEpicMode(directory, sessionID, { enabledVia: 'turbo' });
			session.epicModeActive = true;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error(`[turbo] enableEpicMode failed: ${msg}`);
			if (prior.leanTurboActive !== true) {
				try {
					pauseLeanTurboRun(
						directory,
						sessionID,
						'/swarm turbo epic on (rollback: Epic Mode enable failed)',
					);
				} catch (pauseError) {
					logger.error(
						`[turbo] pauseLeanTurboRun (rollback) failed: ${pauseError instanceof Error ? pauseError.message : String(pauseError)}`,
					);
				}
				session.turboMode = prior.turboMode;
				session.turboStrategy = prior.turboStrategy;
				session.leanTurboActive = prior.leanTurboActive;
				session.leanTurboCurrentPhase = prior.leanTurboCurrentPhase;
				return `Epic Mode could not be enabled: ${msg}\nLean Turbo was rolled back; Turbo state is unchanged.`;
			}
			return `${leanMsg}\nEpic Mode could not be enabled: ${msg}`;
		}
		return `${leanMsg}\nEpic Mode enabled — the architect will use the transparent decide-then-dispatch wave flow: declare_scope (per pending task) → epic_decide_phase → epic_plan_waves → Task (per task in current wave, all in one message) → per task: pre_check_batch → reviewer + test_engineer → update_task_status(completed) → epic_record_divergence → epic_phase_review → phase_complete.`;
	};

	// --- Explicit off commands ---
	if (arg0 === 'off' || (arg0 === 'lean' && arg1 === 'off')) {
		// turbo off OR turbo lean off
		const epicCleared = disableTurbo('/swarm turbo off');
		return `Turbo Mode disabled${epicAlsoDisabledSuffix(epicCleared)}`;
	}

	if (arg0 === 'standard' && arg1 === 'off') {
		// turbo standard off
		const epicCleared = disableTurbo('/swarm turbo standard off');
		return `Turbo Mode disabled${epicAlsoDisabledSuffix(epicCleared)}`;
	}

	// --- Toggle (no args): off/standard → enable standard; standard on → disable ---
	if (arg0 === undefined) {
		if (isTurboOn) {
			// Any turbo is on (standard or lean) → disable all turbo
			const epicCleared = disableTurbo('/swarm turbo (toggle off)');
			return `Turbo Mode disabled${epicAlsoDisabledSuffix(epicCleared)}`;
		} else {
			// Turbo is off → enable standard
			session.turboMode = true;
			session.turboStrategy = 'standard';
			session.leanTurboActive = false;
			session.leanTurboCurrentPhase = undefined;
			return `Turbo Mode enabled. ${TURBO_BYPASS_DISCLOSURE}`;
		}
	}

	// --- Explicit on commands ---
	if (arg0 === 'on') {
		// turbo on → enable standard UNLESS config says lean
		let strategy: 'standard' | 'lean' = 'standard';
		try {
			const { config } = _internals.loadPluginConfigWithMeta(directory);
			if (config.turbo?.strategy === 'lean') {
				strategy = 'lean';
			}
		} catch (error) {
			logger.warn(
				`[turbo] could not read config for strategy default: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		if (strategy === 'lean') {
			return enableLeanTurbo(session, directory, sessionID);
		}

		// Switch to standard (pause lean first if was active)
		const epicCleared: DisableTurboResult = isLeanActive
			? disableTurbo('/swarm turbo on (switching from lean)')
			: { epicCleared: false };
		session.turboMode = true;
		session.turboStrategy = 'standard';
		session.leanTurboActive = false;
		session.leanTurboCurrentPhase = undefined;
		return `Turbo Mode enabled. ${TURBO_BYPASS_DISCLOSURE}${epicAlsoDisabledSuffix(epicCleared)}`;
	}

	// --- turbo standard on ---
	if (arg0 === 'standard' && arg1 === 'on') {
		// Pause lean if was active before switching to standard
		const epicCleared: DisableTurboResult = isLeanActive
			? disableTurbo('/swarm turbo standard on (switching from lean)')
			: { epicCleared: false };
		session.turboMode = true;
		session.turboStrategy = 'standard';
		session.leanTurboActive = false;
		session.leanTurboCurrentPhase = undefined;
		return `Turbo Mode enabled (standard). ${TURBO_BYPASS_DISCLOSURE}${epicAlsoDisabledSuffix(epicCleared)}`;
	}

	// --- turbo standard (no second arg): toggle standard ---
	// #2493 review: the help text and JSDoc advertise `standard [on|off]`,
	// and bare `lean` / bare `epic` both toggle — bare `standard` used to
	// fall through to the unknown-argument rejection instead.
	if (arg0 === 'standard' && arg1 === undefined) {
		const isStandardActive =
			session.turboMode === true && session.turboStrategy === 'standard';
		if (isStandardActive) {
			const epicCleared = disableTurbo('/swarm turbo standard (toggle off)');
			return `Turbo Mode disabled${epicAlsoDisabledSuffix(epicCleared)}`;
		}
		const epicCleared: DisableTurboResult = isLeanActive
			? disableTurbo('/swarm turbo standard (switching from lean)')
			: { epicCleared: false };
		session.turboMode = true;
		session.turboStrategy = 'standard';
		session.leanTurboActive = false;
		session.leanTurboCurrentPhase = undefined;
		return `Turbo Mode enabled (standard). ${TURBO_BYPASS_DISCLOSURE}${epicAlsoDisabledSuffix(epicCleared)}`;
	}

	// --- turbo lean on ---
	if (arg0 === 'lean' && arg1 === 'on') {
		return enableLeanTurbo(session, directory, sessionID);
	}

	// --- turbo lean (no second arg): toggle lean ---
	if (arg0 === 'lean' && arg1 === undefined) {
		if (isLeanActive) {
			// Lean is active → disable
			const epicCleared = disableTurbo('/swarm turbo lean (toggle off)');
			return `Turbo Mode disabled${epicAlsoDisabledSuffix(epicCleared)}`;
		} else {
			// Lean is not active → enable lean
			return enableLeanTurbo(session, directory, sessionID);
		}
	}

	// --- turbo epic on/off: convenience toggle that flips Lean Turbo AND
	// Epic Mode together. Epic Mode auto-decides per-phase parallel-vs-serial
	// and dispatches promoted waves via `Task`; it does not depend on Lean
	// Turbo. `/swarm epic on|off` remains the Epic-only toggle. Epic enabled
	// here is recorded as `enabledVia: 'turbo'` so a later `/swarm turbo off`
	// also turns it off (and says so).
	if (arg0 === 'epic' && arg1 === 'on') {
		return enableTurboEpic();
	}
	if (arg0 === 'epic' && arg1 === 'off') {
		// Explicit epic off: always clear Epic Mode (durable + in-memory),
		// regardless of how it was enabled.
		const r = disableTurbo('/swarm turbo epic off', 'always');
		return r.epicError !== undefined
			? `Turbo Mode disabled${epicAlsoDisabledSuffix(r)}`
			: 'Turbo Mode + Epic Mode disabled';
	}
	if (arg0 === 'epic' && arg1 === undefined) {
		// Bare `/swarm turbo epic` → toggle. Use the in-memory flag as the
		// source of truth (it mirrors the durable SQLite row; the row is the
		// restart authority, but in this process the session flag is what
		// every other check reads).
		if (session.epicModeActive === true) {
			const r = disableTurbo('/swarm turbo epic (toggle off)', 'always');
			return r.epicError !== undefined
				? `Turbo Mode disabled${epicAlsoDisabledSuffix(r)}`
				: 'Turbo Mode + Epic Mode disabled';
		}
		return enableTurboEpic();
	}

	// Unknown argument (issue #2493): reject instead of silently toggling.
	// The legacy fall-through made typos indistinguishable from intentional
	// toggles — `/swarm turbo fast` would flip turbo state with no signal
	// that the argument was never understood. State is left untouched.
	// Report the offending token: when a known mode subcommand (lean/
	// standard/epic) carried a bad second argument, that second token is the
	// unknown one — printing args[0] would name a valid subcommand (#2493).
	const MODE_SUBCOMMANDS = new Set(['lean', 'standard', 'epic']);
	const attempted = stripControlCharacters(
		arg0 !== undefined && MODE_SUBCOMMANDS.has(arg0) && arg1 !== undefined
			? arg1
			: (arg0 ?? ''),
	).slice(0, 100);
	return (
		`Unknown turbo argument "${attempted}". Turbo state is unchanged.\n` +
		'Valid arguments: (none) | on | off | status | lean [on|off] | standard [on|off] | epic [on|off].\n' +
		'Run `/swarm help` for details.'
	);
}

/**
 * Enables Lean Turbo mode for the session.
 * Creates durable run state before flipping session flags (fail-closed pattern).
 */
function enableLeanTurbo(
	session: NonNullable<ReturnType<typeof getAgentSession>>,
	directory: string,
	sessionID: string,
): string {
	let maxParallelCoders = 4;
	let conflictPolicy: 'serialize' | 'degrade' = 'serialize';

	// Read config for lean settings
	try {
		const { config } = _internals.loadPluginConfigWithMeta(directory);
		const leanConfig = config.turbo?.lean;
		if (leanConfig) {
			maxParallelCoders = leanConfig.max_parallel_coders ?? 4;
			conflictPolicy = leanConfig.conflict_policy ?? 'serialize';
		}
	} catch (error) {
		logger.warn(
			`[turbo] could not read lean config: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// Create durable run state FIRST (fail-closed pattern)
	// If this fails, do NOT flip session flags
	let durableError: string | undefined;
	try {
		const state = emptyRunState(sessionID, maxParallelCoders);
		state.status = 'running';
		saveLeanTurboRunState(directory, state);
	} catch (error) {
		durableError = error instanceof Error ? error.message : String(error);
		logger.error(`[turbo] durable run-state write failed: ${durableError}`);
	}

	if (durableError) {
		return [
			'Error: Lean Turbo could NOT be enabled — durable run-state write failed.',
			`Reason: ${durableError}.`,
			'Inspect .swarm/ permissions and disk space, then retry.',
		].join(' ');
	}

	// Check Full-Auto status for reporting
	const fullAutoActive = session.fullAutoMode;

	// Only flip session flags after durable write succeeds
	session.turboMode = true;
	session.turboStrategy = 'lean';
	session.leanTurboActive = true;
	session.leanTurboCurrentPhase = undefined;

	return [
		`Lean Turbo enabled. ${TURBO_BYPASS_DISCLOSURE} ` +
			`Per-lane: reviewer gates and file-lock conflict detection.`,
		`(maxParallelCoders=${maxParallelCoders}, conflict_policy=${conflictPolicy},`,
		`Full-Auto: ${fullAutoActive ? 'active' : 'inactive'})`,
	].join(' ');
}

/**
 * Builds the status message for turbo mode.
 */
function buildStatusMessage(
	session: NonNullable<ReturnType<typeof getAgentSession>>,
	directory: string,
	sessionID: string,
): string {
	if (!session.turboMode) {
		return 'Turbo: off';
	}

	if (session.turboStrategy === 'standard' || !session.leanTurboActive) {
		return 'Turbo: standard (turboMode=true)';
	}

	// Lean Turbo active — load durable state for details
	if (isStateUnreadable(directory)) {
		return [
			'Turbo: lean (turboMode=true, leanTurboActive=true)',
			'WARNING: Durable state is unreadable — cannot report full status.',
		].join('\n');
	}

	const state = loadLeanTurboRunState(directory, sessionID);
	if (!state) {
		return [
			'Turbo: lean (turboMode=true, leanTurboActive=true)',
			'WARNING: Durable state not found.',
		].join('\n');
	}

	const phase =
		state.phase !== undefined ? `phase=${state.phase}` : 'phase=unset';
	const laneCount = state.lanes.length;
	const degradedCount = state.degradedTasks.length;
	const maxParallel = state.maxParallelCoders;
	const fullAutoActive = session.fullAutoMode;

	return [
		`Turbo: lean (turboMode=true, leanTurboActive=true)`,
		`Status: ${state.status}, ${phase}, lanes=${laneCount}, degraded=${degradedCount}`,
		`maxParallelCoders=${maxParallel}, Full-Auto: ${fullAutoActive ? 'active' : 'inactive'}`,
	].join('\n');
}
