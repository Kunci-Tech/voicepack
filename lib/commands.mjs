// lib/commands.mjs — init, teach, diff, merge, list, history, rollback.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  exists,
  mkdirp,
  writeJson,
  writeText,
  readJsonIfExists,
  readLines,
  appendLine,
  listDirs,
  listFiles,
} from './util.mjs';
import { loadProfile, listProfiles, profileDir, profilesRoot, baseProfileDir } from './store.mjs';
import { applyCandidate, listCandidates } from './ingest.mjs';

// ---------------------------------------------------------------- init

const BASE_VOICE = {
  signature: {
    person: 'first-plural',
    formality: 0.4,
    warmth: 0.7,
    playfulness: 0.5,
    humility: 0.6,
    salesPressure: 0.2,
  },
  mechanics: {
    avgSentenceWords: 11,
    maxSentenceWords: 24,
    maxLinesPerParagraph: 3,
    openingMove: 'a concrete detail, never a claim',
    closingMove: 'an invitation, never a hard CTA',
  },
  moves: [],
  never: [],
};

// The AI-slop list is the highest-leverage data in the system: most "this
// doesn't sound like us" problems are eight or ten recurring tells. It is
// brand-agnostic, which is why it belongs in _base and why the demo fixture
// carries the same list (the test suite asserts the two stay identical).
//
// Matching is a case-insensitive substring test, so an entry like 'elevate'
// also catches 'elevated'. Entries are grouped by the tell they belong to.
export const BASE_LEXICON = {
  signatureWords: [],
  banned: {
    aiSlop: [
      // The announcement cluster. The single most common way AI prose gives
      // itself away, and it shows up contracted and uncontracted, so both forms
      // are listed. 'thrilled to announce' also covers 'we're thrilled to
      // announce'; the shorter entries cover the same phrase used elsewhere.
      "we're thrilled",
      'we are thrilled',
      "we're excited to announce",
      'we are excited to announce',
      "we're proud to announce",
      'we are proud to announce',
      "we're delighted",
      'we are delighted',
      'thrilled to announce',
      'excited to announce',
      'proud to announce',
      // The vocabulary cluster.
      'delve',
      'elevate',
      'unleash',
      'game-changer',
      'revolutionary',
      'seamless',
      'cutting-edge',
      'must-try',
      // The scenery cluster.
      'nestled in the heart of',
      'look no further',
      'in today\u2019s fast-paced world',
      "in today's fast-paced world",
    ],
    brandSpecific: [],
  },
  punctuation: { emDash: 'avoid', ellipsis: 'rare', exclamationMax: 1 },
};

function baseChannel(name, over = {}) {
  return {
    channel: name,
    version: '0.1.0',
    constraints: {
      maxChars: 2200,
      hookWindowChars: 125,
      hashtags: { min: 0, max: 6, style: 'lowercase-mixed' },
      emojiPerPost: { max: 2, allowed: [] },
    },
    structure: {
      beats: ['hook', 'context', 'substance', 'invitation'],
      lineBreaks: 'double',
      ctaStyle: 'soft-question',
    },
    toneOverrides: {},
    exemplars: [],
    rules: [],
    ...over,
  };
}

const DATA_GITIGNORE = `# Verbatim third-party content. Never commit this to a public repo.
captures/
candidates/
*.raw.json

# Regenerable caches
**/index.json
**/.cache/
`;

const DATA_README = `# Voicepack data

This directory is the **persona store**. It is separate from the Voicepack
engine on purpose: the engine is public and forkable, this is private.

    profiles/
      _base/          inherited by every profile (voice, lexicon, channels)
      <profile>/      brand data, rules, exemplars
    captures/         verbatim page data from the browser bridge (gitignored)
    candidates/       synthesized patterns awaiting your approval (gitignored)
    learnings/        append-only audit log

## Common commands

    npx voicepack doctor
    npx voicepack pack    --profile <p> --channel instagram --intent launch
    npx voicepack check   --profile <p> --channel instagram --file draft.md
    npx voicepack teach   --profile <p> --channel instagram --rule "..." --why "..."
    npx voicepack diff
    npx voicepack lint

## Point the engine here

Any one of:

    npx voicepack pack --dir <this-dir> ...
    export VOICEPACK_DIR=<this-dir>
    echo '{"dir":"<this-dir>"}' > voicepack.config.json

## Version control

    git init && git add -A && git commit -m "voicepack: initial profile"

Then \`voicepack history\` and \`voicepack rollback\` work, and your voice is
reviewable like any other artefact.

## The one rule

Nothing is learned without your approval. \`ingest\` writes a candidate;
\`merge\` applies it. Automated capture, deliberate learning.
`;

