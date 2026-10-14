#!/usr/bin/env bun
/**
 * Workflow timeout/wait-budget contract gate (issue #2952).
 *
 * Static, bounded, fail-closed scan over `.github/workflows/*.yml`: for every
 * job that waits on a dispatched (or otherwise slow) process via a
 * `seq 1 <N>` x `sleep <S>` poll loop, assert
 *
 *   timeout-minutes x 60 >= ceil(sum(call-site wait budgets) x OVERHEAD_FACTOR) + MARGIN_MINUTES x 60
 *
 * and for every wait call site carrying a `# target-duration: <minutes>`
 * directive (call line or the line immediately above), assert
 *
 *   call-site budget minutes >= target-duration minutes.
 *
 * A wait call site without a `# target-duration` directive is a violation:
 * every wait must declare the realistic duration it must cover. Wait
 * functions may be parameterized (`fn <workflow> <iterations> <sleep>`);
 * parameterless calls fall back to the function's internal defaults, which
 * must be resolvable numeric literals or `${N:-<default>}` expansions. Any
 * construct the parser cannot attribute exactly — an inline (non-function)
 * seq/sleep pair inside a job, a pair outside every job, unresolvable
 * defaults, an expression-valued job `timeout-minutes`, an oversized file —
 * is a fail-closed finding, never a silent pass.
 *
 * Modeled on `scripts/check-required-check-contract.ts`: pure text scan, no
 * YAML dependency, no network, no git, no subprocess.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const OVERHEAD_FACTOR = 1.2;
export const MARGIN_MINUTES = 5;
export const MAX_WORKFLOW_BYTES = 512 * 1024;
export const MAX_FINDINGS = 64;
export const MAX_WORKFLOW_FILES = 64;
export const DEFAULT_WORKFLOWS_DIR = '.github/workflows';

const SEQ_RE = /\bseq\s+1\s+([^\s;&|)]+)/;
const SLEEP_RE = /\bsleep\s+([^\s;&|)]+)/;
const FUNC_DEF_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{/;

export interface TimeoutFinding {
	file: string;
	code: string;
	message: string;
}

interface JobBlock {
	name: string;
	start: number; // inclusive line index
	end: number; // exclusive line index
	timeoutMinutes: number | null;
	timeoutUnparsable: string | null; // raw value when non-numeric/expression
}

interface WaitFunction {
	name: string;
	start: number;
	end: number;
	defaultIterations: number | null;
	defaultSleep: number | null;
	defaultsUnresolvable: boolean;
}

interface WaitCall {
	job: string;
	fn: string;
	workflow: string;
	iterations: number | null;
	sleep: number | null;
	line: number; // 0-based index of the call line
	directiveMinutes: number | null;
	directiveLine: number;
}

function pushFinding(findings: TimeoutFinding[], file: string, code: string, message: string): void {
	if (findings.length < MAX_FINDINGS) {
		findings.push({ file, code, message });
	}
}

/** Parse `jobs:`-region job blocks with their job-level `timeout-minutes`. */
export function parseWorkflowJobs(lines: string[]): JobBlock[] {
	const jobs: JobBlock[] = [];
	let inJobs = false;
	let current: JobBlock | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^jobs:\s*$/.test(line)) {
			inJobs = true;
			current = null;
			continue;
		}
		if (/^\S/.test(line)) {
			// Any other top-level key ends the jobs region (comment lines keep it).
			if (inJobs && !line.startsWith('#')) {
				inJobs = false;
				current = null;
			}
			continue;
		}
		if (!inJobs) continue;
		const jobMatch = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line);
		if (jobMatch) {
			current = {
				name: jobMatch[1],
				start: i,
				end: lines.length,
				timeoutMinutes: null,
				timeoutUnparsable: null,
			};
			jobs.push(current);
			continue;
		}
		if (current) {
			const timeoutMatch = /^ {4}timeout-minutes:\s*(.+?)\s*$/.exec(line);
			if (timeoutMatch) {
				const raw = timeoutMatch[1].trim();
				const numeric = /^-?\d+(?:\.\d+)?$/.exec(raw);
				if (numeric) {
					current.timeoutMinutes = Number.parseFloat(raw);
				} else {
					current.timeoutUnparsable = raw;
				}
			}
		}
	}
	// Close each block at the next job's start (jobs are pushed in order).
	for (let j = 0; j < jobs.length; j++) {
		if (j + 1 < jobs.length) jobs[j].end = jobs[j + 1].start;
	}
	return jobs;
}

