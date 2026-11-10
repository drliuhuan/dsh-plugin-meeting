// Meeting agenda parsing and "who is on now" resolution.
//
// The agenda is a reference, not a transcript: it gives the model and the
// speaker UI the names and organizations that are expected in this meeting, and
// it lets a newly discovered voice cluster start with a plausible label.  All
// of it remains editable; a wrong guess is never treated as identity.

const MAX_ENTRIES = 200;

function clampText(value, limit) {
  return String(value ?? '').slice(0, limit);
}

function parseClock(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 0 && value <= 24) return Math.round(value * 60);
    if (value > 24 && value <= 24 * 60) return Math.round(value);
    return null;
  }
  const text = String(value).trim();
  if (text.length === 0) return null;
  const match = /^(\d{1,2})[:：](\d{2})(?::\d{2})?$/.exec(text);
  if (match) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) return hours * 60 + minutes;
  }
  const iso = /T(\d{2}):(\d{2})/.exec(text);
  if (iso) return Number(iso[1]) * 60 + Number(iso[2]);
  return null;
}

function clockText(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '';
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function splitSpeakerOrg(value) {
  const text = String(value ?? '').trim();
  if (text.length === 0) return { speaker: '', org: '' };
  const bracket = /^([^（(]{1,40})[（(]([^）)]{1,60})[）)]\s*(.*)$/.exec(text);
  if (bracket) return { speaker: bracket[1].trim(), org: bracket[2].trim(), rest: bracket[3].trim() };
  const at = /^([^@]{1,40})@([^\s,，;；]{1,60})\s*(.*)$/.exec(text);
  if (at) return { speaker: at[1].trim(), org: at[2].trim(), rest: at[3].trim() };
  return { speaker: text, org: '', rest: '' };
}

function parseTimeRange(text) {
  const range = /(\d{1,2})[:：](\d{2})\s*(?:-|–|—|~|～|至|到)\s*(\d{1,2})[:：](\d{2})/.exec(text);
  if (range) {
    const start = Number(range[1]) * 60 + Number(range[2]);
    let end = Number(range[3]) * 60 + Number(range[4]);
    if (end <= start) end += 24 * 60;
    return { startMin: start, endMin: end, before: text.slice(0, range.index), after: text.slice(range.index + range[0].length) };
  }
  const single = /(\d{1,2})[:：](\d{2})/.exec(text);
  if (single) {
    const start = Number(single[1]) * 60 + Number(single[2]);
    return {
      startMin: start,
      endMin: start + 30,
      before: text.slice(0, single.index),
      after: text.slice(single.index + single[0].length)
    };
  }
  return { startMin: null, endMin: null, before: '', after: text };
}

function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function fromObject(item) {
  if (item === null || typeof item !== 'object') return null;
  const start = parseClock(item.start ?? item.startTime ?? item.from ?? item.time);
  let end = parseClock(item.end ?? item.endTime ?? item.to);
  if (start !== null && end !== null && end <= start) end += 24 * 60;
  if (start !== null && end === null) end = start + 30;
  const speaker = clampText(item.speaker ?? item.name ?? item.presenter ?? item.who, 60).trim();
  const org = clampText(item.org ?? item.unit ?? item.organization ?? item.company ?? item.department, 80).trim();
  const topic = clampText(item.topic ?? item.title ?? item.subject ?? item.content, 240).trim();
  if (speaker.length === 0 && topic.length === 0 && start === null) return null;
  return { startMin: start, endMin: end, speaker, org, topic, raw: clampText(item.raw, 300) };
}

function fromTextLine(rawLine) {
  let line = rawLine.trim();
  if (line.length === 0) return null;
  if (/^([-*+]|\d+[.)])\s+/.test(line)) line = line.replace(/^([-*+]|\d+[.)])\s+/, '');
  if (line.startsWith('|')) line = line.split('|').map((cell) => cell.trim()).filter(Boolean).join('  ');
  if (/^(#|\/\/)/.test(line)) return null;
  if (/^(会议)?(日程|议程|schedule|agenda)\s*$/i.test(line)) return null;
  if (/^(时间|日程|议程|start|time)/i.test(line) && /(发言人|speaker|单位|org)/i.test(line)) return null;

  const range = parseTimeRange(line);
  let body = range.after.trim();
  // Strip separators left after the time, but keep colon-led speaker syntax.
  body = body.replace(/^[-–—~～|,，:：\s]+/, '');

  let speaker = '';
  let org = '';
  let topic = body;
  const topicOnly = /^(讨论|问答|休息|茶歇|午餐|晚餐|开场|总结|合影|签到|自由交流|闭幕|结束|Q&A)/i.test(body);
  if (topicOnly) {
    speaker = '';
    topic = body;
  } else if (body.includes('|')) {
    const cells = body.split('|').map((cell) => cell.trim()).filter(Boolean);
    if (cells.length >= 3) {
      speaker = cells[0];
      org = cells[1];
      topic = cells.slice(2).join(' ');
    } else if (cells.length === 2) {
      speaker = cells[0];
      topic = cells[1];
    }
  } else {
    const colon = /^([^：:]{1,24})[：:]\s*(.+)$/.exec(body);
    if (colon) {
      const parsed = splitSpeakerOrg(colon[1]);
      speaker = parsed.speaker;
      org = parsed.org;
      topic = [parsed.rest, colon[2]].filter(Boolean).join(' ');
    } else {
      const parsed = splitSpeakerOrg(body);
      if (parsed.rest.length > 0) {
        speaker = parsed.speaker;
        org = parsed.org;
        topic = parsed.rest;
      } else if (body.length <= 30 && /\s/.test(body)) {
        // "张医生 市医院 主题" without brackets.
        const parts = body.split(/\s+/);
        if (parts.length >= 2) {
          speaker = parts[0];
          org = parts[1];
          topic = parts.slice(2).join(' ');
        }
      } else if (body.length > 24) {
        speaker = '';
        topic = body;
      } else {
        speaker = body;
        topic = '';
      }
    }
  }
  if (speaker.length === 0 && topic.length === 0 && range.startMin === null) return null;
  return {
    startMin: range.startMin,
    endMin: range.endMin,
    speaker: clampText(speaker, 60).trim(),
    org: clampText(org, 80).trim(),
    topic: clampText(topic, 240).trim(),
    raw: clampText(rawLine.trim(), 300)
  };
}

function normalizeEntries(entries) {
  const cleaned = entries
    .filter((entry) => entry && (entry.startMin !== null || entry.speaker.length > 0 || entry.topic.length > 0))
    .slice(0, MAX_ENTRIES)
    .map((entry) => ({
      startMin: entry.startMin ?? null,
      endMin: entry.endMin ?? null,
      speaker: clampText(entry.speaker, 60).trim(),
      org: clampText(entry.org, 80).trim(),
      topic: clampText(entry.topic, 240).trim(),
      raw: clampText(entry.raw, 300)
    }));
  cleaned.sort((a, b) => {
    if (a.startMin === null && b.startMin === null) return 0;
    if (a.startMin === null) return 1;
    if (b.startMin === null) return -1;
    return a.startMin - b.startMin;
  });
  for (let index = 0; index < cleaned.length; index += 1) {
    const entry = cleaned[index];
    if (entry.startMin !== null && entry.endMin === null) {
      const next = cleaned[index + 1];
      entry.endMin = next && next.startMin !== null && next.startMin > entry.startMin
        ? next.startMin
        : entry.startMin + 30;
    }
  }
  return cleaned;
}

/**
 * Parse an uploaded/pasted agenda.  Supports JSON arrays, a small CSV shape,
 * Markdown tables, and ordinary lines such as `14:00-14:30 张医生（市医院） 主题`.
 *
 * @param {string} input file text or pasted text.
 * @param {string} [filename]
 * @returns {{ entries: Array<object>, warnings: string[], source: string }}
 */
export function parseAgenda(input, filename = '') {
  const text = clampText(input, 20000).trim();
  const source = String(filename || '').toLowerCase().endsWith('.json') ? 'json'
    : String(filename || '').toLowerCase().endsWith('.csv') ? 'csv'
      : 'text';
  if (text.length === 0) return { entries: [], warnings: ['日程为空'], source };
  const warnings = [];

  if (source === 'json' || text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed?.entries) ? parsed.entries
          : Array.isArray(parsed?.items) ? parsed.items
            : Array.isArray(parsed?.agenda) ? parsed.agenda
              : [];
      const entries = normalizeEntries(list.map(fromObject).filter(Boolean));
      if (entries.length === 0) warnings.push('JSON 里没有识别到日程条目');
      return { entries, warnings, source: 'json' };
    } catch {
      warnings.push('JSON 解析失败，已按文本处理');
    }
  }

  const rawLines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const csvLike = source === 'csv' || (rawLines.length > 1 && rawLines[0].includes(',')
    && /(start|end|speaker|time|开始|结束|发言|时间)/i.test(rawLines[0]));
  if (csvLike) {
    const header = parseCsvLine(rawLines[0]).map((cell) => cell.toLowerCase());
    const indexOf = (...names) => header.findIndex((cell) => names.some((name) => cell.includes(name)));
    const startIndex = indexOf('start', '开始', 'time', '时间');
    const endIndex = indexOf('end', '结束');
    const speakerIndex = indexOf('speaker', '发言', 'name', '姓名', '讲者');
    const orgIndex = indexOf('org', 'unit', '单位', '公司', '部门');
    const topicIndex = indexOf('topic', 'subject', '主题', '内容', 'title');
    const entries = [];
    for (const line of rawLines.slice(1)) {
      const cells = parseCsvLine(line);
      if (cells.length === 0) continue;
      const start = startIndex >= 0 ? parseClock(cells[startIndex]) : null;
      const end = endIndex >= 0 ? parseClock(cells[endIndex]) : null;
      entries.push({
        startMin: start,
        endMin: end,
        speaker: speakerIndex >= 0 ? cells[speakerIndex] ?? '' : '',
        org: orgIndex >= 0 ? cells[orgIndex] ?? '' : '',
        topic: topicIndex >= 0 ? cells[topicIndex] ?? '' : '',
        raw: line
      });
    }
    const normalized = normalizeEntries(entries);
    if (normalized.length === 0) warnings.push('CSV 里没有识别到日程条目');
    return { entries: normalized, warnings, source: 'csv' };
  }

  const entries = [];
  for (const line of rawLines) {
    const entry = fromTextLine(line);
    if (entry) entries.push(entry);
  }
  const normalized = normalizeEntries(entries);
  if (normalized.length === 0) warnings.push('没有识别到日程条目；请使用「时间 姓名（单位） 主题」或 CSV/JSON。');
  return { entries: normalized, warnings, source: 'text' };
}