export function init({ dataDir, profile = 'default', force = false }) {
  const created = [];
  const w = (rel, obj) => {
    const p = path.join(dataDir, rel);
    if (exists(p) && !force) return;
    writeJson(p, obj);
    created.push(rel);
  };
  const wt = (rel, text) => {
    const p = path.join(dataDir, rel);
    if (exists(p) && !force) return;
    writeText(p, text);
    created.push(rel);
  };

  const b = baseProfileDir(dataDir);
  mkdirp(b);
  w(path.join('profiles', '_base', 'voice.json'), BASE_VOICE);
  w(path.join('profiles', '_base', 'lexicon.json'), BASE_LEXICON);
  w(path.join('profiles', '_base', 'channels', 'instagram.json'), baseChannel('instagram'));
  w(path.join('profiles', '_base', 'channels', 'threads.json'), baseChannel('threads', { constraints: { maxChars: 500, hookWindowChars: 60, hashtags: { min: 0, max: 3, style: 'none' }, emojiPerPost: { max: 1, allowed: [] } } }));
  w(path.join('profiles', '_base', 'channels', 'blog.json'), baseChannel('blog', { constraints: { maxChars: 12000, hookWindowChars: 160, hashtags: { min: 0, max: 0, style: 'none' }, emojiPerPost: { max: 0, allowed: [] } }, structure: { beats: ['scene', 'tension', 'substance', 'close'], lineBreaks: 'paragraphs', ctaStyle: 'none' } }));
  w(path.join('profiles', '_base', 'channels', 'generic.json'), baseChannel('generic'));

  const p = profileDir(dataDir, profile);
  w(path.join('profiles', profile, 'brand.json'), {
    brandId: profile,
    extends: '_base',
    version: '0.1.0',
    identity: { name: profile, category: '', oneLiner: '', founded: '', home: '' },
    audience: { primary: [], secondary: [], whatTheyWant: [] },
    pov: { worldview: '', tensions: [], alwaysChampions: [], neverTakes: [] },
    values: [],
    codeSwitching: { default: 'en', allowEnglish: [], never: [] },
  });
  w(path.join('profiles', profile, 'voice.json'), {
    _replace: [],
    signature: { warmth: 0.8, playfulness: 0.6 },
  });
  w(path.join('profiles', profile, 'lexicon.json'), { _replace: [], signatureWords: [], banned: { brandSpecific: [] } });
  w(path.join('profiles', profile, 'channels', 'instagram.json'), {
    _replace: ['structure.beats'],
    channel: 'instagram',
    version: '0.1.0',
    structure: { beats: ['hook', 'context', 'substance', 'invitation'] },
    exemplars: [],
    rules: [],
  });

  for (const d of ['exemplars/instagram', 'exemplars/threads', 'exemplars/blog']) {
    const dir = path.join(p, d);
    if (!exists(dir)) {
      mkdirp(dir);
      created.push(path.join('profiles', profile, d) + '/');
    }
  }
  for (const d of ['captures', 'candidates', 'learnings', 'history']) {
    const dir = path.join(dataDir, d);
    if (!exists(dir)) {
      mkdirp(dir);
      created.push(d + '/');
    }
  }

  wt('.gitignore', DATA_GITIGNORE);
  wt('README.md', DATA_README);
  wt(path.join('learnings', '.gitkeep'), '');

  return { dataDir, profile, created };
}

// ---------------------------------------------------------------- teach

function nextRuleId(profile, channel) {
  const ch = profile.channels[channel];
  const all = [...(profile.sharedRules ?? []), ...(ch?.rules ?? [])];
  const re = new RegExp(`^vp-${channel}-(\\d+)$`);
  const nums = all.map((r) => re.exec(r.id ?? '')).filter(Boolean).map((m) => Number(m[1]));
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return `vp-${channel}-${String(n).padStart(3, '0')}`;
}

export function teach(profile, { channel, rule, why = '', strength = 'soft', detect = null }) {
  const file = path.join(profile.dir, 'channels', `${channel}.json`);
  const ch = readJsonIfExists(file) ?? { channel, version: '0.1.0' };
  ch.rules = ch.rules ?? [];
  const id = nextRuleId(profile, channel);
  const entry = {
    id,
    text: rule,
    strength,
    why,
    source: { type: 'user-teach', date: new Date().toISOString().slice(0, 10) },
    confidence: 0.9,
  };
  if (detect) entry.detect = detect;
  ch.rules.push(entry);
  writeJson(file, ch);
  appendLine(
    path.join(profile.dataDir, 'learnings', 'log.jsonl'),
    JSON.stringify({ id, ts: new Date().toISOString(), type: 'rule', profile: profile.name, channel, diff: `+ ${rule}`, approvedBy: 'user', status: 'merged' })
  );
  return { id, file, entry };
}

