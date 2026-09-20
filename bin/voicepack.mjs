#!/usr/bin/env node
// bin/voicepack.mjs — CLI entry point. Zero dependencies.
//
// THIS TOOL IS CALLED BY AN AGENT, NOT BY A PERSON AT A KEYBOARD.
//
// Consequences that shape everything below:
//   - Output is a flat stream of `key: value` records ending in `next:`,
//     not a table. Cheaper to read, trivial to parse, no ANSI.
//   - `pack` writes ONLY the pack to stdout. Diagnostics go to stderr, so
//     `voicepack pack > pack.txt` captures the artefact and nothing else.
//   - Every error says what to do next. An agent told what broke but not what
//     to do will guess, and guessing is how you get a confident wrong answer.
//   - Nothing ever blocks on input. Reading stdin requires an explicit --stdin.
//   - Exit codes are meaningful (see EXIT below).
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { report, emit, errorReport, EXIT, UsageError, isUsageError, ReportError, isReportError } from '../lib/render.mjs';
import { resolveDataDirDetailed, loadProfile, listProfiles, requireChannel } from '../lib/store.mjs';
import { buildPack } from '../lib/pack.mjs';
import { checkDraft } from '../lib/check.mjs';
import { doctor } from '../lib/doctor.mjs';
import { lintProfile, privacyScan, engineRoot } from '../lib/lint.mjs';
import { init, teach, pending, merge, listAll, history, rollback, isRepo } from '../lib/commands.mjs';
import { applyBundle } from '../lib/apply.mjs';
import { captureUrl, parseRaw, synthesize, ingestSourceFile, listRecipes } from '../lib/ingest.mjs';
import { readTextIfExists } from '../lib/util.mjs';

const VERSION = '0.1.0';

/** Where the install prompt fetches the engine from, unless --repo overrides it. */
const DEFAULT_REPO = 'https://github.com/Kunci-Tech/voicepack';

const COMMANDS = [
  { name: 'context', group: 'orient', summary: 'one-call orientation: data dir, profiles, channels, pending, capture status' },
  { name: 'install-prompt', group: 'orient', summary: 'print the copy-paste bootstrap prompt for a new agent or machine', options: ['--repo', '--json'] },
  { name: 'profile-prompt', group: 'orient', summary: 'print the brand-intake prompt to paste into a general-purpose model', options: ['--brand', '-p', '--json'] },
  { name: 'doctor', group: 'orient', summary: 'preflight: node version, data directory, browser bridge', options: ['--json'] },
  { name: 'recipes', group: 'orient', summary: 'list the capture recipes', options: ['--json', '--verbose'] },
  { name: 'list', group: 'orient', summary: 'profiles with channel, rule and exemplar counts', options: ['--json'] },

  { name: 'pack', group: 'write', summary: 'compile a token-budgeted voice pack for a channel and intent', options: ['--dir', '-p', '-c', '-i', '--max-tokens', '--json', '--verbose'] },
  { name: 'check', group: 'write', summary: 'deterministic lint of a draft. offline, no model, no API key', options: ['--dir', '-p', '-c', '-f', '--text', '--stdin', '--json', '--quiet'] },

  { name: 'teach', group: 'learn', summary: 'store a rule in plain language', options: ['--dir', '-p', '-c', '--rule', '--why', '--strength', '--json'] },
  { name: 'capture', group: 'learn', summary: 'fetch a URL through the browser bridge into captures/', options: ['--dir', '-p', '-c', '--url', '--recipe', '--json'] },
  { name: 'ingest', group: 'learn', summary: 'parse and synthesize a capture or file into a candidate', options: ['--dir', '-p', '-c', '--url', '--capture', '--source', '--own', '--note', '--recipe', '--json'] },
  { name: 'diff', group: 'learn', summary: 'list candidates awaiting approval', options: ['--dir', '--json'] },
  { name: 'merge', group: 'learn', summary: 'apply a candidate as a rule or an exemplar', options: ['--dir', '-p', '--id', '--as', '--json'] },

  { name: 'init', group: 'maintain', summary: 'scaffold a data directory', options: ['--dir', '-p', '--force', '--json'] },
  { name: 'apply', group: 'maintain', summary: 'write a profile bundle (model-generated JSON) into a profile', options: ['--dir', '-p', '--file', '--force', '--json'] },
  { name: 'lint', group: 'maintain', summary: 'integrity, staleness, contradiction and privacy checks', options: ['--dir', '-p', '--privacy', '--json'] },
  { name: 'history', group: 'maintain', summary: 'git log of the data directory', options: ['--dir', '--json'] },
  { name: 'rollback', group: 'maintain', summary: 'revert profiles/ to an earlier commit', options: ['--dir', '--to', '-p'] },
];

