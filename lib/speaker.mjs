// Speaker embedding and online clustering.
//
// SenseVoice transcribes words, not identities.  This module adds a separate
// CAM++ speaker-embedding stage: each VAD utterance becomes a 192-dimensional
// voice vector, and an online cosine clusterer groups similar vectors into
// "发言人 1/2/3".  It is deliberately NOT identity recognition: without an
// enrolled voiceprint it cannot know a person's name.  The panel lets the user
// rename a cluster after the fact, and those names flow into the minutes and
// Q&A context.
//
// sherpa-onnx-node ships with DSH.  It is loaded through the app's asar require
// so the plugin does not duplicate the native runtime or its ~20 MB DLLs.

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const SPEAKER_MODEL = Object.freeze({
  name: 'campplus_zh_16k.onnx',
  bytes: 28281138,
  sha256: 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11',
  urls: [
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
    'https://hf-mirror.com/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'
  ]
});

function requireCandidates() {
  const candidates = [];
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    candidates.push(path.join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'));
  }
  if (typeof process.env.DSH_APP_ASAR === 'string' && process.env.DSH_APP_ASAR.length > 0) {
    candidates.push(path.join(process.env.DSH_APP_ASAR, 'dsh', 'package.json'));
  }
  if (typeof process.execPath === 'string' && process.execPath.length > 0) {
    candidates.push(path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'package.json'));
  }
  return candidates;
}

let cachedSherpa;
let cachedSherpaError;

