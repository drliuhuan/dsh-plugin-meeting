// The live meeting state machine.
//
// One active meeting owns:
//   - a native WASAPI loopback capture and its VAD segmentation,
//   - a serialized SenseVoice ASR queue,
//   - a debounced LLM correction/translation queue,
//   - a rolling minutes generator,
//   - a Q&A queue whose answers stream to the browser over SSE,
//   - a small on-disk history under ~/.dsh/meetings.
//
// All mutations happen on the Host; the browser is a projection of `snapshot()`
// plus incremental events.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PcmTo16k, VadSegmenter, encodeWav16 } from './audio.mjs';
import { ensureNativeHelper, listRenderDevices, ocrImage, startLoopback } from './native.mjs';
import { SpeechAsr } from './asr.mjs';
import { SpeakerClusterer, SpeakerEncoder, ensureSpeakerModel, loadSherpa } from './speaker.mjs';
import { currentAgenda, normalizeOcrText, parseAgenda } from './agenda.mjs';
import { DOMAINS, MeetingAi, SUMMARY_LANGUAGES, TARGET_LANGUAGES } from './ai.mjs';
import { clampString, clampText, nowIso, safeError, sleep } from './util.mjs';

const ASR_LANGUAGES = new Set(['auto', 'zh', 'en', 'yue', 'ja', 'ko']);
const CORRECTION_BATCH = 6;
const CORRECTION_BATCH_MAX = 10;
const CORRECTION_DEBOUNCE_MS = 250;
const SUMMARY_INTERVAL_MS = 60000;
const SUMMARY_MIN_NEW_LINES = 4;
const SUMMARY_MIN_GAP_MS = 45000;
const SUMMARY_IDLE_MS = 90000;
const MAX_TRANSCRIPT_LINES = 4000;
const MAX_ASR_QUEUE = 40;
const TURN_GAP_MS = 45000;
const REFINE_INTERVAL_MS = 60000;
const REFINE_MAX_CHARS = 14000;

