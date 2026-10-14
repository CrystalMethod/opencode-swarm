/**
 * Issue #3199 acceptance check C7 (defect-class guardrail for the third
 * writer). `appendPrWorkflowSkillContractAdvisories` is the same
 * observability-only append class as the two rejection journals: it must not
 * advance the durable gate `revision` (which the write CAS compares), and its
 * advisories must survive a concurrent state write from a fresh read.
 *
 * AC1 (class-level): an advisory journal write leaves the durable revision
 * unchanged while the advisory persists durably. RED at base, GREEN after
 * the fix.
 * AC3 (class-level): advisories survive a concurrent state write issued from
 * a fresh read. GREEN at base, must stay GREEN after the fix.
 *
 * Seeding pattern: hand-written legacy gate-state JSON (imported into the
 * SQLite coordination row on the first read), matching
 * tests/unit/pr-review/journal-revision-cas-3199.test.ts.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	appendPrWorkflowSkillContractAdvisories,
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { writeStateWhileLocked } from '../../../src/pr-review/persistence.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = '2026-10-13T00:00:00.000Z';
const tempDirs: string[] = [];

function freshProject(prefix: string): string {
	const directory = canonicalMkdtemp(`sw3199-${prefix}-`);
	tempDirs.push(directory);
	mkdirSync(join(directory, '.git'), { recursive: true });
	return directory;
}

function seedGateState(directory: string, session: string): void {
	const stateFile = join(
		directory,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(session)}.json`,
	);
	mkdirSync(dirname(stateFile), { recursive: true });
	writeFileSync(
		stateFile,
		JSON.stringify({
			schemaVersion: 1,
			revision: 0,
			sessionID: session,
			mode: 'PR_REVIEW',
			activatedAt: NOW,
			updatedAt: NOW,
		}),
		'utf8',
	);
}

afterEach(() => {
	closeAllProjectDbs();
	for (const directory of tempDirs.splice(0)) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Windows: the SQLite WAL may briefly hold the temp dir; best-effort.
		}
	}
});

test('an advisory journal write does not advance the durable gate revision', async () => {
	const directory = freshProject('advisory-rev');
	const session = 'session-3199-advisory-rev';
	seedGateState(directory, session);
	const before = await readPrWorkflowGateState(directory, session);
	expect(before).not.toBeNull();
	await appendPrWorkflowSkillContractAdvisories(directory, session, [
		'3199 advisory append must not bump the revision',
	]);
	const after = await readPrWorkflowGateState(directory, session);
	// RED at base (the advisory write bumps 0 -> 1); GREEN after the fix.
	expect(after?.revision).toBe(before?.revision);
	// The advisory itself must persist durably (disk-authoritative read).
	expect(after?.skillContractAdvisories).toContain(
		'3199 advisory append must not bump the revision',
	);
});

test('advisories survive a concurrent state write from a fresh read', async () => {
	const directory = freshProject('advisory-preserve');
	const session = 'session-3199-advisory-preserve';
	seedGateState(directory, session);
	await appendPrWorkflowSkillContractAdvisories(directory, session, [
		'3199 advisory preserved across a fresh-read write',
	]);
	const fresh = await readPrWorkflowGateState(directory, session);
	expect(fresh?.skillContractAdvisories?.length ?? 0).toBeGreaterThanOrEqual(1);
	await writeStateWhileLocked(directory, {
		...fresh!,
		updatedAt: NOW,
	});
	const post = await readPrWorkflowGateState(directory, session);
	expect(post?.revision).toBe(fresh!.revision + 1);
	expect(post?.skillContractAdvisories).toContain(
		'3199 advisory preserved across a fresh-read write',
	);
});
