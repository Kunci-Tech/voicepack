---
name: voicepack
description: This skill should be used whenever writing or generating prose on behalf of a brand or person — social media posts, captions, threads, blog articles, newsletters, launch announcements, replies — and whenever the user pastes a link and asks to learn, capture, or adopt its style. It compiles a token-budgeted voice pack from a JSON persona store and critiques drafts against it, so brand voice survives across sessions and across editors instead of decaying into generic AI prose.
agent_created: true
---

# Voicepack

Brand voice decays inside AI agents. Every session, the model's default voice wins
and the output drifts toward generic marketing English. This skill prevents that by
compiling the voice into a token-budgeted pack before every piece of writing, and
critiquing the draft against it afterwards.

## The one rule

**Never read the persona store directly. Always go through the CLI.**

The store is JSON and Markdown on disk. Reading it into context costs 8–15k tokens
and makes adherence *worse*, because the model ignores most of what it is handed.
The CLI reads the store out of context and returns a pack sized to fit.

```
WRONG   read persona/profiles/acme/voice.json, rules.json, channels/*.json, exemplars/*
RIGHT   run: voicepack pack --profile acme --channel instagram --intent launch
```

Do not `cat`, `read`, `glob` or `grep` the data directory. One command, one pack.

## Reading the output

This CLI is built to be read by you, not by a person, so the output format is part
of the contract rather than a presentation choice.

- **Every line is `key: value`**, and the last line is `next:` — the one action to
  take. Parse it; do not scrape prose out of it.
- **`pack` writes only the pack to stdout.** Its token count, what was included and
  what was dropped go to stderr. If you are piping the pack somewhere, the artefact
  is clean.
- **Exit codes are the fastest signal you get**, and they are documented in
  `voicepack --help --json`:

  | Code | Meaning | What to do |
  |---|---|---|
  | `0` | ok | continue |
  | `1` | ran, but the answer is no | do **not** just retry — read `next:` |
  | `2` | you called it wrong | fix the call and retry |
  | `3` | environment not ready | run `doctor`, report the failure |

  The `1` versus `2` split is the one that matters. `1` from `check` means the draft
  is not shippable; retrying the same command changes nothing. `2` means a flag or a
  name was wrong; retrying with it fixed is exactly right.
- **Every error carries a `next:` line.** Use it instead of guessing.
- **Nothing blocks on stdin.** Piping a draft in requires `--stdin`; a forgotten flag
  is an error, never a hang.

Add `--json` when you want the whole structure rather than the record stream.

## Start every session here

```
voicepack context
```

One call, and you know the data directory, the profiles, the channels, the rule and
exemplar counts, anything awaiting approval, and whether capture is ready. Run it
before `pack` in a session that has not used the skill yet — guessing the profile or
channel name costs more than asking.

## Write-time procedure

Run these in order. Do not skip steps and do not carry a pack over from an earlier
turn — in a long conversation an instruction given twenty turns ago is diluted to
nothing.

```bash
# 0. orient (first use in a session)
voicepack context

# 1. compile the pack for this exact job
voicepack pack --profile <p> --channel <c> --intent <i>     # ~700 tokens

# 2. write the draft using ONLY that pack

# 3. layer 1 — deterministic lint (free, offline, instant)
voicepack check --profile <p> --channel <c> --file draft.md

# 4. layer 2 — your own judgement, see below

# 5. fix only what was flagged. Do not rewrite what was not.
```

Intents: `promo`, `launch`, `educational`, `community`, `reactive`,
`behind-the-scenes`, `recruitment`, `apology`. Intent selects which exemplars the
compiler prefers, so a launch post and an apology post draw on different examples.

## The two-layer critique

**Layer 1 is the command.** `voicepack check` catches everything mechanical: banned
lexicon, character and hashtag limits, emoji counts, sentence and paragraph length,
punctuation, and any rule carrying a `detect` predicate. It returns a score and a
verdict. It needs no model and no API key.

**Layer 2 is you.** After layer 1, assess the draft against the pack yourself and
report two things:

- `voiceDrift` — where the draft sounds like a generic AI rather than this brand.
  Cite the specific line. Typical signals: a generic CTA, a press-release opener,
  a paragraph that could belong to any company, a register shift mid-draft.
- `keep` — what is already right and must not be touched during revision. This
  matters more than it looks: without it, revision flattens good lines while
  fixing bad ones.

Score meaning: `ship` (≥85), `revise` (60–84), `rewrite` (<60). A hard violation
caps the score at 60 regardless of everything else.

## When the user pastes a link

This is the most common way the skill gets used, and it must work in one step.

```
1. voicepack doctor                                     # is the bridge up?
2. voicepack ingest --url <url> -p <profile> -c <channel>
```

That captures the page, parses it offline, synthesizes a transferable pattern, and
writes a candidate. Then show the user what it proposes:

