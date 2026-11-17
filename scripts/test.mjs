import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Expand test filenames ourselves: Windows cmd does not expand globs and
// Node.js 20 does not support the same --test glob syntax as newer releases.
// Opt-in GPU integration scripts deliberately do not match *.test.mjs.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(root, 'tests', name));
if (!files.length) throw new Error('No unit tests found.');
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
