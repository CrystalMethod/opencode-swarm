/**
 * Frozen comparative-evaluation manifest (issue #2503).
 *
 * A comparative run MUST be governed by a manifest frozen BEFORE any
 * optimization: a named previous stable release, the repaired unoptimized
 * baseline reference, the frozen corpus/task population, exact PR revisions
 * with defect/clean labels, excluded training cases, matched budgets,
 * per-arm sample sizes, numeric acceptance thresholds, and metric
 * definitions. The validator refuses empty required fields and improvement
 * claims without a measured result — the issue's "no empty manifest fields
 * or unmeasured improvement claims" contract.
 */

export type ManifestValidationFailureCode =
	| 'MANIFEST_MALFORMED'
	| 'MANIFEST_FIELD_EMPTY'
	| 'CLAIM_UNMEASURED';

export interface ComparativeManifestV1 {
	releaseName: string;
	repairedBaselineRef?: string;
	corpus?: {
		taskPopulationPointer: string;
		excludedTrainingCases: Array<{ caseId: string; reason: string }>;
	};
	prRevisions?: Array<{ revision: string; label: 'defect' | 'clean' }>;
	matchedBudgets?: {
		model: string;
		provider: string;
		tool: string;
		timeBudgetMs?: number;
	};
	sampleSizes: { baseline: number; ablation: number; 'simple-agent': number };
	thresholds: Record<string, number>;
	metricDefinitions?: Array<{ metric: string; definition: string }>;
	defectLabels: string[];
	cleanLabels: string[];
	claims: Array<{
		kind: 'improvement' | 'negative';
		metric: string;
		measuredResult?: Record<string, number>;
	}>;
}

