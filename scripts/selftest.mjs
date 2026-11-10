// Pure local self-test: no DSH profile, no native helper and no model needed.
// Run with `npm run selftest`.

import assert from 'node:assert/strict';
import { PcmTo16k, VadSegmenter, encodeWav16 } from '../lib/audio.mjs';
import { parseAgenda, currentAgenda, agendaSpeakers, normalizeOcrText } from '../lib/agenda.mjs';
import { extractOfficeText } from '../lib/office.mjs';
import { SpeakerClusterer } from '../lib/speaker.mjs';
import {
  DEFAULT_SCRIPT_PROMPT,
  buildCueSystemPrompt,
  buildScriptSystemPrompt,
  dueCues,
  formatScriptAgenda,
  markAgendaEntries,
  nameMatches,
  normalizePersonName
} from '../lib/script.mjs';

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

// --- user-only speech drafts (讲词) ---------------------------------------
assert.equal(normalizePersonName(' 张 医 生 '), '张医生');
assert.equal(nameMatches('张医生（市医院）', '张医生'), true);
assert.equal(nameMatches('Zhang Wei', 'zhang wei'), true);
assert.equal(nameMatches('张医生', '李主任'), false);
assert.equal(nameMatches('', '张医生'), false);
const marked = markAgendaEntries(parsed.entries, '张医生');
assert.deepEqual(marked.map((item) => item.mine), [true, false, false]);
const scriptPrompt = buildScriptSystemPrompt({
  entries: parsed.entries,
  userName: '张医生',
  userOrg: '市医院',
  title: '创面修复研讨会',
  topic: '创面修复',
  domainLabel: '医学',
  prompt: ''
});
assert.match(scriptPrompt, /我的姓名：张医生（市医院）/);
assert.match(scriptPrompt, /［我的环节］/);
assert.match(scriptPrompt, /只输出我的讲词/);
assert.match(scriptPrompt, /14:00-14:30 张医生（市医院）：创面修复病例分享/);
assert.ok(scriptPrompt.includes(DEFAULT_SCRIPT_PROMPT));
const customPrompt = buildScriptSystemPrompt({
  entries: parsed.entries,
  userName: '张医生',
  prompt: '每段讲词不超过 80 字，语气更轻松'
});
assert.match(customPrompt, /每段讲词不超过 80 字，语气更轻松/);
assert.doesNotMatch(customPrompt, /每段讲词 120–300 字/);
const liAgenda = formatScriptAgenda(parsed.entries, '李主任').split('\n');
assert.ok(!liAgenda[0].includes('［我的环节］'));
assert.ok(liAgenda[1].includes('［我的环节］'));
assert.ok(!liAgenda[2].includes('［我的环节］'));

// --- 串词 cue scheduling (role-aware, just in time) -------------------------
const cueAgenda = [
  { startMin: 840, endMin: 870, speaker: '张医生', org: '市医院', topic: '病例分享' },
  { startMin: 900, endMin: 920, speaker: '李主任', org: '省医院', topic: '手术演示' },
  { startMin: 960, endMin: 990, speaker: '我', org: '本院', topic: '总结' }
];
const hostOpening = dueCues({ entries: cueAgenda, role: 'host', userName: '我', minutes: 838 });
assert.deepEqual(hostOpening.map((item) => item.kind), ['opening']);
const hostTransition = dueCues({ entries: cueAgenda, role: 'host', userName: '我', minutes: 899 });
assert.deepEqual(hostTransition.map((item) => item.kind), ['transition']);
assert.equal(hostTransition[0].index, 1);
const hostClosing = dueCues({ entries: cueAgenda, role: 'host', userName: '我', minutes: 989 });
assert.deepEqual(hostClosing.map((item) => item.kind), ['closing']);
const speakerDue = dueCues({ entries: cueAgenda, role: 'speaker', userName: '我', minutes: 958 });
assert.deepEqual(speakerDue.map((item) => item.kind), ['thanks']);
assert.equal(dueCues({ entries: cueAgenda, role: 'speaker', userName: '我', minutes: 898 }).length, 0);
const hostCuePrompt = buildCueSystemPrompt({
  kind: 'transition',
  role: 'host',
  entry: cueAgenda[1],
  prevEntry: cueAgenda[0],
  nextEntry: cueAgenda[2],
  entries: cueAgenda,
  userName: '我',
  domainLabel: '医学',
  transcript: '张医生：我们做了 32 例……',
  nowClock: '14:58'
});
assert.match(hostCuePrompt, /总结刚刚结束环节/);
assert.match(hostCuePrompt, /张医生：我们做了 32 例/);
const thanksCuePrompt = buildCueSystemPrompt({ kind: 'thanks', role: 'speaker', entry: cueAgenda[2], entries: cueAgenda, userName: '我' });
assert.match(thanksCuePrompt, /感谢主持人的介绍/);
assert.doesNotMatch(thanksCuePrompt, /总结刚刚结束环节/);

// --- OCR spacing and OOXML text extraction --------------------------------
// A line that is only a time range (or only a dash) must not throw: every
// splitSpeakerOrg branch has to return the same shape.
const bareTime = parseAgenda('14:00-14:30\n15:00-15:20 茶歇\n16:00-', 'bare.txt');
assert.ok(Array.isArray(bareTime.entries));
assert.equal(bareTime.entries.some((entry) => entry.startMin === 840), true);

const ocrText = normalizeOcrText('会 议 日 程 14 ： 00 · 14 ： 30 张 医 生 （ 市 医 院 ） 病 例 14 ： 30 · 15 ： 00 讨 论');
const ocrParsed = parseAgenda(ocrText, 'ocr.txt');
assert.equal(ocrParsed.entries.length, 2);
assert.equal(ocrParsed.entries[0].speaker, '张医生');
assert.equal(ocrParsed.entries[1].topic, '讨论');

// One session can list several participants; speaker/org stay as joined text
// for every prompt and display path.
const multiSession = parseAgenda(JSON.stringify([{
  start: '14:00',
  end: '14:30',
  topic: '圆桌讨论',
  participants: [
    { name: '张医生', org: '市医院' },
    { name: '李主任', org: '省医院' }
  ]
}]), 'multi.json');
assert.equal(multiSession.entries[0].participants.length, 2);
assert.equal(multiSession.entries[0].speaker, '张医生、李主任');
assert.equal(multiSession.entries[0].org, '市医院、省医院');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(name, content) {
  const nameBytes = Buffer.from(name, 'utf8');
  const data = Buffer.from(content, 'utf8');
  const crc = crc32(data);
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  nameBytes.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, central, eocd]);
}

const docx = storedZip(
  'word/document.xml',
  '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>14:00-14:30 张医生（市医院） 病例分享</w:t></w:r></w:p></w:body></w:document>'
);
assert.match(extractOfficeText(docx, 'agenda.docx'), /张医生（市医院）/);

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

console.log('selftest: agenda parsing, OCR spacing, OOXML extraction, user-only script prompts, speaker clustering, audio/VAD all passed');
