# Voicepack

**A portable persona engine that stops brand voice from decaying inside AI agents.**

You know the problem. You ask an AI to write a caption, and it hands back
*"We're thrilled to announce…"* — technically correct, completely off-brand. So you
re-explain the voice, get 80% of the way there, edit the rest by hand. Next session,
you start from zero, because the explanation was never stored anywhere.

Voicepack stores it. It compiles your voice into a token-budgeted **voice pack**
before every piece of writing, and critiques the draft against it afterwards.

```
npx voicepack pack --profile acme --channel instagram --intent launch
```

That returns ~700 tokens of hard rules, lexicon, structure and real examples —
everything the model needs, nothing it doesn't.

---

## Install

**Your agent installs this. You do not.** Copy the prompt from
[`INSTALL.md`](INSTALL.md), paste it into the agent you already write with, and send.
It checks Node, fetches the engine, scaffolds your private data directory, wires it
up, installs its own instructions, and runs preflight — reporting back in plain
language.

```bash
npx voicepack install-prompt              # prints the prompt, repo URL pre-filled
npx voicepack install-prompt --repo <url> # ...or point it at your own fork
```

If you would rather see the commands, `INSTALL.md` also has a manual path. Either
way there is **no `npm install`, no build step and no dependencies** — Node ≥ 18
is the only requirement.

> Not published to npm yet? Run `node <engine>/bin/voicepack.mjs` wherever this
> README says `npx voicepack`. Same CLI, same flags — the engine is written so
> that `npx` becomes a drop-in once it ships.

---

## The idea: the CLI is a context firewall

The naive approach is a growing `persona.json` pasted into the prompt. It fails in a
specific, predictable way: **adherence gets worse as the file gets better.** At 3,000
tokens the model ignores most of what you gave it.

Voicepack inverts that. The agent never reads the store.

| | Agent reads the store | Agent calls the CLI |
|---|---|---|
| Cost per draft | 8–15k tokens | ~700 tokens |
| As the store grows | gets worse | unchanged |
| Knows which rule broke | no | yes, by id |
| Works offline | — | yes |

Store size no longer affects context cost. It can grow to megabytes; the pack stays
the same size, because the compiler selects, ranks, truncates and formats to a budget.

---

## Quick start

Paste the prompt from [`INSTALL.md`](INSTALL.md) into your agent and you are done.
This is what it runs on your behalf:

```bash
# 1. scaffold a data directory (this is where your voice lives)
npx voicepack init --dir ~/voicepack-data --profile acme

# 2. point the engine at it, once
echo '{ "dir": "'"$HOME"'/voicepack-data" }' > voicepack.config.json

# 3. check everything is wired up
npx voicepack doctor

# 4. compile a pack
npx voicepack pack --profile acme --channel instagram --intent launch
```

No install step, no dependencies, no build. Node ≥ 18 is the only requirement.

### Wire it into your editor

`SKILL.md` is a WorkBuddy AI / Claude Code skill. Copy it into your skills
directory and the agent will run the write → check → revise loop on its own.
Adapters for other editors live in `adapters/`.

### Every command is agent-facing

The caller is a model, not a person at a keyboard, and the interface is built for
that:

- Output is a flat stream of `key: value` records ending in a **`next:`** line —
  cheaper than a table, trivial to parse, no ANSI colour to strip.
- **`pack` writes only the pack to stdout.** Diagnostics go to stderr, so
  `voicepack pack > pack.txt` captures the artefact and nothing else.
- **Exit codes carry meaning**, and `--help --json` documents them:

  | Code | Meaning | What the agent should do |
  |---|---|---|
  | `0` | ok | continue |
  | `1` | ran, but the answer is no | do **not** just retry — read `next:` |
  | `2` | you called it wrong | fix the call and retry |
  | `3` | environment not ready | run `doctor`, report the failure |

- **Nothing ever blocks on stdin.** Reading a piped draft needs an explicit
  `--stdin`, so a forgotten flag is an error rather than a hang.