function newMeetingId() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${stamp}-${randomUUID().slice(0, 4)}`;
}

function normalizeSettings(input = {}, previous = {}) {
  const domain = typeof input.domain === 'string' && Object.hasOwn(DOMAINS, input.domain)
    ? input.domain
    : (previous.domain ?? 'general');
  return {
    title: clampString(input.title, 120, previous.title ?? ''),
    domain,
    customDomain: clampString(input.customDomain, 60, previous.customDomain ?? ''),
    topic: clampString(input.topic, 200, previous.topic ?? ''),
    glossary: clampText(input.glossary, 2000, previous.glossary ?? ''),
    targetLang: typeof input.targetLang === 'string' && Object.hasOwn(TARGET_LANGUAGES, input.targetLang)
      ? input.targetLang
      : (previous.targetLang ?? 'off'),
    asrLang: typeof input.asrLang === 'string' && ASR_LANGUAGES.has(input.asrLang)
      ? input.asrLang
      : (previous.asrLang ?? 'auto'),
    summaryLang: typeof input.summaryLang === 'string' && Object.hasOwn(SUMMARY_LANGUAGES, input.summaryLang)
      ? input.summaryLang
      : (previous.summaryLang ?? 'zh'),
    webSearch: input.webSearch === undefined ? (previous.webSearch ?? true) : input.webSearch !== false,
    deviceId: clampString(input.deviceId, 400, previous.deviceId ?? ''),
    micEnabled: input.micEnabled === undefined ? (previous.micEnabled ?? false) : input.micEnabled !== false,
    micDeviceId: clampString(input.micDeviceId, 400, previous.micDeviceId ?? ''),
    speakers: input.speakers === undefined ? (previous.speakers ?? true) : input.speakers !== false,
    speakerThreshold: Number.isFinite(Number(input.speakerThreshold))
      ? Math.min(0.95, Math.max(0.4, Number(input.speakerThreshold)))
      : (previous.speakerThreshold ?? 0.66),
    sensitivity: Number.isFinite(Number(input.sensitivity))
      ? Math.min(1, Math.max(0, Number(input.sensitivity)))
      : (previous.sensitivity ?? 0.5)
  };
}

async function atomicWrite(file, data) {
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
  await fsp.writeFile(temp, data, 'utf8');
  try {
    await fsp.rename(temp, file);
  } catch {
    await fsp.writeFile(file, data, 'utf8');
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

function publicLine(line) {
  return {
    id: line.id,
    at: line.at,
    startMs: line.startMs,
    endMs: line.endMs,
    raw: line.raw,
    text: line.text,
    translation: line.translation,
    speakerId: line.speakerId ?? null,
    speakerName: line.speakerName ?? null,
    speakerOrg: line.speakerOrg ?? null,
    speakerSuggested: line.speakerSuggested === true,
    correctionStatus: line.correctionStatus,
    translationStatus: line.translationStatus,
    correctionError: line.correctionError ?? null
  };
}

function publicTurn(turn) {
  return {
    id: turn.id,
    speakerId: turn.speakerId ?? null,
    speakerName: turn.speakerName ?? null,
    speakerOrg: turn.speakerOrg ?? null,
    speakerSuggested: turn.speakerSuggested === true,
    startMs: turn.startMs,
    endMs: turn.endMs,
    text: turn.text,
    translation: turn.translation,
    correctionStatus: turn.correctionStatus,
    refinedAt: turn.refinedAt ?? 0,
    updatedAt: turn.updatedAt ?? 0,
    segments: Array.isArray(turn.lines) ? turn.lines.map(publicLine) : []
  };
}

function buildTurnsFromLines(lines) {
  const turns = [];
  let sequence = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const last = turns[turns.length - 1];
    const canJoin = last
      && last.speakerId
      && line.speakerId
      && last.speakerId === line.speakerId
      && Number(line.startMs) - Number(last.endMs) <= TURN_GAP_MS;
    if (canJoin) {
      last.lines.push(line);
      last.endMs = line.endMs;
      line.turnId = last.id;
      continue;
    }
    const turn = {
      id: `t${sequence += 1}`,
      speakerId: line.speakerId ?? null,
      speakerName: line.speakerName ?? null,
      speakerOrg: line.speakerOrg ?? null,
      speakerSuggested: line.speakerSuggested === true,
      startMs: line.startMs,
      endMs: line.endMs,
      lines: [line],
      text: '',
      translation: '',
      refinedText: '',
      refinedThroughLineId: null,
      refinedAt: 0,
      correctionStatus: 'done',
      updatedAt: Date.now()
    };
    line.turnId = turn.id;
    turns.push(turn);
  }
  for (const turn of turns) {
    turn.text = turn.lines.map((line) => line.text || line.raw).filter(Boolean).join(' ');
    turn.translation = turn.lines.map((line) => line.translation || '').filter(Boolean).join(' ');
    const pending = turn.lines.some((line) => line.correctionStatus === 'pending' || line.correctionStatus === 'correcting');
    const failed = turn.lines.some((line) => line.correctionStatus === 'error');
    turn.correctionStatus = pending ? 'pending' : failed ? 'partial' : 'done';
  }
  return turns;
}

function publicAnswer(answer) {  return {
    id: answer.id,
    at: answer.at,
    question: answer.question,
    text: answer.text,
    status: answer.status,
    sources: answer.sources,
    searchError: answer.searchError ?? null,
    error: answer.error ?? null
  };
}

export class MeetingService {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.dataRoot = options.dataRoot;
    this.logger = options.logger ?? ctx.logger;
    this.ai = new MeetingAi(ctx);
    this.asr = new SpeechAsr(ctx);
    this.subscribers = new Set();
    this.active = null;
    this.seq = 0;
    this.disposed = false;
    this.abort = new AbortController();
    this.summaryTimer = null;
    this.prepareTask = null;
    this.devicesCache = { loopback: { at: 0, devices: [] }, mic: { at: 0, devices: [] } };
    this.lastSettings = normalizeSettings({});
    this.pendingAgenda = { text: '', entries: [], warnings: [], updatedAt: 0, source: 'text' };
    this.lastClientError = null;
    this.cleanupStarted = false;
  }

  /* ------------------------------------------------------------------ */
  /* events                                                             */
  /* ------------------------------------------------------------------ */

  emit(type, payload) {
    if (this.disposed) return;
    this.seq += 1;
    const event = { seq: this.seq, type, payload, at: nowIso() };
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // one dead browser connection must not break the meeting
      }
    }
  }

  subscribe(subscriber) {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /* ------------------------------------------------------------------ */
  /* snapshots                                                          */
  /* ------------------------------------------------------------------ */

  snapshot() {
    const asr = this.asr.snapshot();
    return {
      ok: true,
      seq: this.seq,
      now: nowIso(),
      active: this.active === null ? null : this.serializeMeeting(this.active),
      settings: this.lastSettings,
      agenda: this.active ? this.active.agenda : this.pendingAgenda,
      agendaNow: currentAgenda((this.active ? this.active.agenda : this.pendingAgenda)?.entries, new Date()),
      asr,
      services: {
        llm: Boolean(this.ai.llm()),
        model: this.ai.selection() ?? null,
        speech: asr.available,
        web: (() => {
          try {
            return Boolean(this.ctx.get('web')?.search);
          } catch {
            return false;
          }
        })()
      }
    };
  }

  /** Diagnostics for support: client-module registration and native paths. */
  debug() {
    let client = { error: 'clientModules unavailable' };
    try {
      const registry = this.ctx.get('clientModules');
      const graph = registry?.graph?.();
      const entries = Array.isArray(graph?.entries) ? graph.entries : [];
      client = {
        total: entries.length,
        meeting: entries.filter((entry) => entry.id === 'dsh-plugin-meeting'),
        clientPath: registry?.clientPath?.('dsh-plugin-meeting') ?? null
      };
    } catch (error) {
      client = { error: safeError(error) };
    }
    return {
      ok: true,
      now: nowIso(),
      client,
      dataRoot: this.dataRoot,
      activeId: this.active?.id ?? null,
      lastClientError: this.lastClientError,
      speakerModel: path.join(this.dataRoot, '.models', 'campplus_zh_16k.onnx'),
      native: path.join(this.dataRoot, '.native', 'LoopbackCapture.exe')
    };
  }

  serializeMeeting(meeting) {
    return {
      id: meeting.id,
      title: meeting.title,
      domain: meeting.domain,
      customDomain: meeting.customDomain,
      topic: meeting.topic,
      glossary: meeting.glossary,
      targetLang: meeting.targetLang,
      asrLang: meeting.asrLang,
      summaryLang: meeting.summaryLang,
      webSearch: meeting.webSearch,
      deviceId: meeting.deviceId,
      micEnabled: meeting.micEnabled === true,
      micDeviceId: meeting.micDeviceId ?? '',
      sensitivity: meeting.sensitivity,
      speakersEnabled: meeting.speakers,
      speakerThreshold: meeting.speakerThreshold,
      speakers: meeting.speakersList,
      speakerState: meeting.speakerState,
      speakerError: meeting.speakerError,
      status: meeting.status,
      error: meeting.error,
      createdAt: meeting.createdAt,
      startedAt: meeting.startedAt,
      endedAt: meeting.endedAt,
      readOnly: meeting.readOnly === true,
      agenda: meeting.agenda,
      agendaNow: currentAgenda(meeting.agenda?.entries, new Date()),
      capture: meeting.capture,
      asrState: meeting.asrState,
      counts: {
        lines: meeting.transcript.length,
        turns: meeting.turns.length,
        corrected: meeting.transcript.filter((line) => line.correctionStatus === 'done').length,
        answers: meeting.answers.length
      },
      refineState: meeting.refineState ?? { status: 'idle' },
      summary: {
        markdown: meeting.summary.markdown,
        updatedAt: meeting.summary.updatedAt,
        status: meeting.summary.status,
        error: meeting.summary.error,
        version: meeting.summary.version
      },
      transcript: meeting.transcript.map(publicLine),
      turns: meeting.turns.map(publicTurn),
      answers: meeting.answers.map(publicAnswer)
    };
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  async start(input = {}) {
    if (this.disposed) throw Object.assign(new Error('会议插件已卸载'), { code: 'DISPOSED' });
    if (this.active !== null && !this.active.readOnly
      && !['ended', 'error'].includes(this.active.status)) {
      throw Object.assign(new Error('已有一场会议正在进行，请先结束当前会议'), { code: 'MEETING_ACTIVE' });
    }
    const settings = normalizeSettings(input, this.lastSettings);
    this.lastSettings = settings;
    const agendaText = typeof input.agendaText === 'string' && input.agendaText.trim().length > 0
      ? input.agendaText
      : this.pendingAgenda.text;
    const agenda = parseAgenda(agendaText, input.agendaFilename || '');
    const id = newMeetingId();
    const dir = path.join(this.dataRoot, id);
    await fsp.mkdir(dir, { recursive: true });

    const meeting = {
      id,
      dir,
      ...settings,
      agenda,
      status: 'preparing',
      error: null,
      createdAt: Date.now(),
      startedAt: 0,
      endedAt: 0,
      readOnly: false,
      capture: null,
      micHandle: null,
      micConverter: null,
      micVad: null,
      asrState: this.asr.snapshot(),
      speakerState: { phase: settings.speakers ? 'idle' : 'off' },
      speakerError: null,
      speakersList: [],
      clusterer: null,
      transcript: [],
      turns: [],
      turnSeq: 0,
      newSinceRefine: 0,
      refineState: { status: 'idle', updatedAt: 0, error: null },
      refineBusy: false,
      refineTimer: null,
      turnsTimer: null,
      answers: [],
      summary: { markdown: '', updatedAt: 0, status: 'idle', error: null, version: 0 },
      lineSeq: 0,
      answerSeq: 0,
      newSinceSummary: 0,
      lastSummaryAttempt: 0,
      summaryBusy: false,
      correctionPending: [],
      correctionBusy: false,
      correctionTimer: null,
      asrQueue: Promise.resolve(),
      asrPending: 0,
      asrFailures: 0,
      stopping: false,
      transcriptTimer: null,
      answersTimer: null
    };
    this.active = meeting;
    await this.persistMeta(meeting);
    this.emit('state', this.snapshot());
    void this.runCapturePipeline(meeting).catch((error) => {
      this.failMeeting(meeting, error);
    });
    return this.snapshot();
  }

  async runCapturePipeline(meeting) {
    this.emit('status', { status: 'preparing', message: '正在准备本地语音识别' });
    await this.asr.ensureReady((state) => {
      meeting.asrState = state;
      this.emit('asr', state);
    }, this.abort.signal);
    if (meeting.stopping || this.active !== meeting) return;

    await this.prepareSpeaker(meeting);
    if (meeting.stopping || this.active !== meeting) return;

    await this.startCapture(meeting);
    if (meeting.stopping || this.active !== meeting) return;
    if (meeting.micEnabled) {
      void this.startMicCapture(meeting).catch((error) => {
        this.emit('warning', { message: `麦克风采集不可用：${safeError(error)}` });
      });
    }

    meeting.status = 'listening';
    meeting.startedAt = Date.now();
    this.emit('status', { status: 'listening', startedAt: meeting.startedAt });
    await this.persistMeta(meeting);
    this.startSummaryTimer(meeting);
    this.startRefineTimer(meeting);
  }

  /**
   * Load CAM++ and prepare the online clusterer.  Speaker labels are an
   * enhancement: a missing runtime or a failed 28 MB model download must not
   * stop the meeting itself.
   */
  async prepareSpeaker(meeting) {
    if (!meeting.speakers) {
      meeting.speakerState = { phase: 'off' };
      this.emit('speaker', { phase: 'off', speakers: [] });
      return;
    }
    meeting.speakerState = { phase: 'preparing' };
    this.emit('speaker', { phase: 'preparing', speakers: [] });
    try {
      const model = await ensureSpeakerModel(this.dataRoot, {
        signal: this.abort.signal,
        logger: this.logger,
        onProgress: (state) => {
          meeting.speakerState = { ...state };
          this.emit('speaker', { ...state, speakers: meeting.speakersList });
        }
      });
      const sherpa = loadSherpa();
      this.speakerEncoder = new SpeakerEncoder(sherpa, model);
      meeting.clusterer = new SpeakerClusterer({ threshold: meeting.speakerThreshold });
      meeting.speakerState = { phase: 'ready' };
      this.emit('speaker', { phase: 'ready', speakers: meeting.speakersList });
    } catch (error) {
      meeting.speakerError = safeError(error);
      meeting.speakerState = { phase: 'error', error: meeting.speakerError };
      this.emit('speaker', { phase: 'error', error: meeting.speakerError, speakers: meeting.speakersList });
      this.emit('warning', { message: `发言人区分不可用：${meeting.speakerError}` });
    }
  }

  identifySpeaker(meeting, segment) {
    if (!this.speakerEncoder || !meeting.clusterer) return null;
    try {
      const embedding = this.speakerEncoder.embed(segment.samples);
      if (embedding === null) return null;
      const result = meeting.clusterer.assign(embedding, segment.endMs - segment.startMs);
      if (result !== null && result.created) {
        // Use the agenda as a *suggestion* for a brand-new cluster: if the
        // current agenda slot names one person who is not already assigned,
        // start with that name (marked as suggested) and let the user correct it.
        const now = currentAgenda(meeting.agenda?.entries, new Date());
        const entry = now.entry;
        if (now.status === 'current' && entry && entry.speaker
          && !meeting.speakersList.some((speaker) => speaker.name === entry.speaker)) {
          const renamed = meeting.clusterer.rename(result.id, entry.speaker, entry.org || '');
          if (renamed) {
            result.name = renamed.name;
            result.org = renamed.org;
            result.agendaSuggested = true;
          }
        }
        meeting.speakersList = meeting.clusterer.list();
        this.emit('speaker', {
          phase: 'ready',
          speakers: meeting.speakersList,
          created: result.id,
          agendaSuggested: result.agendaSuggested === true
        });
      }
      return result;
    } catch (error) {
      // A single bad utterance must not disable the rest of the meeting.
      this.logger?.warn?.(`meeting: speaker embedding failed: ${safeError(error)}`);
      return null;
    }
  }

  async startCapture(meeting) {
    const exe = await ensureNativeHelper(this.dataRoot, { logger: this.logger });
    const capture = await startLoopback({
      exe,
      deviceId: meeting.deviceId || undefined,
      signal: this.abort.signal,
      onHeader: (header) => {
        const converter = new PcmTo16k(header);
        const vad = new VadSegmenter({
          sensitivity: meeting.sensitivity,
          minThreshold: 0.0045,
          minSpeechMs: 380,
          minSilenceMs: 620,
          maxSegmentMs: 20000,
          preRollMs: 300,
          tailMs: 180
        });
        meeting.converter = converter;
        meeting.vad = vad;
        meeting.capture = {
          deviceName: header.deviceName || '系统默认播放设备',
          deviceId: header.deviceId || '',
          sampleRate: header.sampleRate,
          channels: header.channels,
          format: header.format
        };
        this.emit('capture', meeting.capture);
      },
      onPcm: (buffer) => {
        if (!meeting.converter || !meeting.vad) return;
        try {
          const samples = meeting.converter.push(buffer);
          if (samples.length === 0) return;
          const segments = meeting.vad.push(samples);
          for (const segment of segments) this.enqueueSegment(meeting, segment);
        } catch (error) {
          this.emit('warning', { message: `音频处理失败：${safeError(error)}` });
        }
      },
      onClose: (reason) => {
        if (meeting.stopping || meeting.status === 'ended' || meeting.status === 'error') return;
        const detail = reason === 'socket-closed'
          ? '系统音频采集连接已断开（播放设备可能被切换或会议软件释放了音频）'
          : `系统音频采集已停止（${reason}）`;
        this.failMeeting(meeting, Object.assign(new Error(detail), { code: 'CAPTURE_CLOSED' }));
      },
      onError: (error) => {
        if (meeting.stopping) return;
        this.failMeeting(meeting, error);
      }
    });
    meeting.captureHandle = capture;
    meeting.status = 'capturing';
    this.emit('status', { status: 'capturing', capture: meeting.capture });
  }

  async startMicCapture(meeting) {
    const exe = await ensureNativeHelper(this.dataRoot, { logger: this.logger });
    const capture = await startLoopback({
      exe,
      source: 'mic',
      deviceId: meeting.micDeviceId || undefined,
      signal: this.abort.signal,
      onHeader: (header) => {
        meeting.micConverter = new PcmTo16k(header);
        meeting.micVad = new VadSegmenter({
          sensitivity: meeting.sensitivity,
          minThreshold: 0.004,
          minSpeechMs: 320,
          minSilenceMs: 560,
          maxSegmentMs: 20000,
          preRollMs: 250,
          tailMs: 160
        });
        meeting.capture = {
          ...(meeting.capture ?? {}),
          mic: {
            deviceName: header.deviceName || '系统默认麦克风',
            deviceId: header.deviceId || '',
            sampleRate: header.sampleRate,
            channels: header.channels,
            format: header.format
          }
        };
        this.emit('capture', meeting.capture);
      },
      onPcm: (buffer) => {
        if (!meeting.micConverter || !meeting.micVad) return;
        try {
          const samples = meeting.micConverter.push(buffer);
          if (samples.length === 0) return;
          for (const segment of meeting.micVad.push(samples)) {
            this.enqueueSegment(meeting, segment, 'mic');
          }
        } catch (error) {
          this.emit('warning', { message: `麦克风音频处理失败：${safeError(error)}` });
        }
      },
      onClose: (reason) => {
        if (meeting.stopping) return;
        this.emit('warning', { message: `麦克风采集已停止（${reason}）` });
      },
      onError: (error) => {
        this.emit('warning', { message: `麦克风采集失败：${safeError(error)}` });
      }
    });
    meeting.micHandle = capture;
  }

  enqueueSegment(meeting, segment, source = 'loopback') {
    if (meeting.stopping) return;
    if (segment.samples.length < 1600) return; // < 100 ms is noise
    if (meeting.asrPending >= MAX_ASR_QUEUE) {
      this.emit('warning', { message: '识别队列已满，丢弃了一段音频（模型或 CPU 处理不过来）' });
      return;
    }
    meeting.asrPending += 1;
    meeting.asrQueue = meeting.asrQueue.then(async () => {
      try {
        await this.transcribeSegment(meeting, segment, source);
      } catch (error) {
        meeting.asrFailures += 1;
        this.emit('warning', { message: `语音识别失败：${safeError(error)}` });
        if (meeting.asrFailures >= 6 && meeting.status === 'listening') {
          this.failMeeting(meeting, Object.assign(new Error('连续多次语音识别失败，已停止听会'), { code: 'ASR_FAILED' }));
        }
      } finally {
        meeting.asrPending -= 1;
      }
    });
  }

  findOrCreateTurn(meeting, line) {
    const last = meeting.turns[meeting.turns.length - 1];
    const canJoin = last
      && last.speakerId
      && line.speakerId
      && last.speakerId === line.speakerId
      && Number(line.startMs) - Number(last.endMs) <= TURN_GAP_MS;
    if (canJoin) {
      last.lines.push(line);
      last.endMs = line.endMs;
      last.updatedAt = Date.now();
      line.turnId = last.id;
      return last;
    }
    const turn = {
      id: `t${meeting.turnSeq += 1}`,
      speakerId: line.speakerId ?? null,
      speakerName: line.speakerName ?? null,
      speakerOrg: line.speakerOrg ?? null,
      speakerSuggested: line.speakerSuggested === true,
      startMs: line.startMs,
      endMs: line.endMs,
      lines: [line],
      text: '',
      translation: '',
      refinedText: '',
      refinedThroughLineId: null,
      refinedAt: 0,
      correctionStatus: 'pending',
      updatedAt: Date.now()
    };
    line.turnId = turn.id;
    meeting.turns.push(turn);
    return turn;
  }

  recomposeTurn(meeting, turn) {
    const lines = Array.isArray(turn.lines) ? turn.lines : [];
    if (lines.length === 0) {
      turn.text = '';
      return;
    }
    let text;
    if (turn.refinedText && turn.refinedThroughLineId) {
      const index = lines.findIndex((line) => line.id === turn.refinedThroughLineId);
      const after = index >= 0 ? lines.slice(index + 1) : lines;
      text = [turn.refinedText, ...after.map((line) => line.text || line.raw)].filter(Boolean).join(' ');
    } else {
      text = lines.map((line) => line.text || line.raw).filter(Boolean).join(' ');
    }
    turn.text = text;
    if (meeting.targetLang !== 'off') {
      turn.translation = lines.map((line) => line.translation || '').filter(Boolean).join(' ');
    } else {
      turn.translation = '';
    }
    const pending = lines.some((line) => line.correctionStatus === 'pending' || line.correctionStatus === 'correcting');
    const failed = lines.some((line) => line.correctionStatus === 'error');
    turn.correctionStatus = turn.refinedText ? 'refined' : pending ? 'pending' : failed ? 'partial' : 'done';
    if (lines[0]?.speakerSuggested === true && turn.speakerSuggested !== true) turn.speakerSuggested = true;
    turn.updatedAt = Date.now();
  }

  refreshTurnForLine(meeting, line) {
    const turn = meeting.turns.find((item) => item.id === line.turnId
      || item.lines.some((candidate) => candidate.id === line.id));
    if (!turn) return;
    this.recomposeTurn(meeting, turn);
    this.emit('turn', publicTurn(turn));
    this.scheduleTurnsPersist(meeting);
  }

  async transcribeSegment(meeting, segment, source = 'loopback') {
    this.emit('recognizing', { startMs: segment.startMs, endMs: segment.endMs });
    const speaker = source === 'mic'
      ? { id: 'self', name: '自己', org: '', agendaSuggested: false }
      : this.identifySpeaker(meeting, segment);
    const wav = encodeWav16(segment.samples);
    const result = await this.asr.transcribe(wav, meeting.asrLang, this.abort.signal);
    const text = String(result.text ?? '').replace(/\s+/g, ' ').trim();
    this.emit('recognized', { startMs: segment.startMs, endMs: segment.endMs });
    if (text.length === 0) return;
    meeting.asrFailures = 0;
    if (meeting.transcript.length >= MAX_TRANSCRIPT_LINES) {
      this.emit('warning', { message: '转写行数达到上限，旧行仍保留在磁盘，但不再进入实时上下文' });
    }
    const line = {
      id: `l${meeting.lineSeq += 1}`,
      at: Date.now(),
      startMs: segment.startMs,
      endMs: segment.endMs,
      raw: text,
      text,
      translation: '',
      speakerId: speaker?.id ?? null,
      speakerName: speaker?.name ?? null,
      speakerOrg: speaker?.org ?? null,
      speakerSuggested: speaker?.agendaSuggested === true,
      source,
      correctionStatus: 'pending',
      translationStatus: meeting.targetLang === 'off' ? 'off' : 'pending',
      correctionError: null,
      turnId: null
    };
    meeting.transcript.push(line);
    const turn = this.findOrCreateTurn(meeting, line);
    this.recomposeTurn(meeting, turn);
    meeting.newSinceSummary += 1;
    meeting.newSinceRefine += 1;
    this.emit('turn', publicTurn(turn));
    this.emit('line', publicLine(line));
    this.scheduleTranscriptPersist(meeting);
    this.scheduleTurnsPersist(meeting);
    this.queueCorrection(meeting, line);
  }

  failMeeting(meeting, error) {
    if (meeting.stopping || meeting.status === 'ended' || meeting.status === 'error') return;
    meeting.status = 'error';
    meeting.error = safeError(error);
    meeting.endedAt = Date.now();
    this.stopSummaryTimer();
    this.stopRefineTimer();
    try {
      meeting.captureHandle?.stop?.();
    } catch {
      // already gone
    }
    meeting.captureHandle = null;
    this.emit('error', { message: meeting.error, code: error?.code ?? 'MEETING_ERROR' });
    this.emit('status', { status: 'error', error: meeting.error });
    void this.persistMeta(meeting);
    void this.persistTranscript(meeting);
  }

  async stop() {
    const meeting = this.active;
    if (meeting === null || meeting.readOnly || meeting.status === 'ended') {
      return this.snapshot();
    }
    if (meeting.stopping) return this.snapshot();
    meeting.stopping = true;
    meeting.status = 'stopping';
    this.emit('status', { status: 'stopping', message: '正在收尾：处理剩余语音并生成最终纪要' });
    this.stopSummaryTimer();
    this.stopRefineTimer();
    try {
      meeting.captureHandle?.stop?.();
      meeting.captureHandle = null;
      meeting.micHandle?.stop?.();
      meeting.micHandle = null;
      const tail = meeting.vad?.flush?.() ?? [];
      for (const segment of tail) this.enqueueSegment(meeting, segment);
      const micTail = meeting.micVad?.flush?.() ?? [];
      for (const segment of micTail) this.enqueueSegment(meeting, segment, 'mic');
      meeting.converter = null;
      meeting.vad = null;
      meeting.micConverter = null;
      meeting.micVad = null;
      await Promise.race([meeting.asrQueue, sleep(30000)]);
      await this.waitForCorrections(meeting, 30000);
      await Promise.race([this.refineConversation(meeting, { final: true }), sleep(45000)]);
      await Promise.race([this.runSummary(meeting, { final: true }), sleep(45000)]);
    } catch (error) {
      this.emit('warning', { message: `收尾时出现问题：${safeError(error)}` });
    }
    meeting.status = 'ended';
    meeting.endedAt = Date.now();
    meeting.stopping = false;
    await this.persistMeta(meeting);
    await this.persistTranscript(meeting);
    await this.persistTurns(meeting);
    await this.persistAnswers(meeting);
    this.emit('status', { status: 'ended', endedAt: meeting.endedAt });
    this.emit('state', this.snapshot());
    return this.snapshot();
  }

  async load(id) {
    if (this.active !== null && !this.active.readOnly && !['ended', 'error'].includes(this.active.status)) {
      throw Object.assign(new Error('请先结束当前会议，再查看历史会议'), { code: 'MEETING_ACTIVE' });
    }
    if (typeof id !== 'string' || !/^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/.test(id)) {
      throw Object.assign(new Error('无效的会议编号'), { code: 'INVALID_ID' });
    }
    const dir = path.join(this.dataRoot, id);
    let meta;
    try {
      meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
    } catch {
      throw Object.assign(new Error('找不到这场会议的记录'), { code: 'NOT_FOUND' });
    }
    const readArray = async (name) => {
      try {
        const parsed = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    const transcript = await readArray('transcript.json');
    const storedTurns = await readArray('turns.json');
    const answers = await readArray('answers.json');
    let summary = '';
    try {
      summary = await fsp.readFile(path.join(dir, 'summary.md'), 'utf8');
    } catch {
      summary = '';
    }
    const normalizedLines = transcript.map((line) => ({
      ...line,
      correctionStatus: line.correctionStatus === 'correcting' ? 'pending' : (line.correctionStatus ?? 'done'),
      translationStatus: line.translationStatus ?? (line.translation ? 'done' : 'off')
    }));
    const turns = storedTurns.length > 0
      ? storedTurns.map((turn) => ({
        ...turn,
        lines: (Array.isArray(turn.segments) ? turn.segments : []).map((segment) => ({
          ...segment,
          turnId: turn.id,
          correctionStatus: segment.correctionStatus === 'correcting' ? 'pending' : (segment.correctionStatus ?? 'done')
        })),
        refinedText: typeof turn.refinedText === 'string' ? turn.refinedText : '',
        refinedThroughLineId: turn.refinedThroughLineId ?? null,
        refinedAt: Number(turn.refinedAt) || 0,
        updatedAt: Number(turn.updatedAt) || 0
      }))
      : buildTurnsFromLines(normalizedLines);
    const allLines = turns.flatMap((turn) => turn.lines);
    const meeting = {
      id,
      dir,
      ...normalizeSettings(meta, meta),
      status: 'ended',
      error: null,
      createdAt: Number(meta.createdAt) || Date.now(),
      startedAt: Number(meta.startedAt) || 0,
      endedAt: Number(meta.endedAt) || 0,
      readOnly: true,
      capture: meta.capture ?? null,
      asrState: { phase: 'idle' },
      speakerState: { phase: 'idle' },
      speakerError: null,
      speakersList: Array.isArray(meta.speakers) ? meta.speakers : [],
      clusterer: null,
      agenda: meta.agenda && Array.isArray(meta.agenda.entries)
        ? meta.agenda
        : { text: '', entries: [], warnings: [], updatedAt: 0, source: 'text' },
      transcript: allLines.length > 0 ? allLines : normalizedLines,
      turns,
      turnSeq: turns.length,
      newSinceRefine: 0,
      refineState: { status: 'done', updatedAt: 0, error: null },
      refineBusy: false,
      refineTimer: null,
      turnsTimer: null,
      answers: answers.map((answer) => ({ ...answer, status: answer.status === 'thinking' ? 'error' : answer.status })),
      summary: { markdown: summary, updatedAt: Number(meta.summaryUpdatedAt) || 0, status: summary ? 'done' : 'idle', error: null, version: 0 },
      lineSeq: allLines.length,
      answerSeq: answers.length,
      newSinceSummary: 0,
      lastSummaryAttempt: 0,
      summaryBusy: false,
      correctionPending: [],
      correctionBusy: false,
      correctionTimer: null,
      asrQueue: Promise.resolve(),
      asrPending: 0,
      asrFailures: 0,
      stopping: false
    };
    this.active = meeting;
    this.lastSettings = normalizeSettings(meeting, this.lastSettings);
    this.emit('state', this.snapshot());
    return this.snapshot();
  }

  async updateSettings(input = {}) {
    const meeting = this.active;
    const settings = normalizeSettings(input, meeting ?? this.lastSettings);
    this.lastSettings = settings;
    if (meeting !== null && !meeting.readOnly) {
      Object.assign(meeting, settings);
      if (meeting.transcript.length > 0 && meeting.summary.markdown.length > 0) {
        meeting.summary.status = 'stale';
      }
      await this.persistMeta(meeting);
    }
    this.emit('settings', this.lastSettings);
    this.emit('state', this.snapshot());
    return this.snapshot();
  }

  /**
   * Replace the meeting agenda from pasted text or an uploaded file.  The
   * parsed entries drive the current-item indicator, speaker-name suggestions,
   * and the reference block in every LLM prompt.
   */
  async setAgenda(text, filename = '') {
    const parsed = parseAgenda(text, filename);
    const agenda = { ...parsed, text: clampText(text, 20000), updatedAt: Date.now() };
    if (this.active !== null) {
      this.active.agenda = agenda;
      this.emit('agenda', { ...agenda, now: currentAgenda(agenda.entries, new Date()) });
      await this.persistMeta(this.active);
    } else {
      this.pendingAgenda = agenda;
      this.emit('agenda', { ...agenda, now: currentAgenda(agenda.entries, new Date()) });
    }
    this.emit('state', this.snapshot());
    return this.snapshot();
  }

  /**
   * OCR an uploaded/pasted agenda image locally, then parse the recognized text.
   * The image is written to a temp file only for the Windows OCR call and is
   * removed immediately; only the text and filename are kept.
   */
  async setAgendaImage(imageBase64, filename = '') {
    if (typeof imageBase64 !== 'string' || imageBase64.length < 100) {
      throw Object.assign(new Error('没有收到图片数据'), { code: 'IMAGE_EMPTY', status: 400 });
    }
    const payload = imageBase64.replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
    let buffer;
    try {
      buffer = Buffer.from(payload, 'base64');
    } catch {
      throw Object.assign(new Error('图片 base64 无法解码'), { code: 'IMAGE_INVALID', status: 400 });
    }
    if (buffer.length === 0) throw Object.assign(new Error('图片为空'), { code: 'IMAGE_EMPTY', status: 400 });
    if (buffer.length > 8 * 1024 * 1024) {
      throw Object.assign(new Error('图片太大（上限 8 MB）'), { code: 'IMAGE_TOO_LARGE', status: 413 });
    }
    let extension = 'png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8) extension = 'jpg';
    else if (buffer.subarray(0, 4).toString('ascii') === 'RIFF') extension = 'webp';
    else if (buffer[0] === 0x42 && buffer[1] === 0x4d) extension = 'bmp';
    else if (buffer[0] === 0x49 && buffer[1] === 0x49) extension = 'tiff';
    else if (buffer[0] === 0x4d && buffer[1] === 0x4d) extension = 'tiff';
    const tempDir = path.join(this.dataRoot, '.tmp');
    await fsp.mkdir(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `agenda-${randomUUID()}.${extension}`);
    try {
      await fsp.writeFile(tempFile, buffer);
      const text = await ocrImage(tempFile, this.dataRoot);
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw Object.assign(new Error('图片里没有识别到文字，请换一张更清晰、正对屏幕的日程截图'), {
          code: 'OCR_EMPTY',
          status: 422
        });
      }
      const cleaned = normalizeOcrText(text);
      const parsed = parseAgenda(cleaned, 'agenda-ocr.txt');
      const agenda = {
        ...parsed,
        text: cleaned,
        imageName: clampText(filename, 120),
        updatedAt: Date.now(),
        source: 'image'
      };
      if (this.active !== null) {
        this.active.agenda = agenda;
        this.emit('agenda', { ...agenda, now: currentAgenda(agenda.entries, new Date()) });
        await this.persistMeta(this.active);
      } else {
        this.pendingAgenda = agenda;
        this.emit('agenda', { ...agenda, now: currentAgenda(agenda.entries, new Date()) });
      }
      this.emit('state', this.snapshot());
      return this.snapshot();
    } finally {
      await fsp.rm(tempFile, { force: true }).catch(() => {});
    }
  }

  /**
   * Give a detected voice cluster a human-readable name (for example 张医生).
   * This is a local label, not voiceprint authentication.
   */
  async renameSpeaker(id, name, org) {
    const meeting = this.active;
    if (meeting === null) throw Object.assign(new Error('还没有会议'), { code: 'NO_MEETING' });
    const clean = clampString(name, 40, '');
    const cleanOrg = clampString(org, 60, '');
    if (clean.length === 0) throw Object.assign(new Error('发言人名称不能为空'), { code: 'INVALID_NAME' });
    let updated;
    if (meeting.clusterer) {
      updated = meeting.clusterer.rename(id, clean, cleanOrg);
    }
    if (!updated) {
      const existing = meeting.speakersList.find((item) => item.id === id);
      if (existing) updated = { id, name: clean, org: cleanOrg };
    }
    if (!updated) throw Object.assign(new Error('没有找到这个发言人编号'), { code: 'SPEAKER_NOT_FOUND', status: 404 });
    meeting.speakersList = (meeting.clusterer?.list() ?? meeting.speakersList)
      .map((item) => (item.id === id ? { id, name: clean, org: cleanOrg, source: 'manual' } : item));
    for (const line of meeting.transcript) {
      if (line.speakerId === id) {
        line.speakerName = clean;
        line.speakerOrg = cleanOrg;
        line.speakerSuggested = false;
      }
    }
    for (const turn of meeting.turns) {
      if (turn.speakerId === id) {
        turn.speakerName = clean;
        turn.speakerOrg = cleanOrg;
        turn.speakerSuggested = false;
        this.emit('turn', publicTurn(turn));
      }
    }
    this.emit('speaker', { phase: meeting.speakerState?.phase ?? 'ready', speakers: meeting.speakersList, renamed: id });
    this.emit('state', this.snapshot());
    await this.persistTranscript(meeting);
    await this.persistMeta(meeting);
    return this.snapshot();
  }

  /* ------------------------------------------------------------------ */
  /* correction                                                         */
  /* ------------------------------------------------------------------ */

  queueCorrection(meeting, line) {
    if (meeting.readOnly) return;
    meeting.correctionPending.push(line);
    if (meeting.correctionTimer !== null) clearTimeout(meeting.correctionTimer);
    meeting.correctionTimer = setTimeout(() => {
      meeting.correctionTimer = null;
      void this.processCorrections(meeting);
    }, CORRECTION_DEBOUNCE_MS);
  }

  async processCorrections(meeting) {
    if (meeting.correctionBusy || meeting.readOnly) return;
    meeting.correctionBusy = true;
    try {
      while (meeting.correctionPending.length > 0) {
        const size = meeting.correctionPending.length > 10 ? CORRECTION_BATCH_MAX : CORRECTION_BATCH;
        const batch = meeting.correctionPending.splice(0, size);
        for (const line of batch) {
          line.correctionStatus = 'correcting';
          this.emit('line-update', publicLine(line));
        }
        try {
          const results = await this.ai.correctAndTranslate(batch.map((line) => ({
            id: line.id,
            raw: line.raw,
            startMs: line.startMs
          })), {
            domain: meeting.domain,
            customDomain: meeting.customDomain,
            topic: meeting.topic,
            glossary: meeting.glossary,
            targetLang: meeting.targetLang,
            agendaEntries: meeting.agenda?.entries,
            signal: this.abort.signal
          });
          const byId = new Map(results.map((item) => [item.id, item]));
          for (const line of batch) {
            const item = byId.get(line.id);
            if (item && item.missing !== true) {
              line.text = item.corrected;
              line.translation = item.translation;
              line.correctionStatus = 'done';
              line.translationStatus = meeting.targetLang === 'off' ? 'off' : 'done';
              line.correctionError = null;
            } else {
              line.correctionStatus = 'error';
              line.correctionError = '模型没有返回这一行';
            }
            this.emit('line-update', publicLine(line));
            this.refreshTurnForLine(meeting, line);
          }
        } catch (error) {
          for (const line of batch) {
            line.correctionStatus = 'error';
            line.correctionError = safeError(error);
            this.emit('line-update', publicLine(line));
            this.refreshTurnForLine(meeting, line);
          }
          this.emit('warning', { message: `校正/翻译失败：${safeError(error)}` });
        }
        this.scheduleTranscriptPersist(meeting);
      }
    } finally {
      meeting.correctionBusy = false;
    }
  }

  async retryCorrection() {
    const meeting = this.active;
    if (meeting === null || meeting.readOnly) return { retried: 0 };
    const failed = meeting.transcript.filter((line) => line.correctionStatus === 'error');
    for (const line of failed) {
      line.correctionStatus = 'pending';
      line.correctionError = null;
      this.emit('line-update', publicLine(line));
      this.queueCorrection(meeting, line);
    }
    return { retried: failed.length };
  }

  async waitForCorrections(meeting, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while ((meeting.correctionBusy || meeting.correctionPending.length > 0) && Date.now() < deadline) {
      await sleep(100);
    }
  }

  /* ------------------------------------------------------------------ */
  /* summary                                                            */
  /* ------------------------------------------------------------------ */

  startSummaryTimer(meeting) {
    this.stopSummaryTimer();
    this.summaryTimer = setInterval(() => {
      void this.maybeSummary(meeting);
    }, 15000);
  }

  stopSummaryTimer() {
    if (this.summaryTimer !== null) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = null;
    }
  }

  async maybeSummary(meeting) {
    if (this.active !== meeting || meeting.status !== 'listening') return;
    if (meeting.summaryBusy) return;
    if (meeting.newSinceSummary < SUMMARY_MIN_NEW_LINES
      && Date.now() - meeting.summary.updatedAt < SUMMARY_IDLE_MS) return;
    if (Date.now() - meeting.lastSummaryAttempt < SUMMARY_MIN_GAP_MS) return;
    void this.runSummary(meeting, { final: false });
  }

  async runSummary(meeting, options = {}) {
    if (meeting.summaryBusy) return;
    if (meeting.transcript.length === 0) {
      if (options.final) {
        meeting.summary.status = 'done';
        meeting.summary.markdown = '> 会议没有产生可识别的语音内容。';
        meeting.summary.updatedAt = Date.now();
        this.emit('summary', meeting.summary);
        await this.persistSummary(meeting);
      }
      return;
    }
    meeting.summaryBusy = true;
    meeting.lastSummaryAttempt = Date.now();
    meeting.summary = { ...meeting.summary, status: 'summarizing', error: null };
    this.emit('summary', meeting.summary);
    try {
      const markdown = await this.ai.summarize({
        lines: meeting.turns.length > 0 ? meeting.turns : meeting.transcript,
        previousSummary: meeting.summary.markdown,
        domain: meeting.domain,
        customDomain: meeting.customDomain,
        topic: meeting.topic,
        glossary: meeting.glossary,
        summaryLang: meeting.summaryLang,
        agendaEntries: meeting.agenda?.entries,
        final: options.final === true,
        signal: this.abort.signal
      });
      meeting.summary = {
        markdown,
        updatedAt: Date.now(),
        status: 'done',
        error: null,
        version: meeting.summary.version + 1
      };
      meeting.newSinceSummary = 0;
      this.emit('summary', meeting.summary);
      await this.persistSummary(meeting);
      await this.persistMeta(meeting);
    } catch (error) {
      meeting.summary = {
        ...meeting.summary,
        status: meeting.summary.markdown.length > 0 ? 'stale' : 'error',
        error: safeError(error)
      };
      this.emit('summary', meeting.summary);
      this.emit('warning', {
        message: meeting.summary.markdown.length > 0
          ? `纪要更新失败，保留上一版：${safeError(error)}`
          : `纪要生成失败：${safeError(error)}`
      });
    } finally {
      meeting.summaryBusy = false;
    }
  }

  async regenerateSummary() {
    const meeting = this.active;
    if (meeting === null || meeting.readOnly) return this.snapshot();
    void this.runSummary(meeting, { final: meeting.status === 'ended' });
    return this.snapshot();
  }

  async refineNow() {
    const meeting = this.active;
    if (meeting === null || meeting.readOnly) return this.snapshot();
    await this.refineConversation(meeting, { final: true });
    return this.snapshot();
  }

  /* ------------------------------------------------------------------ */
  /* whole-conversation refinement                                     */
  /* ------------------------------------------------------------------ */

  startRefineTimer(meeting) {
    this.stopRefineTimer();
    meeting.refineTimer = setInterval(() => {
      void this.refineConversation(meeting, { final: false });
    }, REFINE_INTERVAL_MS);
  }

  stopRefineTimer() {
    const meeting = this.active;
    if (meeting?.refineTimer) {
      clearInterval(meeting.refineTimer);
      meeting.refineTimer = null;
    }
    if (this.refineTimer) {
      clearInterval(this.refineTimer);
      this.refineTimer = null;
    }
  }

  selectTurnsForRefine(meeting) {
    const candidates = meeting.turns.filter((turn) => typeof turn.text === 'string' && turn.text.trim().length > 0);
    const selected = [];
    let chars = 0;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const turn = candidates[index];
      if (selected.length > 0 && chars + turn.text.length > REFINE_MAX_CHARS) break;
      selected.unshift(turn);
      chars += turn.text.length;
    }
    return selected;
  }

  async refineConversation(meeting, options = {}) {
    if (meeting === null || meeting.readOnly || meeting.refineBusy) return;
    if (!options.final && meeting.newSinceRefine === 0) return;
    const selected = this.selectTurnsForRefine(meeting);
    if (selected.length === 0) return;
    meeting.refineBusy = true;
    meeting.refineState = { status: 'refining', updatedAt: Date.now(), error: null, turns: selected.length };
    this.emit('refine', meeting.refineState);
    try {
      const corrected = await this.ai.refineTurns(selected.map((turn) => ({
        id: turn.id,
        text: turn.text,
        speakerName: turn.speakerName,
        speakerOrg: turn.speakerOrg
      })), {
        domain: meeting.domain,
        customDomain: meeting.customDomain,
        topic: meeting.topic,
        glossary: meeting.glossary,
        agendaEntries: meeting.agenda?.entries,
        signal: this.abort.signal
      });
      let updated = 0;
      for (const turn of selected) {
        const text = corrected.get(turn.id);
        if (typeof text !== 'string' || text.length === 0) continue;
        turn.refinedText = text;
        turn.refinedThroughLineId = turn.lines[turn.lines.length - 1]?.id ?? null;
        turn.refinedAt = Date.now();
        this.recomposeTurn(meeting, turn);
        this.emit('turn', publicTurn(turn));
        updated += 1;
      }
      meeting.newSinceRefine = 0;
      meeting.refineState = { status: 'done', updatedAt: Date.now(), error: null, turns: updated };
      this.emit('refine', meeting.refineState);
      await this.persistTurns(meeting);
    } catch (error) {
      meeting.refineState = {
        status: 'error',
        updatedAt: Date.now(),
        error: safeError(error),
        preview: typeof error?.preview === 'string' ? error.preview : null
      };
      this.emit('refine', meeting.refineState);
      this.emit('warning', { message: `整段二次校正失败：${safeError(error)}` });
    } finally {
      meeting.refineBusy = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* questions                                                          */
  /* ------------------------------------------------------------------ */

  async ask(input = {}) {
    const meeting = this.active;
    if (meeting === null) throw Object.assign(new Error('还没有会议，开始听会后再提问'), { code: 'NO_MEETING' });
    const question = clampString(input.question, 2000, '');
    if (question.length === 0) throw Object.assign(new Error('问题不能为空'), { code: 'EMPTY_QUESTION' });
    const answer = {
      id: `a${meeting.answerSeq += 1}`,
      at: Date.now(),
      question,
      text: '',
      status: 'searching',
      sources: [],
      searchError: null,
      error: null
    };
    meeting.answers.push(answer);
    this.emit('answer', publicAnswer(answer));
    void this.runAnswer(meeting, answer, input).catch((error) => {
      answer.status = 'error';
      answer.error = safeError(error);
      this.emit('answer', publicAnswer(answer));
    });
    return { ok: true, id: answer.id };
  }

  async runAnswer(meeting, answer, input) {
    const useWeb = meeting.webSearch && input.webSearch !== false;
    let search = { available: false, sources: [] };
    if (useWeb) {
      search = await this.ai.search(answer.question, { topic: meeting.topic });
      answer.sources = search.sources;
      answer.searchError = search.error ?? null;
      answer.status = 'thinking';
      this.emit('answer', publicAnswer(answer));
    } else {
      answer.status = 'thinking';
      this.emit('answer', publicAnswer(answer));
    }
    const history = meeting.answers
      .filter((item) => item.id !== answer.id && item.status === 'done' && item.text.length > 0)
      .slice(-4);
    const text = await this.ai.answer({
      question: answer.question,
      lines: meeting.turns.length > 0 ? meeting.turns : meeting.transcript,
      summary: meeting.summary.markdown,
      domain: meeting.domain,
      customDomain: meeting.customDomain,
      topic: meeting.topic,
      glossary: meeting.glossary,
      sources: search.sources,
      searchAttempted: useWeb,
      history,
      agendaEntries: meeting.agenda?.entries,
      language: meeting.summaryLang,
      signal: this.abort.signal,
      onDelta: (delta) => {
        answer.text += delta;
        this.emit('answer-delta', { id: answer.id, delta });
      }
    });
    answer.text = text;
    answer.status = 'done';
    this.emit('answer', publicAnswer(answer));
    this.scheduleAnswersPersist(meeting);
    await this.persistAnswers(meeting);
  }

  /* ------------------------------------------------------------------ */
  /* preparation and devices                                            */
  /* ------------------------------------------------------------------ */

  async prepare() {
    if (this.prepareTask !== null) return this.prepareTask;
    const meeting = this.active;
    this.prepareTask = (async () => {
      try {
        await this.asr.ensureReady((state) => {
          if (meeting !== null) meeting.asrState = state;
          this.emit('asr', state);
        }, this.abort.signal);
        return { ok: true, asr: this.asr.snapshot() };
      } finally {
        this.prepareTask = null;
      }
    })();
    return this.prepareTask;
  }

  async devices(source = 'loopback') {
    const kind = source === 'mic' ? 'mic' : 'loopback';
    const cache = this.devicesCache[kind];
    if (Date.now() - cache.at < 60000) return cache.devices;
    const exe = await ensureNativeHelper(this.dataRoot, { logger: this.logger });
    const devices = await listRenderDevices(exe, this.dataRoot, kind);
    this.devicesCache[kind] = { at: Date.now(), devices };
    return devices;
  }

  /* ------------------------------------------------------------------ */
  /* persistence                                                        */
  /* ------------------------------------------------------------------ */

  /** Last browser-side render error reported by the panel error boundary. */
  reportClientError(body = {}) {
    this.lastClientError = {
      at: nowIso(),
      message: clampText(body.message, 2000),
      stack: clampText(body.stack, 4000)
    };
    this.logger?.warn?.(`meeting client error: ${this.lastClientError.message}`);
    return { ok: true };
  }

  scheduleTranscriptPersist(meeting) {
    if (meeting.transcriptTimer !== null) return;
    meeting.transcriptTimer = setTimeout(() => {
      meeting.transcriptTimer = null;
      void this.persistTranscript(meeting);
    }, 700);
  }

  scheduleAnswersPersist(meeting) {
    if (meeting.answersTimer !== null) return;
    meeting.answersTimer = setTimeout(() => {
      meeting.answersTimer = null;
      void this.persistAnswers(meeting);
    }, 700);
  }

  scheduleTurnsPersist(meeting) {
    if (meeting.turnsTimer !== null) return;
    meeting.turnsTimer = setTimeout(() => {
      meeting.turnsTimer = null;
      void this.persistTurns(meeting);
    }, 700);
  }

  async persistMeta(meeting) {
    if (!meeting.dir) return;
    const meta = {
      id: meeting.id,
      title: meeting.title,
      domain: meeting.domain,
      customDomain: meeting.customDomain,
      topic: meeting.topic,
      glossary: meeting.glossary,
      targetLang: meeting.targetLang,
      asrLang: meeting.asrLang,
      summaryLang: meeting.summaryLang,
      webSearch: meeting.webSearch,
      deviceId: meeting.deviceId,
      micEnabled: meeting.micEnabled === true,
      micDeviceId: meeting.micDeviceId ?? '',
      sensitivity: meeting.sensitivity,
      speakersEnabled: meeting.speakers,
      speakerThreshold: meeting.speakerThreshold,
      speakers: meeting.speakersList,
      agenda: meeting.agenda,
      status: meeting.status,
      error: meeting.error,
      createdAt: meeting.createdAt,
      startedAt: meeting.startedAt,
      endedAt: meeting.endedAt,
      capture: meeting.capture ?? null,
      summaryUpdatedAt: meeting.summary.updatedAt
    };
    try {
      await atomicWrite(path.join(meeting.dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    } catch (error) {
      this.logger?.warn?.(`meeting: could not write meta: ${safeError(error)}`);
    }
  }

  async persistTranscript(meeting) {
    if (!meeting.dir) return;
    try {
      const rows = meeting.transcript.map((line) => ({
        id: line.id,
        at: line.at,
        startMs: line.startMs,
        endMs: line.endMs,
        raw: line.raw,
        text: line.text,
        translation: line.translation,
        speakerId: line.speakerId ?? null,
        speakerName: line.speakerName ?? null,
        speakerOrg: line.speakerOrg ?? null,
        speakerSuggested: line.speakerSuggested === true,
        correctionStatus: line.correctionStatus,
        translationStatus: line.translationStatus,
        correctionError: line.correctionError ?? null,
        turnId: line.turnId ?? null
      }));
      await atomicWrite(path.join(meeting.dir, 'transcript.json'), `${JSON.stringify(rows, null, 2)}\n`);
    } catch (error) {
      this.logger?.warn?.(`meeting: could not write transcript: ${safeError(error)}`);
    }
  }

  async persistTurns(meeting) {
    if (!meeting.dir) return;
    try {
      const rows = meeting.turns.map(publicTurn);
      await atomicWrite(path.join(meeting.dir, 'turns.json'), `${JSON.stringify(rows, null, 2)}\n`);
    } catch (error) {
      this.logger?.warn?.(`meeting: could not write turns: ${safeError(error)}`);
    }
  }

  async persistSummary(meeting) {
    if (!meeting.dir) return;
    try {
      await atomicWrite(path.join(meeting.dir, 'summary.md'), `${meeting.summary.markdown}\n`);
    } catch (error) {
      this.logger?.warn?.(`meeting: could not write summary: ${safeError(error)}`);
    }
  }

  async persistAnswers(meeting) {
    if (!meeting.dir) return;
    try {
      const rows = meeting.answers.map(publicAnswer);
      await atomicWrite(path.join(meeting.dir, 'answers.json'), `${JSON.stringify(rows, null, 2)}\n`);
    } catch (error) {
      this.logger?.warn?.(`meeting: could not write answers: ${safeError(error)}`);
    }
  }

  async history() {
    let entries = [];
    try {
      entries = await fsp.readdir(this.dataRoot, { withFileTypes: true });
    } catch {
      return { ok: true, meetings: [] };
    }
    const meetings = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (!/^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/.test(entry.name)) continue;
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(this.dataRoot, entry.name, 'meta.json'), 'utf8'));
        let lines = 0;
        try {
          const transcript = JSON.parse(await fsp.readFile(path.join(this.dataRoot, entry.name, 'transcript.json'), 'utf8'));
          lines = Array.isArray(transcript) ? transcript.length : 0;
        } catch {
          lines = 0;
        }
        let summaryPreview = '';
        try {
          summaryPreview = (await fsp.readFile(path.join(this.dataRoot, entry.name, 'summary.md'), 'utf8')).slice(0, 220);
        } catch {
          summaryPreview = '';
        }
        meetings.push({
          id: entry.name,
          title: String(meta.title ?? '未命名会议'),
          domain: String(meta.domain ?? 'general'),
          topic: String(meta.topic ?? ''),
          status: String(meta.status ?? 'ended'),
          createdAt: Number(meta.createdAt) || 0,
          endedAt: Number(meta.endedAt) || 0,
          lines,
          summaryPreview
        });
      } catch {
        // an unreadable half-written meeting is skipped
      }
    }
    meetings.sort((a, b) => b.createdAt - a.createdAt);
    return { ok: true, meetings: meetings.slice(0, 30) };
  }

  /* ------------------------------------------------------------------ */
  /* teardown                                                           */
  /* ------------------------------------------------------------------ */

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSummaryTimer();
    this.stopRefineTimer();
    try {
      this.abort.abort(Object.assign(new Error('会议插件卸载'), { code: 'DISPOSED' }));
    } catch {
      // ignore
    }
    try {
      this.active?.captureHandle?.stop?.();
      this.active?.micHandle?.stop?.();
    } catch {
      // ignore
    }
    if (this.active?.correctionTimer) clearTimeout(this.active.correctionTimer);
    if (this.active?.transcriptTimer) clearTimeout(this.active.transcriptTimer);
    if (this.active?.turnsTimer) clearTimeout(this.active.turnsTimer);
    if (this.active?.answersTimer) clearTimeout(this.active.answersTimer);
    this.subscribers.clear();
  }
}

export { normalizeSettings, newMeetingId };
