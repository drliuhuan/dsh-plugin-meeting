// Pure local self-test: no DSH profile, no native helper and no model needed.
// Run with `npm run selftest`.

import assert from 'node:assert/strict';
import { PcmTo16k, VadSegmenter, encodeWav16 } from '../lib/audio.mjs';
import { parseAgenda, currentAgenda, agendaSpeakers } from '../lib/agenda.mjs';
import { SpeakerClusterer } from '../lib/speaker.mjs';

// --- agenda ---------------------------------------------------------------
const agendaText = [
  '14:00-14:30 张医生（市医院） 创面修复病例分享',
  '14:30-15:00 李主任（省医院）：糖尿病足多学科协作',
  '15:00-15:20 讨论'
].join('\n');
const parsed = parseAgenda(agendaText, 'agenda.txt');
assert.equal(parsed.entries.length, 3);
assert.equal(parsed.entries[0].speaker, '张医生');
assert.equal(parsed.entries[0].org, '市医院');
assert.equal(parsed.entries[2].speaker, '');
assert.equal(parsed.entries[2].topic, '讨论');
assert.deepEqual(agendaSpeakers(parsed.entries).map((item) => item.name), ['张医生', '李主任']);
const at = new Date(2026, 10, 9, 14, 10, 0);
const current = currentAgenda(parsed.entries, at);
assert.equal(current.status, 'current');
assert.equal(current.entry.speaker, '张医生');

const csv = 'start,end,speaker,org,topic\n14:00,14:30,张医生,市医院,病例分享';
const parsedCsv = parseAgenda(csv, 'agenda.csv');
assert.equal(parsedCsv.entries.length, 1);
assert.equal(parsedCsv.entries[0].topic, '病例分享');

// --- speaker clustering ---------------------------------------------------
function vector(seed) {
  const result = new Float32Array(16);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Math.cos(seed + index * 0.37);
  }
  let norm = 0;
  for (const value of result) norm += value * value;
  norm = Math.sqrt(norm);
  for (let index = 0; index < result.length; index += 1) result[index] /= norm;
  return result;
}
const clusterer = new SpeakerClusterer({ threshold: 0.66 });
const first = clusterer.assign(vector(0.1), 1800);
const second = clusterer.assign(vector(0.15), 1500);
const other = clusterer.assign(vector(1.7), 1800);
assert.equal(first.created, true);
assert.equal(second.id, first.id);
assert.equal(other.created, true);
assert.notEqual(other.id, first.id);
clusterer.rename(first.id, '张医生', '市医院');
assert.deepEqual(clusterer.list()[0].org, '市医院');

// --- audio resampling and VAD --------------------------------------------
const inputRate = 48000;
const frames = inputRate * 3;
const pcm = Buffer.alloc(frames * 8);
for (let frame = 0; frame < frames; frame += 1) {
  const seconds = frame / inputRate;
  const amplitude = seconds >= 0.5 && seconds < 1.8 ? 0.2 : 0.0004;
  const value = Math.sin(2 * Math.PI * 440 * seconds) * amplitude;
  pcm.writeFloatLE(value, frame * 8);
  pcm.writeFloatLE(value, frame * 8 + 4);
}
const converter = new PcmTo16k({ sampleRate: inputRate, channels: 2, format: 'f32', bits: 32, blockAlign: 8 });
const vad = new VadSegmenter({ sensitivity: 0.5 });
const segments = [];
for (let offset = 0; offset < pcm.length; offset += 3840) {
  segments.push(...vad.push(converter.push(pcm.subarray(offset, offset + 3840))));
}
segments.push(...vad.flush());
assert.equal(segments.length, 1);
assert.ok(segments[0].samples.length > 16000);
const wav = encodeWav16(segments[0].samples);
assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
assert.equal(wav.readUInt32LE(24), 16000);

console.log('selftest: agenda, speaker clustering, audio/VAD all passed');