- Every error carries a `next:` line. An agent told what broke but not what to do
  will guess, and guessing is how you get a confident wrong answer.

`voicepack context` orients a fresh session in one call: data directory, profiles,
channels, rule and exemplar counts, anything awaiting approval, and whether
capture is ready.

---

## The two trees (read this before forking)

Voicepack keeps the **engine** and your **data** in separate places. This is not a
style preference — it is what makes the project forkable and safe to contribute to.

```
voicepack/                    PUBLIC — the engine. Fork this, send PRs.
├── bin/ lib/ ingest/ adapters/
├── install/prompt.txt        the bootstrap prompt — one source of truth
├── INSTALL.md                the same prompt, readable by a person
├── examples/demo/            invented fixture; CI runs against this
└── SKILL.md

~/voicepack-data/             PRIVATE — your voice. Never forked, never PR'd.
└── profiles/<name>/
```

**The guarantee: a pull request cannot contain a persona.** Because your data is
out-of-tree, it isn't a matter of remembering to exclude it — it isn't in the
repository to begin with. `voicepack lint --privacy` verifies this and runs in CI.

### Two ways to use it

**Consumer — no fork.** `npx voicepack@latest` plus a private data directory.
Engine updates arrive when npm publishes. Nothing to maintain.

**Contributor — fork the engine.**

```bash
gh repo fork <upstream> --clone
cd voicepack && git remote add upstream <upstream-url>
npx voicepack init --dir ~/voicepack-data     # data stays outside

git fetch upstream && git merge upstream/main  # never touches your data
git checkout -b fix-pack-budget
gh pr create --repo <upstream>                 # diff is engine code only
```

---

## The write-time loop

```
1. RESOLVE   profile + channel + intent
2. PACK      npx voicepack pack ...                    -> ~700 tokens
3. DRAFT     write using the pack
4. CHECK     npx voicepack check --file draft.md       deterministic, free
5. JUDGE     the agent assesses register and drift     soft rules only
6. REVISE    fix only what was flagged
7. SHIP      hand to a human; publish manually
```

Step 3 is where most setups fail. The pack must be re-emitted immediately before
**every** piece of writing — never carried over from earlier in a conversation.

### Checking is two layers

An earlier design left this ambiguous, which was a real gap: a Node script cannot
judge "does this sound like us", and requiring an API call to scan for banned words
is absurd.

| | Layer 1 — `voicepack check` | Layer 2 — the agent |
|---|---|---|
| Runs | plain Node | already in the loop |
| Cost | free, instant, offline | free |
| Catches | banned lexicon, length and count limits, sentence and paragraph shape, punctuation, rule regexes | register, generic-CTA smell, drift, "does this read like a press release" |

Layer 1 is **data-driven**. Rules carry machine-checkable predicates:

```json
{
  "id": "vp-instagram-001",
  "text": "Open with a concrete number or a named person, never a claim.",
  "strength": "hard",
  "detect": {
    "type": "regex",
    "pattern": "^\\s*(we'?re|our|announcing)\\b",
    "flags": "im",
    "message": "A paragraph opens with a claim instead of a concrete detail."
  }
}
```

Supported: `regex`, `maxChars`, `minChars`, `maxEmoji`, `maxHashtags`, `minHashtags`,
`maxExclamations`, `maxSentenceWords`, `maxParagraphLines`, `forbiddenWords`.

```
$ voicepack check -p demo -c instagram -f examples/draft-bad.md
score: 60
verdict: revise
layer: deterministic
profile: demo
channel: instagram
hard: 2
soft: 5
stats: 467 chars, 80 words, 0 hashtags, 0 emoji, longest sentence 22 words
violation: soft channel:hashtags | 0 hashtags; the channel expects at least 3.
violation: HARD lexicon:banned | Uses banned wording: elevate, we're thrilled, nestled in the heart of, artisanal, mouth-watering
violation: soft lexicon:emDash | Contains 1 em-dash; the lexicon says avoid them.
violation: soft lexicon:exclamation | 4 exclamation marks; the limit is 1.
violation: soft voice:maxSentenceWords | Longest sentence is 22 words; the voice caps at 20.
violation: HARD vp-instagram-001 | A paragraph opens with a claim instead of a concrete detail.
violation: soft vp-instagram-004 | A sentence runs past 20 words.
next: fix the 2 HARD violation(s) first, then re-run check. Do not rewrite what was not flagged.
```