/**
 * Resolve the agenda item covering the current local time.
 * @returns {{ status: 'current'|'next'|'ended'|'empty', entry: object|null, minutes: number, clock: string }}
 */
export function currentAgenda(entries, now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const timed = Array.isArray(entries) ? entries.filter((entry) => entry.startMin !== null) : [];
  if (timed.length === 0) return { status: 'empty', entry: null, minutes, clock: clockText(minutes) };
  const current = timed.find((entry) => entry.startMin <= minutes && entry.endMin !== null && minutes < entry.endMin);
  if (current) return { status: 'current', entry: current, minutes, clock: clockText(minutes) };
  const next = timed.find((entry) => entry.startMin > minutes);
  if (next) return { status: 'next', entry: next, minutes, clock: clockText(minutes) };
  return { status: 'ended', entry: timed[timed.length - 1], minutes, clock: clockText(minutes) };
}

export function formatAgendaEntry(entry) {
  if (!entry) return '';
  const time = entry.startMin !== null
    ? `${clockText(entry.startMin)}${entry.endMin !== null ? `-${clockText(entry.endMin)}` : ''}`
    : '未定时间';
  const who = [entry.speaker, entry.org ? `（${entry.org}）` : ''].join('');
  return `${time} ${who}${who && entry.topic ? '：' : ''}${entry.topic}`.trim();
}

