// Build the Windows loopback helper from native/LoopbackCapture.cs.
//
// The runtime prefers the shipped exe and only falls back to this compiler when
// the exe is missing.  Run `node scripts/build-native.mjs` after editing the C#
// source; `--check` asserts the shipped binary is not older than its source.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const source = path.join(root, 'native', 'LoopbackCapture.cs');
const output = path.join(root, 'native', 'LoopbackCapture.exe');
const check = process.argv.includes('--check');

const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
const compilers = [
  path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
];

function stat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

if (process.platform !== 'win32') {
  if (check) {
    console.error('native helper is Windows-only');
    process.exit(1);
  }
  console.log('native helper is Windows-only; nothing to build');
  process.exit(0);
}

const sourceStat = stat(source);
if (!sourceStat) {
  console.error(`missing ${source}`);
  process.exit(1);
}
const outputStat = stat(output);
if (check) {
  if (!outputStat) {
    console.error('native/LoopbackCapture.exe is missing');
    process.exit(1);
  }
  if (outputStat.mtimeMs < sourceStat.mtimeMs) {
    console.error('native/LoopbackCapture.exe is older than LoopbackCapture.cs');
    process.exit(1);
  }
  console.log('native helper: up to date');
  process.exit(0);
}

const compiler = compilers.find((file) => stat(file));
if (!compiler) {
  console.error('no .NET Framework csc.exe found');
  process.exit(1);
}

await fsp.mkdir(path.dirname(output), { recursive: true });
const child = spawn(compiler, [
  '/nologo',
  '/target:exe',
  '/platform:x64',
  `/out:${output}`,
  source
], { stdio: 'ignore', windowsHide: true });

const code = await new Promise((resolve) => {
  child.on('error', (error) => {
    console.error(String(error?.message ?? error));
    resolve(1);
  });
  child.on('exit', (exitCode) => resolve(exitCode ?? 1));
});
if (code !== 0) {
  console.error(`csc exited with ${code}`);
  process.exit(1);
}
console.log(`built ${output}`);
