#!/usr/bin/env node
/**
 * canary-execute-journey.mjs — MODEL-BACKED canary for the normal EXECUTE
 * journey (issue #2666, AC6). Structurally SEPARATE from the deterministic
 * fixture family (tests/unit/execute-journey/): this entry drives a real
 * model round-trip through the plugin's host transport (a live lane
 * dispatch via the OpenCode server SDK) and writes a canary report
 * (fixture_class: 'model-canary', transport: 'live-model') that
 * deterministic reports can never satisfy (validateCanaryEvidence rejects
 * them by construction).
 *
 * Exit contract (bounded and typed — a mock can NEVER masquerade as model
 * quality):
 *   0                     live-model journey completed; canary report written
 *   3 (REFUSAL)           SWARM_EXECUTE_JOURNEY_CANARY unset
 *   4 (UNAVAILABLE)       gate set but no verified live transport, or the
 *                         live leg failed. NEVER a synthetic success.
 *
 * Live transport is required EXPLICITLY: SWARM_EXECUTE_JOURNEY_CANARY_SERVER
 * (or OPENCODE_SERVER_URL). A project config file is NOT transport evidence.
 * The live leg requires bun (it imports the repo's TS driver); under node
 * this script is evidence for the refusal/unavailable paths only — that is
 * the Node-cell claim recorded in docs/testing/execute-journey.md.
 *
 * Runs under both bun and node (plain .mjs; SDK imported lazily in the live
 * path only). Subprocess hygiene per AGENTS.md invariant 3.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const GATE_ENV = 'SWARM_EXECUTE_JOURNEY_CANARY';
const EXIT_REFUSAL = 3;
const EXIT_UNAVAILABLE = 4;

function refuse(reason) {
	process.stderr.write(`[canary] REFUSAL: ${reason}\n`);
	process.exit(EXIT_REFUSAL);
}
function unavailable(message) {
	process.stderr.write(`[canary] TRANSPORT-UNAVAILABLE: ${message}\n`);
	process.exit(EXIT_UNAVAILABLE);
}

if (process.env[GATE_ENV] !== '1') {
	refuse(
		`${GATE_ENV} unset; refusing to run model-backed journey (set ${GATE_ENV}=1 to enable the canary)`,
	);
}

const serverUrlRaw =
	process.env.SWARM_EXECUTE_JOURNEY_CANARY_SERVER ??
	process.env.OPENCODE_SERVER_URL ??
	null;
if (!serverUrlRaw) {
	unavailable(
		`no live model transport configured: set SWARM_EXECUTE_JOURNEY_CANARY_SERVER (or OPENCODE_SERVER_URL). A project config file is not transport evidence.`,
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

// ---- The live leg needs bun (repo TS driver import) ---------------------
const isBun = String(process.versions.bun ?? '') !== '';
if (!isBun) {
	unavailable(
		'the live-model leg requires bun (repo TS driver); run `bun scripts/canary-execute-journey.mjs`. The node invocation of this script is evidence for the refusal/unavailable paths only.',
	);
}

const repoRoot = path.resolve(import.meta.dirname, '..');
const driverPath = path.join(repoRoot, 'tests', 'helpers', 'execute-journey-driver.ts');
if (!existsSync(driverPath)) {
	unavailable('journey driver not found (tests/helpers/execute-journey-driver.ts)');
}

// The leg boots the REAL plugin with a LIVE client backed by the OpenCode
// server SDK, drives configure → specify → approve → a LIVE explorer lane
// dispatch (an actual model round-trip through session.prompt), and writes
// the canary report. Any live-call failure exits nonzero — never synthetic
// success.
const legSource = `
import { createOpencodeClient } from '@opencode-ai/sdk';
import { bootJourneyHost, createJourneyProject, JourneyDriver, journeyPlanArgs, parseToolResult } from '${driverPath.replace(/\\/g, '/')}';

const serverUrl = ${JSON.stringify(serverUrl)};
const sdk = createOpencodeClient({ baseUrl: serverUrl });

// LIVE host client: the same surface the scripted client implements, but
// every call goes to the real OpenCode server (and the lane prompt is a
// real model round-trip). The calls property mirrors ScriptedHostClient's
// recording seam — JourneyDriver.report() reads client.calls, so the live
// client must expose the same shape or the canary report can never be
// written.
const liveCalls = [];
const client = {
  // The calls getter is live-backed over liveCalls: JourneyDriver.report()
  // reads client.calls, so the live client must expose the same recording
  // seam as ScriptedHostClient or the canary report can never be written.
  get calls() {
    return liveCalls.map((surface) => ({ surface, detail: {}, at: '' }));
  },
  session: {
    create: async (input) => {
      const res = await sdk.session.create({ body: input ?? {} });
      liveCalls.push('session.create');
      return res;
    },
    promptAsync: async (input) => {
      const res = await sdk.session.prompt({ body: input?.body ?? {}, path: input?.path ?? {} });
      liveCalls.push('session.promptAsync');
      return res;
    },
    abort: async (input) => {
      const res = await sdk.session.abort?.({ path: input?.path ?? {} }) ?? { data: undefined };
      liveCalls.push('session.abort');
      return res;
    },
    messages: async (input) => {
      const res = await sdk.session.messages({ path: input?.path ?? {}, query: input?.query ?? {} });
      liveCalls.push('session.messages');
      return res;
    },
  },
};

const project = createJourneyProject('canary-live-');
const booted = await bootJourneyHost({ directory: project.directory, client });
const driver = new JourneyDriver(booted);
await driver.configure();
await driver.specify(journeyPlanArgs());
await driver.approve('model canary: plan-critic approval');

// LIVE model round-trip: the lane dispatch goes through session.prompt on
// the real server. A model failure here fails the canary.
const dispatch = parseToolResult(
  await booted.host.tool.dispatch_lanes_async.execute(
    {
      batch_id: 'canary-live-lane',
      mode: 'journey-model-canary',
      max_concurrent: 1,
      lanes: [{ id: 'canary-1', agent: 'explorer', prompt: 'Reply with the single word: ok' }],
    },
    { directory: project.directory, sessionID: driver.sessionID },
  ),
);
if (dispatch.success !== true) {
  console.error('[canary] live lane dispatch failed: ' + JSON.stringify(dispatch).slice(0, 400));
  process.exit(4);
}
if (!liveCalls.includes('session.create') || !liveCalls.includes('session.promptAsync')) {
  console.error('[canary] LIVE VIOLATION: the lane did not go through the live transport');
  process.exit(4);
}

const reportFile = await driver.writeReport({ command: 'canary-execute-journey (live)', kind: 'canary' });
console.log('CANARY_REPORT=' + reportFile);
console.log('LIVE_CALLS=' + liveCalls.join(','));
project.cleanup();
`;

// Collision-safe temp entry (mkdtemp), removed with the parent's finally.
const tmpDir = mkdtempSync(path.join(tmpdir(), 'swarm-canary-'));
const entryFile = path.join(tmpDir, 'canary-leg.mts');
writeFileSync(entryFile, legSource);

const child = spawn(process.execPath, ['run', entryFile], {
	cwd: repoRoot,
	stdio: ['ignore', 'pipe', 'pipe'],
	timeout: 300_000,
	windowsHide: true,
	env: { ...process.env },
});

let output = '';
child.stdout?.on('data', (chunk) => {
	if (output.length < 60_000) output += String(chunk);
});
child.stderr?.on('data', (chunk) => {
	if (output.length < 60_000) output += String(chunk);
});

// Cleanup runs BEFORE exit: process.exit() skips finally blocks, so the
// exit decision is captured and executed after the cleanup block.
let exitCode = 0;
let exitMessage = '';
try {
	const [code, signal] = await new Promise((resolve, reject) => {
		child.on('error', reject);
		child.on('close', (c, s) => resolve([c, s]));
	});
	if (code === 0) {
		const reportMatch = /CANARY_REPORT=(.*)/.exec(output);
		const callsMatch = /LIVE_CALLS=(.*)/.exec(output);
		exitMessage = `[canary] OK live-model journey completed (live calls: ${callsMatch?.[1]?.trim() ?? 'n/a'}); report: ${reportMatch?.[1]?.trim() ?? 'written under the fixture .swarm/journey/'}\n`;
	} else {
		exitCode = EXIT_UNAVAILABLE;
		process.stderr.write(
			`[canary] TRANSPORT-UNAVAILABLE: live-model journey failed (exit=${String(code)} signal=${String(signal)})\n${output.slice(-2_000)}\n`,
		);
	}
} catch (spawnError) {
	exitCode = EXIT_UNAVAILABLE;
	process.stderr.write(
		`[canary] TRANSPORT-UNAVAILABLE: live leg could not run: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}\n`,
	);
} finally {
	try {
		child.kill();
	} catch {
		/* best-effort kill */
	}
	try {
		rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch {
		/* disposable operator temp; best-effort cleanup */
	}
}
if (exitMessage) process.stdout.write(exitMessage);
process.exit(exitCode);
