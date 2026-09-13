import { describe, expect, test } from 'bun:test';
import { validateComparativeManifest } from '../../../src/services/harness-optimizer/manifest.js';

const fullManifest = {
	releaseName: 'release-7.179.0',
	repairedBaselineRef: 'main@87b5489e2',
	corpus: {
		taskPopulationPointer: 'tests/fixtures/memory-recall-heldout/manifest.json',
		excludedTrainingCases: [
			{ caseId: 'case-07', reason: 'reserved for follow-up' },
		],
	},
	prRevisions: [
		{ revision: 'pr-2736', label: 'defect' as const },
		{ revision: 'pr-2735', label: 'clean' as const },
	],
	matchedBudgets: { model: 'configured', provider: 'default', tool: 'bun' },
	sampleSizes: { baseline: 10, ablation: 10, 'simple-agent': 10 },
	thresholds: { minImprovementLowerCi: 0.05, maxProtectedRegressions: 0 },
	metricDefinitions: [
		{ metric: 'accepted_artifacts', definition: 'count of accepted artifacts' },
	],
	defectLabels: ['defect-present'],
	cleanLabels: ['clean'],
	claims: [
		{
			kind: 'improvement' as const,
			metric: 'accepted_artifacts',
			measuredResult: { lowerCi: 0.12, p: 0.01 },
		},
	],
};

describe('validateComparativeManifest', () => {
	test('accepts a fully-populated manifest', () => {
		const result = validateComparativeManifest(fullManifest);
		expect(result.ok).toBe(true);
	});

	test('rejects an empty or missing release name', () => {
		expect(
			validateComparativeManifest({ ...fullManifest, releaseName: '' }).ok,
		).toBe(false);
		expect(
			validateComparativeManifest({ ...fullManifest, releaseName: undefined })
				.ok,
		).toBe(false);
	});

	test('rejects empty thresholds', () => {
		expect(
			validateComparativeManifest({ ...fullManifest, thresholds: {} }).ok,
		).toBe(false);
	});

	test('rejects empty label sets', () => {
		expect(
			validateComparativeManifest({ ...fullManifest, defectLabels: [] }).ok,
		).toBe(false);
		expect(
			validateComparativeManifest({ ...fullManifest, cleanLabels: [] }).ok,
		).toBe(false);
	});

	test('rejects empty or partial sample sizes', () => {
		expect(
			validateComparativeManifest({ ...fullManifest, sampleSizes: {} }).ok,
		).toBe(false);
		expect(
			validateComparativeManifest({
				...fullManifest,
				sampleSizes: { baseline: 10, ablation: 10 },
			}).ok,
		).toBe(false);
		expect(
			validateComparativeManifest({
				...fullManifest,
				sampleSizes: { baseline: 0, ablation: 10, 'simple-agent': 10 },
			}).ok,
		).toBe(false);
	});

	test('rejects an improvement claim without a measured result', () => {
		const result = validateComparativeManifest({
			...fullManifest,
			claims: [{ kind: 'improvement', metric: 'accepted_artifacts' }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('CLAIM_UNMEASURED');
		}
	});

	test('rejects a non-finite threshold value', () => {
		expect(
			validateComparativeManifest({
				...fullManifest,
				thresholds: { minImprovementLowerCi: Number.NaN },
			}).ok,
		).toBe(false);
	});

	test('rejects malformed input outright', () => {
		expect(validateComparativeManifest(null).ok).toBe(false);
		expect(validateComparativeManifest('manifest').ok).toBe(false);
		expect(validateComparativeManifest([]).ok).toBe(false);
	});

	test('rejects a declared-but-empty optional freeze field', () => {
		expect(
			validateComparativeManifest({
				...fullManifest,
				repairedBaselineRef: '',
			}).ok,
		).toBe(false);
		expect(
			validateComparativeManifest({ ...fullManifest, prRevisions: [] }).ok,
		).toBe(false);
		expect(
			validateComparativeManifest({
				...fullManifest,
				matchedBudgets: { model: '', provider: 'p', tool: 't' },
			}).ok,
		).toBe(false);
		expect(
			validateComparativeManifest({ ...fullManifest, metricDefinitions: [] })
				.ok,
		).toBe(false);
	});
});
