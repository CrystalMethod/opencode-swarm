/**
 * Epic v2 C5 — the planner's inputs beyond the plan, read ONCE per planning
 * call by both callers of the component planner (`epic_next_wave` and the
 * `/swarm epic start` sizing dry-run) so the two plan with the same
 * signals:
 *
 *   - hot modules: calibration's learned hot modules (tasks touching them
 *     run alone) when `turbo.epic.calibration.enabled` is not false;
 *   - co-change: the git co-change pairs + threshold when
 *     `turbo.epic.cochange.enabled` (null otherwise ⇒ path-only conflicts);
 *   - density threshold: `turbo.epic.mode.activation_threshold` — the
 *     intra-component density above which a component runs serially.
 *
 * A failed read degrades to "no signal" (no hot modules / path-only), the
 * same fail-open the planner always had for these optional signals; the
 * wave verdict still guards every issued wave. The sources are injected so
 * each caller keeps its own `_internals` DI seam.
 */

import type { PluginConfig } from '../../config/schema.js';
import type { CalibrationState } from './calibration.js';
import { effectiveHotModules } from './calibration-engine.js';
import type { CoChangeData } from './cochange-source.js';
import {
	DEFAULT_EPIC_DENSITY_THRESHOLD,
	type EpicCochangeSignal,
} from './components.js';
import { isEpicCochangeConfigEnabled } from './config-gate.js';

/** Default co-change threshold (`turbo.epic.cochange.*` schema defaults). */
const DEFAULT_COCHANGE_NPMI = 0.6;
const DEFAULT_MIN_CO_CHANGES = 5;

export interface EpicPlanningSignals {
	hotModules: string[];
	cochange: EpicCochangeSignal | null;
	densityThreshold: number;
}

export interface EpicPlanningSignalSources {
	loadCalibrationState: (directory: string) => CalibrationState | null;
	getCoChangeData: (directory: string) => Promise<CoChangeData>;
}

export async function loadEpicPlanningSignals(
	directory: string,
	config: Pick<PluginConfig, 'turbo'>,
	sources: EpicPlanningSignalSources,
): Promise<EpicPlanningSignals> {
	const epic = config.turbo?.epic;
	let hotModules: string[] = [];
	if (epic?.calibration?.enabled !== false) {
		try {
			hotModules = effectiveHotModules(
				[],
				sources.loadCalibrationState(directory),
			);
		} catch {
			hotModules = [];
		}
	}
	let cochange: EpicCochangeSignal | null = null;
	if (isEpicCochangeConfigEnabled(config)) {
		try {
			const data = await sources.getCoChangeData(directory);
			cochange = {
				pairs: data.pairs,
				threshold: {
					npmi: epic?.cochange?.threshold ?? DEFAULT_COCHANGE_NPMI,
					minCoChanges:
						epic?.cochange?.min_co_changes ?? DEFAULT_MIN_CO_CHANGES,
				},
			};
		} catch {
			cochange = null;
		}
	}
	return {
		hotModules,
		cochange,
		densityThreshold:
			epic?.mode?.activation_threshold ?? DEFAULT_EPIC_DENSITY_THRESHOLD,
	};
}
