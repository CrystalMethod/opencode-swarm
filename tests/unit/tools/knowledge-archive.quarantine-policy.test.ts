/**
 * #2950: knowledge_archive quarantine truthfully reports cohort-safety
 * denials (and not-found) instead of an unconditional success.
 *
 * Cohort-linkedness is simulated via the SANCTIONED curation-policy
 * `_internals` DI seam exactly as the F-03 test does — NO `mock.module`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import { resolveKnowledgeStoreDir } from '../../../src/hooks/knowledge-link';
import {
	appendKnowledge,
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { _internals as policyInternals } from '../../../src/knowledge/curation-policy';
import { knowledge_archive } from '../../../src/tools/knowledge-archive';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { makeCtx, makeSwarmEntry } from './_knowledge-archive-helpers';

function crossOwnedEntry(id: string): SwarmKnowledgeEntry {
	return {
		...makeSwarmEntry(id),
		producer: { cohort_id: 'shared-cohort', worktree_id: 'wt-other' },
		revision: 1,
	} as SwarmKnowledgeEntry;
}

/** Pin the policy seam to a LINKED cohort with the actor on another worktree. */
function pinLinkedCohortActor() {
	const snapshot = { ...policyInternals };
	policyInternals.isLinked = () => true;
	policyInternals.readCohortConfigFingerprint = async () => null;
	policyInternals.resolveWorktreeId = async () => 'wt-actor';
	return snapshot;
}

