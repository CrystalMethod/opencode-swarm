#!/usr/bin/env node
/**
 * Deterministic sanitizer for the captured delegation-ledger fixture
 * (issue #2908 AC5, PR #3284 review findings PRR-019/020/021/022).
 *
 * Usage:
 *   node scripts/scrub-delegation-fixture-2908.mjs <raw-capture.jsonl> [output.jsonl]
 *
 * `<raw-capture.jsonl>` is a `.swarm/background-delegations.jsonl` capture
 * (one full record snapshot per line). The output defaults to
 * `tests/fixtures/background-delegations-2908.jsonl` next to this repository's
 * root, derived from this script's own location (no absolute paths are
 * embedded). The transformation is pure and deterministic: the same input
 * bytes always produce the same output bytes. It is also IDEMPOTENT — running
 * it over an already-scrubbed fixture reproduces that fixture byte-for-byte —
 * so the committed script both regenerates the fixture from a raw capture and
 * re-verifies the committed one (`script(scrub(fixture)) === scrub(fixture)`).
 *
 * Scrub rules applied to every record, in order:
 *
 *  R1 (prose) Every prose-bearing string — `result.text`, `result.error`,
 *     receipt finding `title`/`body`/`evidence`, non-local location
 *     `label`/`detail`, attestation `coverageScope`/`evidence`, unresolved
 *     `detail`, and `workspace.scope` — is replaced by a length-preserving
 *     `[sanitized]---…` placeholder (prefix-truncated below 11 chars), so the
 *     fixture keeps the real byte-length distribution without keeping any
 *     reviewer prose.
 *
 *  R2 (filesystem) `workspace.directory` is redacted to `<redacted>`.
 *
 *  R3 (judgment fields, PRR-020) Structured review-judgment content is
 *     neutralized: finding `severity` -> constant `LOW` and `riskImpact` ->
 *     constant `ORDINARY` (schema enums, so a fixed valid member), `riskTags`
 *     -> `[]`, location `line`/`endLine`/`column`/`endColumn` dropped
 *     (optional fields carrying the identifying line numbers),
 *     `envelope.outcome` re-derived deterministically from the retained
 *     envelope structure (unresolved => INCOMPLETE, findings => FINDINGS,
 *     otherwise CLEAN), and `terminalErrorClass` reduced to its schema-required
 *     `kind` enum plus a constant `category: 'sanitized'` (statusCode and
 *     hostRetryable dropped). `location.kind` and `terminalErrorClass.kind`
 *     are kept because the persisted schemas require those enum values.
 *
 *  R4 (lane names, PRR-020) Receipt-level workflow-lane references
 *     (`workflowLane`, `ownedWorkflowLanes`, `envelope.creditedLanes`,
 *     findings/attestations/unresolved `workflowLane`, and lane-name prefixes
 *     of finding ids) are renamed per record through an injective map to
 *     `sanitized-lane-<k>` (k by sorted distinct lane name), preserving every
 *     partition/coverage/uniqueness invariant the receipt schema enforces
 *     while hiding which lanes the captured run judged or attested.
 *
 *  R5 (digests and ids, PRR-019/PRR-022) After R1–R4 the script recomputes
 *     every derived value over the sanitized bytes so the fixture validates
 *     as a real ledger row set: `result.digest` = sha256(sanitized text)
 *     (wherever `text` is present), `outputRef` keeps its `L1:<sha256(
 *     batchId)>:<sha256(laneId)>` head but its third component becomes the
 *     sha256 of the SANITIZED text (equal to the recomputed digest — it was
 *     previously a byte-exactness oracle over the raw prose),
 *     `semanticEnvelopeDigest` = sha256(JSON.stringify(sanitized envelope)),
 *     and `terminalResult.eventId` = `bgc1:` + sha256(JSON.stringify(
 *     [correlationId, jobId, status, digest])) exactly as
 *     buildBackgroundCompletionEventId (src/background/pending-delegations.ts)
 *     derives it in production.
 *
 *  Preserved verbatim (structured identity, not judgment): ids
 *     (correlationId, jobId, session ids, callID, batchId, laneId), statuses,
 *     mode, workflowLaneFailureClass (closed schema enum), timestamps, hash
 *     fields, numeric counters, and finding `location.file` repo-relative
 *     paths. Record-level `workflowLane`/`ownedWorkflowLanes` are likewise
 *     preserved; only receipt-level lane references are renamed (R4).
 *
 * The script self-checks its output (R5 identities plus R1 placeholder shape)
 * and exits non-zero on any violation.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER = '[sanitized]';
const REDACTED_DIRECTORY = '<redacted>';
const OUTPUT_REF_PREFIX = 'L1';
const DEFAULT_OUTPUT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'tests',
	'fixtures',
	'background-delegations-2908.jsonl',
);

const sha256Hex = (value) =>
	createHash('sha256').update(value).digest('hex');

/** Length-preserving, idempotent prose placeholder (R1). */
function placeholder(value) {
	const filled = PLACEHOLDER.concat(
		'-'.repeat(Math.max(0, value.length - PLACEHOLDER.length)),
	);
	return filled.slice(0, value.length);
}

