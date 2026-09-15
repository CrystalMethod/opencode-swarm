/**
 * j08 — restart preserves tightened runtime policy and reconciles interrupted
 * work (issue #2668, Workstream D slot D15). Boot A drives the journey
 * through approve, tightens the session QA policy through the real
 * `/swarm qa-gates override` command, marks the session mid-execution, and
 * flushes the durable snapshot. The process then "dies" — in this in-process
 * fixture the module-level swarmState singleton is reset via
 * resetSwarmStatePreservingSingletons() (the same disclosed j04 pattern; a
 * real second OS process runs the identical hydration path because every
 * server() boot runs loadSnapshotForInit → rehydrateState).
 *
 * Boot B boots a fresh server() over the same project and proves through
 * REGISTERED surfaces only: the durable plan profile survived; the tightened
 * policy survived (get_qa_gate_profile reports effective mutation_test=true);
 * the interrupted execution reconciled to an owner-named unknown-classified
 * record; and the ephemeral authority expired.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { handleQaGatesCommand } from '../../../src/commands/qa-gates.js';
import { getProfileLookupForIdentity } from '../../../src/db/qa-gate-profile.js';
import {
	RESTART_RECONCILIATION_FILE,
	readRestartReconciliation,
} from '../../../src/session/restart-reconciliation.js';
import { flushPendingSnapshot } from '../../../src/session/snapshot-writer.js';
import {
	getAgentSession,
	resetSwarmState,
	resetSwarmStatePreservingSingletons,
} from '../../../src/state';
import {
	bootJourneyHost,
	createJourneyProject,
	JourneyDriver,
	journeyPlanArgs,
	parseToolResult,
} from '../../helpers/execute-journey-driver';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';

const TASK_ID = '1.1';
const FILE = 'src/feature.ts';

describe('restart preserves tightened runtime policy through the registered host (#2668)', () => {
	let project: ReturnType<typeof createJourneyProject> | null = null;
	let cleanupEnv: (() => void) | null = null;

	beforeEach(() => {
		cleanupEnv = createIsolatedTestEnv().cleanup;
		resetSwarmState();
	});
	afterEach(() => {
		resetSwarmState();
		cleanupEnv?.();
		cleanupEnv = null;
		project?.cleanup();
		project = null;
	});

	test('boot B preserves the tightened policy and reconciles the interrupted execution', async () => {
		// ---- Boot A: journey to an approved plan, tighten, die mid-execution.
		project = createJourneyProject('swarm-j08-');
		const bootA = await bootJourneyHost({ directory: project.directory });
		const driverA = new JourneyDriver(bootA);
		await driverA.configure();
		await driverA.specify(journeyPlanArgs({ taskId: TASK_ID, file: FILE }));
		await driverA.approve('journey fixture j08 approval');

		// Tighten through the real operator command (durable-first write).
		const tighten = await handleQaGatesCommand(
			project.directory,
			['override', 'mutation_test'],
			driverA.sessionID,
		);
		expect(tighten).toContain('Session overrides updated');

		// Mark the session mid-execution and flush the durable snapshot so the
		// death boundary carries in-flight authority (serialized
		// delegationActive=true).
		const sessionA = getAgentSession(driverA.sessionID);
		expect(sessionA).toBeDefined();
		sessionA!.delegationActive = true;
		sessionA!.currentTaskId = TASK_ID;
		await flushPendingSnapshot(project.directory);

		// Simulated process death (disclosed limitation above).
		resetSwarmStatePreservingSingletons();

		// ---- Boot B: fresh server() over the same durable artifacts.
		const bootB = await bootJourneyHost({ directory: project.directory });
		const driverB = new JourneyDriver(bootB);
		await driverB.configure();

		// (a) Durable plan profile survived (spec-level mutation_test still
		// off — the override is session policy, not a profile mutation).
		const planJson = JSON.parse(
			readFileSync(path.join(project.directory, '.swarm', 'plan.json'), 'utf8'),
		) as { swarm: string; title: string };
		const lookup = getProfileLookupForIdentity(project.directory, planJson);
		expect(lookup.kind).toBe('bound');
		expect(lookup.profile.gates.mutation_test).toBe(false);

		// (b) Tightened policy survived: the REGISTERED tool reports effective
		// gates merged with the calling session's restored overrides.
		const raw = await bootB.host.tool.get_qa_gate_profile.execute(
			{},
			{
				directory: project.directory,
				sessionID: driverB.sessionID,
			},
		);
		const profileResult = parseToolResult(raw);
		expect(profileResult.success).toBe(true);
		expect(profileResult.effective_gates).toBeDefined();
		expect(
			(profileResult.effective_gates as Record<string, boolean>).mutation_test,
		).toBe(true);

		// (c) Interrupted execution reconciled owner-named on the durable
		// surface; the ephemeral authority itself expired.
		const artifact = path.join(
			project.directory,
			'.swarm',
			RESTART_RECONCILIATION_FILE,
		);
		expect(existsSync(artifact)).toBe(true);
		const file = readRestartReconciliation(project.directory);
		expect(file.entries.length).toBeGreaterThanOrEqual(1);
		const entry = file.entries.find(
			(e) => e.taskId === TASK_ID && e.classification === 'interrupted',
		);
		expect(entry).toBeDefined();
		expect(entry!.agentName).toBe('architect');
		const sessionB = getAgentSession(driverB.sessionID);
		expect(sessionB?.delegationActive).toBe(false);
	});
});
