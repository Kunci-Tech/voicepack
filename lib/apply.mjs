// lib/apply.mjs — apply a profile bundle to a data directory.
//
// A "bundle" is the single JSON object a model produces when you ask it to
// capture a brand's voice: file paths as keys, file contents as values. This
// turns that one object into a real profile on disk.
//
// Two things make this more than a `cp`:
//
//   1. The bundle is MODEL-GENERATED, so every path in it is untrusted. A key
//      of "../../../../.ssh/authorized_keys" must not write anything anywhere.
//      Paths are validated segment by segment and confined to the profile.
//
//   2. An exemplar is a model of our voice, so it must be our own writing. The
//      provenance rule that `merge` enforces is enforced here too — a bundle is
//      the easiest place in the whole system to smuggle in someone else's post.
//
// And one thing makes it more than an overwrite: JSON files are FILLED, not
// replaced. `init` scaffolds a profile with `extends: "_base"`; a bundle that
// only answers the `identity` questions must not drop it.
import path from 'node:path';
import {
  exists,
  mkdirp,
  writeJson,
  writeText,
  parseFrontmatter,
  readJsonIfExists,
  deepFill,
} from './util.mjs';
import { profileDir } from './store.mjs';
import { UsageError } from './render.mjs';

/** Profile names become directory names, so they must be boring. */
const SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validate a bundle-relative path and return it in POSIX form.
 *
 * Rejects absolute paths, drive letters, and any `..` segment. Without this a
 * model-authored key can escape the profile directory entirely — and the write
 * would look completely normal in the output.
 */
export function safeRelPath(rel) {
  if (typeof rel !== 'string' || !rel.trim()) {
    throw new UsageError('bundle contains a non-string or empty file path', 'every key in "files" must be a relative path string');
  }
  const raw = rel.trim();

  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/.test(raw)) {
    throw new UsageError(`bundle path must be relative: ${raw}`, 'use paths like "brand.json" or "channels/instagram.json"');
  }

  const parts = raw.split(/[\\/]+/);
  for (const seg of parts) {
    if (seg === '..') {
      throw new UsageError(`bundle path escapes the profile: ${raw}`, 'a bundle may only write inside its own profile directory');
    }
    if (seg === '.' || seg === '') {
      throw new UsageError(`bundle path has an empty or "." segment: ${raw}`, 'use a clean relative path');
    }
  }

  return parts.join('/');
}

/** Read the provenance field out of an exemplar's frontmatter. */
function exemplarProvenance(text) {
  const { data } = parseFrontmatter(text);
  return typeof data?.provenance === 'string' ? data.provenance.trim().toLowerCase() : null;
}

/**
 * Write a bundle into `<dataDir>/profiles/<profile>/`.
 *
 * Returns a report rather than throwing for per-file problems, so one bad
 * exemplar does not discard five good files. The caller turns `refused` into a
 * non-zero exit — the import mostly succeeded, but the answer is still no.
 */
export function applyBundle(dataDir, bundle, { force = false, profile = null } = {}) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new UsageError('bundle is not a JSON object', 'the file should contain one object with "profile" and "files" keys');
  }

  const name = profile ?? bundle.profile;
  if (!name || typeof name !== 'string') {
    throw new UsageError('bundle has no "profile" name', 'add a top-level "profile": "yourbrand" to the bundle');
  }
  if (!SAFE_PROFILE.test(name)) {
    throw new UsageError(`invalid profile name: ${name}`, 'use letters, digits, dot, dash or underscore; must not start with punctuation');
  }

  const files = bundle.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new UsageError('bundle has no "files" object', 'put file paths and contents under a top-level "files" key');
  }

  const dir = profileDir(dataDir, name);
  if (!exists(dir)) {
    throw new UsageError(
      `profile "${name}" does not exist in ${dataDir}`,
      `create it first: \`voicepack init --dir ${dataDir} --profile ${name}\``
    );
  }

  const written = [];
  const merged = [];
  const skipped = [];
  const refused = [];

  for (const [key, content] of Object.entries(files)) {
    const rel = safeRelPath(key);
    const target = path.join(dir, rel);

    let payload;
    if (typeof content === 'string') {
      if (rel.endsWith('.json')) {
        // A model may hand back a JSON file as an escaped string. Parse it so
        // the stored file is normalised rather than a stringified string.
        try {
          payload = JSON.parse(content);
        } catch {
          throw new UsageError(`"${rel}" is a string but not valid JSON`, 'the value for a .json path must be an object, or a string that parses to one');
        }
      } else {
        payload = content;
      }
    } else if (content && typeof content === 'object') {
      if (!rel.endsWith('.json')) {
        throw new UsageError(`"${rel}" must be a string but is an object`, 'exemplars are markdown, so their value must be a string');
      }
      payload = content;
    } else {
      throw new UsageError(`"${rel}" has no usable content`, 'each file needs an object (JSON) or a string (markdown)');
    }

    // Provenance guard. Only our own writing may become an exemplar.
    if (rel.startsWith('exemplars/')) {
      if (typeof payload !== 'string') {
        throw new UsageError(`exemplar "${rel}" is not a markdown string`, 'exemplars are .md files with frontmatter');
      }
      const prov = exemplarProvenance(payload);
      if (prov === 'third-party') {
        refused.push(rel);
        continue;
      }
      if (prov !== 'human-written' && prov !== 'human-approved') {
        throw new UsageError(
          `exemplar "${rel}" has provenance "${prov ?? 'missing'}"`,
          'exemplars must be provenance: human-written or human-approved — your own writing only'
        );
      }
    }

    if (exists(target) && !force) {
      skipped.push(rel);
      continue;
    }

    mkdirp(path.dirname(target));

    if (typeof payload === 'string') {
      writeText(target, payload);
      written.push(rel);
      continue;
    }

    // A JSON file that is already there gets FILLED, not replaced. `init`
    // scaffolds a profile, and the bundle is the model answering the parts of
    // that scaffold it knows about — so the keys it does not mention have to
    // survive. Overwriting wholesale would drop `extends: "_base"` and detach
    // the profile from the base lexicon without any visible error.
    const prev = readJsonIfExists(target);
    if (prev && typeof prev === 'object' && !Array.isArray(prev)) {
      writeJson(target, deepFill(prev, payload));
      merged.push(rel);
    } else {
      writeJson(target, payload);
      written.push(rel);
    }
  }

  return {
    profile: name,
    dir,
    written,
    merged,
    skipped,
    refused,
    needsInput: Array.isArray(bundle._needsInput) ? bundle._needsInput : [],
    inferred: Array.isArray(bundle._inferred) ? bundle._inferred : [],
  };
}
