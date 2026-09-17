import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_NOTES = path.resolve(
	process.cwd(),
	'docs/releases/v7.165.0.md',
);

describe('issue-tracer v2-to-v3 migration guidance (#2566)', () => {
	test('preserves the legacy warning, v3 destination, and reinitialization path', () => {
		const contents = fs.readFileSync(MIGRATION_NOTES, 'utf8');
		const migrationHeading = '## Migration notes';
		const migrationStart = contents.indexOf(migrationHeading);
		expect(migrationStart).toBeGreaterThanOrEqual(0);
		const afterMigrationHeading = contents.slice(
			migrationStart + migrationHeading.length,
		);
		const nextHeadingOffset = afterMigrationHeading.search(/^#{1,6}\s/m);
		const migrationEnd =
			nextHeadingOffset === -1
				? contents.length
				: migrationStart + migrationHeading.length + nextHeadingOffset;
		const migration = contents.slice(migrationStart, migrationEnd);

		expect(migration).toContain('.claude/issue-traces/');
		expect(migration).toContain('.agents/issue-traces/');
		expect(migration).toContain('not migrated');
		expect(migration).toContain('legacy trace');
		expect(migration).toContain('warnings rather than enforced');
		expect(migration).toContain('re-initialize with `trace-init.sh`');
		expect(migration).toContain('v3 schema');
	});
});
