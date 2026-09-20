// lib/util.mjs — zero-dependency helpers.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Token estimate. Deliberately an approximation: a real tokenizer would be a
 * dependency, and the budget only needs to be right to within ~10%.
 * ~4 characters per token is the standard English heuristic.
 */
export const estimateTokens = (s) => Math.ceil((s ?? '').length / 4);

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));

export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
};

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function readJsonIfExists(p) {
  return exists(p) ? readJson(p) : null;
}

export function readTextIfExists(p) {
  return exists(p) ? fs.readFileSync(p, 'utf8') : null;
}

export function writeJson(p, obj) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

export function writeText(p, text) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, text);
}

export function listDirs(p) {
  if (!exists(p)) return [];
  return fs
    .readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function listFiles(p, ext) {
  if (!exists(p)) return [];
  return fs
    .readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isFile() && (!ext || d.name.endsWith(ext)))
    .map((d) => d.name)
    .sort();
}

export function appendLine(p, line) {
  mkdirp(path.dirname(p));
  fs.appendFileSync(p, line + '\n');
}

export function readLines(p) {
  const t = readTextIfExists(p);
  if (!t) return [];
  return t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Deep merge with an escape hatch.
 *
 * Objects merge recursively. Arrays CONCATENATE by default, because the things
 * that are arrays here — rules, exemplars, banned words — are additive when a
 * profile extends a base.
 *
 * When concatenation is wrong (an ordered list like `structure.beats`), the
 * override file lists the dotted path in its own `_replace` array:
 *   { "_replace": ["structure.beats"], "structure": { "beats": [...] } }
 */
export function deepMerge(base, over, replacePaths = [], prefix = '') {
  if (!isPlain(over)) return over === undefined ? base : over;
  const out = isPlain(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) {
    if (k === '_replace') continue;
    const dotted = prefix ? `${prefix}.${k}` : k;
    const force = replacePaths.includes(dotted);
    if (isPlain(v)) {
      out[k] = deepMerge(out[k] ?? {}, v, replacePaths, dotted);
    } else if (Array.isArray(v)) {
      out[k] = force || !Array.isArray(out[k]) ? [...v] : [...out[k], ...v];
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Fill a stored document from a newer one. Arrays REPLACE.
 *
 * Deliberately not `deepMerge`: that one concatenates arrays, which is right for
 * `extends` — a profile's rules genuinely add to its base's — and wrong here. A
 * bundle is a model's *answer about the brand*, not an overlay, so re-applying an
 * updated bundle through `deepMerge` would grow `values: ["warmth"]` into
 * `["warmth", "warmth"]` on the second run.
 *
 * Objects still merge recursively, which is the whole point: a bundle that only
 * answers part of the schema leaves the rest of the scaffold — including
 * `extends: "_base"` and `version` — untouched. Replacing the file wholesale
 * would silently detach the profile from the base lexicon and channel rules.
 */
export function deepFill(base, incoming) {
  if (!isPlain(incoming)) return incoming === undefined ? base : incoming;
  const out = isPlain(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(incoming)) {
    if (k === '_replace') continue;
    out[k] = isPlain(v) ? deepFill(out[k] ?? {}, v) : v;
  }
  return out;
}

/**
 * Minimal YAML subset for exemplar frontmatter.
 * Supports `key: value`, nested blocks by indentation, and inline `{...}` / `[...]`
 * written in loose YAML (bare keys, single quotes).
 */
function coerce(raw) {
  const t = raw.trim();
  if (t === '' || t === '~' || t === 'null') return t === '' ? '' : null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  if (t.startsWith('[') && t.endsWith(']')) {
    return t
      .slice(1, -1)
      .split(',')
      .map((x) => coerce(x))
      .filter((x) => x !== '');
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    const out = {};
    const inner = t.slice(1, -1);
    let depth = 0;
    let buf = '';
    const parts = [];
    for (const ch of inner) {
      if (ch === '{' || ch === '[') depth++;
      if (ch === '}' || ch === ']') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(buf);
        buf = '';
      } else buf += ch;
    }
    if (buf.trim()) parts.push(buf);
    for (const p of parts) {
      const i = p.indexOf(':');
      if (i === -1) continue;
      out[p.slice(0, i).trim()] = coerce(p.slice(i + 1));
    }
    return out;
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseYamlLite(text) {
  const out = {};
  const stack = [{ indent: -1, obj: out }];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.search(/\S/);
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    const rest = m[2];
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (rest.trim() === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      parent[key] = coerce(rest);
    }
  }
  return out;
}

/** Split `---` frontmatter from a Markdown body. */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text ?? '');
  if (!m) return { data: {}, body: (text ?? '').trim() };
  return { data: parseYamlLite(m[1]), body: m[2].trim() };
}

export function serializeFrontmatter(data, body) {
  const lines = Object.entries(data).map(([k, v]) => {
    if (v !== null && typeof v === 'object') return `${k}: ${JSON.stringify(v)}`;
    return `${k}: ${v}`;
  });
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`;
}