/** Load the DSH-shipped sherpa-onnx binding once. */
export function loadSherpa() {
  if (cachedSherpa !== undefined) return cachedSherpa;
  if (cachedSherpaError !== undefined) throw cachedSherpaError;
  for (const manifest of requireCandidates()) {
    try {
      const requireFromApp = createRequire(manifest);
      const sherpa = requireFromApp('sherpa-onnx-node');
      cachedSherpa = sherpa;
      return sherpa;
    } catch {
      // try the next location
    }
  }
  cachedSherpaError = Object.assign(new Error(
    '无法加载 DSH 自带的 sherpa-onnx 运行时，发言人区分已关闭（转写、校正和翻译不受影响）。'
  ), { code: 'SPEAKER_RUNTIME_MISSING' });
  throw cachedSherpaError;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function verifyModel(file) {
  try {
    const stat = await fsp.stat(file);
    if (stat.size !== SPEAKER_MODEL.bytes) return false;
    return (await sha256File(file)) === SPEAKER_MODEL.sha256;
  } catch {
    return false;
  }
}

/**
 * Ensure the CAM++ Chinese/English speaker embedding model is on disk.
 *
 * @param {string} dataRoot writable meeting data directory.
 * @param {{ onProgress?: Function, signal?: AbortSignal, logger?: object }} [options]
 * @returns {Promise<string>} absolute model path.
 */
export async function ensureSpeakerModel(dataRoot, options = {}) {
  const explicit = typeof process.env.DSH_MEETING_SPEAKER_MODEL === 'string'
    ? process.env.DSH_MEETING_SPEAKER_MODEL.trim()
    : '';
  if (explicit.length > 0) {
    if (!(await verifyModel(explicit))) {
      throw Object.assign(new Error(`DSH_MEETING_SPEAKER_MODEL 指向的模型不可用：${explicit}`), { code: 'SPEAKER_MODEL_INVALID' });
    }
    return explicit;
  }

  const modelDir = path.join(dataRoot, '.models');
  const target = path.join(modelDir, SPEAKER_MODEL.name);
  if (await verifyModel(target)) return target;
  await fsp.mkdir(modelDir, { recursive: true });

  let lastError;
  for (const url of SPEAKER_MODEL.urls) {
    const temp = `${target}.${process.pid}.${Date.now()}.part`;
    try {
      options.onProgress?.({ phase: 'downloading', completedBytes: 0, totalBytes: SPEAKER_MODEL.bytes, resource: SPEAKER_MODEL.name });
      const response = await fetch(url, {
        redirect: 'follow',
        signal: options.signal,
        headers: { 'user-agent': 'dsh-plugin-live-meeting/0.2' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const total = Number(response.headers.get('content-length')) || SPEAKER_MODEL.bytes;
      const handle = await fsp.open(temp, 'w');
      const hash = crypto.createHash('sha256');
      let written = 0;
      try {
        if (response.body) {
          for await (const chunk of response.body) {
            const buffer = Buffer.from(chunk);
            await handle.write(buffer);
            hash.update(buffer);
            written += buffer.length;
            if (written % (1024 * 1024) < buffer.length) {
              options.onProgress?.({ phase: 'downloading', completedBytes: written, totalBytes: total, resource: SPEAKER_MODEL.name });
            }
          }
        } else {
          const buffer = Buffer.from(await response.arrayBuffer());
          await handle.write(buffer);
          hash.update(buffer);
          written = buffer.length;
        }
      } finally {
        await handle.close();
      }
      const digest = hash.digest('hex');
      if (written !== SPEAKER_MODEL.bytes || digest !== SPEAKER_MODEL.sha256) {
        throw new Error(`模型校验失败（${written} 字节，sha256 ${digest.slice(0, 12)}…）`);
      }
      await fsp.rename(temp, target);
      options.onProgress?.({ phase: 'ready', completedBytes: SPEAKER_MODEL.bytes, totalBytes: SPEAKER_MODEL.bytes, resource: SPEAKER_MODEL.name });
      return target;
    } catch (error) {
      lastError = error;
      await fsp.rm(temp, { force: true }).catch(() => {});
      if (options.signal?.aborted) break;
    }
  }
  throw Object.assign(new Error(`无法下载声纹模型：${String(lastError?.message ?? lastError ?? 'unknown')}`), {
    code: 'SPEAKER_MODEL_DOWNLOAD_FAILED'
  });
}

/** One CAM++ embedding extractor, bound to the local CPU. */
export class SpeakerEncoder {
  constructor(sherpa, modelPath) {
    this.extractor = new sherpa.SpeakerEmbeddingExtractor({
      model: modelPath,
      numThreads: 2,
      provider: 'cpu',
      debug: 0
    });
    this.dim = this.extractor.dim;
  }

  /**
   * Compute an L2-normalized voice vector.  Returns null for clips too short
   * to carry speaker information.
   * @param {Float32Array} samples 16 kHz mono float samples.
   * @returns {Float32Array|null}
   */
  embed(samples) {
    if (!samples || samples.length < 6400) return null; // < 0.4 s
    // Electron's V8 memory cage rejects external buffers; feed a regular copy.
    const copy = new Float32Array(samples.length);
    copy.set(samples);
    const stream = this.extractor.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples: copy });
    if (!this.extractor.isReady(stream)) return null;
    const raw = this.extractor.compute(stream, false);
    const vector = new Float32Array(raw.length);
    let norm = 0;
    for (let index = 0; index < raw.length; index += 1) {
      vector[index] = raw[index];
      norm += raw[index] * raw[index];
    }
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm <= 1e-6) return null;
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
    return vector;
  }
}

function normalize(vector) {
  let norm = 0;
  for (let index = 0; index < vector.length; index += 1) norm += vector[index] * vector[index];
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm <= 1e-6) return vector;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return vector;
}

function cosine(a, b) {
  let value = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) value += a[index] * b[index];
  return value;
}

/**
 * Online cosine clustering for meeting voices.
 *
 * A new utterance joins an existing speaker when its embedding is close to
 * that speaker's running centroid.  Very short utterances may be assigned to
 * the closest speaker but never create or move a centroid: they carry too
 * little voice information to be trustworthy.
 */
export class SpeakerClusterer {
  constructor(options = {}) {
    this.threshold = Math.min(0.95, Math.max(0.4, Number(options.threshold) || 0.66));
    this.maxSpeakers = Math.max(1, Number(options.maxSpeakers) || 8);
    this.speakers = [];
    this.lastSpeakerId = null;
  }

