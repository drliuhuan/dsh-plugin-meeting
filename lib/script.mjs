// Speech drafts and host transitions ("讲词 / 串词") for the meeting assistant.
//
// The agenda is the only source of truth: its parsed entries become the
// structure, the durable local profile marks which slots belong to the user,
// and one LLM call writes a Markdown draft for the user only.  Nothing is
// generated unless the user's name actually appears in the agenda — the draft
// is never a generic script for the whole meeting.
//
// The user can edit the writing instructions and regenerate, so everything
// model-facing is built here and in ai.mjs instead of being hard-coded in the
// client.  Pure helpers only, so scripts/selftest.mjs can verify them offline.

import { formatAgendaEntry } from './agenda.mjs';

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
  '一、我的讲词',
  '- 只为日程里记在我名下的环节（［我的环节］）写讲词。',
  '- 每个环节写成：开场句 + 2–4 条主体要点（每条一句话，可以附一个可举例或引用数据的方向）+ 收尾句。',
  '- 开场句交代这一环节的主题和意义；收尾句做小结或自然过渡。',
  '',
  '二、我的串词',
  '- 只写需要由我来说的衔接：我的环节之前如何承接上一环节或介绍背景，我的环节之间如何过渡，以及我的环节结束时如何收尾/交还主持人。',
  '- 串词要口语化，一两句话承上启下，点出主题；不要替别人写讲稿，也不要写别人的串词。',
  '- 日程里不需要我说话的环节，不要为它写任何内容。',
  '',
  '通用要求：',
  '- 简体中文，正式但不僵硬；不要空话套话，不要编造日程里没有的信息。',
  '- 每段讲词 120–300 字，每段串词 30–90 字。',
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
 * Build the system prompt for one user-only draft.
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
    '你是一名资深会议主持与发言撰稿人，只为参会者「我」准备可以直接照读的参考稿：只有我必须说的内容。',
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
    '## 我的串词',
    '### <位置说明，例如「<上一环节时间> 之后、我上台前」>',
    '…',
    '',
    '规则：',
    '1. 只输出我的内容：不属于我的环节不要写讲词，也不要替别人拟稿或写别人的串词。',
    '2. 只使用上面日程、我的信息和术语表里出现过的事实；缺信息就写得概括，不要编造具体数字、人名或结论。',
    '3. 日程里有、但写作要求没有覆盖的内容，按写作要求的取舍规则处理；两者冲突时以写作要求为准。',
    '4. 时间、姓名、单位与日程完全一致；不要给日程之外的人安排环节。',
    '5. 讲词和串词都用第一人称「我」。'
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
    '请根据会议日程生成「我的讲词」和「我的串词」，只写我负责或需要我说话的内容，严格按输出格式返回 Markdown。'
  ].filter(Boolean).join('\n');
}
