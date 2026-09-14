/**
 * Owner-named restart reconciliation (issue #2668).
 *
 * At the rehydrate boundary, ephemeral execution authority expires by design
 * (`delegationActive` and friends are reset in
 * `TRANSIENT_SESSION_FIELDS`) — but the expiry must not be silent. When a
 * serialized session arrives with in-flight authority, the boundary records a
 * bounded, owner-named reconciliation outcome so an operator (and the
 * resumed session) can tell "interrupted mid-execution, outcome UNKNOWN"
 * from "was idle": absence must never read as success.
 *
 * Two surfaces, written together inside the rehydrate populate loop (after
 * the transient reset, before the caller proceeds to the projection write):
 *
 * 1. The durable artifact `.swarm/session/restart-reconciliation.json` — a
 *    bounded list (cap {@link MAX_RESTART_RECONCILIATION_ENTRIES}, FIFO
 *    overflow) deduped by `(sessionId, taskId)` so a repeated restart
 *    refreshes the entry instead of duplicating it.
 * 2. A one-shot advisory string pushed into the rehydrated session's
 *    `pendingAdvisoryMessages` (per-restart; the next rehydrate re-derives
 *    it).
 *
 * The record deliberately COMPOSES the shipped recovery surfaces instead of
 * duplicating them: guidance points operators at `/swarm recover` (stale
 * coder-settlement WALs) and `/swarm status` (uncertain provider effects),
 * and the #2665 `stale`/`ambiguous`/`live_wedge` classification for
 * coder settlements remains owned by those stores.
 */

import * as fsSync from 'node:fs';
import path from 'node:path';
import { bunWrite } from '../utils/bun-compat.js';
import { warn } from '../utils/logger.js';

/** Relative to the project root's `.swarm/` directory. */
export const RESTART_RECONCILIATION_FILE =
	'session/restart-reconciliation.json';

export const MAX_RESTART_RECONCILIATION_ENTRIES = 50;

export type RestartReconciliationClassification = 'interrupted';

export interface RestartReconciliationEntry {
	sessionId: string;
	agentName: string;
	/** The task the interrupted execution was driving ('(unknown)' when the snapshot carried none). */
	taskId: string;
	classification: RestartReconciliationClassification;
	observedAt: string;
	guidance: string;
}

export interface RestartReconciliationFile {
	version: 1;
	entries: RestartReconciliationEntry[];
}

export const RESTART_RECONCILIATION_GUIDANCE =
	'outcome UNKNOWN — do not assume success; inspect /swarm status for uncertain provider effects; /swarm recover settles stale coder-settlement WALs; a human must resolve external effects (pushed commits, published PRs) manually';

function emptyFile(): RestartReconciliationFile {
	return { version: 1, entries: [] };
}

/**
 * Read the reconciliation artifact fail-closed: absent, corrupt, partial, or
 * oversized files read as an empty list — the boundary then re-records what
 * it observes and the artifact heals on the next append.
 */
export function readRestartReconciliation(
	directory: string,
): RestartReconciliationFile {
	const filePath = path.join(directory, '.swarm', RESTART_RECONCILIATION_FILE);
	let raw: string;
	try {
		raw = fsSync.readFileSync(filePath, 'utf8');
	} catch {
		return emptyFile();
	}
	try {
		const parsed = JSON.parse(raw) as Partial<RestartReconciliationFile>;
		if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
			return emptyFile();
		}
		const entries: RestartReconciliationEntry[] = [];
		for (const entry of parsed.entries) {
			if (
				!entry ||
				typeof entry.sessionId !== 'string' ||
				typeof entry.agentName !== 'string' ||
				typeof entry.taskId !== 'string' ||
				typeof entry.observedAt !== 'string' ||
				typeof entry.guidance !== 'string' ||
				entry.classification !== 'interrupted'
			) {
				continue;
			}
			entries.push({
				sessionId: entry.sessionId,
				agentName: entry.agentName,
				taskId: entry.taskId,
				classification: 'interrupted',
				observedAt: entry.observedAt,
				guidance: entry.guidance,
			});
		}
		return { version: 1, entries };
	} catch {
		return emptyFile();
	}
}

/**
 * Append (or refresh, keyed by `(sessionId, taskId)`) a reconciliation entry
 * and persist the bounded list atomically. Fail-open: a write error is
 * logged and swallowed — the reconciliation record must never fail the
 * rehydrate that produces it.
 */
export async function recordInterruptedExecution(
	directory: string,
	entry: {
		sessionId: string;
		agentName: string;
		taskId: string;
		observedAt?: string;
		guidance?: string;
	},
): Promise<RestartReconciliationEntry> {
	const full: RestartReconciliationEntry = {
		classification: 'interrupted',
		observedAt: entry.observedAt ?? new Date().toISOString(),
		guidance: entry.guidance ?? RESTART_RECONCILIATION_GUIDANCE,
		sessionId: entry.sessionId,
		agentName: entry.agentName,
		taskId: entry.taskId,
	};
	const current = readRestartReconciliation(directory);
	const withoutDuplicate = current.entries.filter(
		(existing) =>
			!(
				existing.sessionId === full.sessionId && existing.taskId === full.taskId
			),
	);
	// Newest first, bounded FIFO: overflow drops the OLDEST entries.
	const entries = [full, ...withoutDuplicate].slice(
		0,
		MAX_RESTART_RECONCILIATION_ENTRIES,
	);
	const filePath = path.join(directory, '.swarm', RESTART_RECONCILIATION_FILE);
	try {
		await bunWrite(
			filePath,
			`${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
		);
	} catch (err) {
		warn(
			`[restart-reconciliation] failed to persist reconciliation artifact for session "${full.sessionId}" (task ${full.taskId}): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
	return full;
}

/**
 * The one-shot session advisory naming the owner of the interrupted effect.
 * Pushed into `pendingAdvisoryMessages` AFTER the transient-field reset so
 * it survives the rehydrate that produced it.
 */
export function buildInterruptedAdvisoryMessage(
	entry: Pick<
		RestartReconciliationEntry,
		'sessionId' | 'agentName' | 'taskId'
	> & { guidance?: string },
): string {
	return (
		`[swarm] Restart reconciliation: session ${entry.sessionId} (agent ` +
		`${entry.agentName}) was interrupted mid-execution on task ${entry.taskId}. ` +
		`The outcome is UNKNOWN — do not treat absence as success. ` +
		`${entry.guidance ?? RESTART_RECONCILIATION_GUIDANCE}.`
	);
}
