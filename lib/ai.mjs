// DSH-owned language work for the meeting panel.
//
// Every model call goes through ctx.llm, so it uses the same provider, model,
// credentials and retry policy as the rest of the harness.  Web lookup goes
// through ctx.web, the same search seam the agent's web_search tool uses.
//
// One LLM call does both jobs for each batch of recognized lines: domain-aware
// proofreading and translation.  That keeps latency and token cost down while
// making the correction see the meeting's vocabulary and topic.

import { formatClock, safeError, tailByChars } from './util.mjs';
import { agendaNameReference, currentAgenda, entriesFromLlm, formatAgenda, formatAgendaEntry } from './agenda.mjs';
import { buildCueSystemPrompt, buildCueUserPrompt, buildScriptSystemPrompt, buildScriptUserPrompt, nameMatches } from './script.mjs';

export const DOMAINS = Object.freeze({
  general: { zh: '通用会议', en: 'general meeting', hint: '日常商务与团队沟通' },
  medical: { zh: '医学/临床', en: 'medical / clinical', hint: '疾病、诊断、治疗方案、药品、检查指标与临床研究' },
  tech: { zh: '科技/IT', en: 'technology / IT', hint: '产品、架构、API、模型、数据、工程与运维' },
  game: { zh: '游戏', en: 'gaming', hint: '玩法、关卡、版本、运营、电竞、玩家社区与商业化' },
  finance: { zh: '金融', en: 'finance', hint: '财务、投资、风控、合规、市场与交易' },
  legal: { zh: '法律', en: 'legal', hint: '法条、合同、诉讼、知识产权与合规' },
  education: { zh: '教育', en: 'education', hint: '课程、教学法、评估、学术与校园管理' },
  manufacturing: { zh: '制造/工程', en: 'manufacturing / engineering', hint: '工艺、设备、质量、供应链与工程项目' },
  marketing: { zh: '市场/销售', en: 'marketing / sales', hint: '品牌、增长、渠道、客户、投放与销售' },
  research: { zh: '科研', en: 'research', hint: '论文、实验、方法、数据与学术合作' },
  custom: { zh: '自定义领域', en: 'custom domain', hint: '' }
});

export const TARGET_LANGUAGES = Object.freeze({
  en: 'English',
  zh: '简体中文',
  ja: '日本語',
  ko: '한국어',
  off: '不翻译'
});

export const SUMMARY_LANGUAGES = Object.freeze({
  zh: '简体中文',
  en: 'English'
});

function domainLabel(domain, language = 'zh') {
  const item = DOMAINS[domain] ?? DOMAINS.general;
  return language === 'en' ? item.en : item.zh;
}

function domainHint(domain, customDomain) {
  if (domain === 'custom') return customDomain || '';
  return DOMAINS[domain]?.hint ?? DOMAINS.general.hint;
}

function modelNotConfigured() {
  return Object.assign(new Error('DSH 还没有配置默认模型。请在「设置 → 模型」里选择一个模型后重试。'), {
    code: 'MODEL_NOT_CONFIGURED'
  });
}

function llmUnavailable() {
  return Object.assign(new Error('DSH 的模型服务不可用，无法进行校正、翻译或总结。'), { code: 'LLM_UNAVAILABLE' });
}