  create(embedding, name, org, source) {
    const speaker = {
      id: `sp${this.speakers.length + 1}`,
      name: name || `发言人 ${this.speakers.length + 1}`,
      org: org || '',
      source: source || 'cluster',
      centroid: normalize(new Float32Array(embedding)),
      count: 1
    };
    this.speakers.push(speaker);
    return speaker;
  }

  assign(embedding, durationMs) {
    if (!embedding || embedding.length === 0) return null;
    if (this.speakers.length === 0) {
      const speaker = this.create(embedding);
      this.lastSpeakerId = speaker.id;
      return { id: speaker.id, name: speaker.name, org: speaker.org, created: true };
    }
    let best = this.speakers[0];
    let bestScore = -Infinity;
    for (const speaker of this.speakers) {
      const score = cosine(embedding, speaker.centroid);
      if (score > bestScore) {
        best = speaker;
        bestScore = score;
      }
    }
    const longEnough = Number(durationMs) >= 700;
    const update = (speaker) => {
      if (!longEnough || speaker.centroid.length === 0) return;
      const next = new Float32Array(speaker.centroid.length);
      for (let index = 0; index < next.length; index += 1) {
        next[index] = (speaker.centroid[index] * speaker.count + embedding[index]) / (speaker.count + 1);
      }
      speaker.centroid = normalize(next);
      speaker.count += 1;
    };
    if (bestScore >= this.threshold) {
      update(best);
      this.lastSpeakerId = best.id;
      return { id: best.id, name: best.name, org: best.org, created: false, score: bestScore };
    }
    // Continuity: a single short or noisy utterance that is still reasonably
    // close to the previous speaker should not create a new person.  This is
    // what keeps one speaker from being split into 发言人 1 / 发言人 2 mid-turn.
    const last = this.speakers.find((speaker) => speaker.id === this.lastSpeakerId);
    if (last) {
      const lastScore = cosine(embedding, last.centroid);
      if (lastScore >= this.threshold - 0.10) {
        update(last);
        return { id: last.id, name: last.name, org: last.org, created: false, score: lastScore };
      }
    }
    if (this.speakers.length < this.maxSpeakers && Number(durationMs) >= 900) {
      const speaker = this.create(embedding);
      this.lastSpeakerId = speaker.id;
      return { id: speaker.id, name: speaker.name, org: speaker.org, created: true, score: bestScore };
    }
    // Too many speakers or too little audio: keep the closest label rather
    // than inventing a new one on every short interjection.
    this.lastSpeakerId = best.id;
    return { id: best.id, name: best.name, org: best.org, created: false, score: bestScore };
  }

  rename(id, name, org) {
    const speaker = this.speakers.find((item) => item.id === id);
    if (!speaker) return undefined;
    const trimmed = String(name ?? '').trim().slice(0, 40);
    if (trimmed.length === 0) return undefined;
    speaker.name = trimmed;
    if (org !== undefined) speaker.org = String(org ?? '').trim().slice(0, 60);
    speaker.source = 'manual';
    return { id: speaker.id, name: speaker.name, org: speaker.org };
  }

  list() {
    return this.speakers.map((speaker) => ({
      id: speaker.id,
      name: speaker.name,
      org: speaker.org || '',
      source: speaker.source || 'cluster'
    }));
  }

  hydrate(list) {
    if (!Array.isArray(list)) return;
    this.speakers = list
      .filter((item) => item && typeof item.id === 'string')
      .slice(0, this.maxSpeakers)
      .map((item) => ({
        id: item.id,
        name: typeof item.name === 'string' && item.name.length > 0 ? item.name : item.id,
        org: typeof item.org === 'string' ? item.org : '',
        source: typeof item.source === 'string' ? item.source : 'cluster',
        centroid: new Float32Array(0),
        count: 1
      }));
  }
}

export { cosine, verifyModel };
