import { describe, expect, test } from 'bun:test';
import {
	applySystemRenderBoundary,
	createSystemRenderBoundaryHook,
	resolveSystemRenderCapability,
} from '../../../src/hooks/system-render-boundary';

const BASE =
	'You are OpenCode, an agent. Base prompt bytes that the host pre-joined.';

function modelFixture(overrides: {
	id?: string;
	providerID?: string;
}): Record<string, unknown> {
	return {
		id: overrides.id ?? 'some-model',
		providerID: overrides.providerID ?? 'some-provider',
		api: { id: 'x', url: 'http://x', npm: '@ai-sdk/x' },
	};
}

describe('resolveSystemRenderCapability (#2673 ladder)', () => {
	test('strict families: qwen and gemma model ids resolve strict', () => {
		expect(
			resolveSystemRenderCapability(
				modelFixture({ id: 'qwen3.6-32b', providerID: 'vllm-local' }),
			),
		).toBe('strict-single-system');
		expect(
			resolveSystemRenderCapability(
				modelFixture({ id: 'Qwen2.5-72B-Instruct', providerID: 'lmstudio' }),
			),
		).toBe('strict-single-system');
		expect(
			resolveSystemRenderCapability(
				modelFixture({ id: 'gemma-3-4b', providerID: 'ollama-local' }),
			),
		).toBe('strict-single-system');
	});

	test('family token must start a segment, not hide inside another word', () => {
		expect(
			resolveSystemRenderCapability(modelFixture({ id: 'notqwen-plus' })),
		).toBe('multi-system');
		expect(
			resolveSystemRenderCapability(modelFixture({ id: 'mistral-qwen-32b' })),
		).toBe('strict-single-system');
	});

	test('ladder symmetry: a cache-capable provider vetoes a strict-family id (gateway relabel lock)', () => {
		expect(
			resolveSystemRenderCapability(
				modelFixture({ id: 'qwen-via-gateway', providerID: 'anthropic' }),
			),
		).toBe('multi-system');
		expect(
			resolveSystemRenderCapability(
				modelFixture({ id: 'qwen3.6-32b', providerID: 'anthropic-compatible' }),
			),
		).toBe('multi-system');
	});

	test('a strict family behind a non-cache provider resolves strict (openrouter lock)', () => {
		expect(
			resolveSystemRenderCapability(
				modelFixture({ id: 'qwen/qwen3.6-32b', providerID: 'openrouter' }),
			),
		).toBe('strict-single-system');
	});

	test('unknown models and unreadable input fail open to multi-system', () => {
		expect(
			resolveSystemRenderCapability(
				modelFixture({ id: 'gpt-x', providerID: 'openai' }),
			),
		).toBe('multi-system');
		expect(resolveSystemRenderCapability(undefined)).toBe('multi-system');
		expect(resolveSystemRenderCapability(null)).toBe('multi-system');
		expect(resolveSystemRenderCapability('a string')).toBe('multi-system');
		expect(resolveSystemRenderCapability({ id: 42, providerID: {} })).toBe(
			'multi-system',
		);
	});
});

