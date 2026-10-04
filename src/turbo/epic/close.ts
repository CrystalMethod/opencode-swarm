/**
 * `/swarm epic close` and `/swarm close` finalization (Epic v2 C1a).
 *
 * C1a closes WITHOUT landing (the epic branch and squash landing are C1b):
 *   1. refuse `epic-incomplete` (pending tasks) / `epic-orphaned` /
 *      `epic-state-unreadable` unless `--abandon`;
 *   2. CAS the row to `closing` (an interrupted close resumes from here);
 *   3. write the minimal close report to `.swarm/epic/reports/<reportKey>.json`
 *      and `.swarm/epic-prior/reports/<reportKey>.json` (newest 50 kept —
 *      `epic-prior/` survives `/swarm close`);
 *   4. delete the row, then compare-and-delete the sentinel, under the
 *      lifecycle lock.
 * `--abandon` on unreadable state deletes every lifecycle row without
 * parsing it, then the sentinel.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../config/plan-schema.js';
import type { PluginConfig } from '../../config/schema.js';
import { projectDbExists } from '../../db/project-db.js';
import { _internals as gitBranchInternals } from '../../git/branch.js';
import { loadPlanJsonOnly } from '../../plan/manager.js';
import { atomicWriteSwarmFileSync } from '../../utils/atomic-write.js';
import { isEpicModeConfigEnabled } from './config-gate.js';
import {
	deleteEpicState,
	type EpicCloseOutcome,
	type EpicRecordV1,
	epicSentinelExists,
	inspectEpic,
	markEpicClosing,
	repairEpicSentinel,
} from './lifecycle.js';

/** Newest close reports kept under `.swarm/epic-prior/reports/`. */
export const EPIC_PRIOR_REPORTS_KEEP = 50;
export const EPIC_REPORTS_RELATIVE_DIR = path.join('.swarm', 'epic', 'reports');
export const EPIC_PRIOR_REPORTS_RELATIVE_DIR = path.join(
	'.swarm',
	'epic-prior',
	'reports',
);
const REPORT_NAME_RE = /^[A-Za-z0-9_-]+-\d{8}T\d{6}Z\.json$/;

export interface EpicTaskSummary {
	total: number;
	completed: number;
	closed: number;
	pending: string[];
}

export interface EpicCloseReport {
	schema: 'epic-report-v1';
	reportKey: string;
	epicKey: string;
	planId: string;
	planKey: string;
	outcome: EpicCloseOutcome;
	startedAt: string;
	closedAt: string;
	startedBySession: string;
	forced: boolean;
	sizingAtStart: EpicRecordV1['sizing'];
	config: EpicRecordV1['config'];
	git: EpicRecordV1['git'] & { headAtClose: string | null };
	/** Null when the plan is gone or no longer the epic's plan (orphaned). */
	tasks: EpicTaskSummary | null;
	lastDecision: EpicRecordV1['lastDecision'];
}

export type EpicCloseResult =
	| { status: 'no-epic'; repairedSentinel: boolean }
	| {
			status: 'refused';
			reason: 'epic-incomplete' | 'epic-orphaned' | 'epic-state-unreadable';
			details: string[];
	  }
	| {
			status: 'repaired-unreadable';
			rowsDeleted: string[];
			sentinelDeleted: boolean;
	  }
	| {
			status: 'closed';
			report: EpicCloseReport;
			reportPaths: string[];
			sentinelDeleted: boolean;
	  };

export interface EpicCloseOptions {
	directory: string;
	abandon: boolean;
	/** Overrides the outcome label (swarm-close finalization). */
	outcome?: EpicCloseOutcome;
}

function compactStamp(iso: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
	if (match) {
		return `${match[1]}${match[2]}${match[3]}T${match[4]}${match[5]}${match[6]}Z`;
	}
	return '00000000T000000Z';
}

/** Unique per epic instance: `<epicKey>-<startedAt compact UTC>`. */
export function epicReportKey(record: EpicRecordV1): string {
	return `${record.epicKey}-${compactStamp(record.startedAt)}`;
}

