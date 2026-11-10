// Native Windows system-audio capture helper.
//
// DSH's Electron shell denies every renderer permission (including display
// capture), so the browser cannot record the meeting.  This module builds and
// runs a tiny .NET Framework helper that opens a WASAPI loopback stream on the
// default render endpoint and forwards the mix format's PCM over a loopback TCP
// socket.  The helper is compiled on first use with the C# compiler that ships
// with .NET Framework, or copied from the prebuilt binary in `native/`.

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.dirname(here);
const sourcePath = path.join(pluginRoot, 'native', 'LoopbackCapture.cs');
const prebuiltPath = path.join(pluginRoot, 'native', 'LoopbackCapture.exe');

async function statOrUndefined(file) {
  try {
    return await fsp.stat(file);
  } catch {
    return undefined;
  }
}

function compilerCandidates() {
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  return [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ];
}

async function firstExisting(files) {
  for (const file of files) {
    if (await statOrUndefined(file)) return file;
  }
  return undefined;
}

/**
 * Run a helper to completion without stdio pipes.
 *
 * The DSH host may run under a confined job where creating pipes for a child
 * fails with EPERM; the helper writes results to a file instead, so `ignore` is
 * both sufficient and robust.
 */
function runProcess(exe, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already gone */ }
      reject(new Error(`process timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`process exited with code ${code ?? 'unknown'}`));
    });
  });
}

/**
 * Return a runnable capture helper, compiling it into the plugin's writable
 * data directory the first time it is needed.
 * @param {string} dataRoot absolute meeting data directory.
 * @param {{ logger?: { warn?: Function } }} [options]
 * @returns {Promise<string>} absolute path to the helper executable.
 */
export async function ensureNativeHelper(dataRoot, options = {}) {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('会议音频采集目前仅支持 Windows'), { code: 'UNSUPPORTED_PLATFORM' });
  }
  const binDir = path.join(dataRoot, '.native');
  const target = path.join(binDir, 'LoopbackCapture.exe');
  const sourceStat = await statOrUndefined(sourcePath);
  if (!sourceStat) {
    throw Object.assign(new Error('缺少 native/LoopbackCapture.cs，无法构建音频采集器'), { code: 'NATIVE_SOURCE_MISSING' });
  }
  const targetStat = await statOrUndefined(target);
  if (targetStat && targetStat.mtimeMs >= sourceStat.mtimeMs) return target;

  await fsp.mkdir(binDir, { recursive: true });

  // Prefer the shipped binary: it is the same source compiled with the same
  // .NET Framework compiler, and it avoids depending on a child-process exec.
  const prebuiltStat = await statOrUndefined(prebuiltPath);
  if (prebuiltStat) {
    await fsp.copyFile(prebuiltPath, target);
    return target;
  }

  const compiler = await firstExisting(compilerCandidates());
  if (compiler) {
    try {
      await runProcess(compiler, [
        '/nologo',
        '/target:exe',
        '/platform:x64',
        `/out:${target}`,
        sourcePath
      ], 60000);
      const built = await statOrUndefined(target);
      if (built) return target;
    } catch (error) {
      options.logger?.warn?.(`meeting: native helper build failed: ${String(error?.message ?? error)}`);
    }
  }

  throw Object.assign(new Error('无法准备音频采集器：没有随包附带的 exe，也无法调用 .NET Framework 的 csc.exe 编译'), {
    code: 'NATIVE_BUILD_FAILED'
  });
}

/**
 * Enumerate render endpoints through the helper's `--list --out <file>` mode.
 * @param {string} exe helper path.
 * @param {string} dataRoot writable meeting data directory.
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
export async function listRenderDevices(exe, dataRoot, source = 'loopback') {
  const binDir = path.join(dataRoot, '.native');
  await fsp.mkdir(binDir, { recursive: true });
  const outFile = path.join(binDir, `devices-${process.pid}-${Date.now()}-${source}.jsonl`);
  try {
    await runProcess(exe, ['--list', '--source', source, '--out', outFile], 8000);
    const text = await fsp.readFile(outFile, 'utf8');
    return text.split(/\r?\n/).map((line) => {
      const index = line.indexOf('\t');
      if (index < 0) return null;
      const id = line.slice(0, index).trim();
      const name = line.slice(index + 1).trim();
      return id.length > 0 ? { id, name: name.length > 0 ? name : id } : null;
    }).filter(Boolean);
  } catch {
    return [];
  } finally {
    await fsp.rm(outFile, { force: true }).catch(() => {});
  }
}

/**
 * OCR an agenda image with the Windows built-in OCR engine (no cloud round trip).
 * The helper script writes UTF-8 text to a file; the image never leaves the Host.
 * @param {string} imagePath
 * @param {string} dataRoot
 * @returns {Promise<string>}
 */
export async function ocrImage(imagePath, dataRoot) {
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(pluginRoot, 'native', 'ocr-agenda.ps1');
  if (!(await statOrUndefined(powershell))) {
    throw Object.assign(new Error('找不到 Windows PowerShell 5.1，无法使用本机 OCR'), { code: 'OCR_POWERSHELL_MISSING' });
  }
  if (!(await statOrUndefined(script))) {
    throw Object.assign(new Error('缺少 native/ocr-agenda.ps1'), { code: 'OCR_SCRIPT_MISSING' });
  }
  const binDir = path.join(dataRoot, '.native');
  await fsp.mkdir(binDir, { recursive: true });
  const outFile = path.join(binDir, `ocr-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  try {
    await runProcess(powershell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-ImagePath', imagePath,
      '-OutFile', outFile
    ], 45000);
    const text = await fsp.readFile(outFile, 'utf8');
    return text.trim();
  } catch (error) {
    let detail = '';
    try {
      detail = (await fsp.readFile(`${outFile}.error`, 'utf8')).trim();
    } catch {
      detail = '';
    }
    throw Object.assign(new Error(`本机 OCR 失败：${detail || String(error?.message ?? error)}`), {
      code: 'OCR_FAILED'
    });
  } finally {
    await fsp.rm(outFile, { force: true }).catch(() => {});
    await fsp.rm(`${outFile}.error`, { force: true }).catch(() => {});
  }
}

