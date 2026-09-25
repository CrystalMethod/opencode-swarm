import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import { checkpoint } from '../tools/checkpoint.js';
import type { ToolResult } from '../tools/create-tool';

const CheckpointResultSchema = z
	.object({
		action: z.string().optional(),
		success: z.boolean(),
		error: z.string().optional(),
		checkpoints: z.array(z.unknown()).optional(),
	})
	.passthrough();

function safeParseResult(
	result: ToolResult,
): z.infer<typeof CheckpointResultSchema> {
	const jsonStr = typeof result === 'string' ? result : result.output;
	const parsed = CheckpointResultSchema.safeParse(JSON.parse(jsonStr));
	if (!parsed.success) {
		return {
			success: false,
			error: `Invalid response: ${parsed.error.message}`,
		};
	}
	return parsed.data;
}

/**
 * Handle /swarm checkpoint command
 * Creates, lists, restores, or deletes checkpoints with optional label
 */
export async function handleCheckpointCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const subcommand = args[0] || 'list';
	const label = args[1];
	const rest = args.slice(2);

	switch (subcommand) {
		case 'save':
			return handleSave(directory, label);
		case 'restore':
			return handleRestore(directory, label, rest);
		case 'delete':
			return handleDelete(directory, label);
		default:
			return handleList(directory);
	}
}

/** Extract --confirm=<token> / --yes from /swarm checkpoint restore args (#2946). */
function parseRestoreFlags(args: string[]): {
	confirmToken?: string;
	yes: boolean;
} {
	let confirmToken: string | undefined;
	let yes = false;
	for (const arg of args) {
		if (arg === '--yes') {
			yes = true;
			continue;
		}
		const match = /^--confirm=(.+)$/.exec(arg);
		if (match) confirmToken = match[1];
	}
	return { confirmToken, yes };
}

async function handleSave(directory: string, label?: string): Promise<string> {
	if (!label) {
		return 'Error: Label required. Usage: `/swarm checkpoint save <label>`';
	}

	try {
		const result = await checkpoint.execute({ action: 'save', label }, {
			directory,
		} as ToolContext);
		const parsed = safeParseResult(result);

		if (parsed.success) {
			return `✓ Checkpoint saved: "${label}"`;
		} else {
			return `Error: ${parsed.error || 'Failed to save checkpoint'}`;
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return `Error: ${msg}`;
	}
}

async function handleRestore(
	directory: string,
	label: string | undefined,
	extraArgs: string[] = [],
): Promise<string> {
	if (!label) {
		return 'Error: Label required. Usage: `/swarm checkpoint restore <label>`';
	}

	// #2946: a destructive restore (uncommitted tracked work present) previews
	// first and requires --confirm=<token> (or --yes) to execute. The token is
	// minted and consumed at the checkpoint tool sink; this wrapper only
	// passes it through and renders the preview honestly.
	const { confirmToken, yes } = parseRestoreFlags(extraArgs);
	if (yes && confirmToken) {
		return 'Error: pass either --yes or --confirm=<token>, not both.';
	}
	try {
		const result = await checkpoint.execute(
			confirmToken
				? { action: 'restore', label, confirm_token: confirmToken }
				: { action: 'restore', label },
			{ directory } as ToolContext,
		);
		const parsed = safeParseResult(result) as {
			success?: boolean;
			error?: string;
			requires_confirm?: boolean;
			preview?: string[];
			confirm_token?: string;
		};

		if (parsed.requires_confirm && parsed.confirm_token) {
			if (yes) {
				// --yes: consume the freshly minted token at the sink in the
				// same invocation (still digest-bound and single-use).
				const confirmed = await checkpoint.execute(
					{ action: 'restore', label, confirm_token: parsed.confirm_token },
					{ directory } as ToolContext,
				);
				const confirmedParsed = safeParseResult(confirmed);
				if (confirmedParsed.success) {
					return `✓ Restored to checkpoint: "${label}" (--yes)`;
				}
				return `Error: ${confirmedParsed.error || 'Failed to restore checkpoint'}`;
			}
			// Preview invocation: surface the tool-minted token.
			return [
				...(parsed.preview ?? []),
				'',
				`🔐 Nothing was restored. Re-run /swarm checkpoint restore ${label} --confirm=${parsed.confirm_token} (valid 15 minutes), or add --yes to confirm in one step.`,
			].join('\n');
		}
		if (parsed.success) {
			return `✓ Restored to checkpoint: "${label}"`;
		}
		if (yes && parsed.error?.includes('no pending purge')) {
			return `Error: ${parsed.error} Re-run /swarm checkpoint restore ${label} to get a fresh preview token.`;
		}
		return `Error: ${parsed.error || 'Failed to restore checkpoint'}`;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return `Error: ${msg}`;
	}
}

async function handleDelete(
	directory: string,
	label?: string,
): Promise<string> {
	if (!label) {
		return 'Error: Label required. Usage: `/swarm checkpoint delete <label>`';
	}

	try {
		const result = await checkpoint.execute({ action: 'delete', label }, {
			directory,
		} as ToolContext);
		const parsed = safeParseResult(result);

		if (parsed.success) {
			return `✓ Checkpoint deleted: "${label}"`;
		} else {
			return `Error: ${parsed.error || 'Failed to delete checkpoint'}`;
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return `Error: ${msg}`;
	}
}

async function handleList(directory: string): Promise<string> {
	try {
		const result = await checkpoint.execute({ action: 'list' }, {
			directory,
		} as ToolContext);
		const parsed = safeParseResult(result);

		if (!parsed.success) {
			return `Error: ${parsed.error || 'Failed to list checkpoints'}`;
		}

		const checkpoints = parsed.checkpoints || [];

		if (checkpoints.length === 0) {
			return 'No checkpoints found. Create one with `/swarm checkpoint save <label>`';
		}

		const lines = [
			'## Checkpoints',
			'',
			...checkpoints.map(
				// biome-ignore lint/suspicious/noExplicitAny: checkpoint shape from JSON.parse is untyped
				(c: any) =>
					`- "${c.label}" — ${new Date(c.timestamp).toLocaleString()}`,
			),
			'',
			'Commands:',
			'- `/swarm checkpoint save <label>` — Create checkpoint',
			'- `/swarm checkpoint restore <label>` — Restore checkpoint',
			'- `/swarm checkpoint delete <label>` — Delete checkpoint',
		];

		return lines.join('\n');
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return `Error: ${msg}`;
	}
}
