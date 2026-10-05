/**
 * Shared fixture helper for Lean Turbo phase-level evidence (issue #2954).
 *
 * Writes the integrated-diff evidence artifact that the phase-readiness
 * check 7 reads (src/turbo/lean/phase-ready.ts): `.swarm/evidence/<phase>/
 * lean-turbo/lean-turbo-phase.json` with a truthy `integratedDiffSummary` —
 * the same path the runner's writePhaseEvidence writes in production.
 * Since the `integrated_diff_required` default flipped to true (projected
 * from DEFAULT_LEAN_TURBO_CONFIG), no-config test fixtures must satisfy
 * check 7 to keep asserting their actual subject (checks 1-6, 8, 9).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export function writeLeanDiffEvidence(dir: string, phase: number): void {
	const evidenceDir = path.join(
		dir,
		'.swarm',
		'evidence',
		String(phase),
		'lean-turbo',
	);
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, 'lean-turbo-phase.json'),
		JSON.stringify({
			phase,
			integratedDiffSummary: 'fixture integrated diff summary',
		}),
	);
}
