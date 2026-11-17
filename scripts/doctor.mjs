import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { KataGoEngine } from '../katago.mjs';

const engine = new KataGoEngine();
const status = engine.status();
let gpu = null;
try {
  gpu = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch { /* NVIDIA tools are optional for CPU inference. */ }
console.log(JSON.stringify({
  node: process.version,
  nodeSupported: Number(process.versions.node.split('.')[0]) >= 20,
  platform: process.platform,
  architecture: process.arch,
  logicalCpus: cpus().length,
  memoryGiB: Math.round(totalmem() / 1024 ** 3),
  nvidia: gpu,
  inference: 'local-only',
  engine: status,
  paths: { executable: engine.executable, config: engine.configPath, model: engine.modelPath, humanModel: engine.humanModelPath },
  nextStep: !status.installed ? 'Run npm run setup. For a CPU-only install: npm run setup:cpu.' : !existsSync(engine.humanModelPath) ? 'Run npm run setup to install HumanSL rank opponents.' : 'Run npm start, then visit http://127.0.0.1:8765/',
}, null, 2));
if (!status.installed || status.error) process.exitCode = 1;