Every violation names the **rule id** that produced it, so a revision can be aimed
at one rule instead of rewriting the whole draft. That is the difference between
editing and regenerating.

---

## Learning

Three inputs, one destination: a proposed diff you approve or reject.

**Teach** — state a rule in plain language.

```bash
npx voicepack teach -p acme -c threads \
  --rule "First line under 60 characters." --why "Scannable on mobile." --strength soft
```

**Ingest** — paste a link and let the agent learn the structure.

```bash
npx voicepack ingest --url https://example.com/post/1 -p acme -c threads
npx voicepack diff
npx voicepack merge --id L-0007
```

`ingest` extracts a **pattern**, never the text: first-line length, sentence rhythm,
whether it opens on a number, how it closes. It records what it deliberately did not
take — topic, phrasing, author identity.

**Own content vs third-party.** Your own post can become an *exemplar*. Someone
else's post can only become a *rule about structure*. The merge guard enforces this:

```
$ npx voicepack merge --id L-0001 --as exemplar
error: Candidate L-0001 is third-party. Only your own content may become an exemplar.
```

That is the right call twice over. Legally, storing a stranger's post to shape your
brand voice isn't defensible. Practically, an exemplar teaches the model to imitate
*that author* — including their subject matter — when what you wanted was the
structural trick. A rule generalizes; a copied post doesn't.

**Nothing is learned without approval.** `ingest` and `teach` propose. `merge` applies.
One instance is evidence, not a rule — promotion needs three independent instances.

---

## Capture through the browser bridge

