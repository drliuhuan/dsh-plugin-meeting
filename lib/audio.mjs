// Browser-independent audio pipeline for the meeting capture.
//
// The native helper delivers the default render endpoint's mix format (almost
// always 48 kHz float32 stereo).  This module downmixes to mono, resamples to
// the 16 kHz mono PCM16 that SenseVoice expects, and cuts the stream into
// utterances with a small energy VAD.  Everything runs in the DSH Host process;
// no audio is ever uploaded by the browser.

import { Buffer } from 'node:buffer';

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms at 16 kHz

class StreamingResampler {
  constructor(inputRate, outputRate) {
    this.step = inputRate / outputRate;
    this.buffer = new Float32Array(0);
    this.position = 0;
  }

  push(input) {
    if (!input || input.length === 0) return new Float32Array(0);
    const combined = new Float32Array(this.buffer.length + input.length);
    combined.set(this.buffer, 0);
    combined.set(input, this.buffer.length);
    const output = [];
    let position = this.position;
    while (position + 1 < combined.length) {
      const index = Math.floor(position);
      const fraction = position - index;
      const a = combined[index];
      const b = combined[index + 1];
      output.push(a + (b - a) * fraction);
      position += this.step;
    }
    const consumed = Math.min(Math.floor(position), combined.length);
    this.buffer = combined.slice(consumed);
    this.position = position - consumed;
    return Float32Array.from(output);
  }

  flush() {
    if (this.buffer.length === 0) return new Float32Array(0);
    const value = this.buffer[this.buffer.length - 1];
    const output = [];
    let position = this.position;
    while (position < this.buffer.length) {
      output.push(value);
      position += this.step;
    }
    this.buffer = new Float32Array(0);
    this.position = 0;
    return Float32Array.from(output);
  }
}

/**
 * Convert the native helper's interleaved PCM into 16 kHz mono float samples.
 * Supports the two formats Windows mixers actually expose: IEEE float32 and
 * signed 16-bit PCM.
 */
export class PcmTo16k {
  constructor(header) {
    this.sampleRate = Number(header?.sampleRate);
    this.channels = Number(header?.channels);
    this.format = header?.format;
    this.bits = Number(header?.bits);
    if (!Number.isFinite(this.sampleRate) || this.sampleRate < 8000 || this.sampleRate > 384000) {
      throw new Error(`unsupported capture sample rate: ${header?.sampleRate}`);
    }
    if (!Number.isFinite(this.channels) || this.channels < 1 || this.channels > 8) {
      throw new Error(`unsupported capture channel count: ${header?.channels}`);
    }
    if (this.format !== 'f32' && this.format !== 's16') {
      throw new Error(`unsupported capture sample format: ${header?.format ?? 'unknown'}`);
    }
    this.bytesPerSample = this.format === 'f32' ? 4 : 2;
    this.blockAlign = Number(header?.blockAlign) || this.channels * this.bytesPerSample;
    this.pending = Buffer.alloc(0);
    this.resampler = new StreamingResampler(this.sampleRate, TARGET_RATE);
  }

  push(buffer) {
    if (!buffer || buffer.length === 0) return new Float32Array(0);
    const data = this.pending.length > 0 ? Buffer.concat([this.pending, buffer]) : buffer;
    const frames = Math.floor(data.length / this.blockAlign);
    const usable = frames * this.blockAlign;
    this.pending = data.subarray(usable);
    if (frames === 0) return new Float32Array(0);

    const mono = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const offset = frame * this.blockAlign;
      let sum = 0;
      for (let channel = 0; channel < this.channels; channel += 1) {
        const sampleOffset = offset + channel * this.bytesPerSample;
        sum += this.format === 'f32'
          ? data.readFloatLE(sampleOffset)
          : data.readInt16LE(sampleOffset) / 32768;
      }
      mono[frame] = sum / this.channels;
    }
    return this.resampler.push(mono);
  }

  flush() {
    return this.resampler.flush();
  }
}

/**
 * Energy VAD with an adaptive noise floor.
 *
 * A segment starts after two consecutive 20 ms frames above a noise-relative
 * threshold and ends after `minSilenceMs` of quiet.  A 300 ms pre-roll keeps
 * the first syllable, and a long monologue is cut at `maxSegmentMs` so the
 * ASR worker never sees an unbounded recording.
 */
