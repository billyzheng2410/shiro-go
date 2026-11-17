import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ownGit = existsSync(join(root, '.git'));
const generatedDirectories = new Set(['.git', 'node_modules', 'engine', 'engine-cuda', 'engine-tensorrt', 'runtime', 'benchmarks', 'verification', 'tmp', 'screenshots', 'build', 'release', 'test-output']);

function filesystemSources(directory = root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!generatedDirectories.has(entry.name)) files.push(...filesystemSources(join(directory, entry.name)));
    } else files.push(relative(root, join(directory, entry.name)).replaceAll('\\', '/'));
  }
  return files;
}

function releaseFiles() {
  // Includes nonignored new source files before staging, but never an ancestor
  // repository. Ignored local runtimes are intentionally outside the release.
  if (!ownGit) return filesystemSources();
  return [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean))];
}

const files = releaseFiles();
// This exact image was visually reviewed: application content only, without
// browser chrome, personal files, usernames or other desktop applications.
const reviewedImages = new Set(['docs/screenshot.jpg']);
const reviewedLicenseTexts = new Set([
  'scripts/licenses/KataGo-MIT.txt',
  'scripts/licenses/KataGo-Network-License.html',
]);
const sourceAllowlist = /^(?:(?:README(?:\.[a-zA-Z-]+)?|THIRD_PARTY_NOTICES|CONTRIBUTING|SECURITY|CHANGELOG)\.md|LICENSE(?:\.md|\.txt)?|package(?:-lock)?\.json|\.(?:gitignore|gitattributes|editorconfig)|[^/]+\.(?:cmd|sh)|dist\/[\w./-]+\.(?:js|css|html|svg)|scripts\/[\w./-]+\.(?:mjs|js|ps1)|tests\/[\w./-]+\.(?:mjs|js)|docs\/[\w./-]+\.(?:md|json)|\.github\/(?:workflows\/[\w.-]+\.ya?ml|ISSUE_TEMPLATE\/[\w.-]+\.(?:md|ya?ml)))$/;

test('public source contains only the application allowlist, without runtimes, games or raw logs', () => {
  for (const required of ['server.mjs', 'katago.mjs', 'dist/index.html', 'dist/app.js', 'THIRD_PARTY_NOTICES.md']) assert.ok(files.includes(required), `Missing application source: ${required}`);
  for (const file of files) {
    const rootModule = /^(?:server|katago|setup-manager)\.mjs$/.test(file) || /^desktop\/[\w-]+\.cjs$/.test(file);
    assert.ok(rootModule || sourceAllowlist.test(file) || reviewedImages.has(file) || reviewedLicenseTexts.has(file), `Unreviewed publication path: ${file}`);
    assert.ok(statSync(join(root, file)).size < 2 * 1024 * 1024, `Source file unexpectedly exceeds 2 MiB: ${file}`);
    assert.doesNotMatch(file, /(?:^|\/)(?:engine(?:-[^/]+)?|runtime|benchmarks|verification|screenshots|node_modules)(?:\/|$)/i);
    if (!reviewedImages.has(file)) assert.doesNotMatch(file, /\.(?:exe|dll|bin|gz|zip|7z|log|sgf|png|jpe?g|webp|mp4|pdf)$/i);
  }
});

test('npm commands use portable paths rather than a developer machine runtime directory', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    assert.doesNotMatch(command, /(?:^|\s|=)[a-zA-Z]:[\\/]/, `Machine-specific drive path in npm script ${name}`);
  }
});

test('publishable text excludes credentials, private home paths and course-project contents', () => {
  const credential = /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
  const privateHome = /(?:\b[A-Za-z]:[\\/]+Users[\\/]+[^\s<>"']+|\/(?:Users|home)\/[a-zA-Z0-9_.-]+\/(?:\.codex|\.aws|\.ssh))/;
  const privateCourse = new RegExp(['comp', '424', 'final', 'project'].join('[-_]'), 'i');
  for (const file of files) {
    if (reviewedImages.has(file)) continue;
    const content = readFileSync(join(root, file), 'utf8');
    assert.doesNotMatch(content, credential, `Credential-like material in ${file}`);
    assert.doesNotMatch(content, privateHome, `Personal absolute path in ${file}`);
    assert.doesNotMatch(content, privateCourse, `Private course-project reference in ${file}`);
  }
});

test('frontend only calls local API paths and has no remote scripts, fonts or stylesheet imports', () => {
  const app = readFileSync(join(root, 'dist', 'app.js'), 'utf8');
  const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
  const css = readFileSync(join(root, 'dist', 'style.css'), 'utf8');
  const targets = [...app.matchAll(/\bfetch\(\s*(['"])(.*?)\1/g)].map(match => match[2]);
  assert.ok(targets.length > 0);
  for (const target of targets) assert.match(target, /^\/api\/(?:status|analyze|score)$/);
  assert.doesNotMatch(html, /<(?:script|link)\b[^>]*(?:src|href)\s*=\s*['"](?:https?:)?\/\//i);
  assert.doesNotMatch(css, /@import\b|url\(\s*['"]?(?:https?:)?\/\//i);
});
