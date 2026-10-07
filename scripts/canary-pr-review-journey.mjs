#!/usr/bin/env node
/**
 * canary-pr-review-journey.mjs — canary for the PR-REVIEW journey
 * (issue #2586 AC6, R20 runtime floor). Mirrors the #2666 execute-journey
 * canary contract (scripts/canary-execute-journey.mjs): refusal /
 * typed-failure / deterministic legs with bounded, typed exit codes, and a
 * structural separation that makes it impossible for deterministic output
 * to masquerade as model-backed canary evidence.
 *
 * Exit contract (bounded and typed — a mock can NEVER masquerade as model
 * quality):
 *   0   --deterministic leg completed (every structural step OK)
 *   1   --deterministic leg failed (a FAIL line names the step)
 *   3   REFUSAL — SWARM_PR_REVIEW_JOURNEY_CANARY unset
 *   4   UNAVAILABLE — gate set but no verified live transport (never a
 *         synthetic success)
 *   5   LIVE-NOT-IMPLEMENTED — gate set + live server verified, but the
 *         model-backed leg is an operator-initiated stub in this matrix;
 *         it refuses to fabricate canary evidence (honest labeling)
 *
 * Live transport is required EXPLICITLY: SWARM_PR_REVIEW_JOURNEY_CANARY=1
 * plus SWARM_PR_REVIEW_JOURNEY_CANARY_SERVER (or OPENCODE_SERVER_URL). A
 * project config file is NOT transport evidence.
 *
 * The deterministic leg is offline structural evidence only — it never
 * claims model quality: it builds/loads the REAL shipped bundle
 * (dist/index.js) under the Node ESM loader (the repro-1873 / repro-704
 * Node-sidecar precedents), asserts the v1 plugin shape { id, server }, and
 * asserts server() exposes the full PR-review controller tool surface.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GATE_ENV = 'SWARM_PR_REVIEW_JOURNEY_CANARY';
const EXIT_DETERMINISTIC_FAIL = 1;
const EXIT_REFUSAL = 3;
const EXIT_UNAVAILABLE = 4;
const EXIT_LIVE_NOT_IMPLEMENTED = 5;

// PR-review journey controller tools, journey order — exact TOOL_METADATA names (verified, not guessed).
const PR_REVIEW_CONTROLLER_TOOLS = [
	'dispatch_lanes_async',
	'collect_lane_results',
	'retrieve_lane_output',
	'parse_lane_candidates',
	'write_pr_review_artifact',
	'write_pr_review_trigger_eval',
	'submit_pr_review_result',
	'complete_pr_workflow',
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = path.join(repoRoot, 'dist', 'index.js');

function refuse(reason) {
	process.stderr.write(`[canary] REFUSAL: ${reason}\n`);
	process.exit(EXIT_REFUSAL);
}
function unavailable(message) {
	process.stderr.write(`[canary] TRANSPORT-UNAVAILABLE: ${message}\n`);
	process.exit(EXIT_UNAVAILABLE);
}

if (!process.argv.slice(2).includes('--deterministic')) {
	if (process.env[GATE_ENV] !== '1') {
		refuse(
			`${GATE_ENV} unset; refusing to run the PR-review journey canary. The live leg needs ` +
				`${GATE_ENV}=1 PLUS an explicit live server URL env SWARM_PR_REVIEW_JOURNEY_CANARY_SERVER ` +
				`(or OPENCODE_SERVER_URL) — a project config file is NOT transport evidence. For the offline ` +
				`structural leg run: node scripts/canary-pr-review-journey.mjs --deterministic`,
		);
	}
	const serverUrlRaw =
		process.env.SWARM_PR_REVIEW_JOURNEY_CANARY_SERVER ??
		process.env.OPENCODE_SERVER_URL ??
		null;
	if (!serverUrlRaw) {
		unavailable(
			'no live model transport configured: set SWARM_PR_REVIEW_JOURNEY_CANARY_SERVER (or OPENCODE_SERVER_URL). A project config file is not transport evidence.',
		);
	}
	if (!/^https?:\/\//i.test(serverUrlRaw)) {
		unavailable(
			`live server URL must use http(s): got ${serverUrlRaw}`,
		);
	}
	const serverUrl = serverUrlRaw.replace(/\/+$/, '');

	// ---- Verify the live server is actually reachable (bounded) -------------
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10_000);
		const probe = await fetch(`${serverUrl}/doc`, { signal: controller.signal });
		clearTimeout(timer);
		if (!probe.ok) {
			unavailable(`live server probe returned HTTP ${probe.status} for ${serverUrl}/doc`);
		}
	} catch (error) {
		unavailable(
			`live server unreachable at ${serverUrl}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// ---- Live leg: operator-initiated stub (honest labeling, exit 5) --------
	// A real live leg would drive a model round-trip through the full PR-review
	// controller chain (dispatch → collect → retrieve → parse → artifact →
	// eval → submit → complete) against the verified server. A synthetic pass
	// would fabricate canary evidence.
	process.stderr.write(
		`[canary] LIVE-NOT-IMPLEMENTED: live transport verified at ${serverUrl}, but the live PR-review ` +
			`journey leg requires an operator-driven run; refusing to fabricate model-backed canary evidence — ` +
			`not implemented in this matrix; see docs/testing/pr-review-matrix.md\n`,
	);
	process.exit(EXIT_LIVE_NOT_IMPLEMENTED);
}

// ---- Deterministic leg (offline, structural; exit 0 / 1) ------------------
class StepFailure extends Error {
	constructor(step, message) {
		super(message);
		this.step = step;
	}
}
async function step(name, fn) {
	try {
		const detail = await fn();
		process.stdout.write(`[canary] OK ${name}${detail ? ` — ${detail}` : ''}\n`);
	} catch (error) {
		throw new StepFailure(name, error instanceof Error ? error.message : String(error));
	}
}

// Bounded, array-form, killable `bun run build` (AGENTS.md invariant 3):
// explicit cwd, stdin ignored, timeout, bounded output, best-effort kill on
// the error path (spawn's timeout covers the hang path and always fires
// `close`, which settles this promise).
function buildDist() {
	return new Promise((resolve, reject) => {
		const child = spawn('bun', ['run', 'build'], {
			cwd: repoRoot,
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 180_000,
			killSignal: 'SIGKILL',
			windowsHide: true,
			env: { ...process.env },
		});
		let output = '';
		const capture = (chunk) => {
			if (output.length < 20_000) output += String(chunk);
		};
		child.stdout?.on('data', capture);
		child.stderr?.on('data', capture);
		child.on('error', (err) => {
			try {
				child.kill();
			} catch {
				/* best-effort kill */
			}
			reject(err);
		});
		child.on('close', (code) => {
			if (code === 0 && existsSync(distEntry)) resolve();
			else reject(new Error(`bun run build failed (exit=${String(code)}): ${output.slice(-1_500)}`));
		});
	});
}