export class VadSegmenter {
  constructor(options = {}) {
    this.minSpeechFrames = Math.max(1, Math.round((options.minSpeechMs ?? 380) / 20));
    this.minSilenceFrames = Math.max(1, Math.round((options.minSilenceMs ?? 620) / 20));
    this.maxFrames = Math.max(this.minSpeechFrames + 1, Math.round((options.maxSegmentMs ?? 20000) / 20));
    this.preRollFrames = Math.max(0, Math.round((options.preRollMs ?? 300) / 20));
    this.tailKeepFrames = Math.max(0, Math.round((options.tailMs ?? 160) / 20));
    this.minThreshold = Math.max(0.0005, Number(options.minThreshold) || 0.0045);
    this.sensitivity = Math.min(1, Math.max(0, Number(options.sensitivity) || 0.5));

    this.residual = new Float32Array(0);
    this.processedFrames = 0;
    this.noise = 0.0025;
    this.preRoll = [];
    this.speechRun = 0;
    this.speaking = false;
    this.frames = [];
    this.silenceFrames = 0;
    this.lastSpeechFrame = 0;
    this.segmentStartFrame = 0;
  }

  thresholdStart() {
    const factor = 4.6 - this.sensitivity * 2.2; // 4.6 (low) .. 2.4 (high)
    return Math.max(this.minThreshold, this.noise * factor);
  }

  thresholdEnd() {
    const factor = 2.6 - this.sensitivity * 1.0;
    return Math.max(this.minThreshold * 0.7, this.noise * factor);
  }

  rms(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
    return Math.sqrt(sum / frame.length);
  }

  push(samples) {
    if (!samples || samples.length === 0) return [];
    const combined = new Float32Array(this.residual.length + samples.length);
    combined.set(this.residual, 0);
    combined.set(samples, this.residual.length);
    const frames = Math.floor(combined.length / FRAME_SAMPLES);
    const usable = frames * FRAME_SAMPLES;
    this.residual = combined.slice(usable);
    const segments = [];
    for (let index = 0; index < frames; index += 1) {
      const frame = combined.subarray(index * FRAME_SAMPLES, (index + 1) * FRAME_SAMPLES);
      const segment = this.processFrame(frame);
      if (segment !== null) segments.push(segment);
    }
    return segments;
  }

  processFrame(frame) {
    const frameIndex = this.processedFrames;
    this.processedFrames += 1;
    const energy = this.rms(frame);
    const startThreshold = this.thresholdStart();
    const endThreshold = this.thresholdEnd();

    if (!this.speaking) {
      this.preRoll.push(frame);
      while (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      if (energy > startThreshold) {
        this.speechRun += 1;
      } else {
        this.speechRun = 0;
        this.noise = this.noise * 0.985 + energy * 0.015;
      }
      if (this.speechRun < 2) return null;
      // Start with the pre-roll so the first syllable is not clipped.
      const preRoll = this.preRoll.slice();
      this.preRoll = [];
      this.frames = preRoll;
      this.lastSpeechFrame = preRoll.length - 1;
      this.segmentStartFrame = Math.max(0, frameIndex - preRoll.length + 1);
      this.speaking = true;
      this.silenceFrames = 0;
      this.speechRun = 0;
      return null;
    }

    this.frames.push(frame);
    if (energy >= endThreshold) {
      this.lastSpeechFrame = this.frames.length - 1;
      this.silenceFrames = 0;
    } else {
      this.silenceFrames += 1;
    }

    if (this.frames.length >= this.maxFrames || this.silenceFrames >= this.minSilenceFrames) {
      return this.finalize();
    }
    return null;
  }

  finalize() {
    if (!this.speaking) return null;
    const cut = Math.min(this.frames.length, this.lastSpeechFrame + 1 + this.tailKeepFrames);
    const frames = this.frames.slice(0, Math.max(1, cut));
    const speechFrames = this.lastSpeechFrame + 1;
    const startMs = this.segmentStartFrame * 20;
    const endMs = startMs + frames.length * 20;
    this.speaking = false;
    this.frames = [];
    this.silenceFrames = 0;
    this.lastSpeechFrame = 0;
    this.speechRun = 0;
    if (speechFrames < this.minSpeechFrames) return null;
    const samples = new Float32Array(frames.length * FRAME_SAMPLES);
    for (let index = 0; index < frames.length; index += 1) {
      samples.set(frames[index], index * FRAME_SAMPLES);
    }
    return { samples, startMs, endMs };
  }

  flush() {
    if (!this.speaking) return [];
    const segment = this.finalize();
    return segment === null ? [] : [segment];
  }
}

/** Encode 16 kHz mono float samples as a canonical PCM16 WAV for the speech service. */
export function encodeWav16(samples) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(TARGET_RATE, 24);
  buffer.writeUInt32LE(TARGET_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }
  return buffer;
}

export { TARGET_RATE, FRAME_SAMPLES };
