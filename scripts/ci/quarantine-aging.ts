#!/usr/bin/env bun
/**
 * Quarantine aging tracker (issue #2905, Workstream I8).
 *
 * Weekly routing for the expiry-aware quarantine census: computes how many
 * active ledger entries expire within 21 days and maintains exactly ONE
 * deduplicated tracking issue titled
 *   `Quarantine aging: <n> entries expire within 21 days`
 * — adopted only when authored by github-actions[bot] (a human- or
 * third-party-titled issue is never absorbed; host-contract routeDrift
 * precedent). n=0 closes every adopted tracking issue. `--dry-run` makes NO
 * network calls and always exits 0.
 *
 * gh failures are ::warning:: lines that never fail the run (flake-detector
 * precedent): the aging view is advisory.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
	type QuarantineCensus,
	type QuarantineTrend,
	buildQuarantineCensus,
	collectAddRetireTrend,
	formatQuarantineCensus,
	readLedgerContents,
} from './quarantine-census';

export const TRACKING_TITLE_PREFIX = 'Quarantine aging:';

const ADOPT_AUTHOR = 'github-actions[bot]';
const MAX_ANCHOR_LOOKUPS = 20;
const GH_TIMEOUT_MS = 30_000;

export interface ExistingIssue {
	number: number;
	title: string;
	author?: { login?: string };
}

export type AgingAction = 'open' | 'update' | 'close';

export interface AgingDecision {
	action: AgingAction;
	title: string;
	adopted: ExistingIssue[];
	n: number;
}

/** Pure decision core — no IO, unit-testable. */
export function decideAgingAction(
	census: QuarantineCensus,
	existingOpenIssues: ExistingIssue[],
): AgingDecision {
	const n = census.expiringSoon.length;
	const title = `${TRACKING_TITLE_PREFIX} ${n} entries expire within 21 days`;
	const adopted = existingOpenIssues.filter(
		(issue) =>
			issue.title.startsWith(TRACKING_TITLE_PREFIX) &&
			issue.author?.login === ADOPT_AUTHOR,
	);
	let action: AgingAction;
	if (n > 0) {
		action = adopted.length > 0 ? 'update' : 'open';
	} else {
		action = 'close';
	}
	return { action, title, adopted, n };
}

export function renderAgingBody(
	census: QuarantineCensus,
	trend: QuarantineTrend,
	anchorStates: Map<string, string>,
): string {
	const lines: string[] = [];
	lines.push(
		`Weekly quarantine-aging view (issue #2905). Entries whose EXPIRY lands within 21 days:`,
		'',
		...formatQuarantineCensus(census, trend),
		'',
		'## Entries entering their last 21 days',
		'',
	);
	if (census.expiringSoon.length === 0) {
		lines.push('None this week.');
	} else {
		lines.push('| Entry | Ledger | EXPIRY | Hard-fail wall | Owner | Anchor issues |');
		lines.push('|---|---|---|---|---|---|');
		for (const entry of census.expiringSoon) {
			const anchors =
				entry.ownerIssueRefs.length > 0
					? entry.ownerIssueRefs
							.map(
								(ref) =>
									`${ref} (${anchorStates.get(ref) ?? 'state unknown'})`,
							)
							.join(', ')
					: 'none';
			lines.push(
				`| ${entry.path} | ${entry.ledger} | ${entry.expiry} | ${entry.wallDate} | ${entry.ownerHandle ?? 'none'} | ${anchors} |`,
			);
		}
	}
	lines.push(
		'',
		'Tracking: renewal cohort #2973 · census/aging workstream #2905 · renewal policy requires an OWNER issue reference on any later-dated EXPIRY.',
	);
	return lines.join('\n');
}

interface GhResult {
	ok: boolean;
	stdout: string;
	error?: string;
}

/** Bounded, fail-open gh invocation (array form, timeout, bounded output). */
function runGh(args: string[]): GhResult {
	try {
		const result = spawnSync('gh', args, {
			cwd: process.cwd(),
			timeout: GH_TIMEOUT_MS,
			encoding: 'utf8',
			maxBuffer: 4 * 1024 * 1024,
			env: process.env,
			stdin: 'ignore',
		});
		if (result.error) {
			return { ok: false, stdout: '', error: String(result.error) };
		}
		if (result.status !== 0) {
			return {
				ok: false,
				stdout: result.stdout ?? '',
				error: `gh exit ${result.status}: ${(result.stderr ?? '').slice(0, 200)}`,
			};
		}
		return { ok: true, stdout: result.stdout ?? '' };
	} catch (error) {
		return { ok: false, stdout: '', error: String(error) };
	}
}

export const _internals = {
	runGh,
};

async function lookupAnchorStates(refs: string[]): Promise<Map<string, string>> {
	const states = new Map<string, string>();
	const repo = process.env.GH_REPO && process.env.GH_REPO.trim() !== ''
		? process.env.GH_REPO.trim()
		: 'ZaxbyHub/opencode-swarm';
	for (const ref of refs.slice(0, MAX_ANCHOR_LOOKUPS)) {
		const res = _internals.runGh([
			'issue',
			'view',
			ref.replace('#', ''),
			'--repo',
			repo,
			'--json',
			'state',
		]);
		if (!res.ok) {
			console.log(
				`::warning::quarantine-aging: anchor state lookup failed for ${ref}: ${res.error ?? 'unknown error'}`,
			);
			continue;
		}
		try {
			const parsed = JSON.parse(res.stdout) as { state?: string };
			if (typeof parsed.state === 'string') states.set(ref, parsed.state);
		} catch {
			console.log(
				`::warning::quarantine-aging: anchor state lookup for ${ref} returned unparseable output.`,
			);
		}
	}
	return states;
}

