/**
 * Independent oracle for the governed HarnessOpt capstone (issue #2503).
 *
 * Scores accepted task outcomes, artifact validity, verification evidence,
 * and completion quality SEPARATELY from the optimizer and from the task's
 * own scorer (src/evaluation/runner.ts scoreExecution). The oracle is the
 * acceptance backstop the issue demands: a candidate whose token count
 * improves while accepted artifact quality or verification evidence falls
 * MUST be rejected, with reasons naming each drop.
 */

export type TokenCount = number | 'unknown';

export interface OracleArmInput {
	/** Task-population denominator for the arm. */
	n: number;
	/** Count of accepted artifacts the arm produced. */
	acceptedArtifacts: number;
	/** Count of verification-evidence records backing those artifacts. */
	verificationEvidence: number;
	tokens: {
		input: TokenCount;
		cache: TokenCount;
		output: TokenCount;
	};
}

export interface OracleVerdict {
	verdict: 'accept' | 'reject';
	reasons: string[];
}

function totalTokens(tokens: OracleArmInput['tokens']): number | 'unknown' {
	const values = [tokens.input, tokens.cache, tokens.output];
	if (values.some((value) => value === 'unknown')) return 'unknown';
	return (values as number[]).reduce((sum, value) => sum + value, 0);
}

/**
 * Compare a candidate arm against the baseline arm. Acceptance requires
 * the candidate to be no worse on accepted artifacts, verification
 * evidence, or (when both arms report tokens) token usage. Any quality or
 * verification drop rejects the candidate regardless of token improvement.
 * Token totals reported as 'unknown' by the host are treated as unknown,
 * never zero, and therefore never counted as an improvement axis.
 */
export async function evaluateIndependentOracle(args: {
	baseline: OracleArmInput;
	candidate: OracleArmInput;
}): Promise<OracleVerdict> {
	const reasons: string[] = [];
	if (args.candidate.acceptedArtifacts < args.baseline.acceptedArtifacts) {
		reasons.push(
			`accepted artifact quality dropped: ${args.candidate.acceptedArtifacts} < ${args.baseline.acceptedArtifacts}`,
		);
	}
	if (
		args.candidate.verificationEvidence < args.baseline.verificationEvidence
	) {
		reasons.push(
			`verification evidence dropped: ${args.candidate.verificationEvidence} < ${args.baseline.verificationEvidence}`,
		);
	}
	const baselineTokens = totalTokens(args.baseline.tokens);
	const candidateTokens = totalTokens(args.candidate.tokens);
	if (
		baselineTokens !== 'unknown' &&
		candidateTokens !== 'unknown' &&
		candidateTokens > baselineTokens
	) {
		reasons.push(
			`token usage increased: ${candidateTokens} > ${baselineTokens}`,
		);
	}
	if (reasons.length > 0) {
		return { verdict: 'reject', reasons };
	}
	return { verdict: 'accept', reasons: [] };
}
