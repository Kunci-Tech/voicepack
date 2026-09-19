// lib/ingest.mjs — capture -> parse -> synthesize.
//
// Capture is deliberately dumb: fetch, serialise, save. All interpretation
// happens in `parse` and `synthesize`, which run offline against files already
// on disk. That split means a platform markup change costs one parser fix
// replayed over existing captures — never a re-fetch.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exists,
  mkdirp,
  writeJson,
  writeText,
  readJsonIfExists,
  readTextIfExists,
  listFiles,
  readLines,
  appendLine,
  parseFrontmatter,
} from './util.mjs';
import { stats } from './check.mjs';

const BRIDGE_PORT = Number(process.env.VOICEPACK_BRIDGE_PORT ?? 8766);
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const RECIPES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ingest', 'recipes');

export function listRecipes() {
  return listFiles(RECIPES_DIR, '.json')
    .map((f) => readJsonIfExists(path.join(RECIPES_DIR, f)))
    .filter(Boolean);
}

/** Pick a capture recipe by explicit name, else by hostname, else generic. */
export function pickRecipe(url, explicit = null) {
  const all = listRecipes();
  if (explicit) {
    const r = all.find((x) => x.name === explicit);
    if (!r) throw new Error(`Unknown recipe "${explicit}". Available: ${all.map((x) => x.name).join(', ')}`);
    return r;
  }
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* not a URL — fall through to generic */
  }
  for (const r of all) {
    if (r.name === 'generic') continue;
    if ((r.match ?? []).some((m) => host === m || host.endsWith(`.${m}`))) return r;
  }
  return all.find((r) => r.name === 'generic');
}

async function bridgeCommand(command, params = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE_URL}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, params, agentId: process.env.VOICEPACK_AGENT ?? 'workbuddy' }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`bridge returned non-JSON for "${command}": ${text.slice(0, 200)}`);
    }
    if (body.error) throw new Error(`bridge "${command}" failed: ${body.error}`);
    return body;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`bridge "${command}" timed out`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** The bridge wraps results inconsistently; try the shapes we know. */
function unwrap(body) {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  for (const k of ['result', 'value', 'data', 'output']) {
    if (body[k] !== undefined) return typeof body[k] === 'string' ? body[k] : JSON.stringify(body[k]);
  }
  return JSON.stringify(body);
}

const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled';

export const capturesDir = (dataDir, profile, channel) => path.join(dataDir, 'captures', profile, channel);
export const candidatesDir = (dataDir) => path.join(dataDir, 'candidates');

/** Capture a URL through the browser bridge. Writes verbatim raw JSON. */
export async function captureUrl(dataDir, profile, channel, url, { navigate = true, recipe = null } = {}) {
  const rec = pickRecipe(url, recipe);

  if (navigate) {
    try {
      await bridgeCommand('navigate', { url });
      await new Promise((r) => setTimeout(r, 2500));
    } catch {
      // Navigation may be unsupported; fall back to whatever tab is active.
    }
  }
  const body = await bridgeCommand('eval', { code: rec.eval });
  const text = unwrap(body);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { url, text: String(text ?? '').slice(0, 8000) };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(capturesDir(dataDir, profile, channel), `${stamp}-${slug(parsed.ogTitle || parsed.title || url)}.raw.json`);
  writeJson(file, {
    capturedAt: new Date().toISOString(),
    requestedUrl: url,
    profile,
    channel,
    source: 'browser-bridge',
    recipe: rec.name,
    page: parsed,
  });
  return file;
}

/** Offline: turn a raw capture into a normalized record. No browser involved. */
export function parseRaw(rawPath) {
  const raw = readJsonIfExists(rawPath);
  if (!raw) throw new Error(`Capture not found: ${rawPath}`);
  const page = raw.page ?? {};
  const ogDesc = (page.ogDescription ?? '').trim();
  const mainText = (page.text ?? '').trim();

  // Social platforms put the caption in og:description. Long-form puts it in main.
  const useOg = ogDesc.length >= 40 && ogDesc.length < mainText.length;
  const text = (useOg ? ogDesc : mainText || ogDesc).trim();

  return {
    capturedAt: raw.capturedAt ?? null,
    sourceUrl: page.url ?? raw.requestedUrl ?? null,
    site: page.ogSite ?? null,
    title: page.ogTitle || page.title || null,
    author: page.author || null,
    published: page.published || null,
    text,
    textSource: useOg ? 'og:description' : 'main text',
    platform: raw.channel ?? null,
    source: raw.source ?? 'unknown',
  };
}

/** Measurable structure of a piece of text. Deterministic, no model. */
export function structuralFingerprint(text) {
  const st = stats(text);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? '';
  return {
    firstLineChars: first.length,
    firstLineHasEmoji: /\p{Extended_Pictographic}/u.test(first),
    opensWithNumber: /^\s*[\d$€£]/.test(first) || /\d/.test(first.slice(0, 30)),
    closesWithQuestion: /\?\s*$/.test(text.trim()),
    sentences: st.sentences,
    avgSentenceWords: st.avgSentenceWords,
    maxSentenceWords: st.maxSentenceWords,
    paragraphs: st.paragraphs,
    lines: lines.length,
    hashtags: st.hashtags,
    emoji: st.emoji,
    blankLineSeparated: /\n\s*\n/.test(text),
  };
}

function describePattern(fp) {
  const bits = [];
  bits.push(fp.firstLineChars <= 60 ? `first line short (${fp.firstLineChars} chars)` : `first line ${fp.firstLineChars} chars`);
  bits.push(fp.firstLineHasEmoji ? 'emoji in the hook' : 'no emoji in the hook');
  if (fp.opensWithNumber) bits.push('opens with a concrete number');
  if (fp.closesWithQuestion) bits.push('closes on an open question');
  if (fp.blankLineSeparated) bits.push('blank-line separated beats');
  bits.push(`~${fp.avgSentenceWords} words per sentence`);
  bits.push(`${fp.hashtags} hashtags`);
  return bits.join(', ');
}

