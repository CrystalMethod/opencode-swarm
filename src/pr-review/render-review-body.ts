/**
 * Pure PR-review submission body renderer (issue #3096, Workstream C PR 1/2).
 *
 * Renders settled PR-review findings into the GitHub PR Review submission body
 * plus the inline-comment plan. STRICTLY pure: no filesystem, no network, no
 * clock — authorization and transport live in `src/tools/pr-review-submission.ts`
 * so any future preview surface (e.g. #3097 post-abort export) can reuse this
 * module without submission authority.
 */

export const PR_REVIEW_INLINE_COMMENT_CAP = 20;

const SEVERITY_ORDER = [
	'CRITICAL',
	'HIGH',
	'MEDIUM',
	'LOW',
	'INFO',
	'NONE',
] as const;

type RendererSeverity = (typeof SEVERITY_ORDER)[number];

export interface RendererFinding {
	finding_id: string;
	status: string;
	file_line: string;
	evidence: string;
	next_action: string;
	severity?: string;
}

export interface RendererCoverage {
	kind: string;
	unresolved_dimensions: string[];
}

export interface RenderReviewBodyInput {
	run_id: string;
	pr_head_sha: string;
	verdict?: string;
	coverage: RendererCoverage;
	findings: RendererFinding[];
	/** Previously posted comment/review bodies; findings whose id already appears are skipped (AC4 dedupe). */
	existingComments?: string[];
}

export interface RenderedInlineComment {
	path: string;
	line: number;
	body: string;
	finding_id: string;
}

export interface RenderedReviewBody {
	body: string;
	inlineComments: RenderedInlineComment[];
	/** finding ids skipped because they already appear in existingComments. */
	skippedAsPosted: string[];
	/** inline comments dropped by the cap (disclosed in the body). */
	truncatedInlineComments: number;
}

interface ParsedLocation {
	path: string;
	line: number;
}

function parseLocation(fileLine: string): ParsedLocation | null {
	const separator = fileLine.lastIndexOf(':');
	if (separator <= 0) return null;
	const lineText = fileLine.slice(separator + 1).trim();
	if (!/^\d+$/.test(lineText)) return null;
	const line = Number.parseInt(lineText, 10);
	if (!Number.isInteger(line) || line <= 0) return null;
	return { path: fileLine.slice(0, separator), line };
}

function severityOf(finding: RendererFinding): RendererSeverity {
	const value = (finding.severity ?? 'NONE').toUpperCase();
	return (SEVERITY_ORDER as readonly string[]).includes(value)
		? (value as RendererSeverity)
		: 'NONE';
}

function severityRank(severity: RendererSeverity): number {
	return SEVERITY_ORDER.indexOf(severity);
}

function singleLine(text: string, cap: number): string {
	const flattened = text.replace(/\s+/g, ' ').trim();
	return flattened.length > cap ? `${flattened.slice(0, cap - 1)}…` : flattened;
}

interface SurvivingFinding {
	finding: RendererFinding;
	location: ParsedLocation | null;
}

/**
 * Renderer-behavior constraints (AC4), applied in order:
 * 1. skip findings whose finding_id already appears in an existing comment body;
 * 2. consolidate a repeated finding_id to its first record;
 * 3. consolidate distinct findings with identical location + evidence into one
 *    comment (the first finding_id wins and names the group).
 */
function selectSurvivors(
	findings: readonly RendererFinding[],
	existingComments: readonly string[],
): { survivors: SurvivingFinding[]; skippedAsPosted: string[] } {
	const skippedAsPosted: string[] = [];
	const seenIds = new Set<string>();
	const seenLocations = new Set<string>();
	const survivors: SurvivingFinding[] = [];
	for (const finding of findings) {
		const id = finding.finding_id;
		if (existingComments.some((comment) => comment.includes(id))) {
			if (!seenIds.has(id)) skippedAsPosted.push(id);
			seenIds.add(id);
			continue;
		}
		if (seenIds.has(id)) continue;
		seenIds.add(id);
		const location = parseLocation(finding.file_line ?? '');
		const evidence = singleLine(finding.evidence ?? '', 400);
		const locationKey = location
			? `${location.path}:${location.line}:${evidence}`
			: `${finding.file_line ?? ''}:::${evidence}`;
		if (seenLocations.has(locationKey)) continue;
		seenLocations.add(locationKey);
		survivors.push({ finding, location });
	}
	return { survivors, skippedAsPosted };
}

export function renderPrReviewSubmissionBody(
	input: RenderReviewBodyInput,
): RenderedReviewBody {
	const existingComments = Array.isArray(input.existingComments)
		? input.existingComments
		: [];
	const { survivors, skippedAsPosted } = selectSurvivors(
		input.findings ?? [],
		existingComments,
	);

	// Stable severity grouping: rank first, input order within a group.
	const grouped = survivors
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => {
			const rankDiff =
				severityRank(severityOf(a.entry.finding)) -
				severityRank(severityOf(b.entry.finding));
			return rankDiff !== 0 ? rankDiff : a.index - b.index;
		})
		.map((row) => row.entry);

	const lines: string[] = [];
	lines.push(
		`PR review submission for run ${input.run_id} at head ${input.pr_head_sha}.` +
			(input.verdict ? ` Report verdict: ${input.verdict}.` : ''),
	);
	lines.push('');
	lines.push('## Findings');
	for (const severity of SEVERITY_ORDER) {
		const group = grouped.filter(
			(entry) => severityOf(entry.finding) === severity,
		);
		if (group.length === 0) continue;
		lines.push('');
		lines.push(`### ${severity}`);
		for (const entry of group) {
			lines.push(
				`- [${entry.finding.finding_id}] ${entry.finding.file_line} — ${singleLine(entry.finding.evidence ?? '', 400)}`,
			);
		}
	}

	lines.push('');
	lines.push('## Coverage');
	if (
		input.coverage?.kind &&
		input.coverage.kind !== 'FULL' &&
		Array.isArray(input.coverage.unresolved_dimensions) &&
		input.coverage.unresolved_dimensions.length > 0
	) {
		lines.push(`- Coverage kind: ${input.coverage.kind}`);
		lines.push(
			`- Unresolved dimensions: ${input.coverage.unresolved_dimensions.join(', ')}`,
		);
	} else {
		lines.push('- Coverage kind: FULL');
	}

	const commentable = grouped.filter((entry) => entry.location !== null);
	const capped = commentable.slice(0, PR_REVIEW_INLINE_COMMENT_CAP);
	const truncatedInlineComments = commentable.length - capped.length;
	if (truncatedInlineComments > 0) {
		lines.push('');
		lines.push(
			`> Truncated: ${truncatedInlineComments} finding(s) omitted from inline comments (inline comment cap: ${PR_REVIEW_INLINE_COMMENT_CAP}). All findings remain listed above.`,
		);
	}

	const inlineComments: RenderedInlineComment[] = capped.map((entry) => ({
		path: entry.location!.path,
		line: entry.location!.line,
		body: `[${entry.finding.finding_id}] ${singleLine(entry.finding.evidence ?? '', 400)}`,
		finding_id: entry.finding.finding_id,
	}));

	return {
		body: lines.join('\n'),
		inlineComments,
		skippedAsPosted,
		truncatedInlineComments,
	};
}