describe('knowledge_archive — quarantine policy truthfulness (#2950)', () => {
	let envDir: string;
	let previousHome: string | undefined;
	let previousXdgConfigHome: string | undefined;
	let previousXdgDataHome: string | undefined;
	let previousLocalAppData: string | undefined;

	beforeEach(() => {
		// Hermetic env: keep the developer's real user-level config out of
		// loadPluginConfigWithMeta reads (config loader deep-merges it).
		previousHome = process.env.HOME;
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
		previousXdgDataHome = process.env.XDG_DATA_HOME;
		previousLocalAppData = process.env.LOCALAPPDATA;
		envDir = canonicalMkdtemp('swarm-j4-env-');
		mkdirSync(`${envDir}/xdg-config`, { recursive: true });
		process.env.HOME = envDir;
		process.env.XDG_CONFIG_HOME = `${envDir}/xdg-config`;
		process.env.XDG_DATA_HOME = `${envDir}/xdg-data`;
		process.env.LOCALAPPDATA = `${envDir}/localappdata`;
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
		if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = previousXdgDataHome;
		if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = previousLocalAppData;
		rmSync(envDir, { recursive: true, force: true });
	});

	it('denied: cross-owned entry in a linked cohort (quorum-insufficient)', async () => {
		const dir = canonicalMkdtemp('swarm-j4-denied-cross-');
		try {
			const swarmPath = resolveSwarmKnowledgePath(dir);
			await appendKnowledge(swarmPath, crossOwnedEntry('owned-by-other'));
			const snapshot = pinLinkedCohortActor();
			try {
				const raw = await knowledge_archive.execute(
					{ id: 'owned-by-other', reason: 'suspect entry', mode: 'quarantine' },
					makeCtx(dir),
				);
				const parsed = JSON.parse(raw);
				expect(parsed.success).toBe(false);
				expect(parsed.basis).toBe('quorum-insufficient');
				expect(parsed.error).toContain(
					'Cohort-safety policy blocked this quarantine:',
				);
				// No silent-success divergence: the entry was NOT moved and no
				// tombstone was written (those are success-path-only).
				const entries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
				expect(entries.some((e) => e.id === 'owned-by-other')).toBe(true);
				expect(
					existsSync(
						swarmPath.replace(
							/knowledge\.jsonl$/,
							'knowledge-quarantined.jsonl',
						),
					),
				).toBe(false);
				expect(
					existsSync(
						swarmPath.replace(/knowledge\.jsonl$/, 'knowledge-rejected.jsonl'),
					),
				).toBe(false);
			} finally {
				Object.assign(policyInternals, snapshot);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('denied: legacy producer-less entry in a linked cohort (protected-unknown-owner)', async () => {
		const dir = canonicalMkdtemp('swarm-j4-denied-legacy-');
		try {
			const swarmPath = resolveSwarmKnowledgePath(dir);
			await appendKnowledge(swarmPath, makeSwarmEntry('legacy-entry'));
			const snapshot = pinLinkedCohortActor();
			try {
				const raw = await knowledge_archive.execute(
					{ id: 'legacy-entry', reason: 'suspect legacy', mode: 'quarantine' },
					makeCtx(dir),
				);
				const parsed = JSON.parse(raw);
				expect(parsed.success).toBe(false);
				expect(parsed.basis).toBe('protected-unknown-owner');
				expect(parsed.error).toContain(
					'Cohort-safety policy blocked this quarantine:',
				);
				const entries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
				expect(entries.some((e) => e.id === 'legacy-entry')).toBe(true);
			} finally {
				Object.assign(policyInternals, snapshot);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('denied: config-fingerprint mismatch (config-mismatch)', async () => {
		const dir = canonicalMkdtemp('swarm-j4-denied-fingerprint-');
		try {
			const swarmPath = resolveSwarmKnowledgePath(dir);
			await appendKnowledge(swarmPath, crossOwnedEntry('fp-entry'));
			const snapshot = { ...policyInternals };
			policyInternals.isLinked = () => true;
			policyInternals.cohortConfigFingerprint = (() => 'fp-current') as never;
			policyInternals.readCohortConfigFingerprint = async () => 'fp-other';
			policyInternals.resolveWorktreeId = async () => 'wt-actor';
			try {
				const raw = await knowledge_archive.execute(
					{ id: 'fp-entry', reason: 'cohort drifted', mode: 'quarantine' },
					makeCtx(dir),
				);
				const parsed = JSON.parse(raw);
				expect(parsed.success).toBe(false);
				expect(parsed.basis).toBe('config-mismatch');
				const entries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
				expect(entries.some((e) => e.id === 'fp-entry')).toBe(true);
			} finally {
				Object.assign(policyInternals, snapshot);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('not_found: in-lock race through the tool reports the pre-check shape', async () => {
		const dir = canonicalMkdtemp('swarm-j4-race-');
		try {
			const swarmPath = resolveSwarmKnowledgePath(dir);
			await appendKnowledge(swarmPath, makeSwarmEntry('race-entry'));
			const storeDir = resolveKnowledgeStoreDir(dir);
			// Hold the SAME store-dir lock quarantineEntry acquires
			// (knowledge-validator lockfile.lock) so its locked read is
			// serialized behind this block. Keep the hold well under
			// proper-lockfile's retry budget (~0.5-1.7s at the callee's
			// config) and release immediately after the rewrite: budget
			// exhaustion would surface as the catch's error: shape instead.
			const release = await lockfile.lock(storeDir);
			let released = false;
			try {
				// The tool's PRR-003 pre-check read is lock-free: it completes
				// during the settle below while the callee queues on the lock.
				const pending = knowledge_archive.execute(
					{ id: 'race-entry', reason: 'race probe', mode: 'quarantine' },
					makeCtx(dir),
				);
				await new Promise((resolve) => setTimeout(resolve, 150));
				// Entry vanishes between the unlocked pre-check and the locked
				// read → the not_found arm fires inside the lock. Both legs
				// report the identical {success:false, message} shape; this
				// construction prefers the in-lock leg, and deleting that arm
				// would flip the result to the error-shape default.
				const remaining = (
					await readKnowledge<SwarmKnowledgeEntry>(swarmPath)
				).filter((e) => e.id !== 'race-entry');
				writeFileSync(
					swarmPath,
					remaining.length > 0
						? `${remaining.map((e) => JSON.stringify(e)).join('\n')}\n`
						: '',
				);
				await release();
				released = true;
				const parsed = JSON.parse(await pending);
				expect(parsed.success).toBe(false);
				expect(parsed.message).toBe('entry not found');
			} finally {
				if (!released) {
					await release().catch(() => {});
				}
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('authorized: unlinked (config-skipped) path still quarantines and writes the tombstone', async () => {
		const dir = canonicalMkdtemp('swarm-j4-authorized-');
		try {
			const swarmPath = resolveSwarmKnowledgePath(dir);
			await appendKnowledge(swarmPath, makeSwarmEntry('mine-entry'));
			// NO DI overrides: an unlinked scratch store authorizes via the
			// config-skipped-unlinked basis.
			const raw = await knowledge_archive.execute(
				{ id: 'mine-entry', reason: 'mine to quarantine', mode: 'quarantine' },
				makeCtx(dir),
			);
			const parsed = JSON.parse(raw);
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('quarantined');
			expect((await readKnowledge<SwarmKnowledgeEntry>(swarmPath)).length).toBe(
				0,
			);
			const quarantined = await readKnowledge<
				SwarmKnowledgeEntry & { original_status: string }
			>(swarmPath.replace(/knowledge\.jsonl$/, 'knowledge-quarantined.jsonl'));
			expect(quarantined).toHaveLength(1);
			expect(quarantined[0].id).toBe('mine-entry');
			expect(quarantined[0].original_status).toBe('candidate');
			expect(
				existsSync(
					swarmPath.replace(/knowledge\.jsonl$/, 'knowledge-rejected.jsonl'),
				),
			).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('helper parity: archive and quarantine denials share one field shape', async () => {
		const dir = canonicalMkdtemp('swarm-j4-parity-');
		try {
			const swarmPath = resolveSwarmKnowledgePath(dir);
			await appendKnowledge(swarmPath, crossOwnedEntry('parity-entry'));
			const snapshot = pinLinkedCohortActor();
			try {
				const archiveParsed = JSON.parse(
					await knowledge_archive.execute(
						{ id: 'parity-entry', reason: 'parity', mode: 'archive' },
						makeCtx(dir),
					),
				);
				const quarantineParsed = JSON.parse(
					await knowledge_archive.execute(
						{ id: 'parity-entry', reason: 'parity', mode: 'quarantine' },
						makeCtx(dir),
					),
				);
				expect(archiveParsed.success).toBe(false);
				expect(quarantineParsed.success).toBe(false);
				expect(typeof archiveParsed.basis).toBe('string');
				expect(archiveParsed.basis.length).toBeGreaterThan(0);
				expect(quarantineParsed.basis).toBe(archiveParsed.basis);
				expect(archiveParsed.error).toContain(
					'Cohort-safety policy blocked this archive:',
				);
				expect(quarantineParsed.error).toContain(
					'Cohort-safety policy blocked this quarantine:',
				);
				// Same key set: the three modes share ONE result contract.
				expect(Object.keys(archiveParsed).sort()).toEqual(
					Object.keys(quarantineParsed).sort(),
				);
			} finally {
				Object.assign(policyInternals, snapshot);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
