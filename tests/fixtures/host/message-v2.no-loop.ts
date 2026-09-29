/**
 * NO-LOOP fixture for issue #2902: a valid TypeScript module that contains no
 * `for (const msg of input)` loop. Simulates a host release that renames,
 * moves, or removes the converter — the check must report SOURCE_NOT_FOUND,
 * never a silent pass (issue exit gate).
 */

export function toModelMessages(input: unknown[]): unknown[] {
	return [];
}
