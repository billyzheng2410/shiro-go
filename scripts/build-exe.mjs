import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = path.join(root, 'build');
const output = path.join(root, 'release');
const nodeVersion = 'v24.22.3';
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the Windows x64 executable on Windows x64.');
await mkdir(build, { recursive: true }); await mkdir(output, { recursive: true });
const archiveName = `node-${nodeVersion}-win-x64.zip`;
const archivePath = path.join(build, archiveName);
const sumsResponse = await fetch(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`);
if (!sumsResponse.ok) throw new Error('Unable to read official Node.js checksums.');
const sums = await sumsResponse.text();
const expected = sums.split(/\r?\n/).find(line => line.endsWith(`  ${archiveName}`))?.split(/\s+/)[0];
if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new Error('Official Node.js archive checksum missing.');
let cached;
try { cached = await readFile(archivePath); } catch {}
if (!cached || createHash('sha256').update(cached).digest('hex') !== expected) {
  const response = await fetch(`https://nodejs.org/dist/${nodeVersion}/${archiveName}`);
  if (!response.ok) throw new Error(`Node.js download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Node.js archive checksum mismatch.');
  await writeFile(archivePath, bytes);
}
const nodeDirectory = path.join(build, 'node-runtime'); await mkdir(nodeDirectory, { recursive: true });
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:SHIRO_NODE_ARCHIVE); try { foreach($e in $z.Entries) { $n=[IO.Path]::GetFileName($e.FullName); if($n -in @('node.exe','LICENSE')) { [IO.Compression.ZipFileExtensions]::ExtractToFile($e,(Join-Path $env:SHIRO_NODE_OUTPUT $n),$true) } } } finally {$z.Dispose()}"], { windowsHide: true, env: { ...process.env, SHIRO_NODE_ARCHIVE: archivePath, SHIRO_NODE_OUTPUT: nodeDirectory } });
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const files = ['package.json', 'server.mjs', 'katago.mjs', 'setup-manager.mjs', 'scripts/setup.mjs', 'scripts/setup-core.mjs', 'scripts/setup-assets.mjs', 'scripts/licenses/KataGo-MIT.txt', 'scripts/licenses/KataGo-Network-License.html', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
const { readdir } = await import('node:fs/promises');
for (const name of await readdir(path.join(root, 'dist'))) if (/\.(?:html|css|js|svg)$/.test(name)) files.push(`dist/${name}`);
const payload = { version, files: {} };
for (const filename of files) payload.files[filename] = (await readFile(path.join(root, filename))).toString('base64');
payload.files['Node-LICENSE.txt'] = (await readFile(path.join(nodeDirectory, 'LICENSE'))).toString('base64');
const payloadPath = path.join(build, 'application.json'); await writeFile(payloadPath, JSON.stringify(payload));
const configPath = path.join(build, 'sea-config.json');
await writeFile(configPath, JSON.stringify({ main: path.join(root, 'desktop', 'entry.cjs'), output: path.join(build, 'sea.blob'), disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets: { 'application.json': payloadPath } }));
const nodeBinary = path.join(nodeDirectory, 'node.exe');
execFileSync(nodeBinary, ['--experimental-sea-config', configPath], { stdio: 'inherit', windowsHide: true });
const executable = path.join(output, `Shiro-Go-${version}-windows-x64.exe`);
await copyFile(nodeBinary, executable);
// The copied vendor signature cannot authenticate our modified application.
// Remove its certificate entry and use the Windows GUI subsystem (no terminal on double-click).
let pe = await readFile(executable); const header = pe.readUInt32LE(0x3c); const optional = header + 24;
if (pe.readUInt32LE(header) !== 0x4550 || pe.readUInt16LE(optional) !== 0x20b) throw new Error('Expected a Windows x64 PE executable.');
const security = optional + 112 + 4 * 8;
const certificateOffset = pe.readUInt32LE(security), certificateSize = pe.readUInt32LE(security + 4);
pe.writeUInt32LE(0, security); pe.writeUInt32LE(0, security + 4);
if (certificateOffset && certificateOffset + certificateSize === pe.length) pe = pe.subarray(0, certificateOffset);
pe.writeUInt16LE(2, optional + 68); await writeFile(executable, pe);
const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
execFileSync(nodeBinary, [postject, executable, 'NODE_SEA_BLOB', path.join(build, 'sea.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'inherit', windowsHide: true });
const sha = createHash('sha256').update(await readFile(executable)).digest('hex');
await writeFile(path.join(output, 'SHA256SUMS.txt'), `${sha}  ${path.basename(executable)}\n`);
await writeFile(path.join(output, 'build-info.json'), JSON.stringify({ version, nodeVersion, archiveSha256: expected, executableSha256: sha, bytes: (await stat(executable)).size, signed: false }, null, 2));
console.log(`Built ${executable}\nSHA256 ${sha}`);