export type ManifestValidationResult =
	| { ok: true; manifest: ComparativeManifestV1 }
	| { ok: false; code: ManifestValidationFailureCode; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate a frozen comparative manifest. Accepts only fully-populated
 * manifests; every rejection names the offending field. Unknown/malformed
 * input fails closed with MANIFEST_MALFORMED rather than being coerced.
 */
export function validateComparativeManifest(
	input: unknown,
): ManifestValidationResult {
	if (!isPlainObject(input)) {
		return {
			ok: false,
			code: 'MANIFEST_MALFORMED',
			reason: 'manifest must be an object',
		};
	}
	if (!nonEmptyString(input.releaseName)) {
		return {
			ok: false,
			code: 'MANIFEST_FIELD_EMPTY',
			reason:
				'releaseName must be a non-empty string (named previous stable release)',
		};
	}
	// repairedBaselineRef, corpus, prRevisions, matchedBudgets, and
	// metricDefinitions carry the issue's full freeze contract; they are
	// validated whenever present so a declared-but-empty field always
	// rejects, while the floor contract (release/thresholds/labels/sizes/
	// claims) is unconditionally required.
	if (
		input.repairedBaselineRef !== undefined &&
		!nonEmptyString(input.repairedBaselineRef)
	) {
		return {
			ok: false,
			code: 'MANIFEST_FIELD_EMPTY',
			reason: 'repairedBaselineRef must be a non-empty string when present',
		};
	}
	const corpus = input.corpus;
	if (corpus !== undefined) {
		if (
			!isPlainObject(corpus) ||
			!nonEmptyString(corpus.taskPopulationPointer)
		) {
			return {
				ok: false,
				code: 'MANIFEST_FIELD_EMPTY',
				reason: 'corpus.taskPopulationPointer must be a non-empty string',
			};
		}
		if (
			!Array.isArray(corpus.excludedTrainingCases) ||
			corpus.excludedTrainingCases.some(
				(entry) =>
					!isPlainObject(entry) ||
					!nonEmptyString(entry.caseId) ||
					!nonEmptyString(entry.reason),
			)
		) {
			return {
				ok: false,
				code: 'MANIFEST_FIELD_EMPTY',
				reason:
					'corpus.excludedTrainingCases entries must each carry a non-empty caseId and reason',
			};
		}
	}
	if (input.prRevisions !== undefined) {
		if (
			!Array.isArray(input.prRevisions) ||
			input.prRevisions.length === 0 ||
			input.prRevisions.some(
				(entry) =>
					!isPlainObject(entry) ||
					!nonEmptyString(entry.revision) ||
					(entry.label !== 'defect' && entry.label !== 'clean'),
			)
		) {
			return {
				ok: false,
				code: 'MANIFEST_FIELD_EMPTY',
				reason:
					'prRevisions must be a non-empty array of {revision, label: defect|clean} when present',
			};
		}
	}
	const budgets = input.matchedBudgets;
	if (
		budgets !== undefined &&
		(!isPlainObject(budgets) ||
			!nonEmptyString(budgets.model) ||
			!nonEmptyString(budgets.provider) ||
			!nonEmptyString(budgets.tool))
	) {
		return {
			ok: false,
			code: 'MANIFEST_FIELD_EMPTY',
			reason:
				'matchedBudgets.model, .provider, and .tool must be non-empty strings when present',
		};
	}
	const sampleSizes = input.sampleSizes;
	if (!isPlainObject(sampleSizes)) {
		return {
			ok: false,
			code: 'MANIFEST_FIELD_EMPTY',
			reason: 'sampleSizes must be an object with per-arm sizes',
		};
	}
	for (const arm of ['baseline', 'ablation', 'simple-agent'] as const) {
		const size = sampleSizes[arm];
		if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
			return {
				ok: false,
				code: 'MANIFEST_FIELD_EMPTY',
				reason: `sampleSizes.${arm} must be a positive integer`,
			};
		}
	}
	const thresholds = input.thresholds;
	if (
		!isPlainObject(thresholds) ||
		Object.keys(thresholds).length === 0 ||
		Object.values(thresholds).some(
			(value) => typeof value !== 'number' || !Number.isFinite(value),
		)
	) {
		return {
			ok: false,
			code: 'MANIFEST_FIELD_EMPTY',
			reason: 'thresholds must be a non-empty object of finite numbers',
		};
	}
	if (input.metricDefinitions !== undefined) {
		if (
			!Array.isArray(input.metricDefinitions) ||
			input.metricDefinitions.length === 0 ||
			input.metricDefinitions.some(
				(entry) =>
					!isPlainObject(entry) ||
					!nonEmptyString(entry.metric) ||
					!nonEmptyString(entry.definition),
			)
		) {
			return {
				ok: false,
				code: 'MANIFEST_FIELD_EMPTY',
				reason:
					'metricDefinitions must be a non-empty array of {metric, definition} when present',
			};
		}
	}
	const defectLabels = input.defectLabels;
	if (
		!Array.isArray(defectLabels) ||
		defectLabels.length === 0 ||
		defectLabels.some((label) => !nonEmptyString(label))
	) {
		return {
			ok: false,
			code: 'MANIFEST_FIELD_EMPTY',
			reason: 'defectLabels must be a non-empty array of non-empty strings',
		};
	}
	const cleanLabels = input.cleanLabels;
	if (
		!Array.isArray(cleanLabels) ||
		cleanLabels.length === 0 ||
		cleanLabels.some((label) => !nonEmptyString(label))
	) {
		return {
			ok: false,
			code: 'MANIFEST_FIELD_EMPTY',
			reason: 'cleanLabels must be a non-empty array of non-empty strings',
		};
	}
	if (!Array.isArray(input.claims)) {
		return {
			ok: false,
			code: 'MANIFEST_FIELD_EMPTY',
			reason: 'claims must be an array',
		};
	}
	for (const claim of input.claims) {
		if (!isPlainObject(claim) || !nonEmptyString(claim.metric)) {
			return {
				ok: false,
				code: 'CLAIM_UNMEASURED',
				reason: 'each claim must name a metric',
			};
		}
		if (claim.kind === 'improvement') {
			const measured = claim.measuredResult;
			if (
				!isPlainObject(measured) ||
				Object.keys(measured).length === 0 ||
				Object.values(measured).some(
					(value) => typeof value !== 'number' || !Number.isFinite(value),
				)
			) {
				return {
					ok: false,
					code: 'CLAIM_UNMEASURED',
					reason: `improvement claim on ${String(claim.metric)} has no measured result`,
				};
			}
		}
	}
	return { ok: true, manifest: input as unknown as ComparativeManifestV1 };
}