function routeDecision(
	decision: AgingDecision,
	body: string,
): void {
	if (decision.action === 'open') {
		const res = _internals.runGh([
			'issue',
			'create',
			'--title',
			decision.title,
			'--body',
			body,
			'--label',
			'area:ci',
		]);
		console.log(
			res.ok
				? 'quarantine-aging: opened tracking issue'
				: `::warning::quarantine-aging: gh issue create failed: ${res.error ?? 'unknown error'} (run unaffected)`,
		);
		return;
	}
	if (decision.action === 'update') {
		const primary = decision.adopted[0];
		if (!primary) return;
		let commentOk = true;
		const comment = _internals.runGh([
			'issue',
			'comment',
			String(primary.number),
			'--body',
			body,
		]);
		commentOk = comment.ok;
		if (!commentOk) {
			console.log(
				`::warning::quarantine-aging: gh issue comment failed: ${comment.error ?? 'unknown error'}`,
			);
		}
		if (primary.title !== decision.title) {
			const retitle = _internals.runGh([
				'issue',
				'edit',
				String(primary.number),
				'--title',
				decision.title,
			]);
			if (!retitle.ok) {
				console.log(
					`::warning::quarantine-aging: gh issue edit (retitle) failed: ${retitle.error ?? 'unknown error'}`,
				);
			}
		}
		// Close duplicate adopted tracking issues — exactly one stays open.
		for (const duplicate of decision.adopted.slice(1)) {
			const closeRes = _internals.runGh([
				'issue',
				'close',
				String(duplicate.number),
				'--comment',
				`Closing duplicate quarantine-aging tracking issue; #${primary.number} is the live one (issue #2905).`,
			]);
			if (!closeRes.ok) {
				console.log(
					`::warning::quarantine-aging: duplicate close failed for #${duplicate.number}: ${closeRes.error ?? 'unknown error'}`,
				);
			}
		}
		return;
	}
	// action === 'close': n=0 — close every adopted tracking issue.
	for (const adoptedIssue of decision.adopted) {
		const closeRes = _internals.runGh([
			'issue',
			'close',
			String(adoptedIssue.number),
			'--comment',
			'Quarantine census: 0 entries expire within 21 days — closing the aging tracking issue (issue #2905).',
		]);
		console.log(
			closeRes.ok
				? `quarantine-aging: closed tracking issue #${adoptedIssue.number} (0 entries within 21 days)`
				: `::warning::quarantine-aging: gh issue close failed for #${adoptedIssue.number}: ${closeRes.error ?? 'unknown error'}`,
		);
	}
}

function parseArgs(argv: string[]) {
	const options = { root: process.cwd(), now: null as string | null, dryRun: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--root' && argv[i + 1]) {
			options.root = path.resolve(argv[i + 1] as string);
			i += 1;
		} else if (arg === '--now' && argv[i + 1]) {
			options.now = argv[i + 1] as string;
			i += 1;
		} else if (arg === '--dry-run') {
			options.dryRun = true;
		}
	}
	return options;
}

async function main(argv: string[]): Promise<number> {
	const options = parseArgs(argv);
	const now = options.now
		? new Date(`${options.now}T00:00:00.000Z`)
		: new Date();
	const census = buildQuarantineCensus(readLedgerContents(options.root), now);
	const trend = await collectAddRetireTrend(options.root, now);
	if (options.dryRun) {
		console.log('quarantine-aging dry-run (no GitHub calls)');
		console.log(`aging: n=${census.expiringSoon.length}`);
		// Dry-run cannot list issues (no network), so the decision is computed
		// against an empty adoption set through the SAME routing core the real
		// mode uses — ONE decision source for both paths; n=0 maps to `close`
		// (a no-op when nothing is adopted).
		const decision = decideAgingAction(census, []);
		console.log(`decision: ${decision.action}`);
		console.log(`title: ${decision.title}`);
		for (const line of formatQuarantineCensus(census, trend)) {
			console.log(line);
		}
		return 0;
	}
	const repo = process.env.GH_REPO && process.env.GH_REPO.trim() !== ''
		? process.env.GH_REPO.trim()
		: 'ZaxbyHub/opencode-swarm';
	const list = _internals.runGh([
		'issue',
		'list',
		'--repo',
		repo,
		'--state',
		'open',
		'--json',
		'number,title,author',
		'--limit',
		'500',
	]);
	let existing: ExistingIssue[] = [];
	if (list.ok) {
		try {
			existing = JSON.parse(list.stdout) as ExistingIssue[];
		} catch (error) {
			console.log(
				`::warning::quarantine-aging: gh issue list output unparseable: ${String(error)} (no routing this run)`,
			);
			return 0;
		}
	} else {
		console.log(
			`::warning::quarantine-aging: gh issue list failed: ${list.error ?? 'unknown error'} (no routing this run)`,
		);
		return 0;
	}
	const decision = decideAgingAction(census, existing);
	const anchorRefs = Array.from(
		new Set(census.expiringSoon.flatMap((entry) => entry.ownerIssueRefs)),
	);
	const anchorStates = await lookupAnchorStates(anchorRefs);
	const body = renderAgingBody(census, trend, anchorStates);
	console.log(`aging: n=${decision.n}`);
	console.log(`decision: ${decision.action}`);
	routeDecision(decision, body);
	return 0;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const isDirectRun =
	typeof process.argv[1] === 'string' &&
	path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH);

if (isDirectRun) {
	void main(process.argv.slice(2))
		.then((exitCode) => {
			process.exit(exitCode);
		})
		.catch((error) => {
			throw error;
		});
}
