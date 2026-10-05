import io

# 1. Remove the dead node:os import (its only use was replaced by canonicalMkdtemp).
p = 'tests/unit/tools/php-vendor-bin-launcher-3050.test.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = "import * as os from 'node:os';\n"
assert old in s, 'os import not found'
s = s.replace(old, '', 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('removed dead node:os import')

# 2. Refresh the PR body's now-stale descriptive numbers and complete the ledger.
import subprocess
body = subprocess.run(
	['gh', 'pr', 'view', '3057', '--repo', 'ZaxbyHub/opencode-swarm', '--json', 'body', '--jq', '.body'],
	capture_output=True, text=True, encoding='utf-8',
).stdout

def rep(a, b, why):
	global body
	assert a in body, 'MISSING: ' + why
	body = body.replace(a, b, 1)

rep('the longest new file is 327 lines against the 500 cap',
	'the longest new file is 442 lines against the 500 cap', 'line count')
rep('`biome ci .` 5102 files, no diagnostics',
	'`biome ci .` 5108 files, no diagnostics', 'biome count')
rep('`test-runner-gradle-launcher-3040` 7/0',
	'`test-runner-gradle-launcher-3040` 8/0', 'gradle count')
rep('- `test-runner-gradle-launcher-3040` 7/0, `test-runner-spawn-error-3039` 7/0.',
	'- `test-runner-gradle-launcher-3040` 8/0, `test-runner-spawn-error-3039` 7/0.', 'gradle count 2')
rep('(APPROVE_WITH_NOTES, seven groups). Both are closed in `88c74ce67`:',
	'(APPROVE_WITH_NOTES, seven groups). The fixes span `88c74ce67` and `3fdd50187`:', 'commit range')
rep("- The win32 command-length budget note above " + '\u2014' + " a real behaviour change, disclosed rather'\nthan silently absorbed.'",
	"- The win32 command-length budget note above " + '\u2014' + " a real behaviour change, disclosed rather'\nthan silently absorbed.'", 'noop') if False else None

io.open('prbody.txt', 'w', encoding='utf-8', newline='').write(body)
print('body refreshed, lines =', body.count('\n'))