describe('applySystemRenderBoundary (#2673 in-place collapse)', () => {
	test('strict model collapses >1 entries to exactly one, in place, joined with a blank line', () => {
		const system = [BASE, 'A', 'B'];
		const identity = system;
		const result = applySystemRenderBoundary(
			modelFixture({ id: 'qwen3.6-32b', providerID: 'vllm-local' }),
			system,
		);
		expect(system).toBe(identity);
		expect(system).toHaveLength(1);
		expect(system[0]).toBe(`${BASE}\n\nA\n\nB`);
		expect(result).toEqual({
			capability: 'strict-single-system',
			entriesBefore: 3,
			entriesAfter: 1,
			collapsed: true,
		});
	});

	test('strict collapse drops empty-string entries without touching content', () => {
		const system = [BASE, '', 'A', ''];
		applySystemRenderBoundary(modelFixture({ id: 'gemma-3-4b' }), system);
		expect(system).toHaveLength(1);
		expect(system[0]).toBe(`${BASE}\n\nA`);
	});

	test('no-op at length <= 1 even for strict models', () => {
		const single = [BASE];
		const result = applySystemRenderBoundary(
			modelFixture({ id: 'qwen3.6-32b' }),
			single,
		);
		expect(single).toEqual([BASE]);
		expect(result.collapsed).toBe(false);
		const empty: string[] = [];
		const emptyResult = applySystemRenderBoundary(
			modelFixture({ id: 'qwen3.6-32b' }),
			empty,
		);
		expect(empty).toEqual([]);
		expect(emptyResult.collapsed).toBe(false);
	});

	test('multi-system models: the array is left byte-identical (cache breakpoints preserved)', () => {
		const system = [BASE, '[guidance] entry'];
		const snapshot = [...system];
		const result = applySystemRenderBoundary(
			modelFixture({ id: 'claude-sonnet-4-6', providerID: 'anthropic' }),
			system,
		);
		expect(system).toEqual(snapshot);
		expect(system[0]).toBe(BASE);
		expect(result.collapsed).toBe(false);
		expect(result.capability).toBe('multi-system');
	});

	test('falsifiability: removing the strict branch (multi everywhere) leaves the array untouched', () => {
		// The pure-seam counterpart of a mutation test: feed the boundary the
		// SAME entries with a model the ladder does NOT classify strict, and
		// assert nothing collapses. If the strict branch were deleted, the
		// strict tests above fail and this one documents the flip side.
		const system = [BASE, 'A'];
		applySystemRenderBoundary(modelFixture({ id: 'unknown-model' }), system);
		expect(system).toEqual([BASE, 'A']);
	});

	test('non-array system input is a safe no-op', () => {
		const result = applySystemRenderBoundary(
			modelFixture({ id: 'qwen3.6-32b' }),
			undefined as unknown as string[],
		);
		expect(result.collapsed).toBe(false);
	});
});

describe('createSystemRenderBoundaryHook (#2673 registered shape)', () => {
	test('hook collapses via the shared output.system array (host visibility, #1619 discipline)', async () => {
		const hook = createSystemRenderBoundaryHook();
		const output = { system: [BASE, '[spec-drift]\nReason: hash mismatch'] };
		await hook['experimental.chat.system.transform'](
			{
				sessionID: 's1',
				model: modelFixture({ id: 'qwen3.6-32b', providerID: 'vllm-local' }),
			},
			output,
		);
		expect(output.system).toHaveLength(1);
		expect(output.system[0]).toContain('[spec-drift]\nReason: hash mismatch');
	});

	test('hook leaves a cache-capable model untouched', async () => {
		const hook = createSystemRenderBoundaryHook();
		const output = { system: [BASE, 'A'] };
		await hook['experimental.chat.system.transform'](
			{
				sessionID: 's2',
				model: modelFixture({ id: 'claude-x', providerID: 'anthropic' }),
			},
			output,
		);
		expect(output.system).toEqual([BASE, 'A']);
	});

	test('missing model leaves the surface untouched (fail-open, observable path)', async () => {
		const hook = createSystemRenderBoundaryHook();
		const output = { system: [BASE, 'A'] };
		await hook['experimental.chat.system.transform'](
			{ sessionID: 's3' },
			output,
		);
		expect(output.system).toEqual([BASE, 'A']);
		await hook['experimental.chat.system.transform']({}, output);
		expect(output.system).toEqual([BASE, 'A']);
	});

	test('a throwing output shape does not escape the hook (fail-open catch)', async () => {
		const hook = createSystemRenderBoundaryHook();
		const poisoned = {
			get system(): string[] {
				throw new Error('poisoned getter');
			},
		};
		await expect(
			hook['experimental.chat.system.transform'](
				{ model: modelFixture({ id: 'qwen3.6-32b' }) },
				poisoned,
			),
		).resolves.toBeUndefined();
	});
});
