// Speech drafts and host transitions ("讲词 / 串词") for the meeting assistant.
//
// Two different jobs, deliberately kept apart:
//
//  - 讲词 (the content of the user's own sessions) is written once, before the
//    meeting, from the agenda.  That is buildScriptSystemPrompt below.
//  - 串词 (the words that carry the meeting: opening, transitions between
//    sessions, closing) is written just in time, a couple of minutes before the
//    moment it is needed, with the agenda *and* what was actually said so far.
//    That is buildCueSystemPrompt below, and the role decides its shape: a host
//    summarises the last session and introduces the next one, while a speaker
//    or panelist only thanks the host for the introduction.
//
// Pure helpers only, so scripts/selftest.mjs can verify them offline.

import { formatAgenda, formatAgendaEntry } from './agenda.mjs';

/** Roles decide what the user actually has to say. */
export const ROLES = Object.freeze({
  host: '主持人',
  speaker: '讲者',
  panelist: '讨论嘉宾',
  attendee: '参会者'
});

export function roleLabel(role) {
  return ROLES[role] ?? ROLES.speaker;
}

export function isRole(value) {
  return typeof value === 'string' && Object.hasOwn(ROLES, value);
}

/** Upper bound for the user-edited writing instructions. */
export const MAX_PROMPT_CHARS = 4000;

/**
 * Default writing instructions for the user's own draft.  The client shows
 * this as the placeholder of the prompt editor; an empty user prompt means
 * "use this text".
 */
export const DEFAULT_SCRIPT_PROMPT = [
  '请以第一人称「我」撰写我要在会议上说的内容，只写属于我的部分：',
  '',
  '我的讲词',
  '- 只为日程里记在我名下的环节（［我的环节］）写讲词。',
  '- 每个环节写成：开场句 + 2–4 条主体要点（每条一句话，可以附一个可举例或引用数据的方向）+ 收尾句。',
  '- 开场句交代这一环节的主题和意义；收尾句做小结。',
  '- 不要写串词：串词由插件在接近我的环节时单独生成。',
  '',
  '通用要求：',
  '- 简体中文，正式但不僵硬；不要空话套话，不要编造日程里没有的信息。',
  '- 每段讲词 120–300 字。',
  '- 日程里的时间、姓名、单位必须原样保留，并且只为我出现的环节写稿。'
].join('\n');

/** Names compare after removing whitespace and typographic separators. */
export function normalizePersonName(value) {
  return String(value ?? '').replace(/[\s·•・]/g, '').trim().toLowerCase();
}

/**
 * True when the agenda speaker looks like the configured user.  This is a
 * display/prompt hint only: the model still sees every entry and decides.
 */
export function nameMatches(speaker, userName) {
  const left = normalizePersonName(speaker);
  const right = normalizePersonName(userName);
  if (left.length === 0 || right.length === 0) return false;
  return left === right || left.includes(right) || right.includes(left);
}

/**
 * Annotate agenda entries with an `mine` flag for the user's own slots.
 * @param {Array<object>} entries
 * @param {string} userName
 * @returns {Array<{ index: number, entry: object, mine: boolean }>}
 */
export function markAgendaEntries(entries, userName) {
  return (Array.isArray(entries) ? entries : []).map((entry, index) => ({
    index,
    entry,
    mine: nameMatches(entry?.speaker, userName)
  }));
}

/**
 * A numbered agenda for the prompt, with the user's own slots marked.
 * @param {Array<object>} entries
 * @param {string} userName
 * @param {number} [limit]
 */
export function formatScriptAgenda(entries, userName, limit = 80) {
  return markAgendaEntries(entries, userName)
    .slice(0, limit)
    .map(({ entry, index, mine }) => `${index + 1}. ${formatAgendaEntry(entry)}${mine ? ' ［我的环节］' : ''}`)
    .join('\n');
}

/**
 * Build the system prompt for one user-only draft (讲词 only).
 *
 * @param {object} options
 * @param {Array<object>} options.entries parsed agenda entries
 * @param {string} options.userName the durable local profile name; must match
 *   at least one agenda entry (the caller validates this).
 * @param {string} [options.userOrg]
 * @param {string} [options.title] meeting title
 * @param {string} [options.topic] meeting topic
 * @param {string} [options.domainLabel] human label of the meeting domain
 * @param {string} [options.domainHint]
 * @param {string} [options.glossary] user glossary, for consistent wording
 * @param {string} [options.prompt] user-edited writing instructions
 * @returns {string}
 */
