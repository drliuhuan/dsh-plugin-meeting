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
import { documentPageImages, extractAgendaText, extensionOf } from './office.mjs';
import { SpeechAsr } from './asr.mjs';
import { SpeakerClusterer, SpeakerEncoder, ensureSpeakerModel, loadSherpa } from './speaker.mjs';
import { clockText, currentAgenda, entriesFromLlm, formatAgendaEntry, normalizeOcrText, parseAgenda } from './agenda.mjs';
import { cueKindFor, dueCues, isRole, minutesOfDay, roleLabel } from './script.mjs';
import { DOMAINS, MeetingAi, SUMMARY_LANGUAGES, TARGET_LANGUAGES } from './ai.mjs';
import { DEFAULT_SCRIPT_PROMPT, MAX_PROMPT_CHARS, nameMatches } from './script.mjs';import { clampString, clampText, nowIso, safeError, sleep } from './util.mjs';

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
// One cluster keeps talking: still start a new block every two minutes so the
// panel stays readable and one person's long monologue can be re-corrected.
const TURN_SPLIT_MS = 120000;
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
    // Role is part of the meeting context, not the durable profile: it starts
    // empty and is remembered only for this meeting (and the pending setup).
    role: input.role === '' ? '' : (isRole(input.role) ? input.role : (previous.role ?? '')),
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
    micEnabled: input.micEnabled === undefined ? (previous.micEnabled ?? true) : input.micEnabled !== false,
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

/** The user's own name is a durable local profile, not a per-meeting setting. */
function normalizeProfile(input = {}, previous = {}) {
  const userName = typeof input.userName === 'string'
    ? clampText(input.userName.replace(/\s+/g, ' ').trim(), 40)
    : (previous.userName ?? '');
  const userOrg = typeof input.userOrg === 'string'
    ? clampText(input.userOrg.replace(/\s+/g, ' ').trim(), 60)
    : (previous.userOrg ?? '');
  // The domain is durable too: a clinician should not have to pick 医学/临床
  // again for every meeting.
  const domain = typeof input.domain === 'string' && Object.hasOwn(DOMAINS, input.domain)
    ? input.domain
    : (previous.domain ?? 'general');
  const customDomain = typeof input.customDomain === 'string'
    ? clampText(input.customDomain.replace(/\s+/g, ' ').trim(), 60)
    : (previous.customDomain ?? '');
  // The role is meeting context, not profile data: it is deliberately not
  // stored here, so a new meeting starts with an empty role again.
  return { userName, userOrg, domain, customDomain, updatedAt: Date.now() };
}

/**
 * State of the script draft (讲词 / 串词).  Kept on the service so agenda
 * uploads before a meeting starts can already generate it.
 */
function emptyScript() {
  return { status: 'idle', markdown: '', prompt: '', error: null, updatedAt: 0, agendaUpdatedAt: 0, userName: '' };
}

