/**
 * Issue #2971: parse-time base/micro workflow-lane namespace disjointness on
 * the async dispatch schema. A base dispatch cannot carry a micro trigger id
 * and vice versa — the invalid namespace must fail ARGUMENT PARSING (before a
 * child session is created), while generic (non-PR-review) modes keep the
 * free-form lane label.
 *
 * Tier-0 pure schema testing: `_test_exports.DispatchLanesAsyncArgsSchema`
 * needs no mocks, no temp directories, and no clock.
 */

import { describe, expect, test } from 'bun:test';
import { _test_exports } from '../../../src/tools/dispatch-lanes.js';

const { DispatchLanesAsyncArgsSchema } = _test_exports;

const BASE_DIMENSION = 'intent-architecture';
const OTHER_BASE_DIMENSION = 'security-trust';
const MICRO_TRIGGER = 'auth-identity-secrets';
const OTHER_MICRO_TRIGGER = 'subprocess-platform';

function baseArgs(
	mode: string | undefined,
	lane: {
		workflowLane?: string;
		ownedWorkflowLanes?: string[];
	},
): Record<string, unknown> {
	return {
		batch_id: 'namespace-probe',
		...(mode ? { mode } : {}),
		lanes: [
			{
				id: 'lane-ns-1',
				agent: 'explorer',
				prompt: 'Namespace disjointness probe prompt.',
				...(lane.workflowLane ? { workflow_lane: lane.workflowLane } : {}),
				...(lane.ownedWorkflowLanes
					? { owned_workflow_lanes: lane.ownedWorkflowLanes }
					: {}),
			},
		],
	};
}

function rejectionMessage(args: Record<string, unknown>): string {
	const parsed = DispatchLanesAsyncArgsSchema.safeParse(args);
	expect(parsed.success).toBe(false);
	const issues = parsed.success ? [] : parsed.error.issues;
	return issues.map((issue) => issue.message).join('; ');
}

describe('dispatch_lanes_async workflow-lane namespace disjointness (issue #2971)', () => {
	test('base mode rejects a micro trigger id and names the base dimension vocabulary', () => {
		const message = rejectionMessage(
			baseArgs('swarm-pr-review:base', { workflowLane: MICRO_TRIGGER }),
		);
		expect(message).toContain(
			`lane workflow label "${MICRO_TRIGGER}" is not a base dimension id`,
		);
		expect(message).toContain('valid ids:');
		// The refusal must TEACH the vocabulary, not just reject the label.
		expect(message).toContain(BASE_DIMENSION);
		expect(message).toContain('compatibility-delivery');
	});

	test('micro mode rejects a base dimension id and names the micro trigger vocabulary', () => {
		const message = rejectionMessage(
			baseArgs('swarm-pr-review:micro', { workflowLane: BASE_DIMENSION }),
		);
		expect(message).toContain(
			`lane workflow label "${BASE_DIMENSION}" is not a micro trigger id`,
		);
		expect(message).toContain('valid ids:');
		expect(message).toContain(MICRO_TRIGGER);
		expect(message).toContain('unclassified-risk');
	});

	test('in-namespace controls parse: base+base and micro+micro', () => {
		expect(
			DispatchLanesAsyncArgsSchema.safeParse(
				baseArgs('swarm-pr-review:base', { workflowLane: BASE_DIMENSION }),
			).success,
		).toBe(true);
		expect(
			DispatchLanesAsyncArgsSchema.safeParse(
				baseArgs('swarm-pr-review:micro', { workflowLane: MICRO_TRIGGER }),
			).success,
		).toBe(true);
	});

	test('generic modes keep the free-form lane label in both vocabularies', () => {
		for (const label of [BASE_DIMENSION, MICRO_TRIGGER]) {
			for (const mode of ['advisory', 'deep-dive', undefined]) {
				expect(
					DispatchLanesAsyncArgsSchema.safeParse(
						baseArgs(mode, { workflowLane: label }),
					).success,
				).toBe(true);
			}
		}
		// A bare "swarm-pr-review" mode (no colon suffix) does not enter the
		// PR-review namespace convention — the parse-time gate stays silent.
		expect(
			DispatchLanesAsyncArgsSchema.safeParse(
				baseArgs('swarm-pr-review', { workflowLane: MICRO_TRIGGER }),
			).success,
		).toBe(true);
	});

	test('owned_workflow_lanes cross-namespace labels are rejected too', () => {
		// Base-mode owned set smuggling a micro trigger id.
		const baseMessage = rejectionMessage(
			baseArgs('swarm-pr-review:base', {
				workflowLane: BASE_DIMENSION,
				ownedWorkflowLanes: [
					BASE_DIMENSION,
					OTHER_BASE_DIMENSION,
					MICRO_TRIGGER,
				],
			}),
		);
		expect(baseMessage).toContain(
			`lane workflow label "${MICRO_TRIGGER}" is not a base dimension id`,
		);
		// Micro-mode owned set smuggling a base dimension id.
		const microMessage = rejectionMessage(
			baseArgs('swarm-pr-review:micro', {
				workflowLane: MICRO_TRIGGER,
				ownedWorkflowLanes: [
					MICRO_TRIGGER,
					OTHER_MICRO_TRIGGER,
					BASE_DIMENSION,
				],
			}),
		);
		expect(microMessage).toContain(
			`lane workflow label "${BASE_DIMENSION}" is not a micro trigger id`,
		);
	});
});