```
PROPOSED (candidate — 1 instance, cannot become a hard rule yet)
  pattern   first line short, no emoji in the hook, opens with a concrete number
  evidence  1 post · captured 2026-09-19
  transfer  structure + rhythm only — no text from the source is stored
  merge     voicepack merge --id L-0007
```

Three things to get right here:

- **Synthesize the pattern, never the text.** The point is the structural trick, not
  the wording. Never offer to copy phrasing. The single exception is the user's own
  post, where `--own` also retains the text — an exemplar has to be their real words,
  and `merge --as exemplar` refuses rather than write an empty one.
- **It lands as a candidate, not a rule.** One post is one data point. It becomes a
  soft signal immediately and promotes to a hard rule only after three independent
  instances agree.
- **Third-party content can never become an exemplar.** If `--own` was not passed,
  the merge guard will refuse `--as exemplar`. That is correct — do not work around
  it. Someone else's post can teach a rule about structure; it cannot be your voice.

If the bridge is unavailable, `voicepack doctor` says so. Fall back to
`voicepack ingest --source <file>` with text the user pasted directly. Never block
the user on the bridge.

**Every candidate gets an answer.** After `diff`, either merge it or reject it — do not
leave it pending. A candidate that turns out to be a reply, a repost, or someone else's
quote is rejected, not merged and not forgotten:

```
voicepack discard --id L-0007 --reason "a reply, not a post"
```

Rejecting is a normal outcome, not a failure. Merging a candidate you are unsure about
puts a rule in the profile that no one asked for, and leaving it pending puts it in
every future `context` call.

## When the user teaches a rule

```
voicepack teach --profile <p> --channel <c> \
  --rule "Threads posts land better when the first line is under 60 characters." \
  --why "Scannable in one glance on mobile." --strength soft
```

Corrections to a draft the user just rejected are also teach events, and they are
the highest-quality signal available because they are grounded in a specific
failure. When the user says "no, not like that" — offer to `teach` the correction.

Nothing is learned without approval. `ingest` and `teach` write; only `merge` and
`teach` change what a draft will look like. Never auto-merge.

## Commands

```
voicepack context                                  orient: dirs, profiles, pending, capture
voicepack install-prompt [--repo <url>]            the bootstrap prompt, for a new machine
voicepack profile-prompt [--brand "<brief>"] [-p P] the intake prompt, for a new brand
voicepack apply   --file <bundle.json> [-p P] [--force]
voicepack doctor                                   preflight: node, data dir, bridge
voicepack pack    -p P -c C [-i I] [--max-tokens N] [--verbose]
voicepack check   -p P -c C -f draft.md [--json] [--quiet]
voicepack teach   -p P -c C --rule "..." [--why "..."] [--strength hard|soft]
voicepack capture -p P -c C --url <url>
voicepack ingest  -p P -c C [--url <url> | --capture <raw.json> | --source <file>] [--own]
voicepack diff    [--json]
voicepack merge   -p P --id L-0001 [--as rule|hard|exemplar]
voicepack lint    -p P          |  voicepack lint --privacy
voicepack list
voicepack history |  voicepack rollback --to <ref>
voicepack init    --dir <path> --profile <name>
```

`--dir` selects the data directory. If omitted, the CLI checks `$VOICEPACK_DIR`,
then `./voicepack.config.json`, then `~/.voicepack`.

When working from a clone rather than an installed package, replace `voicepack`
with `node bin/voicepack.mjs`.

## Setting up a new machine

Do not walk the user through a terminal. Print the bootstrap prompt and let an
agent on that machine perform the install:

```
voicepack install-prompt --repo <engine-repo-url>
```

The prompt checks Node, fetches the engine, scaffolds the private data directory,
wires it up, installs this skill file, and runs preflight — all without the user
touching a shell. It is also the thing to paste when the user asks how to set
Voicepack up somewhere else.

## Capturing a brand from scratch

When the profile is an empty scaffold and the user wants it filled, do not interview
them field by field and do not write the JSON yourself from what you happen to know.
A brand's voice is not something you can infer from its category, and a plausible
guess is worse than a blank — it is stored as fact and silently shapes every draft
from then on.

```
voicepack init          --dir <data> --profile <id>     # scaffold, if not done
voicepack profile-prompt --brand "<who they are>" -p <id>
```

Print the prompt and hand it to the user to paste into a capable model. It runs in two
passes by design: questions and a plain-language description first, JSON only after
the user confirms the description. That description step is where a wrong reading of
the brand gets caught, so do not skip it or "helpfully" generate the bundle yourself.

When the user brings the JSON back:

```
voicepack apply --file bundle.json --force
```

Read the result rather than assuming it worked:

- `written` / `merged` — files landed. `merged` means an existing scaffold file was
  filled; keys the bundle did not mention were kept, including `extends: "_base"`.
