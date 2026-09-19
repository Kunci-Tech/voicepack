// lib/lint.mjs — integrity, staleness, contradiction and privacy checks.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exists, listFiles, readJsonIfExists, readTextIfExists } from './util.mjs';
import { loadExemplars } from './store.mjs';

export const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STALE_DAYS = 90;

export function lintProfile(profile) {
  const issues = [];
  const push = (level, message) => issues.push({ level, message });

  const channelRulesFlat = Object.entries(profile.channels).flatMap(([ch, def]) =>
    (def.rules ?? []).map((r) => ({ ...r, __channel: ch }))
  );
  const allRules = [...profile.sharedRules.map((r) => ({ ...r, __channel: '*' })), ...channelRulesFlat];

  // --- rule integrity ---------------------------------------------------
  const seen = new Map();
  for (const r of allRules) {
    if (!r.id) {
      push('warn', `Rule without an id in channel "${r.__channel}": "${r.text ?? '(no text)'}"`);
      continue;
    }
    if (seen.has(r.id)) {
      push('error', `Duplicate rule id "${r.id}" (in "${seen.get(r.id)}" and "${r.__channel}").`);
    } else {
      seen.set(r.id, r.__channel);
    }
    if (!r.text) push('error', `Rule "${r.id}" has no text.`);
    if (r.strength && !['hard', 'soft'].includes(r.strength)) {
      push('warn', `Rule "${r.id}" has unknown strength "${r.strength}" — expected hard or soft.`);
    }
    if (r.strength === 'hard' && !r.detect && r.detect !== undefined) {
      push('warn', `Rule "${r.id}" is hard but has a malformed detect block.`);
    }
  }

  // --- staleness --------------------------------------------------------
  const cutoff = Date.now() - STALE_DAYS * 86400000;
  for (const r of allRules) {
    const d = r.source?.date;
    if (!d || r.lastUsed) continue;
    const t = Date.parse(d);
    if (!Number.isNaN(t) && t < cutoff) {
      push('warn', `Rule "${r.id}" has gone unused for over ${STALE_DAYS} days — review or delete it.`);
    }
  }

  // --- channels ---------------------------------------------------------
  for (const [ch, def] of Object.entries(profile.channels)) {
    const con = def.constraints ?? {};
    if (con.hashtags) {
      const { min, max } = con.hashtags;
      if (typeof min === 'number' && typeof max === 'number' && min > max) {
        push('error', `Channel "${ch}": hashtags.min (${min}) exceeds hashtags.max (${max}).`);
      }
    }
    if (typeof con.maxChars === 'number' && con.hookWindowChars > con.maxChars) {
      push('error', `Channel "${ch}": hookWindowChars (${con.hookWindowChars}) exceeds maxChars (${con.maxChars}).`);
    }
    if (!def.exemplars?.length) {
      push('warn', `Channel "${ch}" has no exemplars. Rules alone underperform real examples.`);
    }
    for (const ex of loadExemplars(profile, ch)) {
      if (ex.missing) {
        push('error', `Channel "${ch}" references a missing exemplar file: ${ex.rel}`);
        continue;
      }
      if (!ex.text) push('warn', `Exemplar "${ex.id}" has no body text.`);
      const prov = ex.data?.provenance;
      if (prov === 'ai-assisted') {
        push('error', `Exemplar "${ex.id}" is ai-assisted. Only human-written or human-approved text may be an exemplar.`);
      }
      if (!prov) push('warn', `Exemplar "${ex.id}" has no provenance field.`);
      if (!ex.data?.why) push('warn', `Exemplar "${ex.id}" has no "why" note — say what makes it a good example.`);
    }
  }

  // --- voice ------------------------------------------------------------
  const mech = profile.voice?.mechanics ?? {};
  if (mech.avgSentenceWords && mech.maxSentenceWords && mech.avgSentenceWords > mech.maxSentenceWords) {
    push('error', `voice.mechanics: avgSentenceWords (${mech.avgSentenceWords}) exceeds maxSentenceWords (${mech.maxSentenceWords}).`);
  }
  if (!profile.lexicon?.banned?.aiSlop?.length) {
    push('warn', 'lexicon.banned.aiSlop is empty — this list is the highest-leverage artefact in the store.');
  }

  return issues;
}

function walk(dir, out = []) {
  if (!exists(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const PROFILE_SHAPE = ['signatureWords', 'banned', 'aiSlop', 'brandId', 'exemplars'];

/**
 * Privacy scan: the engine tree must never contain brand data.
 * Because data lives out-of-tree, this should always pass — it exists to catch
 * an accidental copy-paste, which is exactly how a leak reaches a public repo.
 */
export function privacyScan(root = engineRoot) {
  const issues = [];
  for (const dir of ['profiles', 'captures', 'candidates', 'persona']) {
    if (exists(path.join(root, dir))) {
      issues.push({ level: 'error', message: `Engine tree contains "${dir}/". Brand data must live outside the repository.` });
    }
  }
  const scanDirs = ['lib', 'bin', 'ingest', 'test'].map((d) => path.join(root, d));
  for (const dir of scanDirs) {
    for (const f of walk(dir)) {
      const rel = path.relative(root, f);

      // Documentation markdown is expected and fine. An EXEMPLAR is not.
      // Distinguish by content, not by extension: exemplars carry frontmatter
      // with provenance / performance / why. Flagging every .md would make this
      // check unusable and train everyone to ignore it.
      if (f.endsWith('.md')) {
        const text = readTextIfExists(f) ?? '';
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
        if (fm && /^\s*(provenance|performance|why)\s*:/m.test(fm[1])) {
          issues.push({ level: 'error', message: `Exemplar inside engine code: ${rel} — exemplars belong in the data directory.` });
        }
      }

      if (f.endsWith('.json')) {
        const j = readJsonIfExists(f);
        if (j && PROFILE_SHAPE.some((k) => k in j)) {
          issues.push({ level: 'error', message: `File looks like profile data: ${rel}` });
        }
      }
    }
  }
  return issues;
}

export function formatIssues(issues) {
  if (!issues.length) return '  no issues';
  const order = { error: 0, warn: 1, info: 2 };
  return issues
    .sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9))
    .map((i) => `  ${i.level.toUpperCase().padEnd(5)} ${i.message}`)
    .join('\n');
}