const EXIT_CODES = {
  0: 'ok',
  1: 'ran, but the answer is no (check: not shippable; merge: refused)',
  2: 'you called it wrong (bad flag, unknown command, unknown profile or channel)',
  3: 'environment not ready (doctor found failures)',
};

const OPTIONS = {
  dir: { type: 'string' },
  profile: { type: 'string', short: 'p' },
  channel: { type: 'string', short: 'c' },
  intent: { type: 'string', short: 'i' },
  file: { type: 'string', short: 'f' },
  rule: { type: 'string' },
  why: { type: 'string' },
  strength: { type: 'string' },
  id: { type: 'string' },
  as: { type: 'string' },
  text: { type: 'string' },
  url: { type: 'string' },
  source: { type: 'string' },
  capture: { type: 'string' },
  recipe: { type: 'string' },
  note: { type: 'string' },
  to: { type: 'string' },
  repo: { type: 'string' },
  brand: { type: 'string' },
  'max-tokens': { type: 'string' },
  json: { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
  quiet: { type: 'boolean', default: false },
  own: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  privacy: { type: 'boolean', default: false },
  stdin: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

const write = (s) => process.stdout.write(s + '\n');
const writeErr = (s) => process.stderr.write(s + '\n');

function usageError(message, next, fields = {}) {
  // Throwing (rather than writing + process.exit) keeps every usage error on a
  // single output path, and avoids truncating stderr on a pipe.
  throw new UsageError(message, next, fields);
}

/**
 * A failure that already has a good answer to report — exit 1, not 2.
 * "Your call was fine; the answer is no."
 */
function fail(message, { fields = {}, next = null, code = EXIT.FAILED } = {}) {
  throw new ReportError(errorReport(message, { code, fields, next }).toString(), code);
}

function need(name, values, next) {
  if (values[name] === undefined || values[name] === null || values[name] === '') {
    usageError(`--${name} is required for this command`, next ?? 'run `voicepack --help --json` for the option list');
  }
  return values[name];
}

/** Resolve a profile, or explain the options and stop. */
function pickProfile(dataDir, requested) {
  const available = listProfiles(dataDir);
  if (requested) {
    if (!available.includes(requested)) {
      throw new UsageError(
        `profile "${requested}" not found`,
        `create it with \`voicepack init -p ${requested}\` or pass one of: ${available.join(', ') || '(none)'}`,
        { data: dataDir, available: available.join(', ') || 'none' }
      );
    }
    return requested;
  }
  if (available.length === 1) return available[0];
  if (!available.length) {
    throw new UsageError('no profiles found', `run \`voicepack init --dir ${dataDir}\``, { data: dataDir });
  }
  throw new UsageError(
    '--profile is required when more than one profile exists',
    `pass -p <name>. available: ${available.join(', ')}`,
    { available: available.join(', ') }
  );
}

const HELP = `voicepack ${VERSION} — a portable persona engine for AI agents

Called by an agent, not by a person. Output is a stream of \`key: value\`
records ending in a \`next:\` line. Use --json when you need full structure.

USAGE
  voicepack <command> [options]
  voicepack --help --json        machine-readable command list

ORIENT
  context         one-call orientation. start here.
  install-prompt  copy-paste prompt that makes an agent do the install
  profile-prompt  copy-paste prompt that interviews you and returns a bundle
  doctor          preflight: node, data dir, browser bridge
  recipes         list capture recipes
  list            profiles with counts

WRITE
  pack     compile a token-budgeted voice pack   (stdout = the pack, only)
  check    deterministic lint of a draft         (offline, no model, no key)

LEARN
  teach    store a rule in plain language
  capture  fetch a URL through the browser bridge
  ingest   parse + synthesize a capture into a candidate
  diff     list candidates awaiting approval
  merge    apply a candidate as a rule or an exemplar

MAINTAIN
  init     scaffold a data directory
  apply    write a profile bundle (model-generated JSON) into a profile
  lint     integrity, staleness, contradiction, privacy
  history  git log of the data directory
  rollback revert profiles/ to an earlier commit

COMMON OPTIONS
  --dir <path>   data dir (else $VOICEPACK_DIR, ./voicepack.config.json, ~/.voicepack)
  -p, --profile  profile name          -c, --channel  channel name
  -i, --intent   intent for the pack   --json         full structure
  --repo <url>   engine repo, for install-prompt
  --brand <text> who the brand is, for profile-prompt
  --file <path>  bundle to apply, for apply
  --force        for apply: fill files that already exist instead of skipping them
                 (JSON is merged — existing keys survive, arrays are replaced)
  --quiet        fewer records         --verbose      diagnostics on stderr

EXIT CODES
  0 ok  ·  1 ran but the answer is no  ·  2 you called it wrong  ·  3 environment not ready

TYPICAL LOOP
  voicepack context
  voicepack pack  -p acme -c instagram -i launch
  voicepack check -p acme -c instagram -f draft.md
`;

async function main() {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true, strict: false });
  const cmd = positionals[0];

  if (values.version) return write(VERSION);

  if (!cmd || cmd === 'help' || values.help) {
    if (values.json) {
      return write(
        JSON.stringify(
          {
            name: 'voicepack',
            version: VERSION,
            purpose: 'Compile a token-budgeted voice pack from a JSON persona store, and lint drafts against it.',
            outputFormat: 'flat `key: value` records, terminated by a `next:` line; --json for full structure',
            exitCodes: EXIT_CODES,
            loop: ['context', 'pack', 'draft', 'check', 'judge', 'revise'],
            dataDirResolution: ['--dir', 'VOICEPACK_DIR', './voicepack.config.json', '~/.voicepack'],
            commands: COMMANDS,
          },
          null,
          2
        )
      );
    }
    return write(HELP.trim());
  }

  const { dir: dataDir, source: dirSource } = resolveDataDirDetailed(values.dir);

  switch (cmd) {
    // ------------------------------------------------------------ context
    case 'context': {
      const profiles = listProfiles(dataDir);
      const cands = pending(dataDir);
      const doc = await doctor(dataDir);

      // Counted before either branch, so `--json` and the record stream cannot
      // disagree about which profiles are usable.
      const totals = profiles.map((name) => {
        const p = loadProfile(dataDir, name);
        const rules = (p.sharedRules ?? []).length + Object.values(p.channels).reduce((n, c) => n + (c.rules ?? []).length, 0);
        const exs = Object.values(p.channels).reduce((n, c) => n + (c.exemplars ?? []).length, 0);
        return { name, channels: Object.keys(p.channels), rules, exemplars: exs, empty: rules === 0 && exs === 0 };
      });
      const usable = totals.filter((t) => !t.empty);

      if (values.json) {
        return write(
          JSON.stringify(
            {
              dataDir,
              dataDirSource: dirSource,
              node: process.versions.node,
              profiles,
              profileDetail: totals,
              emptyProfiles: totals.filter((t) => t.empty).map((t) => t.name),
              pending: cands.map((c) => c.id),
              captureReady: doc.captureReady,
              doctor: doc,
            },
            null,
            2
          )
        );
      }

      const r = report();
      r.kv('data', dataDir).kv('dataSource', dirSource).kv('node', process.versions.node);
      r.rows('profile', profiles);
      if (!profiles.length) {
        r.next(`run \`voicepack init --dir ${dataDir}\``);
        return emit(r);
      }

      for (const t of totals) {
        r.kv(`channels.${t.name}`, t.channels);
        r.kv(`rules.${t.name}`, t.rules);
        r.kv(`exemplars.${t.name}`, t.exemplars);
      }
      r.rows('pending', cands.map((c) => `${c.id} ${c.channel} ${c.provenance}`));
      r.kv('capture', doc.captureReady ? 'ready' : 'unavailable');

      // A profile with no rules and no exemplars still packs: it returns the
      // base defaults and the banned-word list, which is a skeleton, not a
      // voice. That pack looks exactly like a working one, so an agent sent
      // straight to `pack` writes generic prose and reports success — the one
      // outcome the whole tool exists to prevent. Say it out loud instead.
      if (!usable.length) {
        r.rows('empty', totals.map((t) => t.name));
        r.raw('note: an empty profile packs into defaults only — no rules, no examples. Fill it before writing.');
        r.next(`voicepack profile-prompt --brand "<one or two lines about the brand>" -p ${totals[0].name}`);
        return emit(r);
      }

      r.raw('loop: pack -> draft -> check -> revise');
      r.next(`voicepack pack -p ${usable[0].name} -c <channel> -i <intent>`);
      return emit(r);
    }

    // ---------------------------------------------------- install-prompt
    // The bootstrap prompt exists so a person never has to open a terminal:
    // they paste one block into their agent and the agent does the install.
    // It lives as a file in the engine tree rather than a string here, so the
    // published prompt and the documented prompt cannot drift apart — the test
    // suite asserts INSTALL.md contains this file verbatim.
    case 'install-prompt': {
      const promptPath = path.join(engineRoot, 'install', 'prompt.txt');
      const raw = readTextIfExists(promptPath);
      if (raw === null) {
        fail(`install prompt is missing from the engine tree: ${promptPath}`, {
          next: 'your checkout is incomplete — re-clone the engine',
        });
      }

      // The file keeps the placeholder so it stays fork-agnostic; the CLI fills
      // it in, so the common case needs no editing at all. Pass --repo to point
      // the prompt at a fork instead.
      const repo = values.repo ?? DEFAULT_REPO;
      const prompt = raw.replaceAll('<ENGINE_REPO_URL>', repo);

      if (values.json) {
        return write(JSON.stringify({ version: VERSION, engine: engineRoot, repo, prompt }, null, 2));
      }

      // stdout is the prompt and nothing else, so it can be piped straight
      // into a clipboard or another agent.
      process.stdout.write(prompt.endsWith('\n') ? prompt : prompt + '\n');
      writeErr(`install-prompt: ${prompt.split('\n').length} lines · engine ${engineRoot}`);
      writeErr(`repo: ${repo}`);
      if (!values.repo) writeErr(`note: pass --repo <url> to point the prompt at your own fork`);
      writeErr('next: paste this into the agent that should perform the install');
      return;
    }

    // ---------------------------------------------------- profile-prompt
    // The intake prompt is what you paste into a general-purpose model to turn
    // an interview into a bundle that `apply` can write. Like install-prompt it
    // lives as a file so the shipped and documented copies cannot drift, and it
    // stays GENERIC — no brand names in the engine tree, ever. The brand brief
    // is injected at run time, so the same prompt works for every profile.
    case 'profile-prompt': {
      const promptPath = path.join(engineRoot, 'install', 'profile-prompt.txt');
      const raw = readTextIfExists(promptPath);
      if (raw === null) {
        fail(`profile prompt is missing from the engine tree: ${promptPath}`, {
          next: 'your checkout is incomplete — re-clone the engine',
        });
      }

      const brand = values.brand ?? null;
      const brief = brand ?? '[ replace this line with who we are: our name, what we do, where we are, and which languages we post in ]';
      const prompt = raw.replaceAll('<BRAND_BRIEF>', brief);
      const profileId = values.profile ?? null;
      const out = profileId ? prompt.replaceAll('<PROFILE_ID>', profileId) : prompt;

      if (values.json) {
        return write(
          JSON.stringify({ version: VERSION, engine: engineRoot, brand, profile: profileId, prompt: out }, null, 2)
        );
      }

      process.stdout.write(out.endsWith('\n') ? out : out + '\n');
      writeErr(`profile-prompt: ${out.split('\n').length} lines · engine ${engineRoot}`);
      if (!brand) writeErr('note: pass --brand "<one or two lines about the brand>" to fill the brief');
      if (!profileId) writeErr('note: pass -p <profile-id> to fill the folder name the bundle will be written to');
      writeErr('next: paste this into the model that will interview you, then save its JSON and run `voicepack apply --file <bundle.json>`');
      return;
    }

    // ------------------------------------------------------------ doctor
    case 'doctor': {
      const res = await doctor(dataDir);
      if (values.json) return write(JSON.stringify(res, null, 2));
      const r = report();
      r.kv('data', res.dataDir);
      for (const c of res.checks) r.kv(`check.${c.status}`, `${c.name} — ${c.detail ?? ''}`);
      r.kv('summary', res.summary);
      r.kv('capture', res.captureReady ? 'ready' : 'unavailable');
      r.rows('hint', res.checks.filter((c) => c.hint).map((c) => `${c.name}: ${c.hint}`));
      if (res.failing) {
        r.next('fix the failures above, then re-run `voicepack doctor`');
        throw new ReportError(r.toString(), EXIT.PREFLIGHT);
      }
      r.next(res.captureReady ? `voicepack pack -p <profile> -c <channel> -i <intent>` : 'every command except `capture` works without the bridge');
      return emit(r);
    }

    // ------------------------------------------------------------ pack
    case 'pack': {
      const profileName = pickProfile(dataDir, values.profile);
      const profile = loadProfile(dataDir, profileName);
      const channel = values.channel ?? (profile.channels.generic ? 'generic' : Object.keys(profile.channels)[0]);
      if (!channel) {
        usageError('no channels defined for this profile', `add profiles/${profileName}/channels/<channel>.json`, { data: dataDir });
      }
      const maxTokens = values['max-tokens'] ? Number(values['max-tokens']) : 700;
      if (!Number.isFinite(maxTokens) || maxTokens < 1) {
        usageError(`--max-tokens must be a positive number`, 'try --max-tokens 700');
      }
      requireChannel(profile, channel);

      const pack = buildPack(profile, { channel, intent: values.intent ?? null, maxTokens });

      if (values.json) return write(JSON.stringify(pack, null, 2));

      // stdout is the artefact and nothing else.
      process.stdout.write(pack.text);

      // A profile with no rules and no exemplars still compiles: the result is
      // the base defaults plus the banned-word list. It is a well-formed pack,
      // which is exactly the problem — nothing about it looks wrong, so an
      // agent writes generic prose from it and reports success. The artefact is
      // still valid and still on stdout, so the exit code stays 0; it is the
      // instruction that has to change.
      const ruleCount =
        (profile.sharedRules ?? []).length + Object.values(profile.channels).reduce((n, c) => n + (c.rules ?? []).length, 0);
      const exCount = Object.values(profile.channels).reduce((n, c) => n + (c.exemplars ?? []).length, 0);
      const voiceless = ruleCount === 0 && exCount === 0;

      if (voiceless) {
        writeErr(`warning: profile "${pack.profile}" has no rules and no exemplars — this pack is defaults only`);
        writeErr('warning: it will produce generic prose. Do not treat a clean `check` on it as on-voice.');
      }
      writeErr(`pack: ${pack.tokens}/${pack.budget} tokens · ${pack.profile}/${pack.channel}${pack.intent ? `/${pack.intent}` : ''}`);
      writeErr(`included: ${pack.included.join(', ')}`);
      if (pack.dropped.length) writeErr(`dropped: ${pack.dropped.join(', ')}`);
      writeErr(
        voiceless
          ? `next: fill the profile first — \`voicepack profile-prompt --brand "<one or two lines about the brand>" -p ${pack.profile}\``
          : `next: write the draft using only this pack, then \`voicepack check -p ${pack.profile} -c ${pack.channel} -f <draft>\``
      );
      return;
    }

    // ------------------------------------------------------------ check
    case 'check': {
      const profileName = pickProfile(dataDir, values.profile);
      const profile = loadProfile(dataDir, profileName);
      const channel = need('channel', values, `pass -c <channel>. available: ${Object.keys(profile.channels).join(', ')}`);
      requireChannel(profile, channel);

      let text;
      if (values.file) {
        text = readTextIfExists(path.resolve(values.file));
        if (text === null) usageError(`file not found: ${values.file}`, 'pass an existing path with -f <file>, or use --text');
      } else if (values.text) {
        text = values.text;
      } else if (values.stdin) {
        text = fs.readFileSync(0, 'utf8');
      } else {
        // Never block waiting on stdin. An agent that forgets a flag should get
        // an error, not a hang.
        usageError('no draft supplied', 'pass -f <file>, --text "...", or --stdin (only with piped input)');
      }

      const res = checkDraft(profile, { channel, text });

      if (values.json) {
        write(JSON.stringify(res, null, 2));
        process.exitCode = res.verdict === 'ship' ? EXIT.OK : EXIT.FAILED;
        return;
      }

      const r = report();
      r.kv('score', res.score).kv('verdict', res.verdict).kv('layer', 'deterministic');
      r.kv('profile', profileName).kv('channel', channel);
      r.kv('hard', res.hardViolations).kv('soft', res.softViolations);
      r.kv('stats', `${res.stats.chars} chars, ${res.stats.words} words, ${res.stats.hashtags} hashtags, ${res.stats.emoji} emoji, longest sentence ${res.stats.maxSentenceWords} words`);

      const shown = values.quiet ? res.violations.slice(0, 3) : res.violations;
      for (const v of shown) {
        r.raw(`violation: ${v.severity === 'hard' ? 'HARD' : 'soft'} ${v.ruleId} | ${v.message}`);
      }
      if (values.quiet && res.violations.length > shown.length) {
        r.kv('violationsHidden', res.violations.length - shown.length);
      }

      if (res.verdict === 'ship') {
        r.next('layer 1 is clean. Now judge register and drift yourself against the pack, then ship.');
      } else {
        const hard = res.violations.filter((v) => v.severity === 'hard');
        r.next(
          hard.length
            ? `fix the ${hard.length} HARD violation(s) first, then re-run check. Do not rewrite what was not flagged.`
            : 'fix the flagged items, then re-run check. Do not rewrite what was not flagged.'
        );
      }
      emit(r);
      process.exitCode = res.verdict === 'ship' ? EXIT.OK : EXIT.FAILED;
      return;
    }

    // ------------------------------------------------------------ teach
    case 'teach': {
      const profileName = pickProfile(dataDir, values.profile);
      const profile = loadProfile(dataDir, profileName);
      const channel = need('channel', values, `pass -c <channel>. available: ${Object.keys(profile.channels).join(', ')}`);
      requireChannel(profile, channel);
      const rule = need('rule', values, 'pass --rule "the rule in plain language"');

      const res = teach(profile, { channel, rule, why: values.why ?? '', strength: values.strength ?? 'soft' });
      if (values.json) return write(JSON.stringify(res, null, 2));

      const r = report();
      r.kv('id', res.id).kv('strength', res.entry.strength).kv('channel', channel);
      r.kv('text', res.entry.text);
      r.kv('file', path.relative(profile.dataDir, res.file));
      r.next(`it takes effect on the next \`voicepack pack -p ${profileName} -c ${channel}\``);
      return emit(r);
    }

    // ------------------------------------------------------------ capture
    case 'capture': {
      const profileName = pickProfile(dataDir, values.profile);
      const channel = need('channel', values, 'pass -c <channel>');
      const url = need('url', values, 'pass --url <url>');
      let file;
      try {
        file = await captureUrl(dataDir, profileName, channel, url, { recipe: values.recipe ?? null });
      } catch (e) {
        fail(`capture failed: ${e.message}`, {
          fields: { capture: 'unavailable', fallback: 'ingest --source <file> with pasted text' },
          next: 'run `voicepack doctor` to see why the bridge is unavailable, or use `voicepack ingest --source <file>` instead',
        });
      }
      if (values.json) return write(JSON.stringify({ file }, null, 2));
      const r = report();
      r.kv('captured', path.relative(dataDir, file));
      r.next(`voicepack ingest --capture "${file}" -p ${profileName} -c ${channel}`);
      return emit(r);
    }

    // ------------------------------------------------------------ ingest
    case 'ingest': {
      const profileName = pickProfile(dataDir, values.profile);
      loadProfile(dataDir, profileName);
      const channel = need('channel', values, 'pass -c <channel>');

      let cand;
      if (values.url) {
        let file;
        try {
          file = await captureUrl(dataDir, profileName, channel, values.url, { recipe: values.recipe ?? null });
        } catch (e) {
          fail(`capture failed: ${e.message}`, {
            fields: { capture: 'unavailable' },
            next: 'use `voicepack ingest --source <file>` with the text pasted directly, or run `voicepack doctor`',
          });
        }
        cand = synthesize(dataDir, parseRaw(file), { profile: profileName, channel, own: Boolean(values.own), note: values.note ?? null });
      } else if (values.capture) {
        cand = synthesize(dataDir, parseRaw(path.resolve(values.capture)), { profile: profileName, channel, own: Boolean(values.own), note: values.note ?? null });
      } else if (values.source) {
        cand = ingestSourceFile(dataDir, path.resolve(values.source), { profile: profileName, channel, own: Boolean(values.own), note: values.note ?? null });
      } else {
        usageError('no input supplied', 'pass --url <url>, --capture <raw.json>, or --source <file>');
      }

      if (values.json) return write(JSON.stringify(cand, null, 2));

      const r = report();
      r.kv('candidate', cand.id).kv('channel', cand.channel).kv('provenance', cand.provenance);
      r.kv('pattern', cand.pattern);
      r.kv('transfer', cand.transfer);
      r.kv('notTransferred', cand.notTransferred);
      r.kv('instances', cand.instances).kv('promotable', cand.promotable);
      r.kv('mayBecomeExemplar', cand.mayBecomeExemplar);
      r.kv('rule', cand.promotionRule);
      if (!cand.mayBecomeExemplar) {
        r.raw('note: third-party content can only ever become a rule about structure, never an exemplar');
      }
      r.next(`voicepack merge --id ${cand.id}${cand.mayBecomeExemplar ? ' --as exemplar' : ''}`);
      return emit(r);
    }

    // ------------------------------------------------------------ diff
    case 'diff': {
      const cands = pending(dataDir);
      if (values.json) return write(JSON.stringify(cands, null, 2));
      const r = report();
      r.kv('pending', cands.length);
      for (const c of cands) {
        r.raw(`candidate: ${c.id} | ${c.channel} | ${c.provenance} | ${c.pattern}`);
      }
      r.next(
        cands.length
          ? `review each, then \`voicepack merge --id <id>\`. one instance is evidence, not a rule.`
          : 'nothing pending. capture something: `voicepack ingest --url <url> -p <profile> -c <channel>`'
      );
      return emit(r);
    }

    // ------------------------------------------------------------ merge
    case 'merge': {
      const profileName = pickProfile(dataDir, values.profile);
      const profile = loadProfile(dataDir, profileName);
      const id = need('id', values, 'run `voicepack diff` to list candidate ids');
      const as = values.as === 'hard' ? 'hard' : values.as === 'exemplar' ? 'exemplar' : 'rule';

      let res;
      try {
        res = merge(profile, id, { as, text: values.text ?? null });
      } catch (e) {
        fail(e.message, {
          next: /third-party/.test(e.message)
            ? `merge it as a rule instead: \`voicepack merge --id ${id}\``
            : 'run `voicepack diff` to see pending candidates',
        });
      }

      if (values.json) return write(JSON.stringify(res, null, 2));
      const r = report();
      r.kv('id', res.candidate.id).kv('mergedAs', res.result.kind);
      r.kv('file', path.relative(dataDir, res.result.file));
      if (res.result.skipped) r.kv('skipped', 'already present');
      r.next('bump `version` in brand.json if this is a release, then commit the data directory');
      return emit(r);
    }

    // ------------------------------------------------------------ lint
    case 'lint': {
      if (values.privacy) {
        const privacy = privacyScan(engineRoot);
        const errors = privacy.filter((i) => i.level === 'error');
        const code = errors.length ? EXIT.FAILED : EXIT.OK;
        if (values.json) {
          write(JSON.stringify({ root: engineRoot, privacy }, null, 2));
          process.exitCode = code;
          return;
        }
        const r = report();
        r.kv('scan', 'privacy').kv('root', engineRoot);
        r.kv('result', errors.length ? 'FAIL' : 'PASS');
        for (const i of privacy) r.raw(`${i.level}: ${i.message}`);
        r.next(errors.length ? 'remove brand data from the engine tree — it belongs in the data directory' : 'safe to push');
        emit(r);
        process.exitCode = code;
        return;
      }

      const profileName = pickProfile(dataDir, values.profile);
      const profile = loadProfile(dataDir, profileName);
      const issues = lintProfile(profile);
      const errors = issues.filter((i) => i.level === 'error');
      const code = errors.length ? EXIT.FAILED : EXIT.OK;

      if (values.json) {
        write(JSON.stringify({ issues, privacy: privacyScan(engineRoot) }, null, 2));
        process.exitCode = code;
        return;
      }

      const r = report();
      r.kv('profile', profileName).kv('version', profile.version);
      r.kv('errors', errors.length).kv('warnings', issues.length - errors.length);
      for (const i of issues) r.raw(`${i.level}: ${i.message}`);
      r.next(errors.length ? 'fix the errors above, then re-run `voicepack lint`' : 'clean');
      emit(r);
      process.exitCode = code;
      return;
    }

    // ------------------------------------------------------------ list
    case 'list':
    case 'profiles': {
      const rows = listAll(dataDir);
      if (values.json) return write(JSON.stringify(rows, null, 2));
      const r = report();
      r.kv('data', dataDir).kv('count', rows.length);
      for (const x of rows) {
        r.raw(`profile: ${x.name} | v${x.version} | ${x.brand} | ${x.channels.length} channels | ${x.rules} rules | ${x.exemplars} exemplars`);
        r.kv(`channels.${x.name}`, x.channels);
      }
      r.next(rows.length ? 'voicepack context' : `voicepack init --dir ${dataDir}`);
      return emit(r);
    }

    // ------------------------------------------------------------ recipes
    case 'recipes': {
      const list = listRecipes();
      if (values.json) return write(JSON.stringify(list, null, 2));
      const r = report();
      r.kv('count', list.length);
      for (const x of list) r.raw(`recipe: ${x.name} | matches ${(x.match ?? []).join(', ')}`);
      if (values.verbose) for (const x of list) if (x.notes) r.raw(`notes.${x.name}: ${x.notes}`);
      r.next('a broken selector is one edit in ingest/recipes/<name>.json, replayed offline over existing captures');
      return emit(r);
    }

    // ------------------------------------------------------------ init
    case 'init': {
      const profile = values.profile ?? 'default';
      const res = init({ dataDir, profile, force: Boolean(values.force) });
      if (values.json) return write(JSON.stringify(res, null, 2));
      const r = report();
      r.kv('scaffolded', res.dataDir).kv('profile', profile).kv('filesCreated', res.created.length);
      r.raw('data directory is separate from the engine on purpose — see README, "The two trees"');
      r.next(`export VOICEPACK_DIR="${res.dataDir}" then \`voicepack context\``);
      return emit(r);
    }

    // ------------------------------------------------------------ apply
    // A bundle is what a model hands back when you ask it to capture a brand's
    // voice: one JSON object, file paths as keys. This turns it into a profile.
    // The bundle is untrusted input, so the path and provenance guards live in
    // lib/apply.mjs rather than being trusted here.
    case 'apply': {
      const file = need('file', values, 'pass --file <bundle.json>');
      const raw = readTextIfExists(path.resolve(file));
      if (raw === null) usageError(`file not found: ${file}`, 'pass an existing path with --file <bundle.json>');

      let bundle;
      try {
        bundle = JSON.parse(raw);
      } catch (e) {
        // Exit 2, like every other malformed-bundle case. The caller handed us
        // something that is not a bundle; that is a usage error, and the agent
        // fixes it by changing what it passed, not by asking a human.
        usageError(
          `bundle is not valid JSON: ${e.message}`,
          'the bundle must be pure JSON — strip any markdown fences or commentary around it'
        );
      }

      const res = applyBundle(dataDir, bundle, {
        force: Boolean(values.force),
        profile: values.profile ?? null,
      });

      if (values.json) return write(JSON.stringify(res, null, 2));

      const r = report();
      r.kv('profile', res.profile).kv('dir', res.dir);
      r.kv('written', res.written.length);
      for (const f of res.written) r.raw(`file: ${f}`);
      if (res.merged.length) {
        r.kv('merged', res.merged.length);
        for (const f of res.merged) r.raw(`file: ${f}`);
        r.kv('mergedNote', 'existing keys kept; the bundle filled the rest');
      }
      if (res.skipped.length) {
        r.rows('skipped', res.skipped);
        r.kv('skippedNote', 'already existed — pass --force to fill them from the bundle');
      }
      if (res.refused.length) {
        r.rows('refused', res.refused);
        r.kv('refusedReason', 'third-party content cannot become an exemplar');
      }
      if (res.needsInput.length) r.rows('needsInput', res.needsInput);
      if (res.inferred.length) r.rows('inferred', res.inferred);

      // Check what we just wrote. An import that leaves the profile invalid is
      // not a success, and the bundle is the cheapest place to fix it.
      const writtenProfile = loadProfile(dataDir, res.profile);
      const issues = lintProfile(writtenProfile);
      const errors = issues.filter((i) => i.level === 'error');
      r.kv('lint.errors', errors.length);
      for (const i of issues) r.raw(`${i.level}: ${i.message}`);

      if (res.refused.length) {
        r.next('drop the third-party posts from the bundle — only your own writing may become an exemplar');
        emit(r);
        process.exitCode = EXIT.FAILED;
        return;
      }
      if (errors.length) {
        r.next('fix the errors above in the bundle, then re-run `voicepack apply`');
        emit(r);
        process.exitCode = EXIT.FAILED;
        return;
      }
      r.next(
        res.needsInput.length
          ? 'the profile is valid but incomplete — fill the needsInput fields, then re-run `voicepack apply --force`'
          : `voicepack pack -p ${res.profile} -c <channel> -i <intent>`
      );
      return emit(r);
    }

    // ------------------------------------------------------------ history
    case 'history': {
      const res = history(dataDir);
      if (values.json) return write(JSON.stringify(res, null, 2));
      const r = report();
      if (!res.repo) {
        r.kv('repo', 'no');
        r.next(`git -C "${dataDir}" init && git -C "${dataDir}" add -A && git -C "${dataDir}" commit -m "voicepack: initial"`);
        return emit(r);
      }
      r.kv('repo', 'yes').kv('commits', res.log.length);
      for (const e of res.log) r.raw(`commit: ${e.hash} ${e.date} ${e.subject}`);
      r.next(res.log.length ? 'voicepack rollback --to <hash>' : 'no commits yet');
      return emit(r);
    }

    // ------------------------------------------------------------ rollback
    case 'rollback': {
      const to = need('to', values, 'run `voicepack history` to list refs');
      if (!isRepo(dataDir)) {
        usageError(`not a git repository: ${dataDir}`, 'initialise one to get history and rollback', { data: dataDir });
      }
      const res = rollback(dataDir, { to, profile: values.profile ?? null });
      if (values.json) return write(JSON.stringify(res, null, 2));
      const r = report();
      r.kv('reverted', res.target).kv('to', res.to);
      r.next('review the working tree, then commit if it looks right');
      return emit(r);
    }

    default:
      usageError(`unknown command "${cmd}"`, 'run `voicepack --help --json` for the command list');
  }
}

main().catch((e) => {
  // A command that produced a full answer AND needs a non-zero exit hands it
  // back already rendered, so we do not rebuild it here.
  if (isReportError(e)) {
    writeErr(e.reportText);
    process.exitCode = e.code;
    return;
  }

  // Exit 2 means "you called it wrong — fix the call and retry".
  // Exit 1 means "the call was fine, the answer is no — do not just retry".
  // An agent that cannot tell these apart learns to retry the wrong things.
  const usage = isUsageError(e);
  const r = errorReport(e?.message ?? String(e), {
    code: usage ? EXIT.USAGE : EXIT.FAILED,
    fields: e?.fields ?? {},
    next: e?.next ?? 'run `voicepack context` to check the environment',
  });
  writeErr(r.toString());

  // Never process.exit() here: it does not flush a pipe, so the caller can be
  // handed a truncated error. Setting exitCode lets Node drain and exit.
  process.exitCode = usage ? EXIT.USAGE : EXIT.FAILED;
});