export function formatAgenda(entries, limit = 30) {
  return (Array.isArray(entries) ? entries : []).slice(0, limit).map(formatAgendaEntry).join('\n');
}

/** Unique agenda speakers, for the "name this cluster" picker. */
export function agendaSpeakers(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry.speaker) continue;
    const key = `${entry.speaker}\u0000${entry.org}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name: entry.speaker, org: entry.org });
  }
  return result;
}

/** A compact name/org reference for correction prompts. */
export function agendaNameReference(entries) {
  const names = agendaSpeakers(entries);
  if (names.length === 0) return '';
  return names.map((item) => (item.org ? `${item.name}（${item.org}）` : item.name)).join('、');
}

/**
 * Clean the spacing and punctuation patterns produced by Windows OCR before
 * handing the text to the line parser.  Windows OCR often returns
 * `1 5 ： 00 一 1 5 ： 20` for a time range and spaces between every Chinese
 * character, and puts several rows on one line.
 */
export function normalizeOcrText(input) {
  let text = String(input ?? '');
  text = text.replace(/(\d)\s+(?=\d)/g, '$1');
  text = text.replace(/(\d)\s*[：:]\s*(\d{2})/g, '$1:$2');
  text = text.replace(/(\d{1,2}:\d{2})\s*[一–—~～至到·．.。]\s*(\d{1,2}:\d{2})/g, '$1-$2');
  text = text.replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1');
  text = text.replace(/\s*([（(）)：:，,。；;、])\s*/g, '$1');
  text = text.replace(/\s*(?<!\d)(?=\d{1,2}:\d{2}\s*[-–—~至·．.。]\s*\d{1,2}:\d{2})/g, '\n');
  // Windows OCR sometimes splits a Chinese character into radicals.
  text = text.replace(/讠寸讠仑/g, '讨论').replace(/讠寸/g, '讨').replace(/讠仑/g, '论');
  text = text.replace(/\n{2,}/g, '\n');
  return text.trim();
}

export { clockText, parseClock, MAX_ENTRIES };