export function buildScriptSystemPrompt(options = {}) {
  const entries = Array.isArray(options.entries) ? options.entries : [];
  const userName = String(options.userName ?? '').trim();
  const userOrg = String(options.userOrg ?? '').trim();
  const title = String(options.title ?? '').trim();
  const topic = String(options.topic ?? '').trim();
  const domainLabel = String(options.domainLabel ?? '').trim();
  const domainHint = String(options.domainHint ?? '').trim();
  const glossary = String(options.glossary ?? '').trim().slice(0, 1200);
  const custom = String(options.prompt ?? '').trim().slice(0, MAX_PROMPT_CHARS);
  const instructions = custom.length > 0 ? custom : DEFAULT_SCRIPT_PROMPT;
  const mine = entries.filter((entry) => nameMatches(entry?.speaker, userName));
  const mineText = mine.map((entry) => formatAgendaEntry(entry)).join('\n');
  const agendaText = formatScriptAgenda(entries, userName);

  return [
    '你是一名资深会议发言撰稿人，只为参会者「我」准备可以直接照读的讲词：只有我要讲的内容。',
    '',
    '会议信息：',
    `- 会议标题：${title || '未提供'}`,
    `- 会议主题：${topic || '未提供'}`,
    `- 会议领域：${domainLabel || '通用会议'}${domainHint ? `（${domainHint}）` : ''}`,
    `- 我的姓名：${userName}${userOrg ? `（${userOrg}）` : ''}`,
    glossary.length > 0 ? `- 术语表（写稿时必须采用这些写法）：\n${glossary}` : '',
    '',
    '会议日程（编号. 时间 讲者/单位：主题；［我的环节］表示记在我名下）：',
    agendaText || '（日程为空）',
    '',
    '我负责的环节：',
    mineText || '（无）',
    '',
    '写作要求：',
    instructions,
    '',
    '输出格式（Markdown，不要用代码块包裹整篇）：',
    '## 我的讲词',
    '### <时间> <我的环节主题>',
    '**开场**：…',
    '**要点**',
    '- …',
    '**收尾**：…',
    '',
    '规则：',
    '1. 只输出我的讲词：不属于我的环节不要写，也不要替别人拟稿，不要写串词。',
    '2. 只使用上面日程、我的信息和术语表里出现过的事实；缺信息就写得概括，不要编造具体数字、人名或结论。',
    '3. 时间、姓名、单位与日程完全一致；不要给日程之外的人安排环节。',
    '4. 用第一人称「我」。'
  ].filter(Boolean).join('\n');
}

/**
 * The user turn that accompanies the system prompt.
 * @param {object} options
 * @param {string} [options.topic]
 * @returns {string}
 */
export function buildScriptUserPrompt(options = {}) {
  const topic = String(options.topic ?? '').trim();
  return [
    topic.length > 0 ? `会议主题：${topic}` : '',
    '请根据会议日程生成「我的讲词」，只写我负责的环节，严格按输出格式返回 Markdown。'
  ].filter(Boolean).join('\n');
}

/* ------------------------------------------------------------------------ */
/* 串词 (cue) — one card per moment, generated just in time                  */
/* ------------------------------------------------------------------------ */

/**
 * What a cue episode means for this user.
 *
 *  opening    the host opens the meeting
 *  transition the host hands the floor to the next session
 *  closing    the host closes the meeting
 *  thanks     a speaker/panelist thanks the host for the introduction
 *  manual     the user asked for a cue at this point
 */
export function cueKindFor(role, entry, prevEntry, nextEntry) {
  if (role === 'host') {
    if (!prevEntry && nextEntry) return 'opening';
    if (prevEntry && !nextEntry) return 'closing';
    return 'transition';
  }
  return 'thanks';
}