/** Parse shell functions that contain a seq x sleep poll loop. */
export function parseWaitFunctions(lines: string[]): WaitFunction[] {
	const fns: WaitFunction[] = [];
	for (let i = 0; i < lines.length; i++) {
		const def = FUNC_DEF_RE.exec(lines[i]);
		if (!def) continue;
		const indent = def[1];
		const closing = new RegExp(`^${indent}}\\s*$`);
		let end = lines.length - 1;
		for (let j = i + 1; j < lines.length; j++) {
			if (closing.test(lines[j])) {
				end = j;
				break;
			}
		}
		const body = lines.slice(i, end + 1).join('\n');
		const seq = SEQ_RE.exec(body);
		const sleep = SLEEP_RE.exec(body);
		if (!seq || !sleep) continue;
		const defaults = new Map<string, number>();
		const varDefaultRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)="\$\{[0-9]+:-([0-9]+)\}"\s*$/;
		for (const bodyLine of lines.slice(i, end + 1)) {
			const m = varDefaultRe.exec(bodyLine);
			if (m) defaults.set(m[1], Number.parseInt(m[2], 10));
		}
		const resolve = (token: string): number | null => {
			const literal = /^([0-9]+)$/.exec(token);
			if (literal) return Number.parseInt(token, 10);
			// Inline `${2:-120}` / "$ poll_seconds" forms: direct expansion first,
			// then named variables resolved through the `${N:-default}` assignments.
			const bare = token.replace(/^["']+/, '').replace(/["']+$/, '');
			const inline = /^\$?\{([0-9]+):-([0-9]+)\}$/.exec(bare);
			if (inline) return Number.parseInt(inline[2], 10);
			const varName = bare.replace(/^\$/, '').replace(/^\{|\}$/g, '').trim();
			const hit = defaults.get(varName);
			return hit === undefined ? null : hit;
		};
		const defaultIterations = resolve(seq[1]);
		const defaultSleep = resolve(sleep[1]);
		fns.push({
			name: def[2],
			start: i,
			end,
			defaultIterations,
			defaultSleep,
			defaultsUnresolvable: defaultIterations === null || defaultSleep === null,
		});
	}
	return fns;
}

function jobAt(jobs: JobBlock[], line: number): JobBlock | null {
	for (const job of jobs) {
		if (line >= job.start && line < job.end) return job;
	}
	return null;
}

function fnAt(fns: WaitFunction[], line: number): WaitFunction | null {
	for (const fn of fns) {
		if (line >= fn.start && line <= fn.end) return fn;
	}
	return null;
}

const DIRECTIVE_RE = /#\s*target-duration:\s*([0-9]+(?:\.[0-9]+)?)/;

/** Scan one workflow file's lines; append findings. */
export function scanWorkflowLines(
	lines: string[],
	file: string,
	findings: TimeoutFinding[],
): void {
	const jobs = parseWorkflowJobs(lines);
	const fns = parseWaitFunctions(lines);

	// Wait-construct disposition: every seq occurrence must land in exactly
	// one accounted bucket (inside a wait function, inline-in-job, orphan).
	const seqLines: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (SEQ_RE.test(lines[i])) seqLines.push(i);
	}
	for (const line of seqLines) {
		if (fnAt(fns, line)) continue; // accounted via its function's call sites
		const job = jobAt(jobs, line);
		if (job) {
			const hasSleepInJob = lines
				.slice(job.start, job.end)
				.some((l) => SLEEP_RE.test(l));
			if (hasSleepInJob) {
				pushFinding(
					findings,
					file,
					'uncounted-wait-construct',
					`job ${job.name}: seq/sleep wait construct at line ${line + 1} is not inside a recognized wait function — factor it into a wait function with a # target-duration directive`,
				);
			}
		} else {
			pushFinding(
				findings,
				file,
				'unattributable-wait-construct',
				`seq/sleep wait construct at line ${line + 1} is not attributable to any job`,
			);
		}
	}

	// Call sites per job (function-definition lines excluded).
	const calls: WaitCall[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (const fn of fns) {
			if (i < fn.start || i > fn.end) {
				const callRe = new RegExp(`\\b${fn.name}\\b(?!\\s*\\()`);
				if (!callRe.test(line)) continue;
				if (FUNC_DEF_RE.test(line)) continue;
				const argRe = new RegExp(`\\b${fn.name}\\s+([A-Za-z0-9._/-]+)(?:\\s+([0-9]+))?(?:\\s+([0-9]+))?`);
				const args = argRe.exec(line);
				if (!args) continue;
				const job = jobAt(jobs, i) ?? jobAt(jobs, fn.start);
				if (!job) continue; // orphan call: the seq disposition above already flagged the loop
				calls.push({
					job: job.name,
					fn: fn.name,
					workflow: args[1],
					iterations: args[2] ? Number.parseInt(args[2], 10) : null,
					sleep: args[3] ? Number.parseInt(args[3], 10) : null,
					line: i,
					directiveMinutes: null,
					directiveLine: -1,
				});
			}
		}
	}


	// Directives: call line or the line immediately above.
	for (const call of calls) {
		const onCall = DIRECTIVE_RE.exec(lines[call.line]);
		if (onCall) {
			call.directiveMinutes = Number.parseFloat(onCall[1]);
			call.directiveLine = call.line;
			continue;
		}
		if (call.line > 0) {
			const above = DIRECTIVE_RE.exec(lines[call.line - 1]);
			if (above) {
				call.directiveMinutes = Number.parseFloat(above[1]);
				call.directiveLine = call.line - 1;
			}
		}
	}

	// Per-job aggregates.
	const byJob = new Map<string, WaitCall[]>();
	for (const call of calls) {
		const list = byJob.get(call.job) ?? [];
		list.push(call);
		byJob.set(call.job, list);
	}
	for (const [jobName, jobCalls] of byJob) {
		const job = jobs.find((j) => j.name === jobName);
		if (!job) continue;
		if (job.timeoutUnparsable !== null) {
			pushFinding(
				findings,
				file,
				'timeout-unparsable',
				`job ${jobName}: job-level timeout-minutes value "${job.timeoutUnparsable}" is not a plain number — the timeout/wait arithmetic cannot be verified`,
			);
			continue;
		}
		if (job.timeoutMinutes === null) {
			pushFinding(
				findings,
				file,
				'timeout-missing',
				`job ${jobName} waits on ${jobCalls.length} dispatched run(s) but declares no job-level timeout-minutes`,
			);
			continue;
		}
		let sumSeconds = 0;
		let sumResolved = true;
		for (const call of jobCalls) {
			const fn = fns.find((f) => f.name === call.fn);
			if (!fn) continue;
			const iters = call.iterations ?? fn.defaultIterations;
			const sleep = call.sleep ?? fn.defaultSleep;
			if (iters === null || sleep === null) {
				sumResolved = false;
				pushFinding(
					findings,
					file,
					'unresolvable-wait-defaults',
					`job ${jobName}: parameterless call to ${call.fn} (${call.workflow}) at line ${call.line + 1} has no resolvable iteration/sleep defaults`,
				);
				continue;
			}
			const budgetSeconds = iters * sleep;
			sumSeconds += budgetSeconds;
			if (call.directiveMinutes === null) {
				pushFinding(
					findings,
					file,
					'missing-target-duration',
					`job ${jobName}: ${call.fn} call for ${call.workflow} at line ${call.line + 1} has no "# target-duration: <minutes>" directive on the call line or the line immediately above`,
				);
			} else {
				const budgetMinutes = budgetSeconds / 60;
				if (budgetMinutes + 1e-9 < call.directiveMinutes) {
					pushFinding(
						findings,
						file,
						'budget-below-target',
						`job ${jobName}: ${call.fn} budget for ${call.workflow} is ${budgetMinutes}min (${iters}x${sleep}s) < declared target-duration ${call.directiveMinutes}min`,
					);
				}
			}
		}
		if (!sumResolved) continue;
		const requiredSeconds = Math.ceil(sumSeconds * OVERHEAD_FACTOR) + MARGIN_MINUTES * 60;
		const timeoutSeconds = job.timeoutMinutes * 60;
		if (timeoutSeconds + 1e-9 < requiredSeconds) {
			pushFinding(
				findings,
				file,
				'timeout-below-wait-sum',
				`job ${jobName} timeout ${job.timeoutMinutes}min (${timeoutSeconds}s) < required ${requiredSeconds}s (sum waits ${sumSeconds}s x ${OVERHEAD_FACTOR} + ${MARGIN_MINUTES}min margin)`,
			);
		}
	}

	// Expression-valued job timeout anywhere fails closed (the arithmetic
	// cannot be verified), even on jobs without waits.
	for (const job of jobs) {
		if (job.timeoutUnparsable !== null && !byJob.has(job.name)) {
			pushFinding(
				findings,
				file,
				'timeout-unparsable',
				`job ${job.name}: job-level timeout-minutes value "${job.timeoutUnparsable}" is not a plain number — the timeout/wait arithmetic cannot be verified`,
			);
		}
	}
}

