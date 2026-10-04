/**
 * Epic Mode config master gates.
 *
 * `turbo.epic.mode.enabled` and `turbo.epic.cochange.enabled` are documented
 * as opt-in master gates (both default `false`). This module is the single
 * source of truth for reading them so every Epic entry point (slash commands,
 * architect tools, the hot-path seams, phase-complete readiness) agrees.
 *
 * Pure predicates take an already-loaded `PluginConfig`; callers that only
 * have a directory use the `*ForDirectory` variants, which load config via
 * `loadPluginConfigWithMeta` and fail closed (return `false`) if loading
 * throws.
 */

import { loadPluginConfigWithMeta } from '../../config/loader.js';
import type { PluginConfig } from '../../config/schema.js';

/** Remediation text shown when Epic Mode is used without the config opt-in. */
export const EPIC_MODE_CONFIG_DISABLED_MESSAGE =
	'Epic Mode is disabled by config. Set `turbo.epic.mode.enabled: true` in ' +
	'.opencode/opencode-swarm.json (or your user config) to opt in, then retry. ' +
	'The `turbo` block must also declare `"strategy": "standard"` (or ' +
	'`"strategy": "lean"` together with a `"lean": {}` block) — otherwise the ' +
	'whole block fails validation and is ignored. Example: ' +
	'`{ "turbo": { "strategy": "standard", "epic": { "mode": { "enabled": true } } } }`.';

/** True when `turbo.epic.mode.enabled === true`. Absent block ⇒ false. */
export function isEpicModeConfigEnabled(
	config: Pick<PluginConfig, 'turbo'> | null | undefined,
): boolean {
	return config?.turbo?.epic?.mode?.enabled === true;
}

/** True when `turbo.epic.cochange.enabled === true`. Absent block ⇒ false. */
export function isEpicCochangeConfigEnabled(
	config: Pick<PluginConfig, 'turbo'> | null | undefined,
): boolean {
	return config?.turbo?.epic?.cochange?.enabled === true;
}

export const _internals = {
	loadPluginConfigWithMeta,
};

/** Directory-keyed variant of {@link isEpicModeConfigEnabled}; fails closed. */
export function isEpicModeConfigEnabledForDirectory(
	directory: string,
): boolean {
	try {
		return isEpicModeConfigEnabled(
			_internals.loadPluginConfigWithMeta(directory).config,
		);
	} catch {
		return false;
	}
}
