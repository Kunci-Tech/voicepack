#!/usr/bin/env node
// test/smoke.mjs — end-to-end checks. No test framework, no dependencies.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const promptOut = run(['install-prompt']);
ok('install-prompt exits 0', promptOut.code === 0, promptOut.stderr.trim());
ok('install-prompt writes the prompt to stdout only', promptOut.stdout.trim() === promptFile && !/^next: /m.test(promptOut.stdout));
ok('install-prompt puts its note on stderr', /^next: /m.test(promptOut.stderr));

const promptJson = json(['install-prompt', '--repo', 'https://example.test/vp.git', '--json']);
ok('install-prompt --repo substitutes the placeholder', promptJson.prompt.includes('https://example.test/vp.git') && !promptJson.prompt.includes('<ENGINE_REPO_URL>'));

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

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n  ${pass} passed \u00b7 ${fail} failed\n`);
process.exit(fail ? 1 : 0);
