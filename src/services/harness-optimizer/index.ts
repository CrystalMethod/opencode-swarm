export type {
	ComparativeArmKey,
	ComparativeArmResult,
	ComparativeExecutor,
	ComparativeExecutorResult,
	ComparativeProtocolResult,
	ComparativeTaskDescriptor,
} from './comparative.js';
export {
	COMPARATIVE_ARM_KEYS,
	computeArmStreamDigest,
	computeTaskPopulationHash,
	runComparativeProtocol,
	StreamSnapshotDuplicateError,
} from './comparative.js';
export type {
	HarnessOptRoundResult,
	HarnessOptSplit,
	HarnessOptStatus,
	PilotGraduationRecord,
} from './controller.js';
export {
	evaluatePilotGraduation,
	FrozenTaskSetMismatchError,
	freezeHarnessOptTaskSet,
	harnessOptStatus,
	loadPilotGraduationRecord,
	runHarnessOptRound,
	stopHarnessOptLoop,
} from './controller.js';
export type { HarnessOptLineageRecord } from './lineage.js';
export {
	computeCandidateConfigDigest,
	computePromptSelectionDigest,
	listHarnessOptLineage,
	ReplayDecisionMismatchError,
	recordHarnessOptRound,
	replayHarnessOptLineage,
} from './lineage.js';
export type {
	ComparativeManifestV1,
	ManifestValidationFailureCode,
	ManifestValidationResult,
} from './manifest.js';
export { validateComparativeManifest } from './manifest.js';
export type { OracleArmInput, OracleVerdict, TokenCount } from './oracle.js';
export { evaluateIndependentOracle } from './oracle.js';