function nextId(dataDir) {
  const ids = [];
  const re = /^L-(\d+)$/;
  for (const f of listFiles(candidatesDir(dataDir), '.json')) {
    const m = re.exec(path.basename(f, '.json'));
    if (m) ids.push(Number(m[1]));
  }
  for (const line of readLines(path.join(dataDir, 'profiles', '_learnings.jsonl'))) {
    try {
      const m = re.exec(JSON.parse(line).id ?? '');
      if (m) ids.push(Number(m[1]));
    } catch {
      /* ignore */
    }
  }
  const next = (ids.length ? Math.max(...ids) : 0) + 1;
  return `L-${String(next).padStart(4, '0')}`;
}

/**
 * Synthesize a candidate from parsed content.
 *
 * Extracts a transferable PATTERN, never the text. `own` controls what the
 * candidate may eventually become: your own post can become an exemplar, a
 * third-party post can only ever become a rule about structure.
 */
export function synthesize(dataDir, parsed, { profile, channel, own = false, note = null }) {
  const fp = structuralFingerprint(parsed.text);
  const id = nextId(dataDir);

  const candidate = {
    id,
    ts: new Date().toISOString(),
    type: 'candidate',
    status: 'pending',
    profile,
    channel,
    pattern: note ?? describePattern(fp),
    fingerprint: fp,
    transfer: ['structure', 'rhythm', 'devices', 'register'],
    notTransferred: ['topic', 'specific phrasing', 'author identity'],
    provenance: own ? 'human-written' : 'third-party',
    mayBecomeExemplar: Boolean(own),
    instances: 1,
    promotable: false,
    promotionRule: 'Needs 3 independent instances before it can become a hard rule.',
    evidence: [
      {
        url: parsed.sourceUrl,
        site: parsed.site,
        title: parsed.title,
        author: parsed.author,
        published: parsed.published,
        capturedAt: parsed.capturedAt,
        textSource: parsed.textSource,
        excerptChars: parsed.text.length,
        metrics: null,
      },
    ],
  };

  writeJson(path.join(candidatesDir(dataDir), `${id}.json`), candidate);
  appendLine(
    path.join(dataDir, 'learnings', 'log.jsonl'),
    JSON.stringify({
      id,
      ts: candidate.ts,
      type: 'candidate',
      profile,
      channel,
      provenance: candidate.provenance,
      pattern: candidate.pattern,
      evidence: [parsed.sourceUrl],
      status: 'pending',
    })
  );
  return candidate;
}

/** Manual capture path — always available, never needs a browser. */
export function ingestSourceFile(dataDir, file, { profile, channel, own = false, note = null }) {
  const raw = readTextIfExists(file);
  if (raw === null) throw new Error(`Source file not found: ${file}`);
  const { data, body } = parseFrontmatter(raw);
  const text = (body || raw).trim();
  return synthesize(
    dataDir,
    {
      capturedAt: new Date().toISOString(),
      sourceUrl: data.source ?? null,
      site: data.site ?? null,
      title: data.title ?? null,
      author: data.author ?? null,
      published: data.published ?? null,
      text,
      textSource: 'manual',
      source: 'manual',
    },
    { profile, channel, own, note }
  );
}

/** Promote a candidate: as a soft rule by default, or as an exemplar if own. */
export function applyCandidate(dataDir, candidate, { as = 'rule', text = null }) {
  const profDir = path.join(dataDir, 'profiles', candidate.profile);
  if (as === 'exemplar') {
    if (!candidate.mayBecomeExemplar) {
      throw new Error(
        `Candidate ${candidate.id} is ${candidate.provenance}. Only your own content may become an exemplar.\n` +
          `Third-party posts can only become a rule about structure.`
      );
    }
    const dir = path.join(profDir, 'exemplars', candidate.channel);
    mkdirp(dir);
    const file = path.join(dir, `${candidate.id}-${slug(candidate.pattern)}.md`);
    const fm = [
      '---',
      `id: ${candidate.id}`,
      `channel: ${candidate.channel}`,
      'intent: null',
      `captured: ${candidate.ts.slice(0, 10)}`,
      'provenance: human-written',
      `why: "${(candidate.pattern ?? '').replace(/"/g, "'")}"`,
      '---',
      '',
    ].join('\n');
    writeText(file, fm + (text ?? '') + '\n');
    return { kind: 'exemplar', file };
  }

  const chFile = path.join(profDir, 'channels', `${candidate.channel}.json`);
  const ch = readJsonIfExists(chFile) ?? { channel: candidate.channel, version: '0.1.0' };
  ch.rules = ch.rules ?? [];
  if (ch.rules.some((r) => r.id === candidate.id)) {
    return { kind: 'rule', file: chFile, skipped: true };
  }
  ch.rules.push({
    id: candidate.id,
    text: candidate.pattern,
    strength: as === 'hard' ? 'hard' : 'soft',
    why: `Synthesized from ${candidate.evidence?.[0]?.url ?? 'manual capture'}`,
    source: { type: 'ingest', date: candidate.ts.slice(0, 10), ref: candidate.evidence?.[0]?.url ?? null },
    confidence: 0.4,
    instances: candidate.instances,
  });
  writeJson(chFile, ch);
  return { kind: 'rule', file: chFile };
}

export function listCandidates(dataDir) {
  return listFiles(candidatesDir(dataDir), '.json')
    .map((f) => readJsonIfExists(path.join(candidatesDir(dataDir), f)))
    .filter(Boolean)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export { exists };
