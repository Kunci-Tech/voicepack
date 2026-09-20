#!/usr/bin/env node
// test/smoke.mjs — end-to-end checks. No test framework, no dependencies.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DETECT_TYPES } from '../lib/check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'bin', 'voicepack.mjs');
const DEMO = path.join(root, 'examples', 'demo');
const BAD = path.join(root, 'examples', 'draft-bad.md');
const GOOD = path.join(root, 'examples', 'draft-good.md');
const CAPTURED = path.join(root, 'examples', 'captured-post.txt');

let pass = 0;
let fail = 0;

const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  \u001b[32mok\u001b[0m   ${name}`);
  } else {
    fail += 1;
    console.log(`  \u001b[31mFAIL\u001b[0m ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  }
};

// spawnSync, not execFileSync: execFileSync throws on a non-zero exit and
// discards stderr entirely on success. Both streams are part of the contract
// here (stdout is the artefact, stderr carries `next:`), so the harness must
// always hand back both.
function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const json = (args) => JSON.parse(run(args).stdout);

console.log('\nvoicepack smoke test\n');

// ---------------------------------------------------------------- init
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voicepack-'));
const data = path.join(tmp, 'data');

const init = run(['init', '--dir', data, '--profile', 'acme']);
ok('init exits 0', init.code === 0, init.stderr.trim());
ok('init creates _base voice', fs.existsSync(path.join(data, 'profiles', '_base', 'voice.json')));
ok('init creates profile brand', fs.existsSync(path.join(data, 'profiles', 'acme', 'brand.json')));
ok('init creates channels', fs.existsSync(path.join(data, 'profiles', '_base', 'channels', 'instagram.json')));
ok('init writes a data README', fs.existsSync(path.join(data, 'README.md')));
ok('init ignores captures in git', fs.readFileSync(path.join(data, '.gitignore'), 'utf8').includes('captures/'));

// ---------------------------------------------------------------- pack
const pack = json(['pack', '--dir', DEMO, '-p', 'demo', '-c', 'instagram', '-i', 'launch', '--json']);
ok('pack stays inside its budget', pack.tokens <= pack.budget, `${pack.tokens}/${pack.budget}`);
ok('pack includes hard rules', pack.included.includes('hard-rules'));
ok('pack includes exemplars', pack.included.includes('exemplars'));
ok('pack carries a rule id', pack.text.includes('vp-instagram-001'));
ok('pack names the brand', pack.text.includes('HARBOR BAKEHOUSE'));

const tight = json(['pack', '--dir', DEMO, '-p', 'demo', '-c', 'instagram', '--max-tokens', '300', '--json']);
ok('tight pack stays in budget', tight.tokens <= 300, `${tight.tokens}/300`);
ok('tight pack reports drops', tight.dropped.length > 0);

const tiny = json(['pack', '--dir', DEMO, '-p', 'demo', '-c', 'instagram', '--max-tokens', '60', '--json']);
const headingIdx = tiny.text.indexOf('HERE IS THE VOICE');
ok(
  'no dangling exemplar heading',
  headingIdx === -1 || tiny.text.slice(headingIdx).includes('-- exemplar'),
  'heading present with nothing under it'
);
ok('tiny pack still fits', tiny.tokens <= 60, `${tiny.tokens}/60`);

// ---------------------------------------------------------------- check
const bad = json(['check', '--dir', DEMO, '-p', 'demo', '-c', 'instagram', '-f', BAD, '--json']);
ok('bad draft has hard violations', bad.hardViolations > 0);
ok('bad draft is not shippable', bad.verdict !== 'ship', bad.verdict);
ok('bad draft catches banned lexicon', bad.violations.some((v) => v.ruleId === 'lexicon:banned'));
ok('bad draft catches the rule predicate', bad.violations.some((v) => v.ruleId === 'vp-instagram-001'));
ok('bad draft score is capped at 60', bad.score === 60, String(bad.score));

const good = json(['check', '--dir', DEMO, '-p', 'demo', '-c', 'instagram', '-f', GOOD, '--json']);
ok('good draft scores 100', good.score === 100, String(good.score));
ok('good draft ships', good.verdict === 'ship');
ok('good draft has no violations', good.violations.length === 0);

// The announcement cluster is the most common way AI prose gives itself away,
// and it appears contracted and uncontracted. Regression test: a fresh profile
// scored "We are thrilled to announce…" at 100/ship because only the contracted
// form was on the list.
for (const phrase of ["We're thrilled to announce", 'We are thrilled to announce', 'We are excited to announce', 'We are proud to announce']) {
  const hit = json(['check', '--dir', DEMO, '-p', 'demo', '-c', 'instagram', '--text', `${phrase} our new menu.`, '--json']);
  ok(`banned lexicon catches "${phrase}"`, hit.violations.some((v) => v.ruleId === 'lexicon:banned'), `score ${hit.score}`);
}

const nonShip = run(['check', '--dir', DEMO, '-p', 'demo', '-c', 'instagram', '-f', BAD]);
ok('check exits non-zero when not shippable', nonShip.code === 1);

// ---------------------------------------------------------------- lint
const lint = json(['lint', '--dir', DEMO, '-p', 'demo', '--json']);
ok('demo profile lints clean', lint.issues.filter((i) => i.level === 'error').length === 0);

const privacy = json(['lint', '--privacy', '--json']);
ok('engine tree contains no brand data', privacy.privacy.filter((i) => i.level === 'error').length === 0);

// ---------------------------------------------------------------- install prompt
// The bootstrap prompt is the one artefact a person copies by hand, and it is
// documented twice: as the raw file an agent can fetch, and inline in INSTALL.md
// so a human can read it without leaving the page. Two copies drift. So the
// test enforces that they are byte-identical — change one without the other and
// the suite fails.
const promptFile = fs.readFileSync(path.join(root, 'install', 'prompt.txt'), 'utf8').trim();
const installMd = fs.readFileSync(path.join(root, 'INSTALL.md'), 'utf8');
const embedded = /<!-- BEGIN INSTALL PROMPT -->\n([\s\S]*?)\n<!-- END INSTALL PROMPT -->/.exec(installMd);
ok('INSTALL.md carries the install prompt between markers', Boolean(embedded));
ok(
  'INSTALL.md and install/prompt.txt have not drifted',
  embedded && embedded[1].trim() === promptFile,
  embedded ? `md ${embedded[1].trim().length} chars vs file ${promptFile.length}` : 'markers missing'
);

// The file keeps the placeholder so it stays fork-agnostic; the CLI fills it in
// with the canonical repository so the common case needs no hand-editing. Both
// halves matter: a file with a hardcoded URL is wrong for forks, and a CLI that
// emits the raw placeholder pushes a manual step onto the user.
const CANONICAL_REPO = 'https://github.com/Kunci-Tech/voicepack';
ok('the prompt file keeps the repo placeholder (stays fork-agnostic)', promptFile.includes('<ENGINE_REPO_URL>'));

const promptOut = run(['install-prompt']);
ok('install-prompt exits 0', promptOut.code === 0, promptOut.stderr.trim());
ok(
  'install-prompt fills the placeholder with the canonical repo',
  promptOut.stdout.includes(CANONICAL_REPO) && !promptOut.stdout.includes('<ENGINE_REPO_URL>')
);
ok(
  'install-prompt writes the prompt to stdout only',
  promptOut.stdout.trim() === promptFile.replaceAll('<ENGINE_REPO_URL>', CANONICAL_REPO) && !/^next: /m.test(promptOut.stdout)
);
ok('install-prompt puts its note on stderr', /^next: /m.test(promptOut.stderr));
ok('install-prompt notes how to point at a fork', /--repo/.test(promptOut.stderr));

const promptJson = json(['install-prompt', '--repo', 'https://example.test/vp.git', '--json']);
ok('install-prompt --repo substitutes the placeholder', promptJson.prompt.includes('https://example.test/vp.git') && !promptJson.prompt.includes('<ENGINE_REPO_URL>'));

// The intake prompt is the other half of the pair: install-prompt gets the
// engine onto a machine, profile-prompt gets a brand into the engine. It must
// stay GENERIC — this repo is public, and a prompt that names one customer's
// brand is brand data sitting in the engine tree, which is exactly what the
// two-tree rule exists to prevent. The placeholders are the guard: they prove
// the brand-specific text is injected at run time rather than committed.
const profilePromptPath = path.join(root, 'install', 'profile-prompt.txt');
const profilePromptRaw = fs.readFileSync(profilePromptPath, 'utf8');
ok('the intake prompt file is present', fs.existsSync(profilePromptPath));
ok('the intake prompt keeps the brand placeholder (stays generic)', profilePromptRaw.includes('<BRAND_BRIEF>'));
ok('the intake prompt keeps the profile-id placeholder', profilePromptRaw.includes('<PROFILE_ID>'));

const intake = run(['profile-prompt']);
ok('profile-prompt exits 0', intake.code === 0, intake.stderr.trim());
ok('profile-prompt writes the prompt to stdout only', intake.stdout.includes('NEVER INVENT') && !/^next: /m.test(intake.stdout));
ok('profile-prompt puts its note on stderr', /^next: /m.test(intake.stderr));
ok('profile-prompt leaves no bare placeholder behind', !intake.stdout.includes('<BRAND_BRIEF>'));

const intakeFilled = run(['profile-prompt', '--brand', 'Acme Bakehouse, a test brand.', '-p', 'acme']);
ok(
  'profile-prompt --brand fills the brief',
  intakeFilled.stdout.includes('Acme Bakehouse, a test brand.') && !intakeFilled.stdout.includes('[ replace this line')
);
ok('profile-prompt -p fills the profile id', !intakeFilled.stdout.includes('<PROFILE_ID>') && intakeFilled.stdout.includes('"acme"'));

const intakeJson = json(['profile-prompt', '--brand', 'X', '-p', 'acme', '--json']);
ok('profile-prompt --json returns the prompt', intakeJson.prompt.includes('Acme') || intakeJson.prompt.includes('X'));
ok('profile-prompt --json reports the brand it used', intakeJson.brand === 'X' && intakeJson.profile === 'acme');

// ---------------------------------------------------------------- packaging
// `install-prompt` reads install/prompt.txt from the engine tree at runtime. If
// the file is not in package.json `files`, the command works from a git clone
// and breaks for everyone who installed from npm — the worst kind of bug, since
// it is invisible to whoever wrote it.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
ok('package.json ships install/ (install-prompt depends on it)', pkg.files.includes('install'));
ok('the install prompt file is present', fs.existsSync(path.join(root, 'install', 'prompt.txt')));
ok('package.json ships INSTALL.md', pkg.files.includes('INSTALL.md'));

// The zero-dependency promise is load-bearing: it is why this works on any
// machine with Node and nothing else. Enforce it rather than trusting it.
ok('package.json declares no dependencies', !('dependencies' in pkg) && !('devDependencies' in pkg));

// Scripts are documentation that runs. A stale fixture path in package.json is a
// broken promise to every contributor who types `npm run pack`.
ok('the demo fixture the scripts reference exists', fs.existsSync(DEMO) && fs.existsSync(path.join(DEMO, 'profiles', 'demo', 'brand.json')));
ok('the check script target exists', fs.existsSync(path.join(DEMO, 'profiles', 'demo', 'exemplars', 'instagram', '2026-08-14-five-thousand-loaves.md')));

// The AI-slop list is brand-agnostic, so the demo fixture's _base and the list
// `init` scaffolds must be the same list. They were duplicated and had already
// drifted by twelve entries before anyone noticed, which is exactly the failure
// mode: a curated fixture that quietly stops matching what users actually get.
const { BASE_LEXICON } = await import('../lib/commands.mjs');
const fixtureLexicon = JSON.parse(fs.readFileSync(path.join(DEMO, 'profiles', '_base', 'lexicon.json'), 'utf8'));
ok(
  'demo _base lexicon matches what init scaffolds',
  JSON.stringify(fixtureLexicon) === JSON.stringify(BASE_LEXICON),
  `${fixtureLexicon.banned?.aiSlop?.length ?? 0} vs ${BASE_LEXICON.banned.aiSlop.length} aiSlop entries`
);

// ---------------------------------------------------------------- gitignore
// The engine must ignore a root-level profiles/ (someone ran `init` in the wrong
// place) while still tracking examples/demo/profiles/. An unanchored `profiles/`
// pattern matches the fixture too, silently excluding it — which breaks CI's
// ability to validate a pull request without anyone's private data. Invisible
// until someone clones the repo and finds nothing to run against.
const inRepo = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
if (inRepo.status === 0 && inRepo.stdout.trim() === 'true') {
  const ignored = (p) => spawnSync('git', ['-C', root, 'check-ignore', '-q', p]).status === 0;
  ok('the committed demo fixture is not gitignored', !ignored('examples/demo/profiles/demo/brand.json'));
  ok('a root-level profiles/ is still gitignored', ignored('profiles/acme/brand.json'));
  ok('a root-level captures/ is still gitignored', ignored('captures/2026-09-19-x.raw.json'));
} else {
  console.log('  \u001b[33mskip\u001b[0m gitignore assertions (engine tree is not a git repository)');
}

// ---------------------------------------------------------------- teach
const teach = json(['teach', '--dir', data, '-p', 'acme', '-c', 'instagram', '--rule', 'Never open with a pronoun.', '--why', 'Reads like a press release.', '--strength', 'hard', '--json']);
ok('teach assigns a rule id', /^vp-instagram-\d+$/.test(teach.id), teach.id);
ok('teach persists the rule', fs.readFileSync(path.join(data, 'profiles', 'acme', 'channels', 'instagram.json'), 'utf8').includes('Never open with a pronoun.'));

// ---------------------------------------------------------------- ingest
const third = json(['ingest', '--dir', data, '-p', 'acme', '-c', 'instagram', '--source', CAPTURED, '--json']);
ok('ingest creates a candidate', Boolean(third.id), JSON.stringify(third).slice(0, 120));
ok('third-party provenance is recorded', third.provenance === 'third-party');
ok('third-party cannot become an exemplar', third.mayBecomeExemplar === false);
ok('candidate carries a measurable pattern', typeof third.pattern === 'string' && third.pattern.length > 10);
ok('candidate records what was not transferred', Array.isArray(third.notTransferred) && third.notTransferred.includes('topic'));

const refused = run(['merge', '--dir', data, '-p', 'acme', '--id', third.id, '--as', 'exemplar']);
ok('merge refuses third-party as exemplar', refused.code === 1 && /third-party/.test(refused.stderr));

const asRule = run(['merge', '--dir', data, '-p', 'acme', '--id', third.id]);
ok('merge accepts third-party as a rule', asRule.code === 0, asRule.stderr.trim());

const own = json(['ingest', '--dir', data, '-p', 'acme', '-c', 'instagram', '--source', CAPTURED, '--own', '--json']);
ok('own content may become an exemplar', own.mayBecomeExemplar === true);
const ownMerge = run(['merge', '--dir', data, '-p', 'acme', '--id', own.id, '--as', 'exemplar']);
ok('merge accepts own content as exemplar', ownMerge.code === 0, ownMerge.stderr.trim());

// ---------------------------------------------------------------- diff / list / doctor
const diff = json(['diff', '--dir', data, '--json']);
ok('merged candidates leave the pending list', diff.every((c) => c.status === 'pending'));

const list = json(['list', '--dir', DEMO, '--json']);
ok('list reports the demo profile', list.length === 1 && list[0].name === 'demo');
ok('list counts rules and exemplars', list[0].rules === 4 && list[0].exemplars === 3, JSON.stringify(list[0]));

const recipes = json(['recipes', '--json']);
ok('recipes are loadable', recipes.length >= 3);
ok('recipes include a generic fallback', recipes.some((r) => r.name === 'generic'));

const doctor = run(['doctor', '--dir', DEMO, '--json']);
ok('doctor runs and reports', doctor.code === 0 || doctor.code === 1);

// ---------------------------------------------------------------- errors
const missingProfile = run(['pack', '--dir', DEMO, '-p', 'nope', '-c', 'instagram']);
ok('missing profile is a usage error', missingProfile.code === 2 && /not found/.test(missingProfile.stderr), `exit ${missingProfile.code}`);
ok('errors carry a next step', /^next: /m.test(missingProfile.stderr));

const missingChannel = run(['pack', '--dir', DEMO, '-p', 'demo', '-c', 'tiktok']);
ok('missing channel is a usage error', missingChannel.code === 2 && /not defined/.test(missingChannel.stderr), `exit ${missingChannel.code}`);

const unknown = run(['nonsense']);
ok('unknown command is a usage error', unknown.code === 2 && /unknown command/.test(unknown.stderr));

// Exit 1 and exit 2 must stay distinguishable. 1 is "the call was fine, the
// answer is no — do not just retry". 2 is "you called it wrong — fix and
// retry". An agent that cannot tell them apart retries the wrong things.
ok('a refusal carries a next step too', /^next: /m.test(refused.stderr));
ok('a refusal is exit 1, not 2', refused.code === 1, `exit ${refused.code}`);
ok('usage errors and refusals differ', missingProfile.code !== refused.code);

// ---------------------------------------------------------------- output integrity
// The whole report must arrive. A truncated answer is worse than an error,
// because the agent has no way to know it is reading half a document.
const whole = run(['check', '--dir', DEMO, '-p', 'demo', '-c', 'instagram', '-f', BAD]);
const wholeLines = whole.stdout.trimEnd().split('\n');
ok(
  'multi-line output arrives whole',
  wholeLines.length >= 6 && /^next: /.test(wholeLines[wholeLines.length - 1]),
  `${wholeLines.length} lines, last: ${JSON.stringify(wholeLines[wholeLines.length - 1] ?? '')}`
);

// A big artefact must survive the pipe intact — this is where a process.exit()
// racing the write would bite.
const bigJson = run(['pack', '--dir', DEMO, '-p', 'demo', '-c', 'instagram', '--json']);
let bigOk = false;
try {
  const parsed = JSON.parse(bigJson.stdout);
  bigOk = typeof parsed.text === 'string' && parsed.text.length > 1000;
} catch {
  bigOk = false;
}
ok('a large artefact survives the pipe intact', bigOk);

// ---------------------------------------------------------------- agent interface
const helpJson = json(['--help', '--json']);
ok('--help --json lists commands', Array.isArray(helpJson.commands) && helpJson.commands.length >= 12);
ok('--help --json documents exit codes', Boolean(helpJson.exitCodes && helpJson.exitCodes['2']));
ok('--help --json states the output format', /key: value/.test(helpJson.outputFormat ?? ''));

const ctx = json(['context', '--dir', DEMO, '--json']);
ok('context orients in one call', ctx.profiles.includes('demo'));
ok('context reports pending candidates', Array.isArray(ctx.pending));
ok('context reports capture readiness', typeof ctx.captureReady === 'boolean');

const ctxText = run(['context', '--dir', DEMO]).stdout;
ok('context ends with a next step', /^next: /m.test(ctxText));
ok('context output is free of ANSI', !/\u001b\[/.test(ctxText));

const noInput = run(['check', '--dir', DEMO, '-p', 'demo', '-c', 'instagram']);
ok('check never blocks waiting on input', noInput.code === 2, `exit ${noInput.code}`);

const packRaw = run(['pack', '--dir', DEMO, '-p', 'demo', '-c', 'instagram']);
ok('pack stdout is the artefact and nothing else', packRaw.stdout.includes('HARD RULES') && !/^next: /m.test(packRaw.stdout));
ok('pack diagnostics go to stderr', /^next: /m.test(packRaw.stderr));

const checkText = run(['check', '--dir', DEMO, '-p', 'demo', '-c', 'instagram', '-f', BAD]).stdout;
ok('check output is record-shaped', /^score: /m.test(checkText) && /^violation: HARD /m.test(checkText));
ok('check ends with a next step', /^next: /m.test(checkText));

const diffText = run(['diff', '--dir', data]).stdout;
ok('diff ends with a next step', /^next: /m.test(diffText));

// ---------------------------------------------------------------- apply
// `apply` takes a MODEL-GENERATED bundle and writes it to disk, so every path
// and every provenance field in it is untrusted input. The guards matter more
// than the happy path: a bundle is the easiest place in the whole system to
// smuggle in a path traversal or somebody else's post, and both would look
// completely normal in the output.
const writeBundle = (name, obj) => {
  const p = path.join(tmp, `${name}.json`);
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return p;
};
const brandPath = path.join(data, 'profiles', 'acme', 'brand.json');
const readBrand = () => JSON.parse(fs.readFileSync(brandPath, 'utf8'));
const exDir = path.join(data, 'profiles', 'acme', 'exemplars', 'instagram');

// The happy path: a new exemplar lands on disk.
const applied = run([
  'apply',
  '--dir',
  data,
  '--file',
  writeBundle('b-new', {
    profile: 'acme',
    files: {
      'exemplars/instagram/2026-01-01-first.md':
        '---\nprovenance: human-written\nchannel: instagram\n---\n\nPulled the first tray at six.\n',
    },
  }),
]);
ok(
  'apply writes a new exemplar',
  applied.code === 0 && fs.existsSync(path.join(exDir, '2026-01-01-first.md')),
  applied.stderr.trim()
);

// A traversal key must write nothing anywhere, and must not exit 0.
const traversal = run([
  'apply',
  '--dir',
  data,
  '--file',
  writeBundle('b-escape', { profile: 'acme', files: { '../../../../PWNED.json': { pwned: true } } }),
]);
ok('apply refuses a traversal path', traversal.code === 2, `exit ${traversal.code}`);
ok('apply names the escape', /escapes the profile/.test(traversal.stderr), traversal.stderr.trim());
ok('apply writes nothing for a traversal path', !fs.existsSync(path.join(tmp, 'PWNED.json')));

const absTarget = path.join(tmp, 'ABS-PWNED.json');
const absolute = run([
  'apply',
  '--dir',
  data,
  '--file',
  writeBundle('b-abs', { profile: 'acme', files: { [absTarget]: { pwned: true } } }),
]);
ok('apply refuses an absolute path', absolute.code === 2, `exit ${absolute.code}`);
ok('apply writes nothing for an absolute path', !fs.existsSync(absTarget));

// Provenance: third-party is refused with exit 1 (the run succeeded, the answer
// is no); an unattributed exemplar is a usage error (exit 2).
const stolen = run([
  'apply',
  '--dir',
  data,
  '--file',
  writeBundle('b-stolen', {
    profile: 'acme',
    files: {
      'exemplars/instagram/2026-01-02-stolen.md':
        '---\nprovenance: third-party\n---\n\nWe are thrilled to announce our new menu!\n',
    },
  }),
]);
ok('apply refuses a third-party exemplar', stolen.code === 1, `exit ${stolen.code}`);
ok('apply lists the refused file', /^refused: exemplars\/instagram\/2026-01-02-stolen\.md$/m.test(stolen.stdout), stolen.stdout.trim());
ok('apply does not write a third-party exemplar', !fs.existsSync(path.join(exDir, '2026-01-02-stolen.md')));

const ghost = run([
  'apply',
  '--dir',
  data,
  '--file',
  writeBundle('b-ghost', {
    profile: 'acme',
    files: { 'exemplars/instagram/2026-01-03-ghost.md': '---\nchannel: instagram\n---\n\nJust baked.\n' },
  }),
]);
ok('apply refuses an exemplar with no provenance', ghost.code === 2, `exit ${ghost.code}`);
ok('apply does not write an unattributed exemplar', !fs.existsSync(path.join(exDir, '2026-01-03-ghost.md')));

// JSON is FILLED, not replaced. `init` scaffolds `extends: "_base"`, and a
// bundle that only answers the identity questions must not drop it — losing it
// detaches the profile from the base lexicon with no visible error.
const fill = writeBundle('b-fill', {
  profile: 'acme',
  files: { 'brand.json': { identity: { name: 'Acme Bakehouse', founded: '2019' } } },
});
const skipRun = run(['apply', '--dir', data, '--file', fill]);
ok('apply skips a file that already exists', skipRun.code === 0 && /^skipped: brand\.json$/m.test(skipRun.stdout), skipRun.stdout.trim());
ok('apply leaves a skipped file untouched', readBrand().identity.name !== 'Acme Bakehouse');

const before = readBrand();
const forced = run(['apply', '--dir', data, '--file', fill, '--force']);
const after = readBrand();
ok('apply --force fills the file', forced.code === 0 && after.identity.name === 'Acme Bakehouse', forced.stderr.trim());
ok('apply --force keeps keys the bundle omits', after.extends === '_base' && after.extends === before.extends, JSON.stringify(after.extends));
ok('apply --force keeps the version', after.version === before.version, JSON.stringify(after.version));
ok('apply --force reports a merge, not a write', /^merged: 1$/m.test(forced.stdout), forced.stdout.trim());

// Arrays REPLACE. This is the assertion that fails if `apply` is ever
// "simplified" into deepMerge, whose arrays concatenate for `extends` — the
// second run would turn ["warmth"] into ["warmth", "warmth"].
const arrays = writeBundle('b-arrays', { profile: 'acme', files: { 'brand.json': { values: ['warmth', 'craft'] } } });
run(['apply', '--dir', data, '--file', arrays, '--force']);
run(['apply', '--dir', data, '--file', arrays, '--force']);
ok('apply --force does not duplicate arrays', JSON.stringify(readBrand().values) === '["warmth","craft"]', JSON.stringify(readBrand().values));

// Questions the model could not answer must reach the human.
const needs = run([
  'apply',
  '--dir',
  data,
  '--file',
  writeBundle('b-needs', { profile: 'acme', _needsInput: ['identity.home'], _inferred: ['values'], files: {} }),
]);
ok('apply surfaces questions it could not answer', /^needsInput: identity\.home$/m.test(needs.stdout), needs.stdout.trim());
ok('apply surfaces what the model guessed', /^inferred: values$/m.test(needs.stdout), needs.stdout.trim());
ok('apply points at --force when the profile is incomplete', /--force/.test(needs.stdout), needs.stdout.trim());

// Structural failures are all exit 2 — the caller passed the wrong thing.
const structural = [
  ['a non-object bundle', writeBundle('b-arr-root', [1, 2, 3])],
  ['a bundle with no profile', writeBundle('b-noprofile', { files: { 'voice.json': {} } })],
  ['a bundle with no files', writeBundle('b-nofiles', { profile: 'acme' })],
  ['a profile name that is a path', writeBundle('b-badname', { profile: '../../etc', files: {} })],
  ['an unknown profile', writeBundle('b-unknown', { profile: 'nope', files: {} })],
  ['a bundle that is not JSON', writeBundle('b-garbage', '{ not json ')],
  ['a missing bundle file', path.join(tmp, 'does-not-exist.json')],
];
for (const [label, file] of structural) {
  const r = run(['apply', '--dir', data, '--file', file]);
  ok(`apply rejects ${label}`, r.code === 2, `exit ${r.code}`);
}
ok('apply names the fix for an unknown profile', /voicepack init/.test(run(['apply', '--dir', data, '--file', writeBundle('b-unknown2', { profile: 'nope', files: {} })]).stderr));

// ---------------------------------------------------------------- detect contract
// A rule whose `detect` block cannot run is worse than a rule with no detect at
// all: the draft scores 100 while breaking a hard rule, so it ships. That is the
// exact failure the install prompt warns about, so both the prompt and the code
// are checked against the one list of types the linter can actually evaluate.
const detectSection = profilePromptRaw.slice(
  profilePromptRaw.indexOf('Supported types, with their fields:'),
  profilePromptRaw.indexOf('Do not invent other detect types')
);
const promptTypes = [...detectSection.matchAll(/"type":\s*"([A-Za-z]+)"/g)].map((m) => m[1]).sort();
ok(
  'the install prompt lists exactly the detect types the code supports',
  JSON.stringify(promptTypes) === JSON.stringify([...DETECT_TYPES].sort()),
  `prompt has [${promptTypes.join(', ')}]`
);
ok(
  'the install prompt documents "words" for forbiddenWords',
  /"type":\s*"forbiddenWords",\s*"words"/.test(detectSection)
);
ok(
  'the install prompt does not send models to "value" for forbiddenWords',
  !/"forbiddenWords"[^}]*"value"/.test(detectSection)
);

// The runtime half: both spellings fire, and an unsupported type is reported
// rather than ignored.
const fwData = path.join(tmp, 'detect-data');
run(['init', '--dir', fwData, '--profile', 'fw']);
const fwDraft = path.join(tmp, 'draft-fw.md');
fs.writeFileSync(fwDraft, 'A handcrafted loaf, made slowly.\n');

const fwRule = (name, detect) =>
  writeBundle(name, {
    profile: 'fw',
    files: {
      'channels/instagram.json': {
        channel: 'instagram',
        rules: [
          {
            id: 'vp-instagram-001',
            text: 'Never use handcrafted.',
            strength: 'hard',
            why: 'It is generic.',
            example: 'Made by hand.',
            detect,
            source: { type: 'user-teach', date: '2026-09-20' },
            confidence: 0.9,
          },
        ],
      },
    },
  });

const fwCheck = (name, detect) => {
  const applied = run(['apply', '--dir', fwData, '--file', fwRule(name, detect), '--force']);
  return { applied, checked: run(['check', '--dir', fwData, '-p', 'fw', '-c', 'instagram', '-f', fwDraft]) };
};

const asValue = fwCheck('b-fw-value', { type: 'forbiddenWords', value: ['handcrafted'] }).checked;
ok(
  'forbiddenWords fires when written with "value"',
  asValue.code === 1 && /vp-instagram-001/.test(asValue.stdout),
  asValue.stdout.trim()
);
const asWords = fwCheck('b-fw-words', { type: 'forbiddenWords', words: ['handcrafted'] }).checked;
ok(
  'forbiddenWords fires when written with "words"',
  asWords.code === 1 && /vp-instagram-001/.test(asWords.stdout),
  asWords.stdout.trim()
);
ok(
  'a violation with an empty message still says something',
  /^violation: HARD vp-instagram-001 \| \S/m.test(asWords.stdout),
  asWords.stdout.trim()
);
ok(
  'an unsupported detect type is reported, not ignored',
  /unknown detect type "maxWords"/.test(fwCheck('b-fw-unknown', { type: 'maxWords', value: 20 }).applied.stdout)
);

// ---------------------------------------------------------------- empty profile
// A freshly scaffolded profile still packs. The result is the base defaults plus
// the banned-word list — well-formed, and useless. Nothing about it looks wrong,
// so an agent sent straight to `pack` writes generic prose and reports success.
// That is the failure the whole tool exists to prevent, so both commands have to
// say it out loud rather than hand over a clean-looking artefact.
const emptyData = path.join(tmp, 'empty-data');
run(['init', '--dir', emptyData, '--profile', 'blank']);

const emptyCtx = run(['context', '--dir', emptyData]);
ok('context flags an empty profile', /^empty: blank$/m.test(emptyCtx.stdout), emptyCtx.stdout.trim());
ok(
  'context sends an empty profile to the intake prompt',
  /^next: voicepack profile-prompt/m.test(emptyCtx.stdout),
  emptyCtx.stdout.trim()
);
ok(
  'context does not send an empty profile to pack',
  !/^next: voicepack pack/m.test(emptyCtx.stdout),
  emptyCtx.stdout.trim()
);
ok('context --json reports emptyProfiles', json(['context', '--dir', emptyData, '--json']).emptyProfiles.includes('blank'));

const emptyPack = run(['pack', '--dir', emptyData, '-p', 'blank', '-c', 'instagram']);
ok('pack still emits an artefact for an empty profile', emptyPack.stdout.includes('INSTAGRAM'), emptyPack.stdout.slice(0, 80));
ok('pack warns that an empty profile is defaults only', /no rules and no exemplars/.test(emptyPack.stderr), emptyPack.stderr.trim());
ok('pack warns not to trust a clean check on it', /generic prose/.test(emptyPack.stderr), emptyPack.stderr.trim());
ok('pack redirects an empty profile to the intake prompt', /^next: fill the profile first/m.test(emptyPack.stderr), emptyPack.stderr.trim());
ok('pack keeps exit 0 — the artefact is still valid', emptyPack.code === 0, `exit ${emptyPack.code}`);

// A real profile must be untouched by all of the above.
const realPack = run(['pack', '--dir', DEMO, '-p', 'demo', '-c', 'instagram']);
ok('a populated profile does not warn', !/no rules and no exemplars/.test(realPack.stderr), realPack.stderr.trim());
ok(
  'a populated profile still gets the write instruction',
  /^next: write the draft using only this pack/m.test(realPack.stderr),
  realPack.stderr.trim()
);
ok('a populated profile still packs exemplars', json(['pack', '--dir', DEMO, '-p', 'demo', '-c', 'instagram', '--json']).included.includes('exemplars'));

// ---------------------------------------------------------------- pack layout
// Three ways a pack can be well-formed and still wrong. All three were found by
// compiling the first real brand profile, not by reading the compiler — the
// output looked fine until someone read it.
const packData = path.join(tmp, 'pack-data');
run(['init', '--dir', packData, '--profile', 'pk']);

// Fourteen moves with examples is deliberately more than a 700-token budget holds.
const manyMoves = Array.from({ length: 14 }, (_, i) => ({
  id: `mv-${String(i + 1).padStart(3, '0')}`,
  text: `Move ${i + 1} describes a specific thing this brand does when it writes, in enough words to cost real tokens.`,
  example: `Contoh kalimat untuk move ${i + 1} yang juga cukup panjang.`,
}));
run([
  'apply', '--dir', packData, '-p', 'pk', '--force', '--file',
  writeBundle('b-pack', {
    profile: 'pk',
    files: {
      'voice.json': {
        moves: manyMoves,
        mechanics: {
          maxLinesPerParagraph: 3,
          // A full instructive sentence, which is how a model writes this field
          // about half the time. The other half is a short phrase.
          openingMove: 'Start from something real: an observation, incident, or craving. Avoid opening with a generic promotional claim.',
          closingMove: 'End simply. A short statement is often enough. Do not force a question.',
        },
      },
      'lexicon.json': {
        // "elevate" and "unleash" appear in BOTH lists, which is the normal case:
        // _base ships a generic aiSlop list and the profile adds brandSpecific.
        // The last pair overlaps by substring on purpose — "thrilled to announce"
        // is contained in "we're thrilled to announce", and the base list really
        // does hold both forms, because each catches phrasing the other misses.
        banned: {
          aiSlop: ['elevate', 'unleash', 'game-changer', "we're thrilled to announce"],
          brandSpecific: ['elevate', 'unleash', 'aku', 'gigitan', 'thrilled to announce'],
        },
      },
    },
  }),
]);

const pk = run(['pack', '--dir', packData, '-p', 'pk', '-c', 'instagram']);

// A sentence spliced into `open with ${x}` reads "open with Start from
// something real: ... claim.." — doubled full stops and the instruction buried.
ok('a sentence-shaped openingMove is not spliced into "open with"', !/open with Start from/.test(pk.stdout), pk.stdout.slice(0, 200));
ok('a sentence-shaped openingMove gets its own OPEN line', /^OPEN: Start from something real/m.test(pk.stdout));
ok('a sentence-shaped closingMove gets its own CLOSE line', /^CLOSE: End simply/m.test(pk.stdout));
ok('the rhythm line has no doubled full stop', !/\.\./.test(pk.stdout.split('\n').find((l) => l.startsWith('Rhythm:')) ?? ''));

// The lexicon is the artefact `lint` calls the highest-leverage in the store. It
// used to sit below moves in the budget walk and got starved out entirely by a
// long move list.
ok('the lexicon survives a move list that overflows the budget', pk.stdout.includes('NEVER USE:'));
ok('moves are truncated to fit rather than dropped whole', /^MOVES \(do this\)$/m.test(pk.stdout));
ok('a truncated move list says how many it left out', /more moves? not shown/.test(pk.stdout), pk.stdout.slice(-200));

// Deduplication: a word banned by both the base list and the profile must appear
// once. Printing it twice spends budget restating a rule.
const neverUse = pk.stdout.split('\n').find((l) => l.startsWith('NEVER USE:')) ?? '';
const countOf = (w) => (neverUse.match(new RegExp(`\\b${w}\\b`, 'g')) ?? []).length;
ok('a word banned by both lists appears once', countOf('elevate') === 1, `elevate ×${countOf('elevate')}`);
ok('deduplication keeps the brand-specific word', countOf('aku') === 1 && countOf('gigitan') === 1);

// The same bug lived in two files — the pack printed the banned list twice and so
// did the check message — and neither assertion above caught it, because both of
// them read the pack. The check message is the copy a writer actually acts on:
// it is what they see when told which words to delete.
const dupDraft = 'Elevate the everyday. Unleash a new ritual. Aku suka gigitan ini. Truly a game-changer.';
const dup = json(['check', '--dir', packData, '-p', 'pk', '-c', 'instagram', '--text', dupDraft, '--json']);
const lexV = dup.violations.find((v) => v.ruleId === 'lexicon:banned') ?? {};
const named = String(lexV.message ?? '').replace(/^Uses banned wording:\s*/, '').split(',').map((s) => s.trim()).filter(Boolean);

ok('check reports the banned words it matched', named.length === 5, lexV.message);
ok('check names each banned word once', new Set(named).size === named.length, named.join(' | '));

// One list, one order, wherever it surfaces. A writer who reads NEVER USE in the
// pack and then sees the same words reshuffled in the check message has to
// re-scan both to confirm they agree.
const packOrder = neverUse.replace(/^NEVER USE:\s*/, '').split(',').map((s) => s.trim());
ok(
  'check names the banned words in the pack\u2019s order',
  JSON.stringify(named) === JSON.stringify(packOrder.filter((w) => named.includes(w))),
  `pack:  ${packOrder.join(' | ')}\n       check: ${named.join(' | ')}`
);

// A draft that trips a nested pair should name the longer form only. The shorter
// entry matched the same span, so naming it too sends the writer hunting for a
// second occurrence that is not there.
const subDraft = "We're thrilled to announce the new bake.";
const sub = json(['check', '--dir', packData, '-p', 'pk', '-c', 'instagram', '--text', subDraft, '--json']);
const subV = sub.violations.find((v) => v.ruleId === 'lexicon:banned') ?? {};
const subNamed = String(subV.message ?? '').replace(/^Uses banned wording:\s*/, '').split(',').map((s) => s.trim()).filter(Boolean);
ok('a nested ban names the longer form', subNamed.includes("we're thrilled to announce"), subV.message);
ok('a nested ban does not also name the form it contains', !subNamed.includes('thrilled to announce'), subV.message);
ok('a nested ban names one word, not two', subNamed.length === 1, subV.message);

// The other half of the contract: a draft that avoids the lexicon must not be
// flagged at all. A check that fires on everything is as useless as one that
// never fires, and a false positive here trains the writer to ignore the line.
const cleanDraft = 'Kami memanggang roti ini setiap pagi. Datang sebelum jam sembilan.';
const clean = json(['check', '--dir', packData, '-p', 'pk', '-c', 'instagram', '--text', cleanDraft, '--json']);
ok('a draft with no banned wording is not flagged for it', !clean.violations.some((v) => v.ruleId === 'lexicon:banned'));
ok('a draft with no banned wording still returns a score', typeof clean.score === 'number');

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n  ${pass} passed \u00b7 ${fail} failed\n`);
process.exit(fail ? 1 : 0);