// Env isolation (repro-704 precedent): the plugin reads HOME / USERPROFILE /
// XDG_CONFIG_HOME live — point them at a disposable dir so this leg never
// touches real user config or global state.
const savedEnv = new Map(
	['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME'].map((key) => [key, process.env[key]]),
);
const isolatedHome = mkdtempSync(path.join(tmpdir(), 'swarm-canary-pr-home-'));
const workspaces = [];
let exitCode = EXIT_DETERMINISTIC_FAIL;

try {
	process.env.HOME = isolatedHome;
	process.env.USERPROFILE = isolatedHome;
	process.env.XDG_CONFIG_HOME = path.join(isolatedHome, '.config');
	mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });

	await step('dist/index.js present (bounded `bun run build` if absent)', async () => {
		if (existsSync(distEntry)) return 'already present — build skipped';
		await buildDist();
		return 'built via bounded spawn (timeout 180000ms)';
	});

	let mod;
	await step('dist/index.js imports under the Node ESM loader', async () => {
		mod = await import(pathToFileURL(distEntry).href);
		if (!mod || typeof mod !== 'object') throw new Error('import did not return a module object');
	});

	const plugin = mod?.default;
	await step('default export is the v1 plugin shape { id, server }', async () => {
		if (typeof plugin !== 'object' || plugin === null)
			throw new Error(`default export is ${typeof plugin}, expected an object`);
		if (typeof plugin.id !== 'string' || plugin.id.length === 0)
			throw new Error('plugin.id is not a non-empty string');
		if (typeof plugin.server !== 'function')
			throw new Error('plugin.server is not a function');
	});

	await step('server() exposes ALL PR-review controller tools', async () => {
		const workspace = mkdtempSync(path.join(tmpdir(), 'swarm-canary-pr-ws-'));
		workspaces.push(workspace);
		// Independent root (invariant 4): an empty `.git` FILE marker makes the
		// temp workspace its own project root, so runtime state (.swarm/,
		// advisories) stays inside the workspace we dispose — never the user's
		// home when tmpdir() nests under it (e.g. %LOCALAPPDATA%\\Temp).
		writeFileSync(path.join(workspace, '.git'), '');
		// The repro-704 ctx shape (CI-proven under Node): a disposable
		// workspace so any runtime .swarm/ writes stay out of this repo.
		const ctx = {
			directory: workspace,
			project: { id: 'canary-pr-review', root: workspace },
			worktree: { directory: workspace },
			client: { app: {}, config: { get: async () => ({}) } },
			experimental_workspace: { register() {} },
			get serverUrl() {
				return new URL('http://localhost:4096');
			},
			$: undefined,
		};
		const hooks = await plugin.server(ctx, {});
		const tools = hooks?.tool;
		if (!tools || typeof tools !== 'object') throw new Error('server() resolved without a tool map');
		const missing = PR_REVIEW_CONTROLLER_TOOLS.filter(
			(name) => typeof tools[name]?.execute !== 'function',
		);
		if (missing.length > 0)
			throw new Error(`missing from the server() tool map: ${missing.join(', ')}`);
		return `${PR_REVIEW_CONTROLLER_TOOLS.length}/${PR_REVIEW_CONTROLLER_TOOLS.length} controller tools registered with execute()`;
	});

	process.stdout.write('deterministic leg: OK\n');
	exitCode = 0;
} catch (error) {
	if (error instanceof StepFailure) {
		process.stderr.write(`[canary] FAIL ${error.step} — ${error.message}\n`);
	} else {
		process.stderr.write(
			`[canary] FAIL deterministic leg (uncaught) — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
		);
	}
} finally {
	// Cleanup runs here, and process.exit(exitCode) below fires only AFTER this
	// finally completes — the gated legs above exit(3/4/5) before this block is
	// ever entered, so nothing here is skipped (the #2666 ordering note).
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const dir of [...workspaces, isolatedHome]) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		} catch {
			/* disposable temp dirs; best-effort cleanup */
		}
	}
}
process.exit(exitCode);