/**
 * Start one loopback capture.
 *
 * The helper connects back to a loopback TCP server rather than writing to
 * stdout: it keeps binary framing out of the pipe layer and lets the Host close
 * the capture simply by closing the socket.
 *
 * @param {object} options
 * @param {string} options.exe helper path.
 * @param {string} [options.deviceId] render endpoint id; omitted means default.
 * @param {(header: object) => void} options.onHeader called once with the mix format.
 * @param {(buffer: Buffer) => void} options.onPcm called with raw interleaved PCM.
 * @param {(error: Error) => void} [options.onError]
 * @param {(reason: string) => void} [options.onClose]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ stop: () => void, header: object, port: number }>}
 */
export async function startLoopback(options) {
  const { exe, deviceId, source = 'loopback', onHeader, onPcm, onError, onClose, signal } = options;
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = server.address().port;
  const args = ['--port', String(port), '--source', source];
  if (deviceId) args.push('--device', deviceId);
  const child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });

  let socket = null;
  let header = null;
  let pending = Buffer.alloc(0);
  let settled = false;
  let stopped = false;
  let failure = null;

  const cleanup = () => {
    stopped = true;
    try { socket?.destroy(); } catch { /* already gone */ }
    try { server.close(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already gone */ }
  };

  const fail = (error) => {
    if (settled) return;
    settled = true;
    failure = error;
    cleanup();
    onError?.(error);
  };

  server.on('connection', (connected) => {
    if (socket !== null) {
      connected.destroy();
      return;
    }
    socket = connected;
    connected.setNoDelay?.(true);
    connected.on('data', (chunk) => {
      try {
        if (header === null) {
          pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
          const newline = pending.indexOf(10);
          if (newline < 0) {
            if (pending.length > 64 * 1024) throw new Error('audio capture header is too large');
            return;
          }
          const line = pending.subarray(0, newline).toString('utf8');
          const rest = pending.subarray(newline + 1);
          pending = Buffer.alloc(0);
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            throw new Error('audio capture helper sent an invalid header');
          }
          header = parsed;
          onHeader?.(header);
          if (rest.length > 0) onPcm?.(rest);
          return;
        }
        onPcm?.(chunk);
      } catch (error) {
        fail(error);
      }
    });
    connected.on('error', (error) => fail(error));
    connected.on('close', () => {
      if (!stopped) onClose?.('socket-closed');
    });
  });

  child.on('error', (error) => fail(error));
  child.on('exit', (code) => {
    if (!stopped && header === null) {
      fail(Object.assign(new Error(`音频采集器启动失败（退出码 ${code ?? 'unknown'}）`), { code: 'CAPTURE_EXITED' }));
    } else if (!stopped) {
      onClose?.(`helper-exit-${code ?? 'unknown'}`);
    }
  });

  const timeout = setTimeout(() => {
    if (header === null) {
      fail(Object.assign(new Error('音频采集器在 10 秒内没有连接：请确认播放设备可用，并重试'), { code: 'CAPTURE_TIMEOUT' }));
    }
  }, 10000);

  const onAbort = () => {
    fail(Object.assign(new Error('采集已取消'), { code: 'ABORTED' }));
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  // Wait for the header so a start failure surfaces synchronously.
  const deadline = Date.now() + 10000;
  while (header === null && !settled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  clearTimeout(timeout);
  if (settled || header === null) {
    cleanup();
    throw failure ?? Object.assign(new Error('音频采集器未能就绪'), { code: 'CAPTURE_NOT_READY' });
  }

  return {
    header,
    port,
    stop() {
      signal?.removeEventListener('abort', onAbort);
      cleanup();
    }
  };
}

export { prebuiltPath, sourcePath };
