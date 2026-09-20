// lib/store.mjs — locate the data directory, load a profile, resolve inheritance.
import path from 'node:path';
import os from 'node:os';
import {
  exists,
  readJsonIfExists,
  readTextIfExists,
  listDirs,
  listFiles,
  deepMerge,
  parseFrontmatter,
} from './util.mjs';
import { UsageError } from './render.mjs';

/**
 * Data directory resolution order:
 *   1. --dir <path>          2. VOICEPACK_DIR          3. ./voicepack.config.json          4. ~/.voicepack
 * Returns the source too, so an agent can tell why it resolved where it did.
 */
export function resolveDataDirDetailed(cliDir) {
  if (cliDir) return { dir: path.resolve(cliDir), source: '--dir' };
  if (process.env.VOICEPACK_DIR) return { dir: path.resolve(process.env.VOICEPACK_DIR), source: 'VOICEPACK_DIR' };
  const cfg = readJsonIfExists(path.join(process.cwd(), 'voicepack.config.json'));
  if (cfg && cfg.dir) return { dir: path.resolve(process.cwd(), cfg.dir), source: 'voicepack.config.json' };
  return { dir: path.join(os.homedir(), '.voicepack'), source: 'default' };
}

export function resolveDataDir(cliDir) {
  return resolveDataDirDetailed(cliDir).dir;
}

export const profilesRoot = (dataDir) => path.join(dataDir, 'profiles');
export const profileDir = (dataDir, name) => path.join(profilesRoot(dataDir), name);
export const baseProfileDir = (dataDir) => path.join(profilesRoot(dataDir), '_base');

export function listProfiles(dataDir) {
  return listDirs(profilesRoot(dataDir)).filter((p) => p !== '_base');
}

function mergeFile(b, p, rel) {
  const base = readJsonIfExists(path.join(b, rel)) ?? {};
  const over = readJsonIfExists(path.join(p, rel)) ?? {};
  const replacePaths = Array.isArray(over._replace) ? over._replace : [];
  return deepMerge(base, over, replacePaths);
}

export function loadProfile(dataDir, name) {
  const b = baseProfileDir(dataDir);
  const p = profileDir(dataDir, name);

  if (!exists(p)) {
    const avail = listProfiles(dataDir);
    throw new Error(
      `Profile "${name}" not found at ${p}\n` +
        (avail.length
          ? `Available profiles: ${avail.join(', ')}`
          : `No profiles yet. Run: voicepack init --dir ${dataDir}`)
    );
  }

  const brand = readJsonIfExists(path.join(p, 'brand.json')) ?? { brandId: name, identity: { name } };
  const voice = mergeFile(b, p, 'voice.json');
  const lexicon = mergeFile(b, p, 'lexicon.json');

  const chNames = [
    ...new Set([
      ...listFiles(path.join(b, 'channels'), '.json').map((f) => f.replace(/\.json$/, '')),
      ...listFiles(path.join(p, 'channels'), '.json').map((f) => f.replace(/\.json$/, '')),
    ]),
  ].sort();

  const channels = {};
  for (const ch of chNames) {
    const merged = mergeFile(b, p, path.join('channels', `${ch}.json`));
    merged.channel = ch;
    channels[ch] = merged;
  }

  const sharedRules = [
    ...(readJsonIfExists(path.join(b, 'rules.json'))?.rules ?? []),
    ...(readJsonIfExists(path.join(p, 'rules.json'))?.rules ?? []),
  ];

  return {
    name,
    dir: p,
    baseDir: b,
    dataDir,
    brand,
    voice,
    lexicon,
    channels,
    sharedRules,
    version: brand.version ?? '0.0.0',
  };
}

export function requireChannel(profile, channel) {
  const def = profile.channels[channel];
  if (!def) {
    const avail = Object.keys(profile.channels);
    throw new UsageError(
      `Channel "${channel}" is not defined for profile "${profile.name}". ` +
        (avail.length ? `Available: ${avail.join(', ')}` : 'No channels defined.'),
      avail.length
        ? `pass -c <channel> with one of: ${avail.join(', ')}`
        : `add profiles/${profile.name}/channels/<channel>.json`
    );
  }
  return def;
}

/** Shared rules first, then channel-scoped rules. */
export function channelRules(profile, channel) {
  const def = requireChannel(profile, channel);
  return [...profile.sharedRules, ...(def.rules ?? [])];
}

/** Load and parse every exemplar referenced by a channel. */
export function loadExemplars(profile, channel) {
  const def = requireChannel(profile, channel);
  const out = [];
  for (const rel of def.exemplars ?? []) {
    const candidates = [path.join(profile.dir, rel), path.join(profile.baseDir, rel)];
    const found = candidates.find((p) => exists(p));
    if (!found) {
      // `rel` as well as `path`: callers report `ex.rel`, and without it the
      // error reads "references a missing exemplar file: undefined" — useless
      // at exactly the moment it matters most.
      out.push({ id: rel, missing: true, path: rel, rel, text: '', data: {} });
      continue;
    }
    const { data, body } = parseFrontmatter(readTextIfExists(found));
    out.push({ id: data.id ?? path.basename(found, '.md'), path: found, rel, data, text: body, missing: false });
  }
  return out;
}

export function brandName(profile) {
  return profile.brand?.identity?.name ?? profile.brand?.brandId ?? profile.name;
}

/**
 * The effective banned-word list: base `aiSlop` plus the profile's
 * `brandSpecific`, deduplicated, first spelling wins, order preserved.
 *
 * The two lists overlap by construction. `_base` ships a generic list of AI tells
 * and a profile adds the words that are wrong for it specifically — so a brand
 * that bans "elevate" or "nestled in the heart of" is banning something the base
 * already has. `deepMerge` concatenates arrays, so the union contains exact
 * duplicates, and anything that prints it prints them twice: the pack spent budget
 * restating a rule, and `check` reported the same word twice in one violation.
 *
 * One function because it was two, in two files, with the same bug in both.
 */
export function effectiveBanned(lexicon) {
  const seen = new Set();
  const out = [];
  for (const w of [...(lexicon?.banned?.aiSlop ?? []), ...(lexicon?.banned?.brandSpecific ?? [])]) {
    const key = String(w).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/**
 * Drop entries another entry already covers, longest first, original spelling kept.
 *
 * The base list deliberately holds overlapping forms — "thrilled to announce"
 * and "we're thrilled to announce" are separate entries because each catches
 * phrasing the other misses. When both match the same draft, reporting both is
 * noise: the writer needs the words to delete, not the pattern count.
 *
 * Safe because it only ever runs over the *matched* set. A longer entry can only
 * subsume a shorter one if the longer one matched, which means the draft contains
 * the longer string, which by definition contains the shorter one — so the shorter
 * entry names nothing the longer one does not already name.
 *
 * The reported word keeps its spelling from the store: lowercasing it here would
 * hide whether the ban was written "Elevate" or "elevate", which is the one thing
 * a writer checking the list wants to see. The result is returned in store order,
 * not length order, so `check` names the same words in the same sequence as the
 * pack's NEVER USE line — one list, one order, wherever it surfaces.
 */
export function dropSubsumed(words) {
  const longestFirst = [...words].sort((a, b) => String(b).length - String(a).length);
  const kept = [];
  const keptRaw = new Set();
  for (const w of longestFirst) {
    const raw = String(w);
    const lower = raw.toLowerCase();
    if (kept.some((k) => k.includes(lower))) continue;
    kept.push(lower);
    keptRaw.add(raw);
  }
  return words.map(String).filter((w) => keptRaw.has(w));
}
