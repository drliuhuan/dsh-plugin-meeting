// Small HTTP and text helpers shared by the meeting routes and the service.
//
// The plugin deliberately keeps its HTTP surface tiny and same-origin only:
// audio never leaves the machine through this route, and the largest body we
// accept is a question or a settings patch.

import { Buffer } from 'node:buffer';

export const MAX_BODY_BYTES = 64 * 1024;

export function jsonHeaders(extra = {}) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra
  };
}

export function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, jsonHeaders({ 'content-length': Buffer.byteLength(body) }));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

export function sendError(req, res, status, message, code) {
  sendJson(req, res, status, { ok: false, error: message, ...(code === undefined ? {} : { code }) });
}

/** Missing or opaque Origin is treated as a same-origin caller, like the rest of the harness. */
export function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') return true;
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

export function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        req.off('data', onData);
        req.resume();
        reject(Object.assign(new Error('request body is too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

export async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const text = await readBody(req, maxBytes);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { status: 400 });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('request body must be a JSON object'), { status: 400 });
  }
  return parsed;
}

export function clampString(value, maxLength, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

export function clampText(value, maxLength, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

export function formatClock(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      cleanup();
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Trim a transcript so one prompt stays inside a predictable character budget. */
export function tailByChars(text, limit) {
  if (typeof text !== 'string') return '';
  if (text.length <= limit) return text;
  return `…（前文已省略）\n${text.slice(text.length - limit)}`;
}

export function safeError(error) {
  if (error === null || error === undefined) return 'unknown error';
  if (typeof error === 'string') return error;
  const message = typeof error.message === 'string' ? error.message : String(error);
  const code = typeof error.code === 'string' ? error.code : '';
  return code.length > 0 && !message.includes(code) ? `${code}: ${message}` : message;
}
