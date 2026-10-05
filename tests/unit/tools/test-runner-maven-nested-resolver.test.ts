/**
 * resolveMavenModuleDir edge cases (PR #3021 feedback):
 * - W-CONTAIN: canonical (realpath) containment — a symlink/junction module
 *   dir that leads outside the project root is skipped.
 * - W-DOTDOT: only a real `..` path segment escapes; `..foo/` is in-root.
 * - W-CAP: hidden entries and node_modules are skipped BEFORE the probe cap.
 * - FB-T1: nearest pom wins, multi-file fallthrough/ordering, sort order.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	MAX_MAVEN_MODULE_PROBE_ENTRIES,
	resolveMavenModuleDir,
} from '../../../src/tools/test-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realRealpathSync = _internals.realpathSync;
const realReaddirSync = _internals.readdirSync;

let tempDirs: string[] = [];

function makeDir(prefix = 'maven-resolver-'): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

function createFile(dir: string, filePath: string, content = ''): void {
	const fullPath = path.join(dir, filePath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, content);
}

function linkDir(target: string, linkPath: string): void {
	fs.symlinkSync(
		target,
		linkPath,
		process.platform === 'win32' ? 'junction' : 'dir',
	);
}

/**
 * Directory links (junctions on Windows) need no privilege on supported CI
 * hosts, but a restricted host may refuse them; those tests are then SKIPPED
 * with a visible warning instead of passing without exercising anything.
 */
const canLinkDirs = ((): boolean => {
	const probe = canonicalMkdtemp('maven-resolver-link-probe-');
	try {
		fs.mkdirSync(path.join(probe, 'target'));
		linkDir(path.join(probe, 'target'), path.join(probe, 'link'));
		return true;
	} catch (error) {
		console.warn(
			`[test-runner-maven-nested-resolver] directory links unavailable; skipping real-link containment tests: ${String(error)}`,
		);
		return false;
	} finally {
		fs.rmSync(probe, { recursive: true, force: true });
	}
})();