const PLACEHOLDER_RE = /^\[sanitized\]-*$/;

/** Production eventId derivation (buildBackgroundCompletionEventId, R5). */
function completionEventId(correlationId, jobId, status, resultDigest) {
	const canonical = JSON.stringify([correlationId, jobId, status, resultDigest]);
	return `bgc1:${sha256Hex(canonical)}`;
}

function deriveOutcome(envelope) {
	if (envelope.unresolved.length > 0) return 'INCOMPLETE';
	if (envelope.findings.length > 0) return 'FINDINGS';
	return 'CLEAN';
}

/** All lane-name strings referenced by this record's receipt(s) (R4). */
function collectReceiptLaneNames(record) {
	const names = new Set();
	for (const container of [record.result, record.terminalResult?.result]) {
		const receipt = container?.prReviewResultReceipt;
		if (!receipt) continue;
		names.add(receipt.workflowLane);
		for (const lane of receipt.ownedWorkflowLanes ?? []) names.add(lane);
		const envelope = receipt.envelope;
		for (const lane of envelope.creditedLanes ?? []) names.add(lane);
		for (const finding of envelope.findings ?? [])
			names.add(finding.workflowLane);
		for (const entry of envelope.cleanAttestations ?? [])
			names.add(entry.workflowLane);
		for (const entry of envelope.unresolved ?? [])
			names.add(entry.workflowLane);
	}
	return [...names].sort();
}

function renameLane(name, laneMap) {
	return laneMap.get(name) ?? name;
}

/** Longest-first so one lane name cannot shadow another as an id prefix. */
function renameFindingId(id, laneMap) {
	const names = [...laneMap.keys()].sort((a, b) => b.length - a.length);
	for (const name of names) {
		if (id.startsWith(`${name}-`)) {
			return `${laneMap.get(name)}${id.slice(name.length)}`;
		}
	}
	return id;
}

function scrubReceipt(receipt, laneMap) {
	receipt.workflowLane = renameLane(receipt.workflowLane, laneMap);
	if (Array.isArray(receipt.ownedWorkflowLanes)) {
		receipt.ownedWorkflowLanes = receipt.ownedWorkflowLanes.map((lane) =>
			renameLane(lane, laneMap),
		);
	}
	const envelope = receipt.envelope;
	envelope.outcome = deriveOutcome(envelope);
	envelope.creditedLanes = envelope.creditedLanes.map((lane) =>
		renameLane(lane, laneMap),
	);
	for (const finding of envelope.findings) {
		finding.id = renameFindingId(finding.id, laneMap);
		finding.workflowLane = renameLane(finding.workflowLane, laneMap);
		finding.severity = 'LOW';
		finding.riskImpact = 'ORDINARY';
		finding.riskTags = [];
		finding.title = placeholder(finding.title);
		finding.body = placeholder(finding.body);
		finding.evidence = placeholder(finding.evidence);
		const location = finding.location;
		if (location.kind === 'local') {
			delete location.line;
			delete location.endLine;
			delete location.column;
			delete location.endColumn;
		} else {
			location.label = placeholder(location.label);
			location.detail = placeholder(location.detail);
		}
	}
	for (const attestation of envelope.cleanAttestations) {
		attestation.workflowLane = renameLane(attestation.workflowLane, laneMap);
		attestation.coverageScope = placeholder(attestation.coverageScope);
		attestation.evidence = placeholder(attestation.evidence);
	}
	for (const entry of envelope.unresolved) {
		entry.workflowLane = renameLane(entry.workflowLane, laneMap);
		entry.detail = placeholder(entry.detail);
	}
	receipt.semanticEnvelopeDigest = sha256Hex(JSON.stringify(envelope));
}