function normalizeStoredScript(raw) {
  const empty = emptyScript();
  if (raw === null || typeof raw !== 'object') return empty;
  const markdown = typeof raw.markdown === 'string' ? raw.markdown : '';
  const status = raw.status === 'error' ? 'error' : (markdown.length > 0 ? 'done' : 'idle');
  return {
    status,
    markdown,
    prompt: clampText(raw.prompt, MAX_PROMPT_CHARS),
    error: typeof raw.error === 'string' && raw.error.length > 0 ? raw.error : null,
    updatedAt: Number(raw.updatedAt) || 0,
    agendaUpdatedAt: Number(raw.agendaUpdatedAt) || 0,
    userName: clampString(raw.userName, 40, '')
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
      && Number(line.startMs) - Number(last.endMs) <= TURN_GAP_MS
      && Number(line.startMs) - Number(last.startMs) < TURN_SPLIT_MS;
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

function publicCue(cue) {
  return {
    key: cue.key,
    index: cue.index,
    kind: cue.kind,
    role: cue.role,
    entryText: cue.entryText,
    markdown: cue.markdown,
    status: cue.status,
    error: cue.error ?? null,
    at: cue.at,
    auto: cue.auto === true
  };
}

function publicAnswer(answer) {
  return {
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
    this.profileFile = path.join(this.dataRoot, 'profile.json');
    this.scriptDraftFile = path.join(this.dataRoot, 'script-draft.json');
    this.profile = { userName: '', userOrg: '', domain: 'general', customDomain: '', updatedAt: 0 };
    this.script = emptyScript();
    this.scriptToken = 0;
    this.lastClientError = null;
    this.pendingCues = [];
    this.pendingDocument = null;
    this.pendingCueState = { status: 'idle', key: null, updatedAt: 0, error: null };
    this.pendingCueBusy = false;
    this.cleanupStarted = false;
    this.loadLocalState();
    // Durable preferences seed the next meeting: domain and custom domain are
    // remembered across restarts, not just for the current meeting.
    this.lastSettings = normalizeSettings(
      { domain: this.profile.domain, customDomain: this.profile.customDomain },
      {}
    );
  }

  /** Restore the durable profile and the pending script draft (sync, tiny files). */
  loadLocalState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.profileFile, 'utf8'));
      this.profile = {
        userName: clampString(raw?.userName, 40, ''),
        userOrg: clampString(raw?.userOrg, 60, ''),
        domain: typeof raw?.domain === 'string' && Object.hasOwn(DOMAINS, raw.domain) ? raw.domain : 'general',
        customDomain: clampString(raw?.customDomain, 60, ''),
        updatedAt: Number(raw?.updatedAt) || 0
      };
    } catch {
      // first run: no profile yet
    }
    try {
      this.script = normalizeStoredScript(JSON.parse(fs.readFileSync(this.scriptDraftFile, 'utf8')));
    } catch {
      // first run: no script draft yet
    }
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
      profile: {
        userName: this.profile.userName,
        userOrg: this.profile.userOrg,
        domain: this.profile.domain,
        customDomain: this.profile.customDomain
      },
      script: this.publicScript(),
      agenda: this.active ? this.active.agenda : this.pendingAgenda,
      agendaNow: this.agendaNow(this.active ? this.active.agenda : this.pendingAgenda),
      cues: this.active ? (this.active.cues ?? []).map(publicCue) : this.pendingCues.map(publicCue),
      cueState: this.active ? (this.active.cueState ?? { status: 'idle' }) : this.pendingCueState,
      hasTodayMeeting: this.hasTodayMeeting(),
      todayMeetings: this.todayMeetings().length,
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
      vision: this.ai.lastVision ?? null,
      lastServerError: this.lastServerError ?? null,
      pendingDocument: this.pendingDocument
        ? { fileName: this.pendingDocument.fileName, images: this.pendingDocument.images?.length ?? 0 }
        : null,
      speakerModel: path.join(this.dataRoot, '.models', 'campplus_zh_16k.onnx'),
      native: path.join(this.dataRoot, '.native', 'LoopbackCapture.exe')
    };
  }

  /* ------------------------------------------------------------------ */
  /* personal profile and speech drafts                                 */
  /* ------------------------------------------------------------------ */

  /** The browser-facing shape of the script draft. */
  publicScript() {
    return {
      status: this.script.status,
      markdown: this.script.markdown,
      prompt: this.script.prompt,
      defaultPrompt: DEFAULT_SCRIPT_PROMPT,
      error: this.script.error,
      updatedAt: this.script.updatedAt,
      agendaUpdatedAt: this.script.agendaUpdatedAt,
      userName: this.script.userName
    };
  }

  agendaInUse() {
    return this.active !== null ? this.active.agenda : this.pendingAgenda;
  }

  /** Role for the meeting in progress, or the pending setup's choice. */
  roleInUse() {
    const active = this.active;
    if (active && typeof active.role === 'string') return active.role;
    return this.lastSettings.role ?? '';
  }

  /**
   * Which agenda slot is "now".  A pinned index — the user clicked a row —
   * wins over the clock, so a meeting that starts late or skips an item still
   * shows the item that is actually being discussed.
   */
  agendaNow(agenda) {
    const entries = Array.isArray(agenda?.entries) ? agenda.entries : [];
    const raw = agenda?.pinnedIndex;
    const pinned = raw === null || raw === undefined ? null : Number(raw);
    if (Number.isInteger(pinned) && pinned >= 0 && pinned < entries.length) {
      const now = new Date();
      const minutes = now.getHours() * 60 + now.getMinutes();
      return { status: 'pinned', entry: entries[pinned], minutes, clock: clockText(minutes) };
    }
    return currentAgenda(entries, new Date());
  }

  /** Agenda entries whose speaker matches the user's durable name. */
  ownAgendaEntries() {
    const agenda = this.agendaInUse();
    const entries = agenda && Array.isArray(agenda.entries) ? agenda.entries : [];
    if (this.profile.userName.length === 0) return [];
    return entries.filter((entry) => nameMatches(entry?.speaker, this.profile.userName));
  }

  /**
   * Save the user's own name.  It is a durable local profile, independent of
   * any single meeting, and it decides which agenda slots count as "mine".
   */
  async updateProfile(input = {}) {
    const previousName = this.profile.userName;
    this.profile = normalizeProfile(input, this.profile);
    this.lastSettings = normalizeSettings(
      { domain: this.profile.domain, customDomain: this.profile.customDomain },
      this.lastSettings
    );
    try {
      await fsp.mkdir(this.dataRoot, { recursive: true });
      await atomicWrite(this.profileFile, `${JSON.stringify(this.profile, null, 2)}\n`);
    } catch (error) {
      this.logger?.warn?.(`meeting: could not write profile: ${safeError(error)}`);
    }
    this.emit('profile', { userName: this.profile.userName, userOrg: this.profile.userOrg, domain: this.profile.domain });
    this.emit('state', this.snapshot());
    // A new name can turn agenda slots into "mine"; refresh the draft when the
    // name actually changed.  Saving the same name (or only the org) is a
    // no-op for the draft, so it must not spend another model call.
    if (previousName !== this.profile.userName) this.maybeAutoScripts();
    return this.snapshot();
  }

  /**
   * Start (or restart) the 讲词/串词 draft.  Validation is synchronous; the
   * model call runs in the background and progress travels on 'script'.
   *
   * Deliberately refuses to write anything unless the user's name appears in
   * the agenda: the draft is only for the user, never a generic host script.
   */
  startScriptWrite(input = {}) {
    if (this.disposed) throw Object.assign(new Error('会议插件已卸载'), { code: 'DISPOSED' });
    const agenda = this.agendaInUse();
    const entries = agenda && Array.isArray(agenda.entries) ? agenda.entries : [];
    if (entries.length === 0) {
      throw Object.assign(new Error('请先上传或粘贴会议日程，再生成讲词与串词'), { code: 'NO_AGENDA', status: 400 });
    }
    if (this.profile.userName.length === 0) {
      throw Object.assign(new Error('请先在设置里填写「我的姓名」；只有日程里出现你的名字时才会生成讲词'), {
        code: 'NO_USER_NAME',
        status: 400
      });
    }
    if (this.ownAgendaEntries().length === 0) {
      throw Object.assign(new Error(`日程里没有出现“${this.profile.userName}”，不生成讲词与串词`), {
        code: 'NO_AGENDA_MATCH',
        status: 400
      });
    }
    if (this.active !== null && this.active.readOnly) {
      throw Object.assign(new Error('历史会议是只读的，不能重新生成讲词'), { code: 'READONLY', status: 403 });
    }
    const prompt = typeof input.prompt === 'string'
      ? clampText(input.prompt.trim(), MAX_PROMPT_CHARS)
      : this.script.prompt;
    const token = this.scriptToken + 1;
    this.scriptToken = token;
    this.script = {
      status: 'writing',
      markdown: this.script.markdown,
      prompt,
      error: null,
      updatedAt: Date.now(),
      agendaUpdatedAt: Number(agenda.updatedAt) || 0,
      userName: this.profile.userName
    };
    this.emit('script', this.publicScript());
    this.emit('state', this.snapshot());
    void this.runScriptWrite(token).catch((error) => {
      this.logger?.warn?.(`meeting: script generation failed: ${safeError(error)}`);
    });
    return this.publicScript();
  }

  async runScriptWrite(token) {
    const meeting = this.active;
    const prompt = this.script.prompt;
    let next;
    try {
      const markdown = await this.ai.writeScripts({
        entries: this.agendaInUse()?.entries ?? [],
        userName: this.profile.userName,
        userOrg: this.profile.userOrg,
        title: meeting ? meeting.title : this.lastSettings.title,
        topic: meeting ? meeting.topic : this.lastSettings.topic,
        domain: meeting ? meeting.domain : this.lastSettings.domain,
        customDomain: meeting ? meeting.customDomain : this.lastSettings.customDomain,
        glossary: meeting ? meeting.glossary : this.lastSettings.glossary,
        prompt,
        signal: this.abort.signal
      });
      next = { status: 'done', markdown, error: null };
    } catch (error) {
      if (token !== this.scriptToken) return;
      if (error?.code === 'ABORTED') return;
      next = { status: 'error', error: safeError(error) };
    }
    if (token !== this.scriptToken) return;
    this.script = { ...this.script, ...next, updatedAt: Date.now() };
    await this.persistScript();
    this.emit('script', this.publicScript());
    this.emit('state', this.snapshot());
  }

  /**
   * Auto generation after an agenda/profile change.  Skips silently unless the
   * user's name is set and present in the agenda; never throws.
   */
  maybeAutoScripts() {
    try {
      if (this.disposed) return;
      const entries = this.agendaInUse()?.entries ?? [];
      if (entries.length === 0) return;
      if (this.profile.userName.length === 0) return;
      if (this.active !== null && this.active.readOnly) return;
      if (this.ownAgendaEntries().length === 0) {
        // No slot in this agenda belongs to the user: discard any in-flight
        // draft and keep what was already generated for another agenda.
        this.scriptToken += 1;
        if (this.script.status === 'writing') {
          this.script = {
            ...this.script,
            status: this.script.markdown.length > 0 ? 'done' : 'idle',
            updatedAt: Date.now()
          };
          this.emit('script', this.publicScript());
          this.emit('state', this.snapshot());
        }
        return;
      }
      this.startScriptWrite({ prompt: this.script.prompt });
    } catch {
      // A missing model or an aborted call must not break "应用日程".
    }
  }

  /** Persist the draft with the active meeting, or as a pending draft otherwise. */
  async persistScript() {
    const active = this.active;
    const state = {
      status: this.script.status,
      markdown: this.script.markdown,
      prompt: this.script.prompt,
      error: this.script.error,
      updatedAt: this.script.updatedAt,
      agendaUpdatedAt: this.script.agendaUpdatedAt,
      userName: this.script.userName
    };
    try {
      if (active !== null && !active.readOnly) {
        active.scripts = state;
        await atomicWrite(path.join(active.dir, 'scripts.md'), `${this.script.markdown}\n`);
        await this.persistMeta(active);
        return;
      }
      await fsp.mkdir(this.dataRoot, { recursive: true });
      await atomicWrite(this.scriptDraftFile, `${JSON.stringify(state, null, 2)}\n`);
    } catch (error) {
      this.logger?.warn?.(`meeting: could not write script draft: ${safeError(error)}`);
    }
  }

  serializeMeeting(meeting) {
    return {
      id: meeting.id,
      title: meeting.title,
      domain: meeting.domain,
      role: meeting.role ?? '',
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
      agendaNow: this.agendaNow(meeting.agenda),
      capture: meeting.capture,
      asrState: meeting.asrState,
      counts: {
        lines: meeting.transcript.length,
        turns: meeting.turns.length,
        corrected: meeting.transcript.filter((line) => line.correctionStatus === 'done').length,
        answers: meeting.answers.length
      },
      refineState: meeting.refineState ?? { status: 'idle' },
      cues: Array.isArray(meeting.cues) ? meeting.cues.map(publicCue) : [],
      cueState: meeting.cueState ?? { status: 'idle' },
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
    const usesPendingAgenda = agendaText === this.pendingAgenda.text;
    // A pending agenda already structured by the model is reused as-is instead
    // of being flattened by the line parser again at "start".
    const refined = usesPendingAgenda
      && this.pendingAgenda.parsedBy === 'llm'
      && Array.isArray(this.pendingAgenda.entries)
      && this.pendingAgenda.entries.length > 0
      ? this.pendingAgenda
      : null;
    const agenda = {
      ...parseAgenda(agendaText, input.agendaFilename || ''),
      ...(refined ? { entries: refined.entries, warnings: refined.warnings, parsedBy: 'llm' } : {}),
      text: agendaText,
      updatedAt: usesPendingAgenda ? (Number(this.pendingAgenda.updatedAt) || 0) : Date.now()
    };
    // A pin chosen during setup stays the current session when listening starts.
    if (usesPendingAgenda && Number.isInteger(this.pendingAgenda.pinnedIndex)
      && this.pendingAgenda.pinnedIndex < (agenda.entries?.length ?? 0)) {
      agenda.pinnedIndex = this.pendingAgenda.pinnedIndex;
    }
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
      answersTimer: null,
      scripts: emptyScript(),
      cues: [],
      cueState: { status: 'idle', key: null, updatedAt: 0, error: null },
      cueBusy: false,
      cueTimer: null
    };
    // Cue cards written during initialization (opening / thanks) belong to this
    // meeting, so the user does not have to regenerate them after starting.
    if (this.pendingCues.length > 0) {
      meeting.cues = this.pendingCues.map((cue) => ({ ...cue }));
      this.pendingCues = [];
    this.pendingDocument = null;
      this.pendingCueState = { status: 'idle', key: null, updatedAt: 0, error: null };
    }
    // A draft generated for the pending agenda before "开始听会" stays visible
    // in the new meeting instead of being silently dropped.
    const carriedScript = usesPendingAgenda
      && this.script.markdown.length > 0
      && Number(this.script.agendaUpdatedAt) > 0
      && Number(this.script.agendaUpdatedAt) === Number(this.pendingAgenda.updatedAt)
      ? { ...this.script }
      : emptyScript();
    meeting.scripts = carriedScript;
    this.scriptToken += 1;
    this.script = carriedScript;
    this.active = meeting;
    await this.persistMeta(meeting);
    if (meeting.scripts.markdown.length > 0) {
      await atomicWrite(path.join(meeting.dir, 'scripts.md'), `${meeting.scripts.markdown}\n`).catch(() => {});
    }
    this.emit('state', this.snapshot());
    this.refineAgendaWithLlm(meeting.agenda, agenda.entries.length);
    if (meeting.scripts.markdown.length === 0) this.maybeAutoScripts();
    // The chosen domain is a durable preference, not only this meeting's setting.
    this.profile = normalizeProfile(
      { domain: settings.domain, customDomain: settings.customDomain },
      this.profile
    );
    void this.persistProfile().catch(() => {});
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
    this.startRefineTimer(meeting);
    this.startCueTimer(meeting);
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
      && Number(line.startMs) - Number(last.endMs) <= TURN_GAP_MS
      && Number(line.startMs) - Number(last.startMs) < TURN_SPLIT_MS;
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
    this.stopCueTimer();
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
    this.stopCueTimer();
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
    let scriptMarkdown = '';
    try {
      scriptMarkdown = await fsp.readFile(path.join(dir, 'scripts.md'), 'utf8');
    } catch {
      scriptMarkdown = '';
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
      scripts: normalizeStoredScript(
        meta.scripts && typeof meta.scripts === 'object' && typeof meta.scripts.markdown === 'string' && meta.scripts.markdown.length > 0
          ? meta.scripts
          : (scriptMarkdown.trim().length > 0 ? { ...meta.scripts, status: 'done', markdown: scriptMarkdown.trim() } : meta.scripts)
      ),
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
    this.scriptToken += 1;
    this.script = meeting.scripts;
    this.lastSettings = normalizeSettings(meeting, this.lastSettings);
    this.emit('state', this.snapshot());
    return this.snapshot();
  }

  async updateSettings(input = {}) {
    const meeting = this.active;
    const settings = normalizeSettings(input, meeting ?? this.lastSettings);
    this.lastSettings = settings;
    // Domain (and custom domain) survive a restart: they are durable profile
    // fields, so the next meeting does not fall back to 通用会议.
    this.profile = normalizeProfile(
      { domain: settings.domain, customDomain: settings.customDomain },
      this.profile
    );
    void this.persistProfile().catch(() => {});
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
   *
   * @param {string} text agenda text
   * @param {string} [filename]
   * @param {{ requireLlm?: boolean, source?: string, force?: boolean }} [options]
   *   `requireLlm` is used for uploaded files: the entries come from the model,
   *   never from the line parser, and a model failure is reported instead of
   *   silently applying a bad parse.
   */
  async setAgenda(text, filename = '', options = {}) {
    const clean = clampText(text, 20000);
    const requireLlm = options.requireLlm === true;
    const parsed = parseAgenda(clean, filename);
    // The uploaded document (if any) was rendered to page images: the model
    // sees text *and* pages and picks what is more reliable.
    const pendingDoc = this.pendingDocument && this.pendingDocument.fileName === clampText(filename, 160)
      ? this.pendingDocument
      : null;
    const images = Array.isArray(pendingDoc?.images) ? pendingDoc.images : [];
    let structured = null;
    try {
      structured = await this.ai.structureAgenda({
        text: clean,
        filename,
        userName: this.profile.userName,
        hintCount: parsed.entries.length,
        images,
        signal: this.abort.signal
      });
    } catch (error) {
      if (requireLlm) {
        throw Object.assign(new Error(`AI 解析日程失败：${safeError(error)}`), {
          code: 'AGENDA_LLM_FAILED',
          status: 502
        });
      }
      this.logger?.warn?.(`meeting: agenda LLM parse failed, keeping local parse: ${safeError(error)}`);
    }
    const entries = Array.isArray(structured?.entries) ? structured.entries : [];
    if (pendingDoc) this.pendingDocument = null;
    if (requireLlm && entries.length === 0) {
      throw Object.assign(new Error('AI 没有从这份文件里读出日程条目；请检查文件内容，或把日程文字直接粘贴到输入框'), {
        code: 'AGENDA_LLM_EMPTY',
        status: 422
      });
    }
    if (entries.length > 0) {
      const agenda = {
        ...parsed,
        entries,
        warnings: [],
        parsedBy: 'llm',
        text: clean,
        source: options.source === 'image' ? 'image' : parsed.source,
        fileName: clampText(filename, 160),
        updatedAt: Date.now()
      };
      await this.commitAgenda(agenda);
      this.applyAgendaMeta(structured);
      return this.snapshot();
    }
    const agenda = {
      ...parsed,
      text: clean,
      fileName: clampText(filename, 160),
      warnings: parsed.warnings.concat('AI 解析不可用，已使用本地逐行解析'),
      updatedAt: Date.now()
    };
    await this.commitAgenda(agenda);
    return this.snapshot();
  }

  /** Store the agenda on the running meeting, or as the pending draft. */
  async commitAgenda(agenda) {
    // A manual "this is the current session" choice survives an agenda edit as
    // long as the pinned index still exists: the user's pick beats the clock.
    const previous = this.active !== null ? this.active.agenda : this.pendingAgenda;
    if (agenda.pinnedIndex === undefined && previous && Number.isInteger(previous.pinnedIndex)) {
      if (previous.pinnedIndex < (Array.isArray(agenda.entries) ? agenda.entries.length : 0)) {
        agenda.pinnedIndex = previous.pinnedIndex;
      }
    }
    if (this.active !== null) {
      this.active.agenda = agenda;
      this.emit('agenda', { ...agenda, now: this.agendaNow(agenda) });
      await this.persistMeta(this.active);
    } else {
      this.pendingAgenda = agenda;
      // Cue cards belong to the agenda they were written for; a new agenda
      // makes them stale (the opening/thanks card is regenerated right after).
      this.pendingCues = [];
    this.pendingDocument = null;
      this.pendingCueState = { status: 'idle', key: null, updatedAt: 0, error: null };
      this.emit('agenda', { ...agenda, now: this.agendaNow(agenda) });
    }
    this.emit('state', this.snapshot());
    this.maybeAutoScripts();
    return this.snapshot();
  }

  /**
   * Adopt the model's reading of the agenda: meeting topic, title and domain
   * come from the agenda itself, and the domain becomes the durable default.
   */
  applyAgendaMeta(meta) {
    if (!meta || typeof meta !== 'object') return;
    const patch = {};
    if (typeof meta.title === 'string' && meta.title.length > 0) patch.topic = meta.title;
    if (typeof meta.domain === 'string' && Object.hasOwn(DOMAINS, meta.domain)) patch.domain = meta.domain;
    if (typeof meta.customDomain === 'string' && meta.customDomain.length > 0) patch.customDomain = meta.customDomain;
    if (isRole(meta.role)) patch.role = meta.role;
    if (Object.keys(patch).length === 0) return;
    this.lastSettings = normalizeSettings(patch, this.lastSettings);
    this.profile = normalizeProfile(
      { domain: this.lastSettings.domain, customDomain: this.lastSettings.customDomain },
      this.profile
    );
    void this.persistProfile().catch(() => {});
    if (this.active !== null && !this.active.readOnly) {
      Object.assign(this.active, patch);
      void this.persistMeta(this.active).catch(() => {});
    }
    this.emit('state', this.snapshot());
    // The host — or whoever opens the agenda — should have their words before
    // the meeting starts, not two minutes before their first slot.
    void this.maybeGenerateOpeningCue().catch(() => {});
  }

  /**
   * Save the structured agenda exactly as the panel shows it (the editable
   * table).  Times are "HH:MM" strings, entries are normalized on the Host.
   */
  async setAgendaEntries(input = {}) {
    const list = Array.isArray(input.entries) ? input.entries : [];
    const entries = entriesFromLlm(list);
    if (entries.length === 0) {
      throw Object.assign(new Error('日程至少要有一条有效条目'), { code: 'AGENDA_EMPTY', status: 400 });
    }
    const current = this.agendaInUse();
    const agenda = {
      entries,
      warnings: [],
      source: input.source || 'manual',
      parsedBy: input.parsedBy || 'manual',
      text: typeof input.text === 'string' ? clampText(input.text, 20000) : (current?.text ?? ''),
      fileName: current?.fileName ?? '',
      updatedAt: Date.now()
    };
    await this.commitAgenda(agenda);
    this.applyAgendaMeta({
      title: typeof input.topic === 'string' ? input.topic : '',
      domain: typeof input.domain === 'string' ? input.domain : '',
      customDomain: typeof input.customDomain === 'string' ? input.customDomain : '',
      role: typeof input.role === 'string' ? input.role : ''
    });
    return this.snapshot();
  }

  /** Durable "YYYYMMDD" stamp for today. */
  todayStamp() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  }

  /** Meeting directories created today (the initialization flow keys off this). */
  todayMeetings() {
    const now = Date.now();
    if (this._todayCache && now - this._todayCache.at < 5000) return this._todayCache.list;
    let list = [];
    try {
      const prefix = `${this.todayStamp()}-`;
      list = fs.readdirSync(this.dataRoot, { withFileTypes: true })
        .filter((item) => item.isDirectory() && item.name.startsWith(prefix))
        .map((item) => item.name);
    } catch {
      list = [];
    }
    this._todayCache = { at: now, list };
    return list;
  }

  hasTodayMeeting() {
    return this.todayMeetings().length > 0;
  }

  /**
   * The host — or whoever owns the first slot — gets their words as soon as the
   * agenda is confirmed, before the meeting even starts.
   */
  async maybeGenerateOpeningCue() {
    if (this.disposed) return;
    const entries = this.agendaInUse()?.entries ?? [];
    if (entries.length === 0) return;
    const isHost = this.roleInUse() === 'host';
    const first = entries[0];
    const mine = isHost || (this.profile.userName.length > 0 && nameMatches(first?.speaker, this.profile.userName));
    if (!mine) return;
    const key = isHost ? 'open' : 'own:0';
    if (this.active) {
      if (this.active.cues.some((cue) => cue.key === key)) return;
      await this.generateCue(this.active, 0, isHost ? 'opening' : 'thanks', { key, auto: false });
      return;
    }
    if (this.pendingCues.some((cue) => cue.key === key)) return;
    await this.generatePendingCue(0, isHost ? 'opening' : 'thanks', key);
  }

  /** Cue card written before any meeting exists (initialization flow). */
  async generatePendingCue(index, kind, key) {
    const entries = this.agendaInUse()?.entries ?? [];
    const entry = entries[index];
    if (!entry || this.pendingCueBusy) return;
    this.pendingCueBusy = true;
    const cue = {
      key,
      index,
      kind,
      role: this.roleInUse(),
      entryText: formatAgendaEntry(entry),
      markdown: '',
      status: 'writing',
      error: null,
      at: Date.now(),
      auto: false
    };
    this.pendingCues = this.pendingCues.filter((item) => item.key !== key).concat([cue]);
    this.pendingCueState = { status: 'writing', key, updatedAt: Date.now(), error: null };
    this.emit('cue', publicCue(cue));
    this.emit('state', this.snapshot());
    try {
      const markdown = await this.ai.writeCue({
        kind,
        role: this.roleInUse(),
        entry,
        prevEntry: index > 0 ? entries[index - 1] : null,
        nextEntry: index < entries.length - 1 ? entries[index + 1] : null,
        entries,
        userName: this.profile.userName,
        userOrg: this.profile.userOrg,
        topic: this.lastSettings.topic,
        domain: this.lastSettings.domain,
        customDomain: this.lastSettings.customDomain,
        glossary: this.lastSettings.glossary,
        transcript: '',
        summary: '',
        nowClock: clockText(minutesOfDay(new Date())),
        signal: this.abort.signal
      });
      cue.markdown = markdown;
      cue.status = 'done';
      cue.at = Date.now();
      this.pendingCueState = { status: 'done', key, updatedAt: Date.now(), error: null };
    } catch (error) {
      cue.status = 'error';
      cue.error = safeError(error);
      this.pendingCueState = { status: 'error', key, updatedAt: Date.now(), error: cue.error };
      this.emit('warning', { message: `串词生成失败：${cue.error}` });
    } finally {
      this.pendingCueBusy = false;
      this.emit('cue', publicCue(cue));
      this.emit('state', this.snapshot());
    }
  }

  /** Persist the durable profile (name, org, domain). */
  async persistProfile() {
    try {
      await fsp.mkdir(this.dataRoot, { recursive: true });
      await atomicWrite(this.profileFile, `${JSON.stringify(this.profile, null, 2)}\n`);
    } catch (error) {
      this.logger?.warn?.(`meeting: could not write profile: ${safeError(error)}`);
    }
  }

  /**
   * Pin the current agenda item by index, or clear the pin with null.
   * Used when the meeting runs behind schedule or skips an item.
   */
  async setAgendaPin(index) {
    const agenda = this.agendaInUse();
    const entries = Array.isArray(agenda?.entries) ? agenda.entries : [];
    if (entries.length === 0) return this.snapshot();
    const value = index === null || index === undefined || index === '' ? null : Number(index);
    agenda.pinnedIndex = Number.isInteger(value) && value >= 0 && value < entries.length ? value : null;
    this.emit('agenda', { ...agenda, now: this.agendaNow(agenda) });
    this.emit('state', this.snapshot());
    if (this.active !== null && !this.active.readOnly) await this.persistMeta(this.active);
    return this.snapshot();
  }

  /**
   * OCR an uploaded/pasted agenda image locally, then parse the recognized text.
   * The image is written to a temp file only for the Windows OCR call and is
   * removed immediately; only the text and filename are kept.
   */
  async setAgendaFile(fileBase64, filename = '', mime = '') {
    if (typeof fileBase64 !== 'string' || fileBase64.length < 100) {
      throw Object.assign(new Error('没有收到文件数据'), { code: 'FILE_EMPTY', status: 400 });
    }
    const payload = fileBase64.replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
    let buffer;
    try {
      buffer = Buffer.from(payload, 'base64');
    } catch {
      throw Object.assign(new Error('文件 base64 无法解码'), { code: 'FILE_INVALID', status: 400 });
    }
    if (buffer.length === 0) throw Object.assign(new Error('文件为空'), { code: 'FILE_EMPTY', status: 400 });
    if (buffer.length > 20 * 1024 * 1024) {
      throw Object.assign(new Error('文件太大（上限 20 MB）'), { code: 'FILE_TOO_LARGE', status: 413 });
    }

    let extension = extensionOf(filename);
    const imageMagic = (buffer[0] === 0x89 && buffer[1] === 0x50)
      || (buffer[0] === 0xff && buffer[1] === 0xd8)
      || (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP')
      || (buffer[0] === 0x42 && buffer[1] === 0x4d)
      || (buffer[0] === 0x47 && buffer[1] === 0x49);
    if (!extension) extension = imageMagic ? 'png' : 'bin';

    let text = '';
    let kind = 'text';
    let ocr = false;
    if (imageMagic || ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'gif'].includes(extension)) {
      const tempDir = path.join(this.dataRoot, '.tmp');
      await fsp.mkdir(tempDir, { recursive: true });
      const tempFile = path.join(tempDir, `agenda-${randomUUID()}.${extension}`);
      try {
        await fsp.writeFile(tempFile, buffer);
        text = await ocrImage(tempFile, this.dataRoot);
      } finally {
        await fsp.rm(tempFile, { force: true }).catch(() => {});
      }
      kind = 'image';
      ocr = true;
    } else {
      const extracted = await extractAgendaText(buffer, filename || `agenda.${extension}`, this.dataRoot);
      text = extracted.text;
      kind = extracted.kind;
      ocr = extracted.ocr === true;
    }

    if (typeof text !== 'string' || text.trim().length === 0) {
      throw Object.assign(new Error('文件里没有识别到文字，请换一个更清晰的 PDF/PPT/Word/图片，或直接把日程文字粘贴到输入框'), {
        code: 'OCR_EMPTY',
        status: 422
      });
    }
    const cleaned = ocr ? normalizeOcrText(text) : text.replace(/^\uFEFF/, '').trim();
    // Keep the pages around: when the user clicks 应用日程 the model may want
    // to *look* at the document instead of trusting the extracted text, and it
    // decides by itself whether to use the text, the images, or both.
    let images = [];
    let imagesError = null;
    try {
      const rendered = await documentPageImages(buffer, filename || `agenda.${extension}`, this.dataRoot, { maxPages: 8, dpi: 150 });
      images = rendered.images ?? [];
      imagesError = rendered.error ?? null;
    } catch (error) {
      imagesError = safeError(error);
      this.logger?.warn?.(`meeting: could not render agenda pages: ${imagesError}`);
    }
    this.pendingDocument = {
      fileName: clampText(filename, 160),
      text: cleaned,
      kind,
      images,
      at: Date.now()
    };
    // Importing a file runs the model right away: the user should not have to
    // click "AI 解析" after an upload.  A model failure still returns the
    // extracted text so the panel can offer the manual retry.
    const agendaName = filename || `agenda.${extension}`;
    try {
      const snapshot = await this.setAgenda(cleaned, agendaName, {
        requireLlm: true,
        source: kind === 'image' ? 'image' : 'file'
      });
      return {
        ok: true,
        parsed: true,
        text: cleaned,
        kind,
        ocr,
        images: images.length,
        imagesError,
        fileName: clampText(filename, 160),
        snapshot,
        agenda: snapshot.agenda
      };
    } catch (error) {
      this.recordServerError(error);
      return {
        ok: true,
        parsed: false,
        text: cleaned,
        kind,
        ocr,
        images: images.length,
        imagesError,
        fileName: clampText(filename, 160),
        error: safeError(error)
      };
    }
  }

  /** Keep the last server-side failure for the diagnostics route. */
  recordServerError(error) {
    this.lastServerError = {
      message: safeError(error),
      stack: String(error?.stack ?? '').slice(0, 2000),
      at: Date.now()
    };
  }

  /** Backwards-compatible alias for image callers. */
  async setAgendaImage(imageBase64, filename = '') {
    return this.setAgendaFile(imageBase64, filename, 'image/*');
  }

  /**
   * Upgrade the locally parsed agenda with the model's structuring pass.
   *
   * The line parser is instant and stays usable while this runs, so the panel
   * and the pending script are never blocked on the model.  When the answer
   * arrives — and no newer agenda replaced this one meanwhile — the entries are
   * swapped in place and the panel is told again, which turns a messy pasted or
   * OCR'd agenda into proper time / name / unit / topic columns.
   */
  refineAgendaWithLlm(agenda, hintCount = 0) {
    if (this.disposed || !agenda || typeof agenda.text !== 'string') return;
    if (agenda.text.trim().length < 8) return;
    if (agenda.parsedBy === 'llm') return;
    void (async () => {
      try {
        const structured = await this.ai.structureAgenda({
          text: agenda.text,
          userName: this.profile.userName,
          hintCount,
          signal: this.abort.signal
        });
        const entries = Array.isArray(structured?.entries) ? structured.entries : [];
        if (this.disposed || entries.length === 0) return;
        // A newer pasted/uploaded agenda wins over this late answer.
        if (this.agendaInUse() !== agenda) return;
        agenda.entries = entries;
        agenda.warnings = [];
        agenda.parsedBy = 'llm';
        agenda.updatedAt = Date.now();
        this.emit('agenda', { ...agenda, now: this.agendaNow(agenda) });
        this.emit('state', this.snapshot());
        if (this.active !== null && !this.active.readOnly) await this.persistMeta(this.active);
        this.applyAgendaMeta(structured);
        // Speaker names in the agenda decide which slots are the user's own.
        this.maybeAutoScripts();
      } catch (error) {
        this.logger?.warn?.(`meeting: LLM agenda parse failed: ${safeError(error)}`);
      }
    })();
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

  /**
   * Reassign one turn to another known speaker (or to 自己).
   *
   * Speaker clustering is a guess; when the agenda changes at the last minute
   * the user clicks the speaker chip and picks the right person, and every
   * line of that turn follows.
   */
  async setTurnSpeaker(turnId, speakerId, person = {}) {
    const meeting = this.active;
    if (meeting === null) throw Object.assign(new Error('还没有会议'), { code: 'NO_MEETING' });
    const turn = meeting.turns.find((item) => item.id === turnId);
    if (!turn) throw Object.assign(new Error('没有找到这一段发言'), { code: 'TURN_NOT_FOUND', status: 404 });
    let name = '';
    let org = '';
    let id = null;
    if (speakerId === 'self') {
      id = 'self';
      name = '自己';
    } else if (speakerId) {
      const speaker = meeting.speakersList.find((item) => item.id === speakerId)
        ?? (meeting.clusterer?.list?.() ?? []).find((item) => item.id === speakerId);
      if (!speaker) throw Object.assign(new Error('没有找到这个发言人'), { code: 'SPEAKER_NOT_FOUND', status: 404 });
      id = speaker.id;
      name = speaker.name || '';
      org = speaker.org || '';
    } else if (typeof person.name === 'string' && person.name.trim().length > 0) {
      // A name typed by the user (or picked from the agenda roster) that has no
      // voice cluster yet: reuse a speaker with the same name, else register a
      // roster speaker so later turns can point at it too.
      name = clampString(person.name, 40, '');
      org = clampString(person.org, 60, '');
      const matched = meeting.speakersList.find((item) => nameMatches(item.name, name));
      if (matched) {
        id = matched.id;
        name = matched.name || name;
        org = org || matched.org || '';
      } else {
        id = `p:${name}`;
        meeting.speakersList = meeting.speakersList.concat([{ id, name, org, source: 'roster' }]);
        this.emit('speaker', { phase: meeting.speakerState?.phase ?? 'ready', speakers: meeting.speakersList });
      }
    }
    if (id === null && name.length === 0) {
      throw Object.assign(new Error('请选择一个名字，或输入名字'), { code: 'INVALID_NAME', status: 400 });
    }
    turn.speakerId = id;
    turn.speakerName = name;
    turn.speakerOrg = org;
    turn.speakerSuggested = false;
    for (const line of turn.lines) {
      line.speakerId = id;
      line.speakerName = name;
      line.speakerOrg = org;
      line.speakerSuggested = false;
    }
    turn.updatedAt = Date.now();
    this.emit('turn', publicTurn(turn));
    this.emit('state', this.snapshot());
    await this.persistTranscript(meeting);
    await this.persistMeta(meeting);
    return this.snapshot();
  }

  /**
   * Leave a finished/historical meeting view and return to a clean panel.
   * Without this the "新会议" button had nothing to change on the Host.
   */
  async newMeeting() {
    const meeting = this.active;
    if (meeting === null) return this.snapshot();
    if (!meeting.readOnly && !['ended', 'error'].includes(meeting.status)) {
      throw Object.assign(new Error('请先结束当前会议，再开始新会议'), { code: 'MEETING_ACTIVE', status: 409 });
    }
    this.stopSummaryTimer();
    this.stopRefineTimer();
    this.stopCueTimer();
    this.active = null;
    this.pendingCues = [];
    this.pendingDocument = null;
    this.pendingCueState = { status: 'idle', key: null, updatedAt: 0, error: null };
    this.emit('state', this.snapshot());
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
    // Minutes are never generated on a timer: the user decides when to write
    // them (the 会议纪要 tab button), and the final version is written when the
    // meeting is stopped.
    void meeting;
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

  /* ------------------------------------------------------------------ */
  /* 串词 (cue cards) — written just in time, per moment                 */
  /* ------------------------------------------------------------------ */

  startCueTimer(meeting) {
    this.stopCueTimer();
    meeting.cueTimer = setInterval(() => {
      void this.maybeCues(meeting);
    }, 20000);
    void this.maybeCues(meeting);
  }

  stopCueTimer() {
    const meeting = this.active;
    if (meeting?.cueTimer) {
      clearInterval(meeting.cueTimer);
      meeting.cueTimer = null;
    }
    if (this.cueTimer) {
      clearInterval(this.cueTimer);
      this.cueTimer = null;
    }
  }

  /** What has actually been said so far, for the cue prompt. */
  cueTranscript(meeting, limitChars = 8000) {
    const items = Array.isArray(meeting.turns) && meeting.turns.length > 0 ? meeting.turns : meeting.transcript;
    const lines = items.map((item) => {
      const who = item.speakerName ? `${item.speakerName}：` : '';
      const minutes = Number(item.startMs);
      const stamp = Number.isFinite(minutes) ? `[${clockText(Math.floor(minutes / 60000))}] ` : '';
      return `${stamp}${who}${item.refinedText || item.text || item.raw || ''}`.trim();
    }).filter((line) => line.length > 0);
    const joined = lines.join('\n');
    return joined.length > limitChars ? joined.slice(joined.length - limitChars) : joined;
  }

  /**
   * The 2-minute rule: when one of the user's moments is due and its cue card
   * does not exist yet, write it now — with the agenda *and* what was said.
   */
  async maybeCues(meeting) {
    if (this.active !== meeting || meeting.readOnly || meeting.cueBusy) return;
    if (!['listening', 'capturing'].includes(meeting.status)) return;
    const entries = meeting.agenda?.entries ?? [];
    if (entries.length === 0) return;
    const due = dueCues({
      entries,
      role: this.roleInUse(),
      userName: this.profile.userName,
      minutes: minutesOfDay(new Date())
    });
    for (const item of due) {
      if (meeting.cues.some((cue) => cue.key === item.key)) continue;
      await this.generateCue(meeting, item.index, item.kind, { key: item.key, auto: true });
      return; // one card per tick keeps the model calls serial
    }
  }

  /** Panel request: write the cue for one agenda entry right now. */
  async requestCue(index) {
    const entries = (this.active ? this.active.agenda : this.pendingAgenda)?.entries ?? [];
    const target = Number(index);
    if (!Number.isInteger(target) || target < 0 || target >= entries.length) {
      throw Object.assign(new Error('没有找到这个日程环节'), { code: 'AGENDA_INDEX_INVALID', status: 400 });
    }
    const kind = this.roleInUse() === 'host' ? 'manual' : 'thanks';
    if (this.active !== null) {
      await this.generateCue(this.active, target, kind, { key: `manual:${target}:${Date.now()}`, auto: false });
    } else {
      if (entries.length === 0) {
        throw Object.assign(new Error('还没有会议日程，无法生成串词'), { code: 'NO_AGENDA', status: 400 });
      }
      await this.generatePendingCue(target, kind, `manual:${target}:${Date.now()}`);
    }
    return this.snapshot();
  }

  async generateCue(meeting, index, kind, options = {}) {
    if (meeting.cueBusy) return null;
    const entries = Array.isArray(meeting.agenda?.entries) ? meeting.agenda.entries : [];
    const entry = entries[index] ?? null;
    if (!entry) return null;
    const prevEntry = index > 0 ? entries[index - 1] : null;
    const nextEntry = index < entries.length - 1 ? entries[index + 1] : null;
    const key = options.key ?? `entry:${index}`;
    const existing = meeting.cues.find((cue) => cue.key === key);
    if (existing && existing.status === 'done') return existing;
    const cue = existing ?? {
      key,
      index,
      kind,
      role: this.roleInUse(),
      entryText: formatAgendaEntry(entry),
      markdown: '',
      status: 'writing',
      error: null,
      at: Date.now(),
      auto: options.auto === true
    };
    if (!existing) meeting.cues.push(cue);
    meeting.cueBusy = true;
    meeting.cueState = { status: 'writing', key, updatedAt: Date.now(), error: null };
    this.emit('cue', publicCue(cue));
    try {
      const markdown = await this.ai.writeCue({
        kind,
        role: this.roleInUse(),
        entry,
        prevEntry,
        nextEntry,
        entries,
        userName: this.profile.userName,
        userOrg: this.profile.userOrg,
        topic: meeting.topic,
        domain: meeting.domain,
        customDomain: meeting.customDomain,
        glossary: meeting.glossary,
        transcript: this.cueTranscript(meeting),
        summary: meeting.summary?.markdown ?? '',
        nowClock: clockText(minutesOfDay(new Date())),
        signal: this.abort.signal
      });
      cue.markdown = markdown;
      cue.status = 'done';
      cue.error = null;
      cue.at = Date.now();
      meeting.cueState = { status: 'done', key, updatedAt: Date.now(), error: null };
      this.emit('cue', publicCue(cue));
      this.emit('state', this.snapshot());
      await this.persistMeta(meeting);
      return cue;
    } catch (error) {
      cue.status = 'error';
      cue.error = safeError(error);
      meeting.cueState = { status: 'error', key, updatedAt: Date.now(), error: cue.error };
      this.emit('cue', publicCue(cue));
      this.emit('warning', { message: `串词生成失败：${cue.error}` });
      return cue;
    } finally {
      meeting.cueBusy = false;
    }
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
      summaryUpdatedAt: meeting.summary.updatedAt,
      scripts: meeting.scripts ?? null,
      cues: Array.isArray(meeting.cues) ? meeting.cues.map(publicCue) : []
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
    this.scriptToken += 1;
    this.stopSummaryTimer();
    this.stopRefineTimer();
    this.stopCueTimer();
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