- `skipped` — already existed and `--force` was not passed. Nothing was overwritten.
- `refused` — an exemplar claimed `provenance: third-party`. Exit code is 1. Do not
  retry it; the bundle must drop that post. Someone else's writing may teach a *rule*
  about structure, but it may never be a model of this brand's voice.
- `needsInput` — questions the model could not answer. Put these to the user.
- `inferred` — fields the model guessed. Have the user review them specifically.
- `lint.errors` — the import left the profile invalid. Fix the bundle, not the profile.

Exit code 2 means the bundle itself is malformed (bad path, unknown profile, no
`files` key) — fix the bundle. Exit code 1 means the bundle was readable but
something in it was rejected — usually provenance.

Two things the prompt is strict about, and you should be too: it never invents a
field, and it never fabricates an exemplar. If the user's bundle contains an exemplar
that looks too polished to be a real post, ask. An invented exemplar teaches a voice
the brand does not have, and it is the hardest error to find later.

## Troubleshooting

- **"Profile not found"** — the data directory is wrong. Run `voicepack list` or
  `voicepack context` to see what the CLI is actually resolving. This exits `2`,
  not `1`: fix the name and retry.
- **"Channel not defined"** — the error lists what does exist. Add
  `profiles/<profile>/channels/<channel>.json`, or pass one of the available names.
- **Pack is missing exemplars** — the budget was exceeded. Re-run with `--verbose`
  to see what was dropped, or raise `--max-tokens`.
- **Bridge tools absent** — trust is not retroactive. Approving the bridge
  mid-conversation does not add its tools to that conversation. Start a new one.
  Restarting the editor is not required. See the `browser-bridge-diagnostics` skill.
- **`check` returns `ship` but the draft still sounds wrong** — layer 1 only proves
  it is not *mechanically* wrong. Layer 2 is your job; do it.
- **`check` exits `1` and you are tempted to re-run it** — don't. `1` means the
  draft is not shippable. Read the `violation:` lines, fix the `HARD` ones, and
  re-run only after editing.
- **`install-prompt` warns the placeholder is unfilled** — pass
  `--repo <engine-repo-url>`. The prompt still prints; it just cannot tell the
  installing agent where to fetch the engine.
- **`profile-prompt` prints a bracketed reminder instead of a brief** — pass
  `--brand "<one or two lines about the brand>"`. The prompt still prints; it just
  does not know who it is interviewing for.
- **`apply` exits `2`** — the bundle is malformed, not rejected. Read the `error:`
  line: an unknown profile means `init` first, a bad path means the model invented a
  filename, "not valid JSON" means markdown fences survived the copy.
- **`apply` exits `1`** — the bundle was readable but something in it was refused,
  almost always a `provenance: third-party` exemplar. Remove that post from the
  bundle. Do not retry it as-is, and do not "fix" it by relabelling the provenance.
- **`apply` reports `merged` where you expected `written`** — the file already
  existed and `--force` was passed, so the bundle filled it instead of replacing it.
  Keys the bundle omitted survived on purpose: this is what keeps `extends: "_base"`.
- **A rule never fires even though the draft clearly breaks it** — run
  `voicepack lint -p P` and look for "will never run". A `detect` block with an
  unsupported `type`, or `forbiddenWords` with no words, is ignored at check time,
  so the draft scores 100 while violating the rule. Fix the rule, not the draft.
- **`pack` warns "no rules and no exemplars"** — the profile is still a scaffold.
  The pack is real, well-formed and useless: it holds the base defaults and the
  banned-word list and nothing about this brand. Do **not** write from it, and do
  not treat a clean `check` on the result as evidence of anything. Run
  `voicepack context` — it will say `empty:` and point at `profile-prompt`.
- **`context` says a profile is `empty`** — same thing, caught earlier. Fill the
  profile before writing (§ "Capturing a brand from scratch"). This is the state a
  fresh install is in, and the state it is most tempting to skip past.

## Maintaining this skill

If you change the procedure here, keep the CLI surface in sync and re-run
`voicepack lint --privacy` before committing. Brand data must never enter the
engine repository.

Three invariants are enforced by the test suite rather than by discipline, because
each is the kind that fails silently:

- `INSTALL.md` must contain `install/prompt.txt` **verbatim**, between the
  `BEGIN/END INSTALL PROMPT` markers. Edit one without the other and the suite fails.
- `package.json` must ship `install/`, must list no dependencies, and its scripts
  must point at fixtures that exist. `install-prompt` and `profile-prompt` read that
  directory at runtime, so omitting it from `files` breaks the published package
  while working perfectly from a clone.
- `install/profile-prompt.txt` must keep its `<BRAND_BRIEF>` and `<PROFILE_ID>`
  placeholders, and the detect types it lists must match `DETECT_TYPES` in
  `lib/check.mjs` exactly. The first stops brand data reaching this public repo; the
  second stops the prompt promising models a rule type the linter cannot evaluate.
