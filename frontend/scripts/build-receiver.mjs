// Runs tools/build_browsdr_receiver.py with the project Python. `vite build`
// empties frontend/dist, including dist/receiver, so `npm run build:all` runs
// this after the console build. The builder itself only needs the standard library.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const windows = process.platform === 'win32';
const venvPython = windows ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python');
const [command, prefix] = existsSync(venvPython) ? [venvPython, []] : windows ? ['py', ['-3']] : ['python3', []];

console.log(`Building the embedded Receiver with ${[command, ...prefix].join(' ')}`);
const result = spawnSync(command, [...prefix, join(root, 'tools', 'build_browsdr_receiver.py')], { cwd: root, stdio: 'inherit' });
if (result.error) {
  console.error(`Could not start ${command}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