function scrubResultPayload(result) {
	if (typeof result.text === 'string') {
		result.text = placeholder(result.text);
		result.digest = sha256Hex(result.text);
	}
	if (typeof result.error === 'string') {
		result.error = placeholder(result.error);
	}
	if (typeof result.outputArtifactError === 'string') {
		result.outputArtifactError = placeholder(result.outputArtifactError);
	}
	if (result.terminalErrorClass) {
		result.terminalErrorClass = {
			kind: result.terminalErrorClass.kind,
			category: 'sanitized',
		};
	}
	if (
		typeof result.outputRef === 'string' &&
		typeof result.digest === 'string'
	) {
		const parts = result.outputRef.split(':');
		if (
			parts.length === 4 &&
			parts[0] === OUTPUT_REF_PREFIX &&
			parts[3] !== result.digest
		) {
			result.outputRef = `${parts[0]}:${parts[1]}:${parts[2]}:${result.digest}`;
		}
	}
}

function scrubRecord(record) {
	if (record.workspace) {
		record.workspace.directory = REDACTED_DIRECTORY;
		if (typeof record.workspace.scope === 'string') {
			record.workspace.scope = placeholder(record.workspace.scope);
		}
	}
	const laneMap = new Map(
		collectReceiptLaneNames(record).map(
			(name, index) => [name, `sanitized-lane-${index + 1}`],
		),
	);
	for (const container of [record.result, record.terminalResult?.result]) {
		if (!container) continue;
		scrubResultPayload(container);
		if (container.prReviewResultReceipt) {
			scrubReceipt(container.prReviewResultReceipt, laneMap);
		}
	}
	if (record.terminalResult?.result) {
		record.terminalResult.eventId = completionEventId(
			record.correlationId,
			record.jobId,
			record.terminalResult.status,
			record.terminalResult.result.digest,
		);
	}
	return record;
}

/** Post-scrub self-check: the output must validate as a real ledger row set. */
function assertSelfConsistent(record, lineNumber) {
	const where = `line ${lineNumber} (${record.correlationId})`;
	const terminal = record.terminalResult;
	if (terminal?.result) {
		const expected = completionEventId(
			record.correlationId,
			record.jobId,
			terminal.status,
			terminal.result.digest,
		);
		if (terminal.eventId !== expected) {
			throw new Error(`${where}: eventId does not match production derivation`);
		}
	}
	for (const container of [record.result, terminal?.result]) {
		if (!container) continue;
		if (
			typeof container.text === 'string' &&
			!PLACEHOLDER_RE.test(container.text)
		) {
			throw new Error(`${where}: result.text was not sanitized`);
		}
		if (
			typeof container.outputRef === 'string' &&
			typeof container.digest === 'string' &&
			container.outputRef.split(':')[3] !== container.digest
		) {
			throw new Error(`${where}: outputRef third component != text digest`);
		}
		const receipt = container.prReviewResultReceipt;
		if (
			receipt &&
			receipt.semanticEnvelopeDigest !==
				sha256Hex(JSON.stringify(receipt.envelope))
		) {
			throw new Error(`${where}: semanticEnvelopeDigest is stale`);
		}
	}
}

function main() {
	const inputPath = process.argv[2];
	if (!inputPath) {
		console.error(
			'usage: scrub-delegation-fixture-2908.mjs <raw-capture.jsonl> [output.jsonl]',
		);
		process.exitCode = 2;
		return;
	}
	const outputPath = process.argv[3] ?? DEFAULT_OUTPUT;
	const raw = fs.readFileSync(inputPath, 'utf-8');
	const lines = raw.split('\n');
	if (lines.at(-1) === '') lines.pop();
	const outLines = [];
	for (const [index, line] of lines.entries()) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const record = scrubRecord(JSON.parse(trimmed));
		assertSelfConsistent(record, index + 1);
		outLines.push(JSON.stringify(record));
	}
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(outputPath, `${outLines.join('\n')}\n`);
	console.log(
		`scrubbed ${outLines.length} records -> ${path.relative(process.cwd(), outputPath)}`,
	);
}

main();