/** Minutes since midnight for "now". */
export function minutesOfDay(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Which cue moments are due right now.
 *
 * The rule the operator asked for: a cue is produced about two minutes before
 * the user has to speak, and never earlier than that, so it can use what was
 * actually said.  `window` is [start - lead, start + grace].
 *
 * @param {object} options
 * @param {Array<object>} options.entries
 * @param {string} options.role
 * @param {string} options.userName
 * @param {number} options.minutes minutes of day
 * @param {number} [options.lead] minutes before the slot (default 2)
 * @param {number} [options.grace] minutes after the slot start (default 12)
 * @returns {Array<{ key: string, index: number, kind: string }>}
 */
export function dueCues(options = {}) {
  const entries = Array.isArray(options.entries) ? options.entries : [];
  const role = isRole(options.role) ? options.role : 'speaker';
  const userName = String(options.userName ?? '').trim();
  const minutes = Number(options.minutes);
  const lead = Number.isFinite(Number(options.lead)) ? Number(options.lead) : 2;
  const grace = Number.isFinite(Number(options.grace)) ? Number(options.grace) : 12;
  if (!Number.isFinite(minutes) || entries.length === 0) return [];
  const timed = entries
    .map((entry, index) => ({ entry, index }))
    .filter((item) => item.entry && item.entry.startMin !== null && item.entry.startMin !== undefined);
  if (timed.length === 0) return [];
  const due = [];
  const inWindow = (startMin) => minutes >= startMin - lead && minutes <= startMin + grace;

  if (role === 'host') {
    const first = timed[0];
    if (inWindow(first.entry.startMin)) {
      due.push({ key: 'open', index: first.index, kind: 'opening' });
    }
    for (const item of timed) {
      if (!inWindow(item.entry.startMin)) continue;
      const position = timed.findIndex((candidate) => candidate.index === item.index);
      // The opening already introduces the first session; a second card for it
      // would just repeat the welcome.
      if (position === 0) continue;
      const prev = position > 0 ? timed[position - 1].entry : null;
      const next = position < timed.length - 1 ? timed[position + 1].entry : null;
      const kind = cueKindFor(role, item.entry, prev, next);
      due.push({ key: `entry:${item.index}`, index: item.index, kind });
    }
    const last = timed[timed.length - 1];
    const endMin = Number(last.entry.endMin ?? last.entry.startMin + 30);
    if (minutes >= endMin - lead && minutes <= endMin + grace) {
      due.push({ key: 'close', index: last.index, kind: 'closing' });
    }
    return due;
  }

  if (role === 'speaker' || role === 'panelist') {
    for (const item of timed) {
      if (!nameMatches(item.entry.speaker, userName)) continue;
      if (!inWindow(item.entry.startMin)) continue;
      due.push({ key: `own:${item.index}`, index: item.index, kind: 'thanks' });
    }
    return due;
  }

  return [];
}

/**
 * The system prompt for one cue card.
 *
 * @param {object} options
 * @param {string} options.kind opening | transition | closing | thanks | manual
 * @param {string} options.role
 * @param {object} [options.entry] the session the cue leads into
 * @param {object} [options.prevEntry] the session that just ended
 * @param {object} [options.nextEntry] the session after `entry`
 * @param {Array<object>} options.entries full agenda
 * @param {string} [options.userName]
 * @param {string} [options.userOrg]
 * @param {string} [options.topic]
 * @param {string} [options.domainLabel]
 * @param {string} [options.domainHint]
 * @param {string} [options.glossary]
 * @param {string} [options.transcript] what was said so far (may be empty)
 * @param {string} [options.summary] running minutes, if any
 * @param {number} [options.nowClock] "HH:MM" of the moment
 * @returns {string}
 */
export function buildCueSystemPrompt(options = {}) {
  const kind = String(options.kind ?? 'transition');
  const role = isRole(options.role) ? options.role : 'speaker';
  const entries = Array.isArray(options.entries) ? options.entries : [];
  const userName = String(options.userName ?? '').trim();
  const userOrg = String(options.userOrg ?? '').trim();
  const topic = String(options.topic ?? '').trim();
  const domainLabel = String(options.domainLabel ?? '').trim();
  const domainHint = String(options.domainHint ?? '').trim();
  const glossary = String(options.glossary ?? '').trim().slice(0, 800);
  const transcript = String(options.transcript ?? '').trim().slice(0, 9000);
  const summary = String(options.summary ?? '').trim().slice(0, 4000);
  const entryText = options.entry ? formatAgendaEntry(options.entry) : '';
  const prevText = options.prevEntry ? formatAgendaEntry(options.prevEntry) : '';
  const nextText = options.nextEntry ? formatAgendaEntry(options.nextEntry) : '';
  const agendaText = formatAgenda(entries, 40);

  if (kind === 'thanks') {
    return [
      `你是一名${domainLabel || '会议'}现场发言顾问。我是「${userName}」${userOrg ? `（${userOrg}）` : ''}，在这场会议里的角色是${roleLabel(role)}。`,
      '',
      '现在轮到我上场，我只需要一段很短的开场回应：感谢主持人的介绍，简短自我介绍（姓名/单位，只用已给信息），然后把话头交给我的内容。',
      '',
      '规则：',
      '1. 只写 1–2 句，30–60 字，口语化，可以直接照读。',
      '2. 不要写讲稿正文，不要总结会议，不要介绍别人，不要编造事实。',
      '3. 称呼主持人时用「主持人」即可，不要编造姓名。',
      '4. 输出纯文本，不要标题、不要 markdown 代码块。',
      '',
      entryText ? `我要讲的环节：${entryText}` : ''
    ].filter(Boolean).join('\n');
  }

  const kindInstruction = kind === 'opening'
    ? '现在是会议开场：欢迎参会者，说明会议背景与今天的日程安排，把第一个环节和讲者介绍出去。'
    : kind === 'closing'
      ? '现在是会议结束：总结今天的要点（只依据转写/纪要已有的内容），致谢讲者与参会者，说明后续安排或联系方式（没有信息就不要编）。'
      : '现在上一个环节刚刚结束，我要把场子交给下一个环节。';

  return [
    `你是一名资深会议主持人，我是「${userName}」${userOrg ? `（${userOrg}）` : ''}，这场会议的${roleLabel(role)}。`,
    '请写我此刻要说的一段串词。',
    '',
    '会议信息：',
    `- 会议主题：${topic || '未提供'}`,
    `- 会议领域：${domainLabel || '通用会议'}${domainHint ? `（${domainHint}）` : ''}`,
    glossary.length > 0 ? `- 术语表（必须采用这些写法）：\n${glossary}` : '',
    '',
    '完整日程：',
    agendaText || '（日程为空）',
    '',
    prevText ? `刚刚结束的环节：${prevText}` : '',
    entryText ? `即将开始的环节：${entryText}` : '',
    nextText ? `它之后还有：${nextText}` : '',
    '',
    kindInstruction,
    '',
    '写作规则：',
    '1. 先用 1–2 句总结刚刚结束环节里真实讲过的内容（只能依据下面的转写/纪要；没有内容就礼貌带过，绝不编造）。',
    '2. 再用 1–2 句介绍下一个环节的主题和讲者（姓名、单位与日程一致）。',
    '3. 口语化，可以直接照读；总长 60–180 字。',
    '4. 不要写别人的讲稿，不要写我没有说过的事实，不要用 bullet 列表。',
    '5. 输出纯文本，不要标题、不要 markdown 代码块。',
    '',
    transcript ? `已经识别到的会议内容（截至现在，可能有识别错误）：\n${transcript}` : '（会议刚开始，还没有识别到内容）',
    summary ? `\n当前会议纪要（供参考）：\n${summary}` : ''
  ].filter(Boolean).join('\n');
}

/**
 * The user turn for one cue card.
 * @param {object} options
 * @param {string} [options.nowClock] e.g. "14:28"
 * @param {string} [options.kind]
 * @returns {string}
 */
export function buildCueUserPrompt(options = {}) {
  const clock = String(options.nowClock ?? '').trim();
  const kind = String(options.kind ?? 'transition');
  const moment = kind === 'opening' ? '会议开场'
    : kind === 'closing' ? '会议结束'
      : kind === 'thanks' ? '我上场前'
        : '环节交接';
  return `现在时间 ${clock || '（未提供）'}，场合是「${moment}」。请只输出我这一刻要说的那段话。`;
}
