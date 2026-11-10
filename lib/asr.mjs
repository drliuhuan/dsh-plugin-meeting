// Thin adapter over DSH's optional speech-to-text service.
//
// The local SenseVoice provider is a non-streaming recognizer: the meeting
// pipeline therefore cuts utterances with VAD and sends one canonical WAV per
// utterance.  This module owns readiness (including the one-time model
// download) and the provider call, and deliberately has no fallback that would
// silently upload audio somewhere else.

import { sleep } from './util.mjs';

const PROVIDER_ID = 'sensevoice-local';
const READY_PHASES = new Set(['ready', 'standby']);
const FAILED_PHASES = new Set(['failed', 'cancelled']);
const PREPARE_TIMEOUT_MS = 30 * 60 * 1000;

function speechUnavailable() {
  return Object.assign(new Error(
    '本地语音识别服务尚未启用。请在 DSH 的插件管理里启用官方「语音输入」组合包（它会提供 SenseVoice 本地识别与模型下载），然后重试。'
  ), { code: 'SPEECH_UNAVAILABLE' });
}

function providerMissing(providers) {
  const names = providers.map((item) => item.id).join(', ') || '无';
  return Object.assign(new Error(
    `语音服务已加载，但没有找到 SenseVoice 识别器（当前可用：${names}）。请启用「语音输入」组合包或检查其配置。`
  ), { code: 'SPEECH_PROVIDER_MISSING' });
}

export class SpeechAsr {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.providerId = options.providerId ?? PROVIDER_ID;
  }

  service() {
    try {
      return this.ctx.get('speechToText');
    } catch {
      return undefined;
    }
  }

  /** Current provider readiness without starting any work. */
  snapshot() {
    const service = this.service();
    if (!service || typeof service.snapshot !== 'function') {
      return { available: false, phase: 'unavailable', providerId: this.providerId, message: speechUnavailable().message };
    }
    try {
      const snapshot = service.snapshot();
      const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
      const provider = providers.find((item) => item.id === this.providerId)
        ?? providers.find((item) => String(item.id).includes('sensevoice'))
        ?? providers[0];
      if (!provider) {
        return { available: true, phase: 'missing-provider', providerId: this.providerId, message: providerMissing(providers).message };
      }
      return {
        available: true,
        phase: provider.preparation?.phase ?? 'unknown',
        providerId: provider.id,
        preparation: provider.preparation ?? null
      };
    } catch (error) {
      return { available: true, phase: 'error', providerId: this.providerId, message: String(error?.message ?? error) };
    }
  }

  /**
   * Wait until SenseVoice can transcribe.  The first call downloads the model
   * (about 240 MB for int8) and compiles/loads the native worker.
   * @param {(state: object) => void} [onProgress]
   * @param {AbortSignal} [signal]
   */
  async ensureReady(onProgress, signal) {
    const service = this.service();
    if (!service || typeof service.snapshot !== 'function') throw speechUnavailable();
    const started = Date.now();
    let prepareRequested = false;
    while (true) {
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'ABORTED' });
      const snapshot = service.snapshot();
      const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
      const provider = providers.find((item) => item.id === this.providerId)
        ?? providers.find((item) => String(item.id).includes('sensevoice'))
        ?? providers[0];
      if (!provider) throw providerMissing(providers);
      const phase = provider.preparation?.phase ?? 'unknown';
      onProgress?.({
        phase,
        providerId: provider.id,
        preparation: provider.preparation ?? null,
        elapsedMs: Date.now() - started
      });
      if (READY_PHASES.has(phase)) return provider;
      if (phase === 'missing-provider' || phase === 'unavailable') throw speechUnavailable();
      if (!prepareRequested || FAILED_PHASES.has(phase)) {
        try {
          service.prepare?.(provider.id);
          prepareRequested = true;
        } catch (error) {
          throw Object.assign(new Error(`无法准备本地语音模型：${String(error?.message ?? error)}`), { code: 'SPEECH_PREPARE_FAILED' });
        }
      }
      if (Date.now() - started > PREPARE_TIMEOUT_MS) {
        throw Object.assign(new Error('准备本地语音模型超时（30 分钟）'), { code: 'SPEECH_PREPARE_TIMEOUT' });
      }
      await sleep(400, signal);
    }
  }

  /**
   * Transcribe one 16 kHz mono PCM16 WAV.
   * @param {Uint8Array} wav
   * @param {string} language
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ text: string, audioSeconds?: number, inferenceSeconds?: number }>}
   */
  async transcribe(wav, language, signal) {
    const service = this.service();
    if (!service) throw speechUnavailable();
    const spec = service.resolve({ audio: wav, language, providerId: this.providerId });
    const result = await service.transcribe(spec, signal);
    return {
      text: typeof result?.text === 'string' ? result.text.trim() : '',
      audioSeconds: result?.audioSeconds,
      inferenceSeconds: result?.inferenceSeconds
    };
  }
}

export { PROVIDER_ID };