afterEach(() => {
	_internals.realpathSync = realRealpathSync;
	_internals.readdirSync = realReaddirSync;
	for (const dir of tempDirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
	tempDirs = [];
});

describe('W-CONTAIN: canonical containment of the module dir', () => {
	test.skipIf(!canLinkDirs)(
		'a linked dir escaping the root is rejected (files and file-less)',
		() => {
			const root = makeDir();
			const outside = makeDir('maven-resolver-outside-');
			createFile(outside, 'pom.xml', '<project/>');
			createFile(outside, 'src/A.java', 'class A {}');
			linkDir(outside, path.join(root, 'link'));
			// Precondition: the lexical path really does expose the outside pom.
			expect(fs.existsSync(path.join(root, 'link', 'pom.xml'))).toBe(true);

			expect(resolveMavenModuleDir(root, ['link/src/A.java'])).toBeNull();
			expect(resolveMavenModuleDir(root)).toBeNull();
		},
	);

	test.skipIf(!canLinkDirs)(
		'an in-root linked module still resolves (lexical path returned)',
		() => {
			const root = makeDir();
			createFile(root, 'real-mod/pom.xml', '<project/>');
			createFile(root, 'real-mod/src/X.java', 'class X {}');
			linkDir(path.join(root, 'real-mod'), path.join(root, 'alias'));

			expect(resolveMavenModuleDir(root, ['alias/src/X.java'])).toBe(
				path.join(root, 'alias'),
			);
			// 'alias' sorts before 'real-mod' and is contained, so it wins.
			expect(resolveMavenModuleDir(root)).toBe(path.join(root, 'alias'));
		},
	);

	test.skipIf(!canLinkDirs)(
		'an escaping link "a" is skipped and the real module "b" is returned',
		() => {
			const root = makeDir();
			const outside = makeDir('maven-resolver-outside-');
			createFile(outside, 'pom.xml', '<project/>');
			linkDir(outside, path.join(root, 'a'));
			createFile(root, 'b/pom.xml', '<project/>');
			createFile(root, 'b/src/B.java', 'class B {}');

			expect(resolveMavenModuleDir(root)).toBe(path.join(root, 'b'));
			expect(
				resolveMavenModuleDir(root, ['a/src/A.java', 'b/src/B.java']),
			).toBe(path.join(root, 'b'));
		},
	);

	test('realpath escape via the _internals seam (host-independent)', () => {
		const root = makeDir();
		const outside = makeDir('maven-resolver-outside-');
		createFile(root, 'a/pom.xml', '<project/>');
		createFile(root, 'b/pom.xml', '<project/>');
		const escaping = path.join(root, 'a');
		_internals.realpathSync = ((p: fs.PathLike) =>
			p.toString() === escaping
				? outside
				: realRealpathSync(p)) as typeof _internals.realpathSync;

		expect(resolveMavenModuleDir(root)).toBe(path.join(root, 'b'));
		expect(resolveMavenModuleDir(root, ['a/src/A.java'])).toBeNull();
	});

	test('a module whose realpath is exactly the root parent ("..") is rejected', () => {
		const parent = makeDir();
		const root = path.join(parent, 'proj');
		fs.mkdirSync(root);
		createFile(parent, 'pom.xml', '<project/>');
		createFile(root, 'a/pom.xml', '<project/>');
		const linked = path.join(root, 'a');
		// path.relative(root, parent) === '..' exactly (no "../" suffix): only the
		// bare ".." clause of relativeEscapesRoot rejects it.
		_internals.realpathSync = ((p: fs.PathLike) =>
			p.toString() === linked
				? parent
				: realRealpathSync(p)) as typeof _internals.realpathSync;
		expect(path.relative(root, parent)).toBe('..');

		expect(resolveMavenModuleDir(root, ['a/src/A.java'])).toBeNull();
		expect(resolveMavenModuleDir(root)).toBeNull();
	});

	test('fails closed when the root itself cannot be realpath-resolved', () => {
		const root = makeDir();
		createFile(root, 'backend/pom.xml', '<project/>');
		_internals.realpathSync = ((p: fs.PathLike) => {
			if (p.toString() === root) throw new Error('EACCES');
			return realRealpathSync(p);
		}) as typeof _internals.realpathSync;

		expect(resolveMavenModuleDir(root)).toBeNull();
		expect(resolveMavenModuleDir(root, ['backend/src/A.java'])).toBeNull();
	});
});

describe('W-DOTDOT: only a real ".." segment escapes the root', () => {
	test('an in-root "..foo" directory resolves', () => {
		const root = makeDir();
		createFile(root, '..foo/pom.xml', '<project/>');
		createFile(root, '..foo/X.java', 'class X {}');

		expect(resolveMavenModuleDir(root, ['..foo/X.java'])).toBe(
			path.join(root, '..foo'),
		);
	});

	test('a real "../x" path outside the root still returns null', () => {
		const parent = makeDir();
		const root = path.join(parent, 'proj');
		fs.mkdirSync(root);
		createFile(parent, 'x/pom.xml', '<project/>');
		createFile(parent, 'x/A.java', 'class A {}');

		expect(resolveMavenModuleDir(root, ['../x/A.java'])).toBeNull();
	});
});

describe('W-CAP: file-less probe skipping and cap accounting', () => {
	test('101 hidden dirs do not exhaust the cap before a later module', () => {
		const root = makeDir();
		for (let i = 0; i <= MAX_MAVEN_MODULE_PROBE_ENTRIES; i++) {
			fs.mkdirSync(path.join(root, `.h${String(i).padStart(3, '0')}`));
		}
		createFile(root, '.idea/pom.xml', '<project/>');
		createFile(root, 'zmod/pom.xml', '<project/>');

		expect(resolveMavenModuleDir(root)).toBe(path.join(root, 'zmod'));
	});

	test('cap boundary: the module is found only within the first N non-hidden entries', () => {
		const atCap = makeDir();
		const underCap = makeDir();
		for (let i = 0; i < MAX_MAVEN_MODULE_PROBE_ENTRIES; i++) {
			const name = `d${String(i).padStart(3, '0')}`;
			fs.mkdirSync(path.join(atCap, name));
			if (i < MAX_MAVEN_MODULE_PROBE_ENTRIES - 1) {
				fs.mkdirSync(path.join(underCap, name));
			}
		}
		createFile(atCap, 'zmod/pom.xml', '<project/>');
		createFile(underCap, 'zmod/pom.xml', '<project/>');

		// N entries precede zmod -> zmod is entry N+1 -> beyond the cap.
		expect(resolveMavenModuleDir(atCap)).toBeNull();
		// N-1 entries precede zmod -> zmod is entry N -> inspected.
		expect(resolveMavenModuleDir(underCap)).toBe(path.join(underCap, 'zmod'));
	});

	test('node_modules/pom.xml and .git/pom.xml are never modules', () => {
		const root = makeDir();
		createFile(root, 'node_modules/pom.xml', '<project/>');
		createFile(root, '.git/pom.xml', '<project/>');

		expect(resolveMavenModuleDir(root)).toBeNull();

		createFile(root, 'svc/pom.xml', '<project/>');
		expect(resolveMavenModuleDir(root)).toBe(path.join(root, 'svc'));
	});

	test('entries are sorted before probing (c, a, b -> a)', () => {
		const root = makeDir();
		for (const name of ['c', 'a', 'b']) {
			createFile(root, `${name}/pom.xml`, '<project/>');
		}
		// Force an unsorted directory listing so the sort is what decides.
		_internals.readdirSync = (() => [
			'c',
			'a',
			'b',
		]) as unknown as typeof _internals.readdirSync;

		expect(resolveMavenModuleDir(root)).toBe(path.join(root, 'a'));
	});
});

describe('FB-T1: files-mode resolution order', () => {
	test('nearest pom wins over an enclosing pom on the same path', () => {
		const root = makeDir();
		createFile(root, 'services/pom.xml', '<project/>');
		createFile(root, 'services/backend/pom.xml', '<project/>');

		expect(
			resolveMavenModuleDir(root, ['services/backend/src/test/java/X.java']),
		).toBe(path.join(root, 'services', 'backend'));
	});

	test('an unresolvable first file falls through to the next file', () => {
		const root = makeDir();
		createFile(root, 'm1/pom.xml', '<project/>');

		expect(
			resolveMavenModuleDir(root, ['nomod/src/A.java', 'm1/src/B.java']),
		).toBe(path.join(root, 'm1'));
	});

	test('the first resolvable file decides, in caller order', () => {
		const root = makeDir();
		createFile(root, 'm1/pom.xml', '<project/>');
		createFile(root, 'm2/pom.xml', '<project/>');

		expect(resolveMavenModuleDir(root, ['m2/x/A.java', 'm1/x/B.java'])).toBe(
			path.join(root, 'm2'),
		);
		expect(resolveMavenModuleDir(root, ['m1/x/B.java', 'm2/x/A.java'])).toBe(
			path.join(root, 'm1'),
		);
	});
});