export function summarizePlanTasks(plan: Plan): EpicTaskSummary {
	const summary: EpicTaskSummary = {
		total: 0,
		completed: 0,
		closed: 0,
		pending: [],
	};
	for (const phase of plan.phases) {
		for (const task of phase.tasks ?? []) {
			summary.total += 1;
			if (task.status === 'completed') summary.completed += 1;
			else if (task.status === 'closed') summary.closed += 1;
			else summary.pending.push(task.id);
		}
	}
	return summary;
}

function readHead(directory: string, record: EpicRecordV1): string | null {
	if (!record.git.isRepo) return null;
	try {
		return _internals.gitExec(['rev-parse', 'HEAD'], directory).trim();
	} catch {
		return null;
	}
}

/** Keep the newest {@link EPIC_PRIOR_REPORTS_KEEP} reports (by mtime). */
export function pruneEpicPriorReports(directory: string): number {
	const dir = path.join(directory, EPIC_PRIOR_REPORTS_RELATIVE_DIR);
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((name) => REPORT_NAME_RE.test(name));
	} catch {
		return 0;
	}
	if (names.length <= EPIC_PRIOR_REPORTS_KEEP) return 0;
	const entries = names
		.map((name) => {
			try {
				return { name, mtime: fs.statSync(path.join(dir, name)).mtimeMs };
			} catch {
				return { name, mtime: 0 };
			}
		})
		.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
	let removed = 0;
	for (const entry of entries.slice(EPIC_PRIOR_REPORTS_KEEP)) {
		try {
			fs.unlinkSync(path.join(dir, entry.name));
			removed += 1;
		} catch {
			// best-effort; the retention sweep backstops it
		}
	}
	return removed;
}

function writeReport(directory: string, report: EpicCloseReport): string[] {
	const payload = `${JSON.stringify(report, null, 2)}\n`;
	const paths = [
		path.join(directory, EPIC_REPORTS_RELATIVE_DIR, `${report.reportKey}.json`),
		path.join(
			directory,
			EPIC_PRIOR_REPORTS_RELATIVE_DIR,
			`${report.reportKey}.json`,
		),
	];
	for (const target of paths) {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		atomicWriteSwarmFileSync(target, payload);
	}
	pruneEpicPriorReports(directory);
	return paths;
}

