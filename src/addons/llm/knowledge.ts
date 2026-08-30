/**
 * The knowledge base the LLM is allowed to answer from.
 *
 * Sources, in order: every `.md`/`.txt` file under `config/knowledge/`, then
 * `config/knowledge.md`, then whatever inline text sits in `llm_knowledge`.
 * The whole `config/` directory is bind-mounted into the container, so support
 * can edit or drop in exported articles without a rebuild - files are re-read
 * whenever their mtime changes.
 *
 * An exported knowledge base is easily larger than a model's context, so the
 * text is split into sections and only the ones that look related to the
 * question are sent. The scoring is deliberately plain word overlap: no
 * embeddings to host, nothing to re-index when support edits a file.
 */
import fs from 'fs';
import path from 'path';
import cache from '../../cache';
import * as log from 'fancy-log';

const DEFAULT_DIR = './config/knowledge';
const DEFAULT_FILE = './config/knowledge.md';
const READABLE = new Set(['.md', '.txt', '.markdown']);

/** Sections longer than this are split further, so one huge article cannot
 * crowd out everything else. */
const MAX_SECTION_CHARS = 1800;

export interface Section {
  /** Heading trail, e.g. "Тарифы > Продление". */
  title: string;
  text: string;
}

interface Loaded {
  stamp: string;
  sections: Section[];
  totalChars: number;
}

let loaded: Loaded | null = null;

function conf() {
  return cache.config as any;
}

/**
 * Lists knowledge files, newest configuration first.
 *
 * @returns Absolute or relative paths of every readable knowledge file.
 */
function files(): string[] {
  const found: string[] = [];
  const dir = conf().llm_knowledge_dir || DEFAULT_DIR;
  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (READABLE.has(path.extname(entry.name).toLowerCase())) found.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);

  const file = conf().llm_knowledge_file || DEFAULT_FILE;
  if (fs.existsSync(file) && !found.includes(file)) found.push(file);
  return found;
}

/** Files plus their mtimes: the cache key that makes edits take effect. */
function stampOf(paths: string[]): string {
  return paths
    .map((p) => {
      try {
        const s = fs.statSync(p);
        return `${p}:${s.mtimeMs}:${s.size}`;
      } catch {
        return `${p}:missing`;
      }
    })
    .join('|');
}

/**
 * Splits one document into sections on Markdown headings.
 *
 * @param source - Name shown in the section title (the file name).
 * @param text - Document text.
 * @returns Sections in document order.
 */
export function splitSections(source: string, text: string): Section[] {
  const sections: Section[] = [];
  const trail: string[] = [];
  let title = source;
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join('\n').trim();
    buffer = [];
    if (!body) return;
    // Keep sections small enough that a single one cannot eat the budget.
    if (body.length <= MAX_SECTION_CHARS) {
      sections.push({ title, text: body });
      return;
    }
    let chunk: string[] = [];
    let size = 0;
    const flushChunk = () => {
      if (chunk.length) sections.push({ title, text: chunk.join('\n\n') });
      chunk = [];
      size = 0;
    };
    for (const paragraph of body.split(/\n{2,}/)) {
      // An exported article can be one wall of text with no blank lines at all,
      // and a section nothing can ever fit into is a section never sent.
      if (paragraph.length > MAX_SECTION_CHARS) {
        flushChunk();
        for (let at = 0; at < paragraph.length; at += MAX_SECTION_CHARS) {
          sections.push({ title, text: paragraph.slice(at, at + MAX_SECTION_CHARS) });
        }
        continue;
      }
      if (size + paragraph.length > MAX_SECTION_CHARS) flushChunk();
      chunk.push(paragraph);
      size += paragraph.length;
    }
    flushChunk();
  };

  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (!heading) {
      buffer.push(line);
      continue;
    }
    flush();
    const level = heading[1].length;
    trail.length = Math.max(0, level - 1);
    trail[level - 1] = heading[2].trim();
    title = [source, ...trail.filter(Boolean)].join(' > ');
  }
  flush();
  return sections;
}

/**
 * Loads (or re-loads, after an edit) every knowledge section.
 *
 * @returns All sections, plus their combined size.
 */
function load(): Loaded {
  const paths = files();
  const stamp = stampOf(paths);
  if (loaded && loaded.stamp === stamp) return loaded;

  const sections: Section[] = [];
  for (const file of paths) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      sections.push(...splitSections(path.basename(file), text));
    } catch (e) {
      log.error(`llm: could not read knowledge file ${file}:`, e);
    }
  }
  if (!sections.length) {
    const inline = (conf().llm_knowledge || '').toString().trim();
    if (inline) sections.push(...splitSections('knowledge', inline));
  }

  loaded = {
    stamp,
    sections,
    totalChars: sections.reduce((sum, s) => sum + s.text.length + s.title.length, 0),
  };
  if (loaded.sections.length) {
    log.info(`llm: knowledge loaded - ${sections.length} sections, ${loaded.totalChars} chars`);
  }
  return loaded;
}

/** Words worth matching on: 4+ characters, cut to a crude Russian stem. */
function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []).map((w) => w.slice(0, 6));
}

/**
 * Picks the sections most related to a question, within a character budget.
 *
 * @param question - The customer's message.
 * @param budgetChars - Maximum size of the returned text.
 * @returns Knowledge text to put in the prompt (empty when there is none).
 */
export function relevant(question: string, budgetChars = 12000): string {
  const { sections, totalChars } = load();
  if (!sections.length) return '';
  const render = (list: Section[]) =>
    list.map((s) => `### ${s.title}\n${s.text}`).join('\n\n');

  if (totalChars <= budgetChars) return render(sections);

  const wanted = new Set(terms(question));
  const scored = sections.map((section, index) => {
    const inTitle = new Set(terms(section.title));
    const inText = new Set(terms(section.text));
    let score = 0;
    for (const term of wanted) {
      // A heading hit is worth more: it is what the section is actually about.
      if (inTitle.has(term)) score += 3;
      else if (inText.has(term)) score += 1;
    }
    return { section, score, index };
  });

  const picked = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const out: Section[] = [];
  let size = 0;
  for (const { section } of picked) {
    const cost = section.text.length + section.title.length + 8;
    if (size + cost > budgetChars) continue;
    out.push(section);
    size += cost;
  }
  // Nothing matched (a one-word "не работает" and a huge base): fall back to the
  // opening sections, which is where the general answers live.
  if (!out.length) {
    for (const section of sections) {
      const cost = section.text.length + section.title.length + 8;
      if (size + cost > budgetChars) break;
      out.push(section);
      size += cost;
    }
  }
  // Every candidate is on its own larger than the budget: send the best one,
  // trimmed, rather than sending no knowledge at all.
  if (!out.length) {
    const best = (picked[0]?.section ?? sections[0]);
    return `### ${best.title}\n${best.text}`.slice(0, budgetChars);
  }
  // Restore document order so the model reads coherent material.
  const order = new Map(sections.map((s, i) => [s, i]));
  out.sort((a, b) => order.get(a) - order.get(b));
  return render(out);
}

/** Drops the cached knowledge. Used by tests. */
export function reset(): void {
  loaded = null;
}

/** Whether any knowledge is configured at all. */
export function isConfigured(): boolean {
  return load().sections.length > 0;
}