export interface ScanResult {
	findings: TimeoutFinding[];
	filesScanned: number;
}

export function scanWorkflowsDir(dir: string): ScanResult {
	const findings: TimeoutFinding[] = [];
	let filesScanned = 0;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		pushFinding(findings, dir, 'workflows-dir-unreadable', `cannot read workflows directory ${dir}`);
		return { findings, filesScanned };
	}
	const names = entries
		.filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
		.map((e) => e.name)
		.sort();
	if (names.length > MAX_WORKFLOW_FILES) {
		pushFinding(
			findings,
			dir,
			'file-count-exceeded',
			`workflows directory ${dir} holds ${names.length} workflow files (cap ${MAX_WORKFLOW_FILES})`,
		);
	}
	for (const name of names.slice(0, MAX_WORKFLOW_FILES)) {
		const full = path.join(dir, name);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(full);
		} catch {
			pushFinding(findings, name, 'file-unreadable', `cannot stat ${full}`);
			continue;
		}
		if (stat.size > MAX_WORKFLOW_BYTES) {
			pushFinding(
				findings,
				name,
				'file-too-large',
				`workflow file ${name} is ${stat.size} bytes (cap ${MAX_WORKFLOW_BYTES}) — bounded read refuses to guess`,
			);
			continue;
		}
		filesScanned++;
		const text = fs.readFileSync(full, 'utf-8');
		scanWorkflowLines(text.split(/\r?\n/), name, findings);
	}
	return { findings, filesScanned };
}

export function main(argv: string[] = process.argv.slice(2), root = process.cwd()): number {
	let dirArg: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--workflows-dir' && i + 1 < argv.length) {
			dirArg = argv[i + 1];
			i++;
		}
	}
	const dir = dirArg
		? path.resolve(root, dirArg)
		: path.resolve(root, DEFAULT_WORKFLOWS_DIR);
	const { findings, filesScanned } = scanWorkflowsDir(dir);
	for (const finding of findings) {
		console.log(`::error file=${finding.file}::[check-workflow-timeouts:${finding.code}] ${finding.message}`);
	}
	const status = findings.length > 0 ? 'fail' : 'pass';
	console.log(`[check-workflow-timeouts] ${status} (${findings.length} finding(s), ${filesScanned} workflow file(s) scanned in ${dir})`);
	return findings.length > 0 ? 1 : 0;
}

if (import.meta.main) {
	process.exitCode = main(process.argv.slice(2));
}