export async function closeEpic(
	options: EpicCloseOptions,
): Promise<EpicCloseResult> {
	const { directory, abandon } = options;
	let plan: Plan | null = null;
	try {
		plan = await _internals.loadPlanJsonOnly(directory);
	} catch {
		plan = null;
	}
	const inspection = _internals.inspectEpic(directory, plan);

	if (inspection.unreadable) {
		if (!abandon) {
			return {
				status: 'refused',
				reason: 'epic-state-unreadable',
				details: [
					inspection.unreadable,
					'Run `/swarm epic close --abandon` to delete the unreadable Epic lifecycle state (no report can be written for it).',
				],
			};
		}
		const deleted = deleteEpicState(directory, null, null);
		return {
			status: 'repaired-unreadable',
			rowsDeleted: deleted.rowsDeleted,
			sentinelDeleted: deleted.sentinelDeleted,
		};
	}

	const record = inspection.record;
	if (!record) {
		const repair = inspection.sentinelPresent
			? repairEpicSentinel(directory)
			: 'none';
		return {
			status: 'no-epic',
			repairedSentinel: repair === 'removed-stale-sentinel',
		};
	}

	const resuming = record.status === 'closing' && record.closing !== null;
	const tasks =
		plan && inspection.orphanReason === null ? summarizePlanTasks(plan) : null;
	if (!abandon && !resuming) {
		if (inspection.orphanReason !== null) {
			return {
				status: 'refused',
				reason: 'epic-orphaned',
				details: [
					`Epic ${record.epicKey} no longer matches the current plan (${inspection.orphanReason}).`,
					'Run `/swarm epic close --abandon` to close it.',
				],
			};
		}
		if (tasks && tasks.pending.length > 0) {
			return {
				status: 'refused',
				reason: 'epic-incomplete',
				details: [
					`${tasks.pending.length} task(s) are not completed or closed: ${tasks.pending.slice(0, 10).join(', ')}${tasks.pending.length > 10 ? ', …' : ''}.`,
					'Finish them (or set them to `closed`), or run `/swarm epic close --abandon`.',
				],
			};
		}
	}

	const requestedOutcome: EpicCloseOutcome =
		options.outcome ?? (abandon ? 'abandoned' : 'completed');
	const closing = _internals.markEpicClosing(
		directory,
		record.epicKey,
		requestedOutcome,
		record.token,
	);
	if (!closing) return { status: 'no-epic', repairedSentinel: false };
	const outcome = closing.closing?.outcome ?? requestedOutcome;

	const report: EpicCloseReport = {
		schema: 'epic-report-v1',
		reportKey: epicReportKey(closing),
		epicKey: closing.epicKey,
		planId: closing.planId,
		planKey: closing.planKey,
		outcome,
		startedAt: closing.startedAt,
		closedAt: new Date(_internals.now()).toISOString(),
		startedBySession: closing.startedBySession,
		forced: closing.forced,
		sizingAtStart: closing.sizing,
		config: closing.config,
		git: { ...closing.git, headAtClose: readHead(directory, closing) },
		tasks,
		lastDecision: closing.lastDecision,
	};
	const reportPaths = _internals.writeReport(directory, report);
	const deleted = deleteEpicState(directory, closing.epicKey, closing.token);
	return {
		status: 'closed',
		report,
		reportPaths,
		sentinelDeleted: deleted.sentinelDeleted,
	};
}

/**
 * `/swarm close` hook, run BEFORE the archive stage (MINOR 1): an open epic
 * is closed as `abandoned-by-swarm-close` so its report lands in
 * `.swarm/epic/` (archived) and `.swarm/epic-prior/reports/` (kept).
 *
 * Epic-gated on the config close already loaded: with
 * `turbo.epic.mode.enabled !== true` it returns null with NO I/O, so a
 * non-Epic close is byte-identical (leftover state is left for
 * `/swarm epic close --abandon`, which works regardless of config). With the
 * gate on it acts when the sentinel exists, or — sentinel lost — when a
 * lifecycle row exists in an existing swarm.db. Never throws.
 */
export async function finalizeOpenEpicOnSwarmClose(
	directory: string,
	config: Pick<PluginConfig, 'turbo'> | null | undefined,
): Promise<string | null> {
	if (!isEpicModeConfigEnabled(config)) return null;
	if (!epicSentinelExists(directory)) {
		if (!projectDbExists(directory)) return null;
		try {
			const inspection = _internals.inspectEpic(directory);
			if (inspection.rowKeys.length === 0) return null;
		} catch {
			return null;
		}
	}
	try {
		const result = await closeEpic({
			directory,
			abandon: true,
			outcome: 'abandoned-by-swarm-close',
		});
		switch (result.status) {
			case 'closed':
				return `Open epic ${result.report.epicKey} was closed as abandoned-by-swarm-close (report: .swarm/epic-prior/reports/${result.report.reportKey}.json).`;
			case 'repaired-unreadable':
				return `Unreadable Epic lifecycle state was removed (${result.rowsDeleted.length} row(s)).`;
			case 'no-epic':
				return result.repairedSentinel
					? 'A stale Epic sentinel (no open epic) was removed.'
					: null;
			default:
				return `Open epic was not finalized: ${result.details.join(' ')}`;
		}
	} catch (error) {
		return `Open epic could not be finalized: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * DI seam (AGENTS.md invariant 7). Restore in `afterEach`.
 */
export const _internals = {
	loadPlanJsonOnly,
	inspectEpic,
	markEpicClosing,
	writeReport,
	gitExec: (args: string[], cwd: string): string =>
		gitBranchInternals.gitExec(args, cwd),
	now: (): number => Date.now(),
};