`ingest --url` and `capture` drive your **already-authenticated Chrome** via the
[WorkBuddy Browser Bridge](https://github.com/Kunci-Tech/workbuddy-browser-bridge).
The mechanism that matters: **it never logs in.** No credential is handed to a script
and no sign-in flow runs, so CAPTCHA, 2FA and "this browser may not be secure" walls
never appear.

`voicepack doctor` reports whether it is available. If it isn't, everything except
`capture` still works — `ingest --source <file>` takes text you paste yourself.

Capture stays dumb on purpose: fetch, serialise, save. Parsing and synthesis run
offline against files already on disk. When Instagram or Threads change their markup,
that costs one parser fix replayed over existing captures — never a re-fetch.

**Guardrails.** Read-only, always — never automate a like, follow, comment or post.
Never automate login. Human-scale rate. Your own accounts first, official APIs
preferred. Others' content targeted, not harvested.

---

## Commands

```
voicepack context          [--json]                    orient a fresh session
voicepack install-prompt   [--repo <url>] [--json]     the bootstrap prompt
voicepack init     --dir <path> --profile <name>
voicepack doctor   [--json]
voicepack pack     -p P -c C [-i INTENT] [--max-tokens N] [--json] [--verbose]
voicepack check    -p P -c C [-f draft.md | --text "..."] [--json] [--quiet]
voicepack teach    -p P -c C --rule "..." [--why "..."] [--strength hard|soft]
voicepack capture  -p P -c C --url <url>
voicepack ingest   -p P -c C [--url <url> | --capture <raw.json> | --source <file>] [--own]
voicepack diff     [--json]
voicepack merge    -p P --id L-0001 [--as rule|hard|exemplar]
voicepack lint     -p P   |   voicepack lint --privacy
voicepack list
voicepack history  |  voicepack rollback --to <ref>
```

`--dir` resolution order: `--dir` → `$VOICEPACK_DIR` → `./voicepack.config.json` → `~/.voicepack`.
`voicepack --help --json` returns the whole surface — commands, options, and the
exit-code contract — in one parseable object.

---

## Data model

| File | Holds |
|---|---|
| `brand.json` | identity, audience, point of view, values, code-switching rules |
| `voice.json` | tone dials, sentence mechanics, named moves |
| `channels/<c>.json` | constraints, structure, rules, exemplar list |
| `lexicon.json` | signature words, banned words, punctuation policy |
| `exemplars/<c>/*.md` | real posts, with `why` and performance frontmatter |
| `learnings/log.jsonl` | append-only audit trail |

A profile inherits from `_base` and overrides what it needs. Objects merge; arrays
concatenate — because rules, exemplars and banned words are additive. When
concatenation is wrong (an ordered list like `structure.beats`), list the dotted path
in `_replace`:

```json
{ "_replace": ["structure.beats"], "structure": { "beats": ["hook", "turn", "close"] } }
```

**The `aiSlop` list is the highest-leverage single file in the system.** Most "AI
voice" problems are eight or ten recurring tells, and the list is brand-agnostic —
which is why it lives in `_base` and why the demo fixture carries the same list.
The test suite asserts the two are identical, because they had already drifted by
twelve entries before anyone noticed: the curated fixture had quietly stopped
matching what `init` actually scaffolds.

Matching is a case-insensitive substring test, so `elevate` also catches `elevated`.
Entries are grouped by tell — the announcement cluster (`we're thrilled`, `we are
thrilled`, `thrilled to announce`), the vocabulary cluster (`delve`, `seamless`,
`cutting-edge`), and the scenery cluster (`nestled in the heart of`). Add to it
before adding anything else; it is the cheapest quality win available.

---

## Why not…?

**…embeddings or a vector store?** The retrieval axis for voice is a `WHERE` clause,
not a nearest-neighbour search. You don't want "posts about sourdough" — you want
"the rules that apply to Instagram + launch, ranked by performance." Topic is
actively the wrong axis: it would surface a badly-written post about the right topic
over a brilliantly-written post about a different one.

**…graft, or a code index?** Graft indexes *source code* — 23 programming languages,
and its README states plainly that a file whose language isn't listed is skipped.
Markdown and JSON are not on the list, so it would skip every rule and every exemplar.
It's a genuinely good tool for navigating the engine's own codebase during
development, and that's where it belongs. It is not a persona index.

**…a fine-tuned model?** Style is a few-shot problem. A fine-tune is expensive, slow
to update, and turns an auditable store into a black box you can't roll back.

**…Python?** A skill that needs Python has to solve, on someone else's machine: which
interpreter, which version, pip vs uv vs poetry, a venv that survives shell restarts,
and native build failures. `npx voicepack` works wherever Node exists.

---

## Development

```bash
npm test                        # smoke suite: 89 assertions, no framework
npm run pack                    # compile the demo pack
npm run check                   # lint a fixture draft
npm run context                 # orient against the demo profile
npm run install-prompt          # print the bootstrap prompt
node bin/voicepack.mjs lint --privacy
```

`package.json` has **no `dependencies` key**, and the suite fails if one appears.
That is a design constraint, not an accident.

Five invariants are enforced by tests rather than by discipline, because each one
fails silently in production:

| Invariant | Why it is tested |
|---|---|
| no dependencies | the promise that makes install work anywhere Node exists |
| engine tree holds no brand data | a PR must not be able to leak a persona |
| the committed demo fixture is not gitignored | an unanchored `profiles/` pattern would exclude it, leaving CI with nothing to run |
| `INSTALL.md` matches `install/prompt.txt` verbatim | documentation drift is invisible otherwise |
| demo `_base` lexicon matches what `init` scaffolds | the fixture had already drifted by 12 entries |

Every one of those was found by testing rather than by review. That is the argument
for the tests, not for the review.

Contributions welcome. Please keep engine code and brand data separate — run
`voicepack lint --privacy` before opening a PR.

---

## License

MIT
