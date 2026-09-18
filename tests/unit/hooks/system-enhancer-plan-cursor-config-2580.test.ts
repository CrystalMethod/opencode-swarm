/**
 * plan_cursor config effectiveness on both context paths (#2580).
 *
 * Pins the issue #2580 contract at the repo-suite layer, complementing the
 * issue-tracer frozen checks: the schema-accepted controls (enabled /
 * max_tokens / lookahead_tasks) must reach BOTH system-enhancer context paths
 * (Path A default injection, Path B opt-in scoring candidates) and the context
 * budget report must account for the actually-injected cursor.
 *
 * Edge case ruled out in writing (Full-Resolution Contract clause 4):
 * a dedicated DISCOVER-mode parity test would be vacuous — DISCOVER is
 * returned by detectArchitectMode only when loadPlan yields NO plan, and
 * loadPlan migrates a markdown-only plan.md into a structured Plan, so a
 * workspace in DISCOVER cannot contain a plan.md at all; both paths then skip
 * the cursor by the planContent-null branch regardless of the mode gate. The
 * mode gate on Path B exists for structural parity with Path A.
 *
 * No mock.module: production modules are imported statically and driven with
 * real temp workspaces (system-enhancer-context-budget-wiring precedent).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { extractPlanCursor } from '../../../src/hooks/extractors';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import { estimateTokens } from '../../../src/hooks/utils';
import { getContextBudgetReport } from '../../../src/services/context-budget-service';
import { resetSwarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const PLAN_MD = `# PC2580 Repo regression fixture plan

## Phase 1: Foundation [COMPLETE]
- [x] 1.1: Scaffold the repository layout with a pinned toolchain and a reproducible baseline configuration so every supported host platform builds identically from a clean clone of the source tree
- [x] 1.2: Wire the configuration schema with strict defaults and fail-closed validation so malformed user input surfaces actionable diagnostics instead of silently falling back to unintended runtime behavior
- [x] 1.3: Establish deterministic acceptance harness conventions with isolated per-scenario workspaces so every regression check in this family runs without shared mutable state or wall-clock dependence

## Phase 2: Integration [COMPLETE]
- [x] 2.1: Connect the ledger replay path to the projection writer so derived plan artifacts can never diverge from the authoritative append-only event stream without an explicit recorded reconciliation
- [x] 2.2: Back the checkpoint import and export flows with byte-stable serialization and identity guards so cross-version restores either land exactly or fail loudly with a diagnostic the operator can act on
- [x] 2.3: Normalize artifact path handling across POSIX and Windows hosts so every stored reference resolves identically regardless of the drive layout or separator convention of the machine running the swarm

## Phase 3: Hardening [COMPLETE]
- [x] 3.1: Fuzz the recovery boundary with truncated, poisoned, and reordered ledgers to prove the replay prefix never silently rolls back durable events recorded after the point of corruption
- [x] 3.2: Tighten the write authorization preflight against stale bindings, empty scopes, and cross-session declarations so no child state publishes before an exact active scope correlation passes
- [x] 3.3: Cap every bounded queue, cache, and tracker with explicit eviction policies so long-lived sessions cannot grow memory usage without an observable and documented limit being reached

## Phase 4: Delivery [IN PROGRESS]
- [ ] 4.1: Implement the regression suite pinning the cursor contract across both context injection paths end to end using deterministic fixtures and fresh isolated workspaces per scenario
- [ ] 4.2: Align the context budget report so its plan cursor accounting reflects the exact injected cursor content instead of a bespoke approximation nobody consumes at runtime
- [ ] 4.3: Keep documentation honest about the disabled-cursor fallback instead of claiming the entire plan markdown is injected
- [ ] 4.4: Ship the release fragment so the plan_cursor tuning knobs are discoverable alongside the existing context budget controls

## Phase 5: Verification [PENDING]
- [ ] 5.1: Run the regression suite on every supported platform and record the per-check verdicts

## Phase 6: Release [PENDING]
- [ ] 6.1: Publish the fixed build and confirm the suite stays green through the merge queue
`;

const VALID_PLAN_JSON = JSON.stringify({
	schema_version: '1.0.0',
	swarm: 'pc2580-repo',
	title: 'Repo Regression Plan',
	current_phase: 1,
	phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
});

interface PlanCursorCfg {
	enabled?: boolean;
	max_tokens?: number;
	lookahead_tasks?: number;
}

function pathAConfig(planCursor?: PlanCursorCfg): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		...(planCursor ? { plan_cursor: planCursor } : {}),
	} as PluginConfig;
}

function pathBConfig(planCursor?: PlanCursorCfg): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		context_budget: { scoring: { enabled: true } },
		...(planCursor ? { plan_cursor: planCursor } : {}),
	} as PluginConfig;
}

async function runEnhancer(
	config: PluginConfig,
	dir: string,
	sessionID: string,
): Promise<string[]> {
	resetSwarmState();
	const hook = createSystemEnhancerHook(config, dir, {
		surface: 'messages',
	});
	const transform = hook['experimental.chat.system.transform'] as unknown as (
		input: { sessionID: string },
		output: { system: string[] },
	) => Promise<void>;
	const output = { system: [] as string[] };
	await transform({ sessionID }, output);
	resetSwarmState();
	return output.system;
}

async function makeWorkspace(withValidPlanJson = false): Promise<string> {
	const dir = canonicalMkdtemp('pc2580-repo-');
	await mkdir(join(dir, '.swarm'), { recursive: true });
	await writeFile(join(dir, '.swarm', 'plan.md'), PLAN_MD, 'utf8');
	if (withValidPlanJson) {
		await writeFile(join(dir, '.swarm', 'plan.json'), VALID_PLAN_JSON, 'utf8');
	}
	return dir;
}

async function withFreshRun(
	config: PluginConfig,
	sessionID: string,
	withValidPlanJson: boolean,
	body: (system: string[]) => Promise<void>,
): Promise<void> {
	const dir = await makeWorkspace(withValidPlanJson);
	try {
		await body(await runEnhancer(config, dir, sessionID));
	} finally {
		// Best-effort: the hook can hold a handle on Windows until process
		// exit; a leaked tmp dir never affects verdicts.
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

const CURSOR_OPEN = '[SWARM PLAN CURSOR]';
const CURSOR_CLOSE = '[/SWARM PLAN CURSOR]';

function cursorBlock(system: string[]): string | null {
	const joined = system.join('\n');
	const start = joined.indexOf(CURSOR_OPEN);
	const end = joined.indexOf(CURSOR_CLOSE);
	if (start === -1 || end === -1 || end < start) return null;
	return joined.slice(start, end + CURSOR_CLOSE.length);
}

describe('system-enhancer plan_cursor config (#2580) — Path A (non-scoring)', () => {
	it('injects the cursor with default config (unchanged behavior)', async () => {
		await withFreshRun(pathAConfig(), 'a-default', false, async (system) => {
			expect(cursorBlock(system)).toContain(CURSOR_OPEN);
			expect(system.join('\n')).toContain('[SWARM CONTEXT] Phase:');
		});
	});

	it('suppresses the cursor when enabled:false while keeping the phase header', async () => {
		await withFreshRun(
			pathAConfig({ enabled: false }),
			'a-disabled',
			false,
			async (system) => {
				expect(cursorBlock(system)).toBeNull();
				expect(system.join('\n')).toContain('[SWARM CONTEXT] Phase:');
			},
		);
	});

	it('honors lookahead_tasks (0 differs from default 2)', async () => {
		await withFreshRun(pathAConfig(), 'a-la-default', false, async (def) => {
			await withFreshRun(
				pathAConfig({ lookahead_tasks: 0 }),
				'a-la-zero',
				false,
				async (zero) => {
					const defBlock = cursorBlock(def);
					const zeroBlock = cursorBlock(zero);
					expect(defBlock).not.toBeNull();
					expect(zeroBlock).not.toBeNull();
					expect(zeroBlock).not.toBe(defBlock);
				},
			);
		});
	});

	it('honors max_tokens (500 compacts below 1500)', async () => {
		await withFreshRun(pathAConfig(), 'a-mt-default', false, async (def) => {
			await withFreshRun(
				pathAConfig({ max_tokens: 500 }),
				'a-mt-500',
				false,
				async (small) => {
					const defBlock = cursorBlock(def);
					const smallBlock = cursorBlock(small);
					expect(defBlock).not.toBeNull();
					expect(smallBlock).not.toBeNull();
					expect(smallBlock!.length).toBeLessThan(defBlock!.length);
				},
			);
		});
	});
});

describe('system-enhancer plan_cursor config (#2580) — Path B (scoring)', () => {
	it('injects the cursor candidate with default config (markdown fallback workspace)', async () => {
		await withFreshRun(pathBConfig(), 'b-default', false, async (system) => {
			expect(cursorBlock(system)).toContain(CURSOR_OPEN);
		});
	});

	it('injects the cursor candidate even with a valid structured plan.json (dead else-branch fix)', async () => {
		await withFreshRun(pathBConfig(), 'b-planjson', true, async (system) => {
			expect(cursorBlock(system)).toContain(CURSOR_OPEN);
		});
	});

	it('suppresses the cursor candidate when enabled:false while keeping the phase candidate', async () => {
		await withFreshRun(
			pathBConfig({ enabled: false }),
			'b-disabled',
			false,
			async (system) => {
				expect(cursorBlock(system)).toBeNull();
				expect(system.join('\n')).toContain('[SWARM CONTEXT] Current phase:');
			},
		);
	});

	it('honors lookahead_tasks (0 differs from default 2)', async () => {
		await withFreshRun(pathBConfig(), 'b-la-default', false, async (def) => {
			await withFreshRun(
				pathBConfig({ lookahead_tasks: 0 }),
				'b-la-zero',
				false,
				async (zero) => {
					const defBlock = cursorBlock(def);
					const zeroBlock = cursorBlock(zero);
					expect(defBlock).not.toBeNull();
					expect(zeroBlock).not.toBeNull();
					expect(zeroBlock).not.toBe(defBlock);
				},
			);
		});
	});

	it('honors max_tokens (500 compacts below 1500)', async () => {
		await withFreshRun(pathBConfig(), 'b-mt-default', false, async (def) => {
			await withFreshRun(
				pathBConfig({ max_tokens: 500 }),
				'b-mt-500',
				false,
				async (small) => {
					const defBlock = cursorBlock(def);
					const smallBlock = cursorBlock(small);
					expect(defBlock).not.toBeNull();
					expect(smallBlock).not.toBeNull();
					expect(smallBlock!.length).toBeLessThan(defBlock!.length);
				},
			);
		});
	});
});

describe('context budget report plan-cursor accounting (#2580)', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await makeWorkspace(false);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	});

	const budgetConfig = {
		budgetTokens: 100_000,
		warningPct: 70,
		criticalPct: 90,
	} as Parameters<typeof getContextBudgetReport>[2];

	it('reports exactly 0 planCursorTokens when the cursor is disabled', async () => {
		const report = await getContextBudgetReport(
			dir,
			'x'.repeat(300),
			budgetConfig,
			{ enabled: false, max_tokens: 1500, lookahead_tasks: 2 },
		);
		expect(report.planCursorTokens).toBe(0);
	});

	it('accounts for the actual cursor with default controls (canonical estimator)', async () => {
		const report = await getContextBudgetReport(
			dir,
			'x'.repeat(300),
			budgetConfig,
			{ enabled: true, max_tokens: 1500, lookahead_tasks: 2 },
		);
		expect(report.planCursorTokens).toBe(
			estimateTokens(extractPlanCursor(PLAN_MD)),
		);
	});

	it('still works without the 4th argument (backward-compatible signature)', async () => {
		const report = await getContextBudgetReport(
			dir,
			'x'.repeat(300),
			budgetConfig,
		);
		expect(report.planCursorTokens).toBe(
			estimateTokens(extractPlanCursor(PLAN_MD)),
		);
		expect(report.planCursorTokens).toBeGreaterThan(0);
	});
});