function parseJsonPayload(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const objectStart = candidate.indexOf('{');
  const objectEnd = candidate.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    try {
      return JSON.parse(candidate.slice(objectStart, objectEnd + 1));
    } catch {
      // fall through to the array form
    }
  }
  const arrayStart = candidate.indexOf('[');
  const arrayEnd = candidate.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try {
      return JSON.parse(candidate.slice(arrayStart, arrayEnd + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function stripCodeFence(text) {
  if (typeof text !== 'string') return '';
  const fenced = text.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Parse the marker format used for correction batches.
 *
 * JSON is a poor fit here: a meeting line can contain quotes, newlines and
 * braces, and one escaping mistake loses a whole batch.  Three unambiguous
 * markers per item keep the model's job simple and the parser forgiving.
 *
 * @param {string} text raw model output.
 * @returns {Map<string, {corrected: string, translation: string}>}
 */
function parseTaggedCorrections(text) {
  const cleaned = stripCodeFence(text);
  const result = new Map();
  const strict = /<<<\s*([A-Za-z0-9_-]+)\s*>>>([\s\S]*?)<<<\s*(?:translation|译文)\s*>>>([\s\S]*?)<<<\s*(?:end|结束)\s*>>>/gi;
  let match;
  while ((match = strict.exec(cleaned)) !== null) {
    result.set(match[1].trim().toLowerCase(), { corrected: match[2], translation: match[3] });
  }
  if (result.size > 0) return result;
  // Forgiving pass: the model omitted the end marker.
  const loose = /<<<\s*([A-Za-z0-9_-]+)\s*>>>([\s\S]*?)<<<\s*(?:translation|译文)\s*>>>([\s\S]*?)(?=<<<\s*[A-Za-z0-9_-]+\s*>>>|$)/gi;
  while ((match = loose.exec(cleaned)) !== null) {
    result.set(match[1].trim().toLowerCase(), { corrected: match[2], translation: match[3] });
  }
  return result;
}

/** Parse the `<<<Tn>>> ... <<<end>>>` blocks used by the whole-turn refiner. */
function parseTaggedBlocks(text) {
  const cleaned = stripCodeFence(text);
  const result = new Map();
  const pattern = /<<<\s*([A-Za-z0-9_-]+)\s*>>>([\s\S]*?)<<<\s*(?:end|结束)\s*>>>/gi;
  let match;
  while ((match = pattern.exec(cleaned)) !== null) {
    result.set(match[1].trim().toLowerCase(), match[2].trim());
  }
  return result;
}

function cleanCorrection(value) {
  return String(value ?? '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/^(校正|修正|原文|corrected)\s*[:：]\s*/i, '')
    .replace(/^(翻译|译文|translation|translated)\s*[:：]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceLines(lines, options = {}) {
  const includeTranslation = options.includeTranslation === true;
  const groups = [];
  for (const line of lines) {
    const clock = formatClock(line.startMs ?? 0);
    const text = cleanCorrection(line.text || line.raw || '');
    if (text.length === 0) continue;
    const translation = includeTranslation ? cleanCorrection(line.translation ?? '') : '';
    const previous = groups[groups.length - 1];
    const sameSpeaker = previous && line.speakerId && previous.speakerId === line.speakerId
      && Number(line.startMs) - Number(previous.endMs) <= 30000;
    if (sameSpeaker) {
      previous.text = `${previous.text} ${text}`.trim();
      if (translation.length > 0) previous.translation = `${previous.translation} ${translation}`.trim();
      previous.endMs = line.endMs;
      continue;
    }
    groups.push({
      clock,
      speakerId: line.speakerId ?? null,
      speakerName: line.speakerName ?? '',
      speakerOrg: line.speakerOrg ?? '',
      text,
      translation,
      endMs: line.endMs
    });
  }
  return groups.map((group) => {
    const speaker = group.speakerName.length > 0
      ? `${group.speakerName}${group.speakerOrg ? `（${group.speakerOrg}）` : ''}: `
      : '';
    return `[${group.clock}] ${speaker}${group.text}${group.translation.length > 0 ? `（译文：${group.translation}）` : ''}`;
  }).join('\n');
}

export class MeetingAi {
  constructor(ctx) {
    this.ctx = ctx;
  }

  llm() {
    try {
      return this.ctx.get('llm');
    } catch {
      return undefined;
    }
  }

  selection() {
    try {
      const service = this.ctx.get('agentDefaultModel');
      const current = service?.currentSelection?.();
      if (typeof current?.provider === 'string' && current.provider.length > 0
        && typeof current?.model === 'string' && current.model.length > 0) {
        return current;
      }
    } catch {
      // no default selection service on this host
    }
    return undefined;
  }

  /**
   * Read one DSH model stream to completion.
   * @returns {Promise<{ text: string, finish: object|null }>}
   */
  async stream({ system, messages, maxTokens, temperature, purpose, reasoningEffort, signal, onDelta }) {
    const llm = this.llm();
    if (!llm || typeof llm.stream !== 'function') throw llmUnavailable();
    const selection = this.selection();
    if (!selection) throw modelNotConfigured();
    const request = {
      provider: selection.provider,
      model: selection.model,
      messages,
      maxTokens,
      temperature,
      purpose,
      signal
    };
    if (typeof system === 'string' && system.length > 0) request.system = system;
    const correctionPurpose = typeof purpose === 'string' && purpose.startsWith('meeting-correct');
    // Proofreading is a deterministic low-creativity task; reasoning tokens
    // would only delay the line and can crowd out the answer itself.
    const effort = reasoningEffort ?? (correctionPurpose ? 'off' : selection.reasoningEffort);
    if (typeof effort === 'string' && effort.length > 0) request.reasoningEffort = effort;

    let text = '';
    let finish = null;
    try {
      for await (const chunk of llm.stream(request)) {
        if (signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'ABORTED' });
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text;
          try {
            onDelta?.(chunk.text);
          } catch {
            // a presentation callback must not break the model stream
          }
        } else if (chunk.type === 'finish') {
          finish = chunk.reason ?? chunk;
        }
      }
    } catch (error) {
      if (error?.code === 'ABORTED') throw error;
      throw Object.assign(new Error(`模型请求失败：${safeError(error)}`), { code: error?.code ?? 'LLM_FAILED' });
    }
    if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
      const failure = finish.failure ?? {};
      throw Object.assign(new Error(`模型请求失败：${failure.message ?? failure.code ?? finish.kind}`), {
        code: finish.kind === 'aborted' ? 'ABORTED' : (failure.code ?? 'LLM_FAILED')
      });
    }
    return { text, finish };
  }

  /**
   * Correct ASR text in the meeting's domain and translate it in one request.
   *
   * @param {Array<{id:string, raw:string, startMs:number}>} lines
   * @param {object} options
   * @param {string} options.domain
   * @param {string} [options.customDomain]
   * @param {string} [options.topic]
   * @param {string} [options.glossary]
   * @param {string} options.targetLang
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<Array<{id:string, corrected:string, translation:string}>>}
   */
  async correctAndTranslate(lines, options) {
    if (!Array.isArray(lines) || lines.length === 0) return [];
    const domain = domainLabel(options.domain, 'zh');
    const hint = domainHint(options.domain, options.customDomain);
    const target = TARGET_LANGUAGES[options.targetLang] ?? TARGET_LANGUAGES.en;
    const translate = options.targetLang !== 'off';
    const glossary = typeof options.glossary === 'string' ? options.glossary.trim() : '';
    const topic = typeof options.topic === 'string' ? options.topic.trim() : '';
    const nameReference = agendaNameReference(options.agendaEntries);
    const input = lines.map((line) => `[${line.id}] ${line.raw}`).join('\n');

    const system = [
      '你是一名专业的会议实时记录员，负责校正语音识别结果，并在需要时做同声传译。',
      `会议领域：${domain}${hint ? `（${hint}）` : ''}。`,
      `会议主题：${topic.length > 0 ? topic : '未提供'}。`,
      nameReference.length > 0 ? `日程中出现的姓名/单位（校正时优先采用这些写法）：${nameReference}` : '',
      glossary.length > 0 ? `术语表（出现时必须优先采用这些写法）：\n${glossary}` : '',
      '',
      '任务规则：',
      '1. 只做校正：修正同音字、错别字、断句、标点、大小写和领域专有名词；不得改变说话人的原意，不得增删信息，不得总结或改写句子结构。',
      '2. 数字、日期、金额、姓名、产品名必须保持原样；无法确定的词保留原样，不要猜测。',
      '3. 如果某一句已经是目标语言且没有识别错误，corrected 保留原样，translation 也保留原样。',
      translate
        ? `4. 将校正后的文本翻译为${target}，使用${domain}领域自然、专业的表达；translation 只放译文。`
        : '4. 不需要翻译：translation 部分留空。',
      '',
      '5. 输出格式（必须逐字遵守；不要 JSON、不要 markdown 代码块、不要解释，也不要输出编号）：',
      '<<<输入里的 id>>>',
      '校正后的原文',
      '<<<translation>>>',
      '译文（不翻译时留空）',
      '<<<end>>>',
      '6. 对每一条输入重复上面的格式；id 必须与输入完全一致、顺序一致、每条恰好出现一次。',
      '7. 校正后的原文里不要包含 <<< 或 >>> 这两个标记。'
    ].filter(Boolean).join('\n');

    const messages = [{ role: 'user', content: [{ type: 'text', text: input }] }];
    const tokenBudget = Math.min(8000, 600 + lines.length * 400);
    const run = async () => this.stream({
      system,
      messages,
      maxTokens: tokenBudget,
      temperature: 0,
      purpose: 'meeting-correct',
      reasoningEffort: 'off',
      signal: options.signal
    });
    let text = '';
    let parsed = new Map();
    let batchError = null;
    try {
      text = (await run()).text;
      parsed = parseTaggedCorrections(text);
      if (parsed.size === 0) {
        // One repair attempt: reformat the model's own output into the marker
        // format.  This is cheaper than dropping a whole batch, and it never
        // sends an assistant message (a standalone llm.stream has no durable
        // assistant source/replay state).
        const repaired = await this.stream({
          system: `${system}\n\n上一次输出缺少标记。请只按上面的标记格式重新输出，不要任何其他文字。`,
          messages: [
            ...messages,
            {
              role: 'user',
              content: [{
                type: 'text',
                text: `上一次的输出是：\n${text.slice(0, 16000)}\n\n请只按 <<<id>>> / <<<translation>>> / <<<end>>> 格式重新输出全部条目。`
              }]
            }
          ],
          maxTokens: tokenBudget,
          temperature: 0,
          purpose: 'meeting-correct-repair',
          reasoningEffort: 'off',
          signal: options.signal
        });
        text = repaired.text;
        parsed = parseTaggedCorrections(text);
      }
    } catch (error) {
      batchError = error;
    }

    // Fallback path: give each still-unresolved line its own plain-text call.
    // This is more expensive, but a live meeting cannot wait for a formatting
    // argument with the model.  Correct and translate are separate calls so
    // there is nothing to parse but the answer itself.
    const recovered = new Map();
    const missing = lines.filter((line) => !parsed.has(line.id)
      || (translate && cleanCorrection(parsed.get(line.id)?.translation ?? '').length === 0));
    if (missing.length > 0) {
      let cursor = 0;
      const worker = async () => {
        while (cursor < missing.length) {
          const line = missing[cursor];
          cursor += 1;
          try {
            const existing = parsed.get(line.id);
            const corrected = existing
              ? cleanCorrection(existing.corrected) || line.raw
              : await this.correctOne(line, options);
            const existingTranslation = existing ? cleanCorrection(existing.translation) : '';
            const translation = translate
              ? (existingTranslation.length > 0 ? existingTranslation : await this.translateOne(corrected, options))
              : '';
            recovered.set(line.id, { corrected, translation });
          } catch (error) {
            if (batchError === null) batchError = error;
          }
        }
      };
      await Promise.all([worker(), worker()]);
    }

    if (parsed.size === 0 && recovered.size === 0) {
      const failure = batchError ?? Object.assign(new Error('模型返回的校正结果没有可识别的标记格式'), {
        code: 'CORRECTION_PARSE_FAILED'
      });
      if (failure.preview === undefined && text.length > 0) failure.preview = text.slice(0, 180);
      throw failure;
    }

    return lines.map((line) => {
      const item = parsed.get(line.id) ?? recovered.get(line.id);
      if (!item) {
        return { id: line.id, corrected: line.raw, translation: '', missing: true };
      }
      const corrected = cleanCorrection(item.corrected);
      const translation = translate ? cleanCorrection(item.translation) : '';
      return {
        id: line.id,
        corrected: corrected.length > 0 ? corrected : line.raw,
        translation
      };
    });
  }

  /** One plain-text correction call, used when the batch format is not obeyed. */
  async correctOne(line, options) {
    const domain = domainLabel(options.domain, 'zh');
    const hint = domainHint(options.domain, options.customDomain);
    const topic = typeof options.topic === 'string' ? options.topic.trim() : '';
    const glossary = typeof options.glossary === 'string' ? options.glossary.trim() : '';
    const nameReference = agendaNameReference(options.agendaEntries);
    const system = [
      '你是一名会议实时记录员。只输出这一句话的校正结果。',
      `会议领域：${domain}${hint ? `（${hint}）` : ''}。会议主题：${topic.length > 0 ? topic : '未提供'}。`,
      nameReference.length > 0 ? `日程中的姓名/单位（优先采用）：${nameReference}` : '',
      glossary.length > 0 ? `术语表：\n${glossary}` : '',
      '规则：修正同音字、错别字、断句、标点和专有名词；不改变原意，不增删信息，不总结；数字、姓名、产品名保留原样。',
      '只输出校正后的文本本身：不要解释、不要引号、不要前缀、不要翻译。'
    ].filter(Boolean).join('\n');
    const result = await this.stream({
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: line.raw }] }],
      maxTokens: 800,
      temperature: 0,
      purpose: 'meeting-correct-one',
      reasoningEffort: 'off',
      signal: options.signal
    });
    const corrected = cleanCorrection(result.text);
    return corrected.length > 0 ? corrected : line.raw;
  }

  /** One plain-text translation call, used when the batch format is not obeyed. */
  async translateOne(text, options) {
    if (options.targetLang === 'off') return '';
    const domain = domainLabel(options.domain, 'zh');
    const target = TARGET_LANGUAGES[options.targetLang] ?? TARGET_LANGUAGES.en;
    const system = [
      `你是一名${domain}领域的专业同声传译。`,
      `把用户给出的文本翻译为${target}，使用该领域自然、专业的表达。`,
      '只输出译文本身：不要解释、不要引号、不要前缀、不要保留原文。'
    ].join('\n');
    const result = await this.stream({
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      maxTokens: 800,
      temperature: 0,
      purpose: 'meeting-translate-one',
      reasoningEffort: 'off',
      signal: options.signal
    });
    return cleanCorrection(result.text);
  }

  /**
   * Re-correct whole speaker turns with the full conversation as context.
   *
   * This is the once-a-minute pass: it can join sentences that were split by
   * the 10-second ASR window, unify terminology, and fix names using what was
   * said later, without changing what was said.
   *
   * @param {Array<{id:string,text:string,speakerName?:string,speakerOrg?:string}>} turns
   * @param {object} options
   * @returns {Promise<Map<string,string>>} turn id -> corrected text.
   */
  async refineTurns(turns, options) {
    if (!Array.isArray(turns) || turns.length === 0) return new Map();
    const domain = domainLabel(options.domain, 'zh');
    const hint = domainHint(options.domain, options.customDomain);
    const topic = typeof options.topic === 'string' ? options.topic.trim() : '';
    const glossary = typeof options.glossary === 'string' ? options.glossary.trim() : '';
    const nameReference = agendaNameReference(options.agendaEntries);
    const agendaText = formatAgenda(options.agendaEntries, 20);
    const now = currentAgenda(options.agendaEntries, new Date());
    const currentText = now.entry && now.status === 'current' ? formatAgendaEntry(now.entry) : '';
    const input = turns.map((turn) => {
      const speaker = turn.speakerName
        ? `${turn.speakerName}${turn.speakerOrg ? `（${turn.speakerOrg}）` : ''}: `
        : '';
      return `<<<${turn.id}>>>\n${speaker}${turn.text}\n<<<end>>>`;
    }).join('\n\n');
    const totalChars = input.length;

    const system = [
      '你是一名会议记录员，负责对整段会议转写做二次校正。',
      `会议领域：${domain}${hint ? `（${hint}）` : ''}。`,
      `会议主题：${topic.length > 0 ? topic : '未提供'}。`,
      agendaText.length > 0 ? `会议日程（讲者/单位/环节，仅作人名与术语参考）：\n${agendaText}\n` : '',
      currentText.length > 0 ? `当前日程：${currentText}` : '',
      nameReference.length > 0 ? `日程中的姓名/单位（优先采用）：${nameReference}` : '',
      glossary.length > 0 ? `术语表（优先采用）：\n${glossary}` : '',
      '',
      '任务：把每个 Tn 块里的转写整理成通顺、准确的发言记录。',
      '规则：',
      '1. 只校正：修正同音字、错别字、断句、标点、大小写和领域专有名词；可以合并被 10 秒识别窗口切断的句子，但不改变原意、不增删信息、不总结、不扩写。',
      '2. 保留每个 Tn 的边界和说话人，绝不能把不同 Tn 合并，也不能把一个 Tn 拆成多个。',
      '3. 数字、日期、金额、姓名、产品名保持原样；无法确定的词保留原文。',
      '4. 利用整段上下文统一术语和人名，但不要引入上下文中没有的事实。',
      '5. 输出格式（严格，不要 JSON、不要 markdown 代码块、不要解释）：',
      '<<<T1>>>',
      '校正后的完整文本',
      '<<<end>>>',
      '每个输入 Tn 恰好出现一次。'
    ].filter(Boolean).join('\n');

    const result = await this.stream({
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      maxTokens: Math.min(8000, 900 + Math.ceil(totalChars / 1.2)),
      temperature: 0,
      purpose: 'meeting-refine',
      reasoningEffort: 'off',
      signal: options.signal
    });
    const blocks = parseTaggedBlocks(result.text);
    if (blocks.size === 0) {
      throw Object.assign(new Error('整段二次校正没有返回可识别的 Tn 块'), {
        code: 'REFINE_PARSE_FAILED',
        preview: result.text.slice(0, 180)
      });
    }
    // Guard against a model that summarizes instead of correcting: keep the
    // previous text when the "correction" is drastically shorter.
    const accepted = new Map();
    for (const turn of turns) {
      const corrected = cleanCorrection(blocks.get(turn.id) ?? '');
      if (corrected.length === 0) continue;
      if (turn.text.length > 80 && corrected.length < turn.text.length * 0.45) continue;
      accepted.set(turn.id, corrected);
    }
    if (accepted.size === 0) {
      throw Object.assign(new Error('整段二次校正没有产生可用的 Tn 内容'), {
        code: 'REFINE_EMPTY',
        preview: result.text.slice(0, 220)
      });
    }
    return accepted;
  }

  /**
   * Produce or update the running meeting minutes.
   * @returns {Promise<string>} Markdown.
   */
  async summarize(options) {
    const domain = domainLabel(options.domain, 'zh');
    const hint = domainHint(options.domain, options.customDomain);
    const topic = typeof options.topic === 'string' ? options.topic.trim() : '';
    const previous = typeof options.previousSummary === 'string' ? options.previousSummary.trim() : '';
    const transcript = tailByChars(sourceLines(options.lines, { includeTranslation: false }), 32000);
    const language = SUMMARY_LANGUAGES[options.summaryLang] ?? SUMMARY_LANGUAGES.zh;
    const final = options.final === true;
    const agendaEntries = Array.isArray(options.agendaEntries) ? options.agendaEntries : [];
    const agendaText = formatAgenda(agendaEntries);
    const now = currentAgenda(agendaEntries, new Date());
    const currentText = now.entry && now.status === 'current' ? formatAgendaEntry(now.entry) : '';

    const system = [
      '你是一名资深会议纪要专家。',
      `会议领域：${domain}${hint ? `（${hint}）` : ''}。`,
      `会议主题：${topic.length > 0 ? topic : '未提供'}。`,
      '',
      '请根据转写生成会议纪要，使用 Markdown，固定包含以下小节：',
      '## 一句话结论',
      '## 关键讨论',
      '## 决策与结论',
      '## 待办事项',
      '## 风险与未决问题',
      '',
      '规则：',
      '1. 只写转写里出现过的内容，不编造；不确定的地方标注「待确认」。',
      '2. 保留关键数字、日期、人名、产品名与时间点；不要写空话。',
      '3. 待办事项尽量写清「谁 / 做什么 / 何时」，没有负责人就写「待定」。',
      '4. 这是滚动更新的纪要：如果给了上一版纪要，合并新信息，保留仍然有效的旧结论，不要重复堆砌。',
      `5. 用${language}输出。`,
      final ? '6. 会议已经结束，请给出完整、可归档的最终版纪要。' : '6. 会议仍在进行，请给出简洁的当前版本，后续还会继续更新。'
    ].join('\n');

    const user = [
      agendaText.length > 0 ? `会议日程（姓名/单位/主题参考，不是会议内容）：\n${agendaText}\n` : '',
      currentText.length > 0 ? `当前时间 ${now.clock}，当前日程：${currentText}\n` : '',
      previous.length > 0 ? `上一版纪要：\n${previous}\n` : '',
      final ? '完整转写：' : '到目前为止的转写：',
      transcript
    ].filter(Boolean).join('\n');

    const result = await this.stream({
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: 3000,
      temperature: 0.2,
      purpose: 'meeting-summary',
      reasoningEffort: 'off',
      signal: options.signal
    });
    const markdown = stripCodeFence(result.text);
    if (markdown.length === 0) throw Object.assign(new Error('模型没有返回纪要内容'), { code: 'SUMMARY_EMPTY' });
    return markdown;
  }

  /**
   * Structure a raw agenda with the meeting's model.
   *
   * The local parsers work line by line, so a pasted agenda with odd spacing,
   * merged rows, headers or OCR noise ends up as one big "topic".  This pass
   * hands the same text to the model and asks for the agenda table back as
   * JSON, which keeps names, units and time ranges in separate fields.
   *
   * @param {object} options
   * @param {string} options.text raw agenda text (pasted or extracted/OCR'd)
   * @param {string} [options.filename]
   * @param {string} [options.userName] the user's name, to infer their role
   * @param {number} [options.hintCount] locally parsed entry count, for context
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{ entries: Array<object>, title: string, domain: string, customDomain: string, role: string }>}
   */
  async structureAgenda(options = {}) {
    const text = String(options.text ?? '').trim();
    if (text.length === 0) return { entries: [], title: '', domain: '', customDomain: '', role: '' };
    const hintCount = Number(options.hintCount);
    const userName = String(options.userName ?? '').trim();
    const domainList = Object.entries(DOMAINS)
      .filter(([id]) => id !== 'custom')
      .map(([id, item]) => `${id}（${item.zh}）`)
      .join('、');
    const system = [
      '你是一名会议日程结构化助手。输入可能是从 PDF、PPT、Word、图片识别或直接粘贴的会议日程，排版可能混乱：行被合并、汉字之间有多余空格、时间与姓名粘连、夹着页眉页脚。',
      '请识别这份日程，输出会议主题、会议领域和日程条目。',
      '',
      '规则：',
      '1. 只使用输入里出现的信息；绝不编造姓名、单位、时间或主题。',
      '2. 一行日程输出一个对象，按开始时间从早到晚排序；同一时间段的多个并行环节也各占一个对象。',
      '3. start/end 用 24 小时制 "HH:MM"；原本没写结束时间就留空 ""；整行没有时间时 start 和 end 都留空 "".',
      '4. participants 是该时段的参与人数组 [{name, org}]：name 是人名（去掉「主任/教授/医生」等职务备注），org 是单位或部门；同一时段有多人时全部放进去，绝不要把多个人写进 topic。',
      '5. topic 是该环节的主题或活动名（例如「茶歇」「病例讨论」「开幕致辞」）。不要把姓名或单位重复写进 topic。',
      '6. 丢弃地点、主办方、联系人、页脚和页码等非日程行，但标题和日期要用来判断会议主题。',
      '7. 输入里的姓名、单位、数字、时间必须原样保留，不要翻译、不要改写。',
      `8. domain 必须从以下 id 里选一个最贴近的：${domainList}；都不贴切就选 general。customDomain 只在 domain 为 custom 时填写具体领域名，否则留空。`,
      '9. title 是从日程标题/日期行和内容里概括出的会议主题，一句话，不要编造。',
      userName
        ? `10. role 是「${userName}」在这场会议里的角色，必须从 host（主持人）、speaker（讲者）、panelist（讨论嘉宾）、attendee（参会者）里选一个：日程里写明主持人是「${userName}」就是 host；以「${userName}」名义安排了发言就是 speaker；被安排参加讨论/圆桌就是 panelist；名字出现在嘉宾或参会名单但没写发言就是 attendee；日程完全没提到就留空 ""。`
        : '10. role 留空 ""（没有我的姓名，无法判断角色）。',
      '11. 如果同时给了文档页面截图，请自己判断：只读文字、只看截图，或两者结合，以能准确还原日程为准；截图里的表格、版式和图片中的信息优先于文字提取结果。',
      '12. 输出严格 JSON，不要 markdown 代码块，不要任何解释：',
      '{"title":"糖尿病足多学科协作研讨会","domain":"medical","customDomain":"","role":"host","entries":[{"start":"14:00","end":"14:30","topic":"病例讨论","participants":[{"name":"张医生","org":"市医院"},{"name":"李主任","org":"省医院"}]}]}'
    ].join('\n');
    const images = Array.isArray(options.images) ? options.images.slice(0, 6) : [];
    const user = [
      Number.isFinite(hintCount) && hintCount > 0 ? `（本地逐行解析初步得到 ${hintCount} 条，可能不准确，请以原文为准。）\n` : '',
      images.length > 0 ? `（另附 ${images.length} 张文档页面截图，可自行选择使用文字还是看图。）\n` : '',
      text.slice(0, 16000)
    ].filter(Boolean).join('\n');
    // Let the model decide between text and vision: both go out in one turn,
    // and a text-only model receives the images as omitted placeholders.
    let content = [{ type: 'text', text: user }];
    this.lastVision = { images: images.length, admitted: false, error: null };
    if (images.length > 0) {
      try {
        const attachments = this.ctx.get('attachments');
        if (attachments && typeof attachments.admitPromptContent === 'function') {
          content = await attachments.admitPromptContent(content.concat(images.map((image) => ({
            type: 'image',
            mediaType: image.mediaType,
            data: image.data
          }))));
          this.lastVision = { images: images.length, admitted: true, error: null };
        }
      } catch (error) {
        // Vision is an upgrade; text extraction alone must still work.
        content = [{ type: 'text', text: user }];
        this.lastVision = { images: images.length, admitted: false, error: String(error?.message ?? error) };
      }
    }
    const result = await this.stream({
      system,
      messages: [{ role: 'user', content }],
      maxTokens: 4000,
      temperature: 0,
      purpose: 'meeting-agenda',
      reasoningEffort: 'off',
      signal: options.signal
    });
    const payload = parseJsonPayload(result.text);
    const list = Array.isArray(payload) ? payload
      : Array.isArray(payload?.entries) ? payload.entries
        : Array.isArray(payload?.items) ? payload.items
          : Array.isArray(payload?.agenda) ? payload.agenda
            : [];
    const domain = typeof payload?.domain === 'string' && Object.hasOwn(DOMAINS, payload.domain)
      ? payload.domain
      : '';
    const role = ['host', 'speaker', 'panelist', 'attendee'].includes(payload?.role) ? payload.role : '';
    return {
      entries: entriesFromLlm(list),
      title: typeof payload?.title === 'string' ? payload.title.trim().slice(0, 120) : '',
      domain,
      customDomain: domain === 'custom' && typeof payload?.customDomain === 'string'
        ? payload.customDomain.trim().slice(0, 60)
        : '',
      role
    };
  }

  /**
   * Write one cue card (串词) for the moment the user has to speak.
   *
   * Unlike the speech draft this is generated just in time, so it can use what
   * was actually said in the session that just ended.
   *
   * @param {object} options
   * @param {'opening'|'transition'|'closing'|'thanks'|'manual'} options.kind
   * @param {string} options.role durable profile role id
   * @param {object} [options.entry] the session the cue leads into
   * @param {object} [options.prevEntry]
   * @param {object} [options.nextEntry]
   * @param {Array<object>} options.entries
   * @param {string} [options.userName]
   * @param {string} [options.userOrg]
   * @param {string} [options.topic]
   * @param {string} [options.domain]
   * @param {string} [options.customDomain]
   * @param {string} [options.glossary]
   * @param {string} [options.transcript] recognized content so far
   * @param {string} [options.summary]
   * @param {string} [options.nowClock]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<string>} plain text the user can read out.
   */
  async writeCue(options = {}) {
    const system = buildCueSystemPrompt({
      kind: options.kind,
      role: options.role,
      entry: options.entry,
      prevEntry: options.prevEntry,
      nextEntry: options.nextEntry,
      entries: options.entries,
      userName: options.userName,
      userOrg: options.userOrg,
      topic: options.topic,
      domainLabel: domainLabel(options.domain, 'zh'),
      domainHint: domainHint(options.domain, options.customDomain),
      glossary: options.glossary,
      transcript: options.transcript,
      summary: options.summary,
      nowClock: options.nowClock
    });
    const result = await this.stream({
      system,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: buildCueUserPrompt({ nowClock: options.nowClock, kind: options.kind }) }]
      }],
      maxTokens: 800,
      temperature: 0.4,
      purpose: 'meeting-cue',
      reasoningEffort: 'off',
      signal: options.signal
    });
    const text = stripCodeFence(result.text).trim();
    if (text.length === 0) throw Object.assign(new Error('模型没有返回串词内容'), { code: 'CUE_EMPTY' });
    return text;
  }

  /**
   * Write the draft for the user only: their own speeches plus the transitions
   * they have to say.  Nothing is generated unless the user's name appears in
   * the agenda; the prompt is user-editable, so the draft is Markdown only.
   *
   * @param {object} options
   * @param {Array<object>} options.entries parsed agenda entries
   * @param {string} options.userName durable local profile name
   * @param {string} [options.userOrg]
   * @param {string} [options.title]
   * @param {string} [options.topic]
   * @param {string} [options.domain]
   * @param {string} [options.customDomain]
   * @param {string} [options.glossary]
   * @param {string} [options.prompt] user-edited writing instructions
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<string>} Markdown.
   */
  async writeScripts(options = {}) {
    if (!Array.isArray(options.entries) || options.entries.length === 0) {
      throw Object.assign(new Error('还没有可以生成讲词的会议日程'), { code: 'NO_AGENDA', status: 400 });
    }
    const userName = typeof options.userName === 'string' ? options.userName.trim() : '';
    if (userName.length === 0) {
      throw Object.assign(new Error('请先设置「我的姓名」；只有日程里出现你的名字时才会生成讲词'), {
        code: 'NO_USER_NAME',
        status: 400
      });
    }
    const own = options.entries.filter((entry) => nameMatches(entry?.speaker, userName));
    if (own.length === 0) {
      throw Object.assign(new Error(`日程里没有出现“${userName}”，不生成讲词与串词`), {
        code: 'NO_AGENDA_MATCH',
        status: 400
      });
    }
    const domain = domainLabel(options.domain, 'zh');
    const hint = domainHint(options.domain, options.customDomain);
    const system = buildScriptSystemPrompt({
      entries: options.entries,
      userName,
      userOrg: options.userOrg,
      title: options.title,
      topic: options.topic,
      domainLabel: domain,
      domainHint: hint,
      glossary: options.glossary,
      prompt: options.prompt
    });
    const user = buildScriptUserPrompt(options);
    const result = await this.stream({
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: 5000,
      temperature: 0.35,
      purpose: 'meeting-scripts',
      reasoningEffort: 'low',
      signal: options.signal
    });
    const markdown = stripCodeFence(result.text);
    if (markdown.length < 40) {
      throw Object.assign(new Error('模型没有返回讲词内容'), {
        code: 'SCRIPT_EMPTY',
        preview: result.text.slice(0, 180)
      });
    }
    return markdown;
  }

  /**
   * Search the web through DSH's ctx.web seam.  Missing search capability is a
   * soft failure: the answer still works from the meeting itself.
   * @returns {Promise<{ available: boolean, sources: Array<object>, error?: string }>}
   */
  async search(question, options = {}) {
    let web;
    try {
      web = this.ctx.get('web');
    } catch {
      web = undefined;
    }
    if (!web || typeof web.search !== 'function') {
      return { available: false, sources: [], error: '当前 DSH 没有启用联网搜索' };
    }
    const query = String(question).replace(/^(请问|请帮我|帮我|麻烦)/, '').trim();
    const topic = typeof options.topic === 'string' ? options.topic.trim() : '';
    const finalQuery = topic.length > 0 && query.length < 16 ? `${topic} ${query}` : query;
    try {
      const result = await web.search({ query: finalQuery.slice(0, 400), maxResults: 5 });
      const sources = Array.isArray(result?.sources) ? result.sources.map((source) => ({
        title: String(source?.title ?? source?.url ?? '来源'),
        url: String(source?.url ?? ''),
        snippet: String(source?.snippet ?? source?.text ?? '').slice(0, 1200)
      })).filter((source) => /^https?:\/\//i.test(source.url)) : [];
      return { available: true, sources, answer: typeof result?.answer === 'string' ? result.answer : undefined };
    } catch (error) {
      return { available: true, sources: [], error: safeError(error) };
    }
  }

  /**
   * Answer a participant's question from the meeting and optional web sources.
   * @param {object} options
   * @param {(delta: string) => void} [options.onDelta]
   * @returns {Promise<string>}
   */
  async answer(options) {
    const domain = domainLabel(options.domain, 'zh');
    const hint = domainHint(options.domain, options.customDomain);
    const topic = typeof options.topic === 'string' ? options.topic.trim() : '';
    const summary = typeof options.summary === 'string' ? options.summary.trim() : '';
    const transcript = tailByChars(sourceLines(options.lines, { includeTranslation: true }), 36000);
    const sources = Array.isArray(options.sources) ? options.sources : [];
    const sourceText = sources.map((source, index) => {
      return `[${index + 1}] ${source.title}\nURL: ${source.url}\n摘要: ${source.snippet}`;
    }).join('\n\n');
    const history = Array.isArray(options.history) ? options.history : [];
    const historyText = history.slice(-6).map((item) => `Q: ${item.question}\nA: ${(item.answer ?? '').slice(0, 1200)}`).join('\n\n');
    const language = options.language === 'en' ? 'English' : '简体中文';
    const agendaEntries = Array.isArray(options.agendaEntries) ? options.agendaEntries : [];
    const agendaText = formatAgenda(agendaEntries);
    const now = currentAgenda(agendaEntries, new Date());
    const currentText = now.entry && now.status === 'current' ? formatAgendaEntry(now.entry) : '';

    const system = [
      '你是这场会议的实时助手，正在帮助参会者理解会议内容并做出决策。',
      `会议领域：${domain}${hint ? `（${hint}）` : ''}。`,
      `会议主题：${topic.length > 0 ? topic : '未提供'}。`,
      '',
      '回答规则：',
      '1. 优先依据「会议纪要」和「转写」回答；引用会议内容时给出时间点，格式如 [12:34]。',
      '2. 如果提供了「外部资料」，用它补充会议里没有的事实，并用 [标题](URL) 标注来源；不要编造链接或来源。',
      '3. 会议里没有提到、外部资料也没有的内容，要明确说「会议中尚未提到」或「资料不足」，再给谨慎的一般性建议。',
      '4. 先给结论，再给依据；用要点组织，避免长篇复述。',
      `5. 用${language}回答。`
    ].join('\n');

    const user = [
      agendaText.length > 0 ? `会议日程：\n${agendaText}\n` : '',
      currentText.length > 0 ? `当前时间 ${now.clock}，当前日程：${currentText}\n` : '',
      summary.length > 0 ? `会议纪要：\n${summary}\n` : '',
      transcript.length > 0 ? `转写节选：\n${transcript}\n` : '',
      sourceText.length > 0 ? `外部资料：\n${sourceText}\n` : (options.searchAttempted ? '外部资料：没有检索到可用结果。\n' : ''),
      historyText.length > 0 ? `此前的问答：\n${historyText}\n` : '',
      `问题：${options.question}`
    ].filter(Boolean).join('\n');

    const result = await this.stream({
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: 3000,
      temperature: 0.25,
      purpose: 'meeting-answer',
      reasoningEffort: 'low',
      signal: options.signal,
      onDelta: options.onDelta
    });
    const text = result.text.trim();
    if (text.length === 0) throw Object.assign(new Error('模型没有返回答案'), { code: 'ANSWER_EMPTY' });
    return text;
  }
}

export { domainLabel, parseJsonPayload, sourceLines };