// ---------------------------------------------------------------- diff / merge

export function pending(dataDir) {
  const cands = listCandidates(dataDir).filter((c) => c.status === 'pending');
  return cands;
}

export function merge(profile, id, { as = 'rule', text = null } = {}) {
  const cands = listCandidates(profile.dataDir);
  const cand = cands.find((c) => c.id === id);
  if (!cand) throw new Error(`No pending candidate with id "${id}". Run: voicepack diff`);

  const result = applyCandidate(profile.dataDir, cand, { as, text });

  cand.status = 'merged';
  cand.mergedAs = result.kind;
  cand.mergedAt = new Date().toISOString();
  writeJson(path.join(profile.dataDir, 'candidates', `${cand.id}.json`), cand);

  appendLine(
    path.join(profile.dataDir, 'learnings', 'log.jsonl'),
    JSON.stringify({ id: cand.id, ts: cand.mergedAt, type: 'merge', profile: profile.name, channel: cand.channel, mergedAs: result.kind, target: path.relative(profile.dataDir, result.file), status: 'merged' })
  );
  return { candidate: cand, result };
}

/**
 * Reject a candidate without applying it.
 *
 * The queue needed this the moment it existed. `diff` says "review each", but
 * review only means something if the answer can be no — and without a way to say
 * no, every candidate is either merged (polluting the profile) or left pending
 * forever (cluttering every `context` call). A capture that turned out to be a
 * reply, a repost, or someone else's quote has to be clearable.
 *
 * The record stays on disk with `status: discarded`, so `diff` stops listing it
 * and the learnings log keeps the trail.
 */
export function discard(dataDir, id, { reason = null } = {}) {
  const cands = listCandidates(dataDir);
  const cand = cands.find((c) => c.id === id);
  if (!cand) throw new Error(`No candidate with id "${id}". Run: voicepack diff`);

  cand.status = 'discarded';
  cand.discardedAt = new Date().toISOString();
  if (reason) cand.discardReason = reason;
  writeJson(path.join(dataDir, 'candidates', `${cand.id}.json`), cand);

  appendLine(
    path.join(dataDir, 'learnings', 'log.jsonl'),
    JSON.stringify({
      id: cand.id,
      ts: cand.discardedAt,
      type: 'discard',
      profile: cand.profile,
      channel: cand.channel,
      reason,
      status: 'discarded',
    })
  );
  return cand;
}

// ---------------------------------------------------------------- list

export function listAll(dataDir) {
  const profiles = listProfiles(dataDir);
  const out = [];
  for (const name of profiles) {
    const p = loadProfile(dataDir, name);
    out.push({
      name,
      version: p.version,
      channels: Object.keys(p.channels),
      rules: [...(p.sharedRules ?? []), ...Object.values(p.channels).flatMap((c) => c.rules ?? [])].length,
      exemplars: Object.values(p.channels).reduce((n, c) => n + (c.exemplars ?? []).length, 0),
      brand: p.brand?.identity?.name ?? name,
    });
  }
  return out;
}

// ---------------------------------------------------------------- history

const git = (dataDir, args) => execFileSync('git', ['-C', dataDir, ...args], { encoding: 'utf8' });

export function isRepo(dataDir) {
  return exists(path.join(dataDir, '.git'));
}

export function history(dataDir, limit = 20) {
  if (!isRepo(dataDir)) {
    return { repo: false, log: [], hint: `Not a git repository. Run: git -C "${dataDir}" init && git -C "${dataDir}" add -A && git -C "${dataDir}" commit -m "voicepack: initial"` };
  }
  try {
    const log = git(dataDir, ['log', `-${limit}`, '--pretty=format:%h|%ad|%s', '--date=short']).split('\n').filter(Boolean).map((l) => {
      const [hash, date, ...rest] = l.split('|');
      return { hash, date, subject: rest.join('|') };
    });
    return { repo: true, log };
  } catch (err) {
    return { repo: true, log: [], hint: String(err.message ?? err).split('\n')[0] };
  }
}

export function rollback(dataDir, { to, profile = null, dryRun = false }) {
  if (!isRepo(dataDir)) throw new Error(`Not a git repository: ${dataDir}`);
  const target = profile ? path.join('profiles', profile) : 'profiles';
  if (dryRun) return { target, to };
  execFileSync('git', ['-C', dataDir, 'checkout', to, '--', target], { encoding: 'utf8' });
  return { target, to };
}

export { listDirs, listFiles };
