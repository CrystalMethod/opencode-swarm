/**
 * /swarm pr-feedback-loop — operator surface for the settling loop (#2502).
 *
 * `stop <reason...>` is the human stop: it cancels any armed publication via
 * the #2584 route (fail-open), marks the session's loop correlations terminal
 * `cancelled` with the operator-visible reason, clears claimed-but-unsettled
 * queue events, and writes an atomic cleanup receipt. Idempotent.
 *
 * Human-only by design (toolPolicy restricted): stopping an autonomous loop is
 * an operator decision; the agent must ask you to run it.
 */
import { cancelPrFeedbackLoop } from '../background/pr-feedback-loop';

const USAGE = `Usage:
  /swarm pr-feedback-loop stop <reason...>

Stops the autonomous PR babysitting settling loop for the current session:
- cancels any armed publication generation via the audited no-publish route (#2584);
- records a terminal 'cancelled' state with the operator-visible reason;
- clears claimed-but-unsettled monitor events from the session queue;
- writes an atomic cleanup receipt under .swarm/pr-feedback-loop-cleanups/.

The reason is mandatory and must be non-empty.`;

export async function handlePrFeedbackLoopCommand(
	directory: string,
	args: string[],
	sessionID: string,
): Promise<string> {
	const subcommand = args[0];
	const reason = args.slice(1).join(' ').trim();

	if (subcommand !== 'stop') {
		return `Error: unknown or missing subcommand (expected 'stop')\n\n${USAGE}`;
	}
	if (!reason) {
		return `Error: stop requires a non-empty reason\n\n${USAGE}`;
	}

	const result = await cancelPrFeedbackLoop(directory, sessionID, reason);
	return [
		'PR feedback loop stopped.',
		`Terminal state: ${result.terminalState}`,
		`Reason: ${result.reason}`,
		`Cleared queued events: ${result.cleanupReceipt.clearedEvents.length}`,
		result.cleanupReceipt.clearedEvents.length > 0
			? `Tokens: ${result.cleanupReceipt.clearedEvents.join(', ')}`
			: '',
		`Cleanup receipt: ${result.cleanupReceipt.path || '(write failed — see warnings)'}`,
		'No new wakes will be issued for this session. A wake already in flight may still surface; the workflow gate refuses pushes against a cancelled generation.',
	]
		.filter((line) => line !== '')
		.join('\n');
}
