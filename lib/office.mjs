// Agenda extraction for office documents and PDFs.
//
// Text-bearing OOXML/ODF files are read directly (fast and exact).  Legacy
// binary Office files and PDFs are rendered to PNG pages by the LibreOffice
// engine that ships with DSH, then the local Windows OCR helper reads each
// page.  Images use the same OCR path.  Nothing is uploaded.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ocrImage } from './native.mjs';

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'text']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'gif']);
const OOXML_EXTENSIONS = new Set(['docx', 'pptx', 'odt', 'odp']);
const RENDER_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'ods', 'odt', 'odp']);

function extensionOf(filename) {
  return String(filename || '').toLowerCase().replace(/^.*\./, '').replace(/[^a-z0-9]/g, '');
}

function xmlText(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Find and inflate one entry from a ZIP archive (DOCX/PPTX/ODF are ZIPs). */
export function readZipEntry(buffer, wanted) {
  const eocd = (() => {
    const start = Math.max(0, buffer.length - 65557);
    for (let index = buffer.length - 22; index >= start; index -= 1) {
      if (buffer.readUInt32LE(index) === 0x06054b50) return index;
    }
    return -1;
  })();
  if (eocd < 0) throw new Error('not a ZIP archive');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`unsupported ZIP compression ${method}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return undefined;
}

/** Extract exact text from DOCX, PPTX, ODT or ODP without rendering. */
export function extractOfficeText(buffer, filename) {
  const extension = extensionOf(filename);
  try {
    if (extension === 'docx') {
      const xml = readZipEntry(buffer, 'word/document.xml')?.toString('utf8');
      if (!xml) return '';
      const text = xml
        .replace(/<w:tab[^>]*\/>/g, '\t')
        .replace(/<w:br[^>]*\/>/g, '\n')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, '$1')
        .replace(/<[^>]+>/g, '');
      return xmlText(text).replace(/\n{3,}/g, '\n\n').trim();
    }
    if (extension === 'pptx') {
      const slides = [];
      for (let index = 1; index <= 200; index += 1) {
        const name = `ppt/slides/slide${index}.xml`;
        const xml = readZipEntry(buffer, name)?.toString('utf8');
        if (!xml) continue;
        const text = xml
          .replace(/<a:br[^>]*\/>/g, '\n')
          .replace(/<\/a:p>/g, '\n')
          .replace(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g, '$1')
          .replace(/<[^>]+>/g, '');
        const cleaned = xmlText(text).trim();
        if (cleaned.length > 0) slides.push(cleaned);
      }
      return slides.join('\n\n').trim();
    }
    if (extension === 'odt' || extension === 'odp') {
      const xml = readZipEntry(buffer, 'content.xml')?.toString('utf8');
      if (!xml) return '';
      const text = xml
        .replace(/<text:tab[^>]*\/>/g, '\t')
        .replace(/<text:line-break[^>]*\/>/g, '\n')
        .replace(/<\/text:p>/g, '\n')
        .replace(/<\/text:h>/g, '\n')
        .replace(/<[^>]+>/g, '');
      return xmlText(text).replace(/\n{3,}/g, '\n\n').trim();
    }
  } catch {
    return '';
  }
  return '';
}

async function loadOfficeKit() {
  const candidates = [];
  if (typeof process.resourcesPath === 'string') {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'index.js'));
  }
  if (typeof process.env.DSH_APP_ASAR === 'string') {
    candidates.push(path.join(process.env.DSH_APP_ASAR, '..', 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'index.js'));
  }
  candidates.push('E:\\DeepSeek\\dsh\\resources\\app.asar.unpacked\\dsh\\node_modules\\@deepseek-ai\\libreoffice-kit\\lib\\index.js');
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return await import(pathToFileURL(candidate).href);
    } catch {
      // try the next location
    }
  }
  throw Object.assign(new Error('找不到 DSH 自带的 LibreOffice 转换引擎，无法读取 PDF/PPT/Word'), {
    code: 'OFFICE_ENGINE_MISSING'
  });
}

/**
 * Render a PDF or legacy Office document to PNG pages, then OCR each page.
 * @returns {Promise<string>} recognized text, pages joined by blank lines.
 */
export async function ocrRenderedDocument(file, dataRoot, options = {}) {
  const kit = await loadOfficeKit();
  const outputDir = path.join(dataRoot, '.tmp', `office-${randomUUID()}`);
  await fsp.mkdir(path.dirname(outputDir), { recursive: true });
  let converter;
  try {
    converter = await kit.createConverter({ timeoutMs: 120000 });
    const extension = extensionOf(file);
    const spreadsheet = ['xls', 'xlsx', 'ods'].includes(extension);
    const request = {
      inputPath: path.resolve(file),
      outputDir,
      dpi: options.dpi ?? 200,
      maxPages: options.maxPages ?? 12
    };
    if (!spreadsheet) request.pages = 'all';
    const result = await converter.renderImages(request);
    const images = Array.isArray(result.images) ? result.images : [];
    const pages = [];
    for (const image of images) {
      try {
        const text = await ocrImage(image.path, dataRoot);
        if (typeof text === 'string' && text.trim().length > 0) pages.push(text.trim());
      } catch {
        // one unreadable page should not discard the rest
      }
    }
    return pages.join('\n\n').trim();
  } finally {
    try {
      await converter?.dispose();
    } catch {
      // ignore
    }
    await fsp.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Extract agenda text from an uploaded file.
 * @param {Buffer} buffer file bytes.
 * @param {string} filename original filename.
 * @param {string} dataRoot writable meeting data directory.
 * @returns {Promise<{ text: string, kind: 'text'|'image'|'office'|'pdf' }>}
 */
export async function extractAgendaText(buffer, filename, dataRoot) {
  const extension = extensionOf(filename);
  if (TEXT_EXTENSIONS.has(extension)) {
    return { text: buffer.toString('utf8'), kind: 'text', ocr: false };
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return { text: '', kind: 'image', ocr: true };
  }

  const direct = OOXML_EXTENSIONS.has(extension) ? extractOfficeText(buffer, filename) : '';
  if (direct.length >= 20) return { text: direct, kind: 'office', ocr: false };

  if (RENDER_EXTENSIONS.has(extension)) {
    const tempDir = path.join(dataRoot, '.tmp');
    await fsp.mkdir(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `agenda-${randomUUID()}.${extension || 'bin'}`);
    try {
      await fsp.writeFile(tempFile, buffer);
      const text = await ocrRenderedDocument(tempFile, dataRoot, { maxPages: 12 });
      if (text.length > 0) {
        return { text, kind: extension === 'pdf' ? 'pdf' : 'office', ocr: true };
      }
    } finally {
      await fsp.rm(tempFile, { force: true }).catch(() => {});
    }
  }
  throw Object.assign(new Error(`暂不支持这个文件格式：${extension || '未知'}。支持 PDF / Word / PPT / Excel / 图片 / txt / md / csv / json。`), {
    code: 'AGENDA_FORMAT_UNSUPPORTED',
    status: 415
  });
}

export { extensionOf, IMAGE_EXTENSIONS, TEXT_EXTENSIONS, OOXML_EXTENSIONS, RENDER_EXTENSIONS };
