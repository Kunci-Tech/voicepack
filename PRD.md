# PRD — Voicepack

**A portable persona engine that stops brand voice from decaying inside AI agents.**

| | |
|---|---|
| **Product** | Voicepack — persona storage, compilation, critique and learning |
| **npm** | `voicepack` (available) |
| **Runtime** | Node ≥ 18, zero runtime dependencies, `npx`-first |
| **First target** | WorkBuddy AI skill (adapters for other agents later) |
| **Repository model** | Public engine repo + private profile data, out of tree |
| **First brand profile** | Kunci Kuppi (data, not the product) |
| **Status** | Phase 0 implemented; 157/157 smoke assertions passing |
| **Version** | 0.6 |
| **Date** | 20 September 2026 |

> **Naming.** The product is generic and intended for open source. "Kunci Kuppi" is a *brand profile* — a folder of data inside Voicepack, not the product's identity. Any business can drop in its own profile.

> **Changelog — v0.6.** Added §5.7: how an empty profile gets filled —
> `install/profile-prompt.txt` (a two-pass interview prompt), `voicepack
> profile-prompt`, and `voicepack apply` (a bundle importer with path and
> provenance guards). The intake prompt is generic and carries `<BRAND_BRIEF>` /
> `<PROFILE_ID>` placeholders, so no brand data enters the public engine tree.
> `DETECT_TYPES` became an exported contract that `lint` reports against and the
> test suite checks the prompt against, after defect 6 below showed that a rule
> whose predicate cannot run scores a violating draft at 100/ship. `context` and
> `pack` now report an empty profile instead of handing over a clean-looking
> skeleton (defect 10). Principle 18 added. Eight defects found by testing (6–13)
> recorded; assertions 89 → 157.

> **Changelog — v0.5.** Added §3.6 (the interface is agent-first) and principles
> 15–17. Installation became a paste-able prompt rather than a procedure
> (`install/prompt.txt`, `INSTALL.md`, `voicepack install-prompt`). The CLI output
> contract and exit codes are now specified, and the appendix was rewritten against
> the implemented surface — it had drifted to list commands that do not exist.
> Three invariants moved from prose into tests: zero dependencies, engine tree free
> of brand data, and install-prompt/`INSTALL.md` parity.

---

## 1. Problem

Every time an AI agent writes — a caption, a blog post, a launch announcement — the model's default voice wins. It drifts toward generic marketing English: *"We're excited to announce…"*, *"In today's fast-paced world…"*, *"delve"*, *"elevate"*. The output is technically correct and completely off-brand.

Today the fix is manual. Someone re-explains the voice in the prompt, gets 80% of the way there, edits the rest by hand. Then the next session starts from zero, because the prompt was never stored anywhere.

**The core failure is not that the AI can't write. It's that brand voice is treated as a one-off instruction instead of a persistent, versioned, channel-aware asset.**

### Jobs to be done

| When… | I want to… | So I can… |
|---|---|---|
| I open any AI editor | have the voice already loaded | write without re-explaining myself |
| I ask for a Threads post vs. a blog post | get different structure and tone for each | stop hand-editing the format every time |
| I read a draft | know *specifically* which rules it broke | fix it in 10 seconds, not rewrite it |
| I see a post that nailed it | capture that style as a rule | compound my voice over time |
| A post goes viral | learn *why* and adjust | ride the wave instead of guessing |
| I switch editors | keep the exact same voice | not be locked into one tool |

### Non-goals

- Not an auto-poster or scheduler. Voicepack produces and critiques text; publishing stays manual.
- Not a content calendar or campaign planner.
- Not a fine-tuned model. No training runs.
- Not a chatbot personality. This is *authorial voice*, not conversational roleplay.

---

## 2. Design Principles

These are the opinions the architecture is built on. Violating them breaks the product.

1. **JSON is the database, not the prompt.** Dumping a growing JSON file into a prompt makes adherence *worse* as it gets better. There must be a compile step that emits a token-budgeted slice.
2. **The agent never reads the persona store.** It calls a CLI and receives a pack. All retrieval happens out of context. This is the single biggest token decision in the system (§4).
3. **Exemplars beat adjectives.** Three real posts that nailed the voice outperform thirty rules saying "be warm but not cheesy." Every rule carries a real example or it's decoration.
4. **The critique pass is the actual anti-drift mechanism.** Storage alone changes nothing. Generate → critique against the rubric → revise.
5. **Nothing is learned without human approval.** The system proposes diffs; you merge them. Auto-merge turns a persona into mush by averaging.
6. **A pattern from one post is a candidate, not a rule.** Promotion requires ≥3 independent instances. This is what stops a single viral post from hijacking the brand.
7. **Zero runtime dependencies. Node only.** If installing Voicepack can break someone's machine, they won't install it. `npx voicepack` must be the entire setup (§3.3).
8. **The engine must be agent-agnostic.** Core data and logic in plain JSON + plain Node. Each AI editor gets a thin adapter.
9. **The engine and the data live in different repositories.** The public repo contains no brand data, ever. This makes a pull request safe by construction and `git pull upstream` conflict-free (§3.5).
10. **Synthesize style, never reproduce content.** A captured post yields a *pattern* — structure, rhythm, devices — not lifted text. Someone else's post can teach a rule; it can never become an exemplar (§7.3).
11. **`npx` is the interface.** Every command is `npx voicepack …`. No global install, no clone required, no build step.
12. **Voice is namespaced per profile.** Profiles inherit from a shared base but never share exemplars.
13. **Capture is assisted, not bulk-automated.** Browser bridge capture reads through your own authenticated session — human-scale, read-only, never a crawler (§8).
14. **The bridge is an ingest adapter, not a core dependency.** The store and the write-time loop must work with it absent.
15. **The interface is designed for an agent, not for a person.** The human never types `voicepack`. Output is parseable records with meaningful exit codes, `pack` separates artefact from diagnostics, and nothing blocks on input (§3.6).
16. **The user never opens a terminal.** Installation is a block of text the user pastes into the agent they already use; that agent performs every step and reports back in plain language (§3.6).
17. **A promise that is not tested is not a promise.** Zero dependencies, engine/data separation, install-prompt/INSTALL.md parity, the genericness of the intake prompt, and `apply`'s path and provenance guards are asserted by the test suite, because each one fails silently otherwise (§3.5, §3.6, §5.7).
18. **A check that cannot run is indistinguishable from a check that passes.** A `detect` block the linter cannot evaluate, and an empty profile that packs into defaults, both produce output identical to the working case — a clean check and a shipping draft. So an unsupported type is reported rather than ignored, `DETECT_TYPES` is exported and tested against the prompt, and an empty profile is named as empty instead of handed over as a valid pack (§6, §5.7).

---

## 3. Architecture

### 3.1 Options considered

**Option A — Flat JSON injected into the prompt** *(the initial idea)*

One `persona.json` per brand, pasted into the system prompt.

- ✅ Zero tooling. Works on day one.
- ❌ Token cost grows linearly with quality. At 3,000 tokens the model ignores most of it.
- ❌ No channel awareness, no validation, no versioning, no learning loop.
- ❌ Cannot tell you *which* rule a draft broke.
- **Verdict:** correct as a starting file, wrong as an architecture. It breaks exactly when the persona gets good.

**Option B — Persona Engine: JSON store + compiler + critic + adapters** ← **recommended**

JSON is the source of truth. A compile step assembles a ~700-token voice pack for the specific job. A critic scores drafts against the rubric. Thin adapters make it portable.

- ✅ Adherence stays high as the store grows — the agent never reads the store.
- ✅ Every rule is addressable, versionable, traceable to its source.
- ✅ Learning is a reviewable diff, not a silent mutation.
- ❌ Requires building a small CLI.

**Option C — Fine-tune a model, or RAG over a vector store of past posts**

- ❌ Style is a few-shot problem, not a retrieval problem. Retrieving "similar posts" returns posts about *similar topics*, not posts in the right *voice*. Topic is the wrong axis (§4.3).
- ❌ Expensive, slow to update, and the persona becomes a black box you can't audit or roll back.
- ❌ Kills portability — a fine-tune per editor.
- **Verdict:** no.

### 3.2 Recommended architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  WRITE-TIME                                                      │
│                                                                  │
│   WorkBuddy skill   (adapters for Cursor / ChatGPT come later)   │
│              │                                                   │
│              ▼                                                   │
│     ┌──────────────────┐        ~700 tokens back                 │
│     │ npx voicepack    │ ──────────────────────────►  agent      │
│     │ pack / check     │ ◄──────────────────────────  writes     │
│     └────────┬─────────┘                                         │
└──────────────┼───────────────────────────────────────────────────┘
               │ reads/writes — NEVER enters agent context
┌──────────────▼───────────────────────────────────────────────────┐
│  PERSONA STORE  (plain JSON + Markdown, git-versioned)           │
│                                                                  │
│   brand.json   voice.json   channels/*.json   lexicon.json       │
│   rules.json   exemplars/**   index.json (cache)   history/      │
└──────────────▲───────────────────────────────────────────────────┘
               │ writes (after approval only)
┌──────────────┴───────────────────────────────────────────────────┐
│  LEARNING LOOP                                                   │
│                                                                  │
│   capture ──► propose diff ──► HUMAN APPROVES ──► merge ──► bump │
│      ▲                                                           │
│      └── teach · official APIs · browser bridge · manual paste   │
└──────────────────────────────────────────────────────────────────┘
```

The critical difference from a naive design: **the store sits outside the agent's context entirely.** The agent sees a command and 700 tokens. It never sees the JSON.

**Why this maps onto the skill format.** Skills use three-level progressive disclosure: metadata always loaded → `SKILL.md` on trigger → bundled resources on demand. Voicepack uses the platform's own retrieval model as its compiler, and level 3 stays unloaded because the CLI does the reading instead.

### 3.3 Runtime and distribution

**Node only. Zero runtime dependencies.**

```
npx voicepack pack --channel instagram --intent launch
```

That is the entire setup. No install step, no virtualenv, no global binary, no lockfile to reconcile.

**Why not Python.** A skill that requires Python has to solve, on someone else's machine: which interpreter, which version, `pip` vs `pipx` vs `uv` vs `poetry`, a virtualenv that survives shell restarts, and native build failures for anything with a C extension. Each of those is a support burden and an install-time failure the author cannot debug remotely. Node is already present — WorkBuddy requires it, and the browser bridge requires it. `npx` resolves and caches the package with no state on the user's machine.

**Version floor: Node ≥ 18.** Everything Voicepack needs is built in — `node:fs/promises`, `node:path`, `node:crypto`, `structuredClone`, and ESM with top-level await. No `node_modules`, ever.

**Note on dev tooling.** Graft, used for maintaining this repo (§4.4), requires Node ≥ 22.12. That is a *development* requirement and must not raise Voicepack's runtime floor. CI should test the CLI on 18.

**Distribution.** `npx voicepack` from npm is the primary interface. A clone (`node bin/voicepack.mjs`) is supported for contributors and air-gapped use.

**Installation is a prompt, not a procedure.** The user does not run the commands above. They paste one block of text — `install/prompt.txt`, also printed by `voicepack install-prompt` — into the agent they already write with, and that agent performs the install: Node check, engine fetch, data scaffold, wiring, skill install, preflight. The user answers at most one question (the repository URL) and reads a summary. The full reasoning is in §3.6.

**Where the data lives.** The engine does not ship with brand data and never writes it into its own tree. `npx voicepack` resolves a *data directory* at runtime, in this order:

| Order | Source | Use |
|---|---|---|
| 1 | `--dir <path>` | explicit, per-command |
| 2 | `VOICEPACK_DIR` env | per-shell or CI |
| 3 | `voicepack.config.json` in cwd | per-project |
| 4 | `~/.voicepack` | global default |

`npx voicepack init` scaffolds a data directory — profiles, `_base`, a starter profile, `captures/`. It does **not** scaffold engine code, and it does not clone anything. That is the whole setup for a new user: one command, no repo.

### 3.4 Repository layout

Two trees, deliberately separate.

**The engine — public, forkable, PR-able. Contains no brand data.**

```
voicepack/                          # PUBLIC REPO
├── SKILL.md                        # WorkBuddy skill: procedure + trigger
├── README.md
├── INSTALL.md                      # the paste-this prompt, for people
├── package.json                    # no "dependencies" key at all
├── bin/voicepack.mjs               # entry point, shebang, command dispatch
├── lib/
│   ├── util.mjs                    # tokens, fs, deep merge, YAML-lite
│   ├── render.mjs                  # agent-first output: records, exit codes, errors
│   ├── store.mjs                   # resolve + load + validate + inherit
│   ├── pack.mjs                    # compile a budgeted voice pack
│   ├── check.mjs                   # deterministic linter + score
│   ├── lint.mjs                    # integrity, staleness, contradiction, privacy
│   ├── doctor.mjs                  # preflight: node, data, bridge
│   ├── ingest.mjs                  # recipes, capture, parse, synthesize
│   └── commands.mjs                # init, teach, diff, merge, list, history
├── install/prompt.txt              # the bootstrap prompt — single source of truth
├── ingest/recipes/{threads,instagram,generic}.json
├── adapters/
│   ├── cursorrules.template
│   └── chatgpt-instructions.md
├── examples/
│   ├── demo/                       # committed fixture — CI runs against this
│   ├── draft-bad.md                # a draft that trips 2 hard + 5 soft rules
│   ├── draft-good.md               # a draft that scores 100
│   └── captured-post.txt           # a manual-capture source for the ingest test
└── test/smoke.mjs                  # 89 assertions, no framework
```

**Build status (Phase 0 complete).** The CLI runs against Node ≥ 18 with zero
dependencies and **89/89 smoke assertions passing**. Working: `context`,
`install-prompt`, `init`, `doctor`, `recipes`, `list`, `pack`, `check`, `teach`,
`capture`, `ingest`, `diff`, `merge`, `lint` (including `--privacy`), `history`,
`rollback`.

Four design details were settled during the build and are worth recording:

- **`check` is entirely deterministic and needs no model.** Layer 2 (register and
  drift) is the agent's own judgement, written into `SKILL.md` as a required step.
  This is what makes Phase 0 shippable with no API key.
- **The merge guard is enforced in code, not documentation.** Attempting
  `merge --as exemplar` on a third-party candidate exits 1 with an explanation.
  A guardrail that lives only in a README is not a guardrail.
- **Output is agent-first, and the exit codes are part of the contract.** The
  `1`/`2` split (§3.6) is the piece that most affects how an agent behaves, because
  it is the difference between "fix and retry" and "stop, the answer is no".
- **Six invariants are tested rather than trusted**: zero dependencies, engine
  tree free of brand data, `install/prompt.txt` identical to the copy embedded
  in `INSTALL.md`, `install/profile-prompt.txt` keeping its `<BRAND_BRIEF>` /
  `<PROFILE_ID>` placeholders and listing exactly the detect types the linter
  supports, `apply` refusing path traversal and third-party exemplars, and an
  empty profile being reported as empty rather than packed silently. Each fails
  silently in production otherwise.

**Thirteen defects found by testing, not by review.** Worth recording, because each
was invisible on inspection and would have shipped:

1. **A dangling exemplar heading.** At `--max-tokens 300` the compiler emitted
   "HERE IS THE VOICE" with nothing beneath it — worse than omitting the heading,
   since it reads as a truncated pack.
2. **A privacy-scan false positive.** The scan flagged every `.md` in the engine
   tree, including its own adapter docs, so it was noise rather than a signal. Fixed
   to distinguish by frontmatter content, then verified with a planted leak.
3. **The entire demo fixture was gitignored.** `profiles/` is unanchored, so it also
   matched `examples/demo/profiles/` — meaning CI would have had nothing to validate
   a pull request against. Root-anchored to `/profiles/`.
4. **The demo `_base` lexicon had drifted from what `init` scaffolds** by twelve
   entries, including the whole uncontracted announcement cluster. A fresh profile
   scored "We are thrilled to announce…" at 100/ship.
5. **`install/` was missing from `package.json` `files`.** `install-prompt` reads
   that file at runtime, so the command worked perfectly from a clone and would have
   broken for everyone installing from npm.
6. **`forbiddenWords` never fired.** The install prompt documented the field as
   `"value"`, like every other detect type; the code read `"words"`. A draft using a
   hard-banned word therefore scored **100/ship** against a rule written to catch it.
   This is the worst defect in the list, because the failure is invisible from both
   ends and the artefact that was wrong is the one a model is told to trust.
7. **`apply --force` destroyed the scaffold.** It replaced JSON files wholesale, so
   importing a bundle that answered only `identity` silently dropped
   `extends: "_base"` — detaching the profile from the base lexicon and channel rules
   with no error anywhere. Now filled rather than replaced (§5.7).
8. **A missing exemplar reported as `undefined`.** `loadExemplars` built its
   "missing" record without a `rel` field, which is exactly what the caller printed:
   `references a missing exemplar file: undefined`. The path was lost at the one
   moment it was the whole point of the message.
9. **An unsupported `detect.type` passed silently.** `lint` had no opinion on it, so
   a rule whose predicate could never run looked identical to one that always passed.
10. **An empty profile packed into a clean-looking skeleton.** Found by executing the
    install prompt end to end rather than reading it. A freshly scaffolded profile
    has no rules and no exemplars, yet `pack` returned a well-formed 250-token pack
    (base defaults plus the banned-word list), `context` pointed at `pack` as the
    next step, and `check` passed a draft written from it — because there was nothing
    in the pack to violate. An agent would have written generic prose and reported
    success, which is precisely the outcome the tool exists to prevent. Both commands
    now report the profile as empty and redirect to the intake prompt. `pack` keeps
    exit `0`: the artefact is valid, so the write loop must not break — the
    *instruction* is what was wrong.

Defects 6, 9 and 10 share a shape: **a check that cannot run is indistinguishable
from a check that passes.** 6 and 9 are the same bug in two places, which is why
`DETECT_TYPES` is now exported, reported against by `lint`, and tested against the
prompt. 10 is that shape applied to the whole pipeline rather than one rule: an
empty profile produces output that is structurally identical to a working one.
None of the three was found by reading code. 6 and 9 were found by writing a draft
that deliberately breaks a rule and asserting the score drops; 10 was found by
executing the install prompt as an agent would.

Defects 11–13 were found the same way, by compiling the **first real brand profile**
and reading the result. All three produced a well-formed pack that fit its budget
and passed every existing test.

11. **The banned-word list was dropped from the pack.** Lexicon sat below moves in
    the budget walk, and ten moves with examples is most of a 700-token budget — so
    the block `lint` itself calls "the highest-leverage artefact in the store" was
    the one that got dropped. Moves are now truncated to fit rather than taken
    first-come-first-served, and lexicon moved above them. A partial move list plus
    the banned words beats a full move list without them; the old code chose the
    latter without ever comparing the two.
12. **A sentence-shaped `openingMove` was spliced into `open with …`.** Models write
    that field as a full instructive sentence about as often as a short phrase, and
    the template assumed the phrase. The output read
    `Rhythm: max 3 lines per paragraph. open with Start from something real: an
    observation, … Avoid opening with a generic promotional claim.. close with End
    simply. … already lands..` — doubled full stops, a forty-word "rhythm" line, and
    the instruction buried inside a list it does not belong to. They now get their
    own `OPEN:` / `CLOSE:` lines, which reads correctly whichever shape arrives.
13. **The banned-word list printed its duplicates.** `_base` ships a generic aiSlop
    list and the profile adds `brandSpecific`; a brand that bans "elevate" is
    banning something the base already has, and `deepMerge` concatenates arrays. Six
    words appeared twice, spending budget restating a rule — in the one section
    where every token is supposed to be load-bearing.

The pattern across all thirteen: **none was found by reading code, and the last
four were found only after a real profile existed.** A fixture written to exercise
the compiler will exercise the paths its author already thought about. The
defects live in the paths nobody thought about, and a real user's data is the only
thing that visits them.


**The data — private, never forked, never PR'd.**

```
<dataDir>/                          # PRIVATE — separate repo or plain directory
├── profiles/
│   ├── _base/                      # inherited by every profile
│   │   ├── voice.json
│   │   ├── lexicon.json
│   │   └── channels/*.json
│   └── kunci-kuppi/
│       ├── brand.json
│       ├── voice.json              # overrides only
│       ├── lexicon.json            # overrides only
│       ├── channels/*.json
│       ├── rules.json
│       ├── exemplars/<channel>/*.md
│       └── learnings/log.jsonl
├── captures/                       # verbatim raw page data, gitignored
├── candidates/                     # synthesized, awaiting approval
└── history/                        # release notes + tags
```

### 3.5 Repository model: fork, upstream, and pull requests

The requirement is: fork it, add your own personas, keep pulling engine updates, and send fixes upstream. That only works if **engine code and brand data never share a tree.** If profiles live inside the fork, then `git pull upstream main` fights your data and any PR risks shipping your business voice to the world.

So the model has two modes and one guarantee.

**Consumer mode — no fork at all.** Run `npx voicepack@latest` and point it at your private data directory. Engine updates arrive the moment npm publishes. Nothing to maintain.

**Contributor mode — fork the engine, keep the data outside.**

```bash
gh repo fork <upstream> --clone       # engine fork
cd voicepack && git remote add upstream <upstream-url>

npx voicepack init --dir ~/voicepack-data    # data lives elsewhere, always

git fetch upstream && git merge upstream/main # never touches ~/voicepack-data

git checkout -b fix-pack-budget
# ... change lib/pack.mjs ...
gh pr create --repo <upstream>                # diff contains engine code only
```

**The guarantee: a pull request cannot contain a persona.** Because the data is out-of-tree, it is not a matter of remembering to exclude it — it is not in the repository to begin with. That is why the separation is an architectural rule (principle 9) and not a `.gitignore` line.

Three supporting mechanisms:

- **`examples/demo/`** is a small committed fixture with invented data. CI runs `pack`, `check` and `lint` against it, so **a pull request is validatable without access to anyone's private profiles.** This is what makes outside contributions possible at all.
- **`captures/` and `candidates/` are gitignored** in the data repo by default. They hold verbatim third-party content; committing them to a public repo would be a copyright problem, not just a privacy one.
- **`voicepack lint --privacy`** scans the engine tree for accidental profile data — a stray `profiles/` directory, a committed `.md` exemplar, a lexicon with brand words in it. Run it in CI and as a pre-push hook.

### 3.6 The interface is agent-first

The user of this tool is an agent. The person never types `voicepack`. That
reframing changes what "good UX" means, and it is worth stating because the
default instinct — a friendly table with colour — is actively worse here.

**The command surface is an interface contract, not a UI.** Every rule below exists
because of a specific way an agent fails:

| Design | The failure it prevents |
|---|---|
| flat `key: value` records, terminated by `next:` | prose output has to be interpreted; a record stream can be parsed and acted on |
| `pack` writes only the pack to stdout; diagnostics to stderr | an agent that captures stdout gets the artefact with no commentary mixed in |
| exit `1` (answer is no) distinct from exit `2` (you called it wrong) | a single non-zero code teaches the agent to retry refusals, burning turns |
| every error carries `next:` | an agent told what broke but not what to do will guess |
| no ANSI, ever | colour is invisible to a human reading a log and a parsing hazard to a model |
| nothing blocks on stdin; `--stdin` is explicit | a forgotten flag becomes a hang instead of an error, and a hang is unrecoverable |
| `voicepack --help --json` publishes commands and exit codes | the contract can be read rather than inferred from trial and error |
| `voicepack context` orients in one call | six exploratory commands to find the profile name is six wasted round-trips |

The same reasoning forbids `process.exit()` after a pipe write. It does not flush
pending output, so the caller can receive a truncated pack or a truncated JSON
document. That is strictly worse than an error, because nothing signals the
truncation — the agent simply reasons confidently over half a document. Commands
set `process.exitCode` and return instead.

**Installation is a prompt, not a procedure.** The second half of the same
principle: if the agent runs the commands, the user should never be handed a
terminal. So the bootstrap path is a single block of text — `install/prompt.txt`,
printed by `voicepack install-prompt` — which the user pastes into whichever agent
they already use. That agent checks Node, fetches the engine, scaffolds the private
data directory, wires it up, installs its own instructions, and runs preflight. The
user answers at most one question (the repository URL) and reads a summary.

Two consequences worth naming:

- **The prompt is a distributed artefact and therefore has a drift risk.** It is
  documented twice — as the raw file an agent can fetch, and inline in `INSTALL.md`
  so a person can read it without leaving the page. The test suite asserts the two
  are byte-identical between `BEGIN/END INSTALL PROMPT` markers, so editing one
  without the other fails the build. Documentation drift is normally invisible;
  here it is a test failure.
- **`install/prompt.txt` must ship in `package.json` `files`.** The command reads
  it from the engine tree at runtime, so omitting it produces the worst class of
  bug: works perfectly from a clone, breaks for everyone who installed from npm.
  The suite asserts the `files` array covers it, that no dependencies exist, and
  that the scripts point at fixtures that are really there.

---

## 4. Context and Token Architecture

This is the section that decides whether the system survives growth. Everything else is bookkeeping.

### 4.1 The CLI is a context firewall

The agent never reads the persona store. It runs one command and receives a budgeted pack.

```
BAD    agent reads voice.json + rules.json + channels/instagram.json + 5 exemplars
       -> 8-15k tokens, and it pays this again every session

GOOD   agent runs:  npx voicepack pack --channel instagram --intent launch
       -> ~700 tokens, and the agent never learns how big the store is
```

Context cost becomes **O(pack size), constant** — independent of store size. The answer to *"what if the JSON gets too big?"* is that it can grow to megabytes and the agent still pays 700 tokens. The store is not in the context window; it is behind a command.

This is why the pack is *assembled to fit* rather than *dumped*. The compiler selects, ranks, truncates and formats to a budget. Everything it discards costs nothing.

### 4.2 Where tokens still leak

Constant pack size does not mean constant cost everywhere. Three leaks, each with a specific fix:

| Leak | Why it happens | Fix |
|---|---|---|
| **The pack grows** | Rules accumulate; more exemplars qualify | Hard token budget (700 target / 1,200 cap). Rank by strength, confidence and performance, then truncate. Report what was dropped in `--verbose` |
| **The critique grows** | A bad draft breaks 20 rules; each violation carries evidence | Cap at the top 5 by severity. Truncate `evidence` to the offending span, never the paragraph. `--quiet` returns score + top 3 only |
| **The agent reads the store anyway** | Habit, or a vague skill instruction | `SKILL.md` states it explicitly: *never read `persona/` directly — always go through the CLI.* Also enforced by keeping the store out of the paths the skill points at |

The third is the one that quietly ruins the design. It must be an explicit, written prohibition, not an inference.

### 4.3 Indexing: facet, not similarity

The retrieval axis for voice is a **`WHERE` clause, not a nearest-neighbour search**. You do not want "posts about sourdough" — you want "the rules and exemplars that apply to Instagram + launch, ranked by performance." Topical similarity is actively the wrong axis: it would surface a badly-written post about the right topic over a brilliantly-written post about a different one.

So the index is a **facet manifest**, not a vector store.

| Store size | Retrieval strategy |
|---|---|
| **< ~200 exemplars** | **No index.** `channels/*.json` already lists its own exemplars. Read the list, read the selected files. |
| **> ~200 exemplars** | **`index.json`** — one flat manifest: `{id, channel, intent, tags, performance, tokens, path}`. Read one small file (~10–30 KB), then read only the 2-3 exemplar files actually selected. Without it, the CLI would parse 200+ frontmatters per call. |

The index is roughly 60 lines of Node with no dependencies, rebuilt incrementally on `teach` and `merge`.

**An index is a cache, never a source of truth.** It must be deletable and regenerable from the store at any time, exactly like graft's own graph. If `index.json` is ever the only place a fact lives, that is a bug.

**Why not BM25 or embeddings.** For v1, neither. Facet filtering plus explicit weights (performance, recency, confidence, strength) covers the retrieval need. If `learnings/` grows past a few thousand entries, add a ~120-line lexical scorer for the one genuinely fuzzy query — *"have we seen something like this rule before?"* — when proposing a new rule. Still zero dependencies, still no vectors.

**The convergence worth noting:** graft's README independently rejected embeddings for the same structural reason — *"no embeddings, no similarity search, no index to keep warm."* Different problem, same conclusion. When two systems arrive at the same architecture from opposite directions, the architecture is probably right.

### 4.4 Evaluating graft

The question was whether graft could serve as the indexing layer. It was worth checking properly, because it is already installed and trusted on this machine (v0.18.0).

**Verdict: right tool, wrong layer. Use it — for the codebase, not the persona.**

**What graft actually is.** A local context engine that parses *source code* with tree-sitter and writes a graph of typed nodes as linked markdown. Queried via `graft ask | grep | callers | map | skeleton`, exposed as six MCP tools (`graft_find_code`, `graft_file_api`, `graft_trace_calls`, `graft_find_all`, `graft_repo_map`, `graft_check_freshness`). Its own help text is unambiguous: *"Build a repo's context graph as linked markdown, and keep it in sync with the **code**."*

**Three reasons it cannot serve persona retrieval:**

1. **It indexes code, not content.** Its language list is 23 *programming* languages. The README states: *"A file whose language isn't listed is skipped, not indexed."* **Markdown and JSON are not on the list.** The persona store is JSON plus Markdown exemplars. Graft would index `lib/pack.mjs` and skip every single rule and every single exemplar — the exact data we need it for.

2. **The retrieval shape is wrong.** Graft answers *"where in the code is X, and what does it do?"* and returns nodes with `file:line`. Voice retrieval needs *"which 3 of my 400 exemplars best represent this channel and intent?"* — a weighted facet filter. Graft has no concept of engagement, recency, confidence, channel or intent.

3. **It would violate principle 7.** It adds a dependency and a build step to a system whose entire value proposition is `npx voicepack` working on a fresh machine with only Node. The pack must never depend on a graph having been built.

**Where graft genuinely belongs: this repository, at development time.**

Voicepack will be a non-trivial Node codebase — CLI, facet index, inheritance resolver, recipe engine, offline parser, tests. Graft's published numbers are real and its headline failure mode is precisely the one we would hit: on SWE-bench Verified, the baseline *"patches one file and misses its siblings"* — 1 of 5 required files, breaking 18 previously-passing tests. Graft scored +12 points correctness, −23% tokens, −32% wall-clock across 50 instances by not making that mistake.

So: run `graft init` in the voicepack repo. It is already installed, registered in `~/.workbuddy-ai/mcp.json`, and trusted. It costs nothing at runtime because it never touches the persona store — different directory, different job.

| | Persona retrieval | Voicepack's own codebase |
|---|---|---|
| Tool | `voicepack pack` — facet filter over JSON | graft — tree-sitter graph over `.mjs` |
| When | Every draft, at runtime | Development and maintenance only |
| Data | Rules, exemplars, lexicon | CLI, lib, parsers, tests |
| Dependency | Zero, in the shipped product | Dev-only, never shipped |

**One caveat to carry forward:** graft needs Node ≥ 22.12; Voicepack ships for Node ≥ 18. Do not let the dev tool raise the runtime floor — CI must test on 18.

---

## 5. Data Model

Five concerns, five files. Each independently editable and diffable.

### 5.1 `brand.json` — who we are

```json
{
  "brandId": "kunci-kuppi",
  "extends": "_base",
  "version": "1.0.0",
  "identity": {
    "name": "Kunci Kuppi",
    "category": "Artisan Bakehouse with Coffee",
    "oneLiner": "Bakery is the moat; coffee is the magnet.",
    "founded": "2024-01-11",
    "home": "Licin, Banyuwangi, East Java"
  },
  "audience": {
    "primary": ["Banyuwangi locals who treat the cafe as a third place",
                "Ijen-bound travellers looking for something real"],
    "secondary": ["Jakarta/Surabaya weekenders", "local F&B operators watching us"],
    "whatTheyWant": ["craft they can taste", "a place that feels like home",
                     "to feel let in on something, not sold to"]
  },
  "pov": {
    "worldview": "Small, careful, repeated work beats big gestures.",
    "tensions": ["craft vs. scale", "local vs. tourist", "homey vs. premium"],
    "alwaysChampions": ["local producers", "the people who make things by hand"],
    "neverTakes": ["cheap shots at competitors", "hustle-culture bragging",
                   "apologising for being small"]
  },
  "values": ["kaizen", "local sourcing", "authenticity", "transparency", "community"],
  "codeSwitching": {
    "default": "id",
    "allowEnglish": ["product names", "technical terms", "punchlines"],
    "never": ["forced slang", "translated idioms", "corporate English"]
  }
}
```

### 5.2 `voice.json` — how we sound

```json
{
  "signature": {
    "person": "first-plural",
    "formality": 0.35, "warmth": 0.8, "playfulness": 0.6,
    "humility": 0.7, "salesPressure": 0.15
  },
  "mechanics": {
    "avgSentenceWords": 9, "maxSentenceWords": 22, "maxLinesPerParagraph": 3,
    "openingMove": "concrete detail or number, never a claim",
    "closingMove": "an open question or an invitation, never a hard CTA"
  },
  "moves": [
    { "id": "mv-001", "text": "Name the person who made the thing.",
      "example": "Bu Sri pulled the first tray at 5:40." },
    { "id": "mv-002", "text": "Lead with the number, not the adjective.",
      "example": "5,223 bagels this year." }
  ],
  "never": [
    { "id": "nv-001", "text": "No announcing announcements.",
      "bad": "We're excited to announce…" },
    { "id": "nv-002", "text": "No superlatives about ourselves.",
      "bad": "the best bagels in Banyuwangi" }
  ]
}
```

### 5.3 `channels/<channel>.json` — how we sound *here*

```json
{
  "channel": "instagram",
  "version": "1.0.0",
  "constraints": {
    "maxChars": 2200, "hookWindowChars": 125,
    "hashtags": { "min": 3, "max": 6, "style": "lowercase-mixed" },
    "emojiPerPost": { "max": 2, "allowed": ["🥐", "☕", "🔑"] }
  },
  "structure": { "beats": ["hook", "context", "substance", "invitation"],
                 "lineBreaks": "double", "ctaStyle": "soft-question" },
  "toneOverrides": { "playfulness": 0.7, "formality": 0.2 },
  "exemplars": [
    "exemplars/instagram/2026-08-14-bagel-drop.md",
    "exemplars/instagram/2026-07-02-roku-10000.md"
  ],
  "rules": [
    {
      "id": "vp-ig-004",
      "text": "Open with the number, not the claim.",
      "strength": "hard",
      "why": "Audience scrolls; numbers stop thumbs.",
      "example": "5,223 bagels. Zero shortcuts.",
      "source": { "type": "user-teach", "date": "2026-09-19" },
      "confidence": 0.9
    }
  ]
}
```

Each channel carries its own exemplar list, so the compiler never guesses relevance.

### 5.4 `lexicon.json` — words in and out

```json
{
  "signatureWords": ["kaizen", "satu cangkir", "moat", "bakehouse", "pelan-pelan"],
  "banned": {
    "aiSlop": ["delve", "elevate", "unleash", "game-changer",
               "in today's fast-paced world", "look no further", "we're thrilled",
               "nestled in the heart of", "it's not just a … it's a …"],
    "brandSpecific": ["cheap", "best in town", "must-try"]
  },
  "punctuation": { "emDash": "avoid", "ellipsis": "rare", "exclamationMax": 1 }
}
```

The `aiSlop` list is the highest-leverage single artefact in the system. Most "AI voice" problems are a handful of recurring tells.

### 5.5 `exemplars/<channel>/<id>.md` — the real thing

```markdown
---
id: ig-2026-08-14-bagel-drop
channel: instagram
intent: launch
tags: [bagels, craft, team]
performance: { likes: 812, saves: 140, comments: 63, viral: false }
captured: 2026-08-14
provenance: human-written        # human-written | human-approved | ai-assisted
why: "Opens with a number, names the baker, closes on an open question."
---

5,223 bagels since January.

Nobody asked us to make bagels. We just kept making them — 4am trays,
Bu Sri on the bench, dough that refused to cooperate for the first
three months.

That's the whole trick. Show up, fail small, adjust, repeat.

Which one's your regular? 🥐
```

**`provenance` is enforced.** Only `human-written` and `human-approved` text may be promoted into exemplars. AI output that no human edited cannot teach the system its own habits.

The frontmatter is duplicated into `index.json` so the CLI does not parse 200 frontmatters to select 3.

### 5.6 `learnings/log.jsonl` — the audit trail

Append-only. Every event, merged or rejected.

```json
{"id":"L-0042","ts":"2026-09-19T10:22:00+07:00","type":"candidate","channel":"threads","pattern":"Threads posts land better when the first line is under 60 chars and contains no emoji.","evidence":["threads/2026-09-11","threads/2026-09-14","threads/2026-09-17"],"status":"pending"}
{"id":"L-0043","ts":"2026-09-19T10:31:00+07:00","type":"rule","target":"vp-th-007","diff":"+ strength: hard","approvedBy":"founder","status":"merged","version":"1.1.0"}
```

### 5.7 Getting a brand in: the intake prompt and `apply`

Everything above describes a profile that already exists. Filling an empty one is the first thing a user does, and it is the highest-leverage moment in the whole system: a wrong assumption here is written to disk as fact and shapes every draft afterwards. Two artefacts carry that step.

**`install/profile-prompt.txt`** is a prompt the user pastes into a general-purpose model. It is not a form. It works in two passes on purpose: pass 1 asks at most six questions and writes a plain-language description of the voice in under 200 words; pass 2 emits the JSON bundle, and only after the user has confirmed that description. The description is the cheap place to catch a wrong reading of the brand — before it is spread across forty fields.

Two rules override everything else in the prompt:

- **Never invent.** Unknown values come back as `""` / `[]` / `null` and the field name is added to a top-level `_needsInput`. A plausible guess is worse than a blank, because a blank is visibly missing and a guess is not.
- **Never fabricate an exemplar.** Exemplars are copied character for character from real posts, typos and line breaks included, or omitted. An invented exemplar teaches the model a voice the brand does not have, and it is the hardest class of error to notice later.

**The prompt ships generic.** It carries `<BRAND_BRIEF>` and `<PROFILE_ID>` placeholders that `voicepack profile-prompt --brand "…" -p <id>` substitutes at run time. This is not tidiness — this repository is public, and a prompt naming one customer's brand would be brand data in the engine tree, which is the single thing §3.4 exists to prevent. The test suite asserts both placeholders survive, and that the file lists exactly the detect types `lib/check.mjs` can evaluate.

**`voicepack apply`** turns the returned bundle into files. It is not a copy, and every difference exists because the bundle is model-generated and therefore untrusted:

| Guard | Failure it prevents |
|---|---|
| Paths validated segment by segment, confined to the profile | A key of `../../../../.ssh/authorized_keys` writing anywhere on the machine, with output that looks completely normal. |
| Exemplars must be `human-written` or `human-approved` | A bundle is the easiest place in the system to smuggle in someone else's post. `third-party` is refused (exit 1), not warned about. |
| JSON files are **filled**, not replaced | `init` scaffolds `extends: "_base"`. A bundle answering only `identity` would otherwise silently detach the profile from the base lexicon and channel rules. Objects merge; **arrays replace**, so re-applying an updated bundle does not grow `["warmth"]` into `["warmth", "warmth"]`. |
| `_needsInput` / `_inferred` are surfaced | The prompt forbids guessing, so whatever it still could not answer must reach the human as a question, and whatever it inferred must be flagged for review. |
| The result is linted before the command exits | An import that leaves the profile invalid is not a success. `apply` exits 1, and the bundle — not the profile — is the cheap place to fix it. |

`--force` is what fills an existing scaffold: without it, files that already exist are skipped rather than overwritten. There is no hard-replace mode; delete the file first if that is genuinely what you want. The default should be the one that cannot destroy `extends`.

This is the `apply` fill-merge, deliberately distinct from the `deepMerge` used for `extends`. `deepMerge` **concatenates** arrays, which is right when a profile's rules are additive to its base's, and wrong here: re-applying an updated bundle would duplicate every list. Two merge functions with different array semantics is a real cost, paid because one function cannot be correct for both jobs.

---

## 6. The Write-Time Loop

The procedure the skill enforces. Deliberately non-optional.

```
1. RESOLVE   brand + channel + intent
2. PACK      npx voicepack pack --channel C --intent I    -> ~700 tokens
3. DRAFT     write using the pack (never from memory of an earlier turn)
4. CHECK     npx voicepack check --channel C --file draft.md   (deterministic, free)
5. JUDGE     the agent itself assesses register against the pack  (soft rules only)
6. REVISE    fix only the flagged violations
7. SHIP      hand to human; publish manually
```

**Step 3 is where most systems fail.** In a long conversation, an instruction given twenty turns ago is diluted to nothing. The pack must be re-emitted immediately before *every* piece of writing, not once at the session start.

### Two-layer checking

An earlier draft of this PRD left `check` ambiguous about who does the judging. That is a real gap: a Node script cannot assess "does this sound like us," and requiring an API call for a banned-word scan is absurd.

So checking splits in two, and the split is what makes Phase 0 shippable with no API key at all.

| | Layer 1 — deterministic | Layer 2 — judgment |
|---|---|---|
| **Runs in** | `lib/check.mjs`, plain Node | the agent, already in the loop |
| **Cost** | free, instant, offline | free — the agent is already there |
| **Catches** | banned lexicon, char/hashtag/emoji limits, sentence and paragraph length, punctuation, rule regexes | register, generic-CTA smell, drift from the exemplars, "does this sound like a press release" |
| **Output** | `score`, `violations[]`, `verdict` | `voiceDrift[]`, `keep[]` |
| **Data-driven?** | yes — rules carry machine-checkable `detect` predicates | yes — the pack is the rubric |

**Layer 1 is data-driven, not hardcoded.** A rule may carry a `detect` predicate, which is what makes `rules.json` actually enforceable rather than decorative:

```json
{
  "id": "vp-ig-004",
  "text": "Open with the number, not the claim.",
  "strength": "hard",
  "detect": { "type": "regex", "pattern": "^(we'?re|our|kami)\\b", "flags": "i",
              "message": "Opens with a claim instead of a number." }
}
```

Supported `detect.type` values: `regex`, `maxChars`, `minChars`, `maxEmoji`, `maxHashtags`, `minHashtags`, `maxExclamations`, `maxSentenceWords`, `maxParagraphLines`, `forbiddenWords`.

**This list is a contract, not documentation.** `DETECT_TYPES` in `lib/check.mjs` is the single source of truth, and two things depend on it:

- **`lint` reports an unsupported type instead of ignoring it.** A `detect` block whose type the linter cannot evaluate is strictly worse than no `detect` block at all: the rule *looks* machine-checked, so a draft that breaks it scores 100 and ships. The failure is invisible from both ends — the rule author sees a clean check, and the draft author sees a passing draft. `lint` therefore warns `has unknown detect type "X" — it will never run`, and the same warning covers a `forbiddenWords` rule with no words.
- **The install prompt is checked against it by the test suite.** A model writing rules from the prompt must not be promised a type the linter cannot evaluate, and the prompt must not omit a type the linter supports. The suite extracts the types the prompt lists and asserts set equality with `DETECT_TYPES`, so adding a type means editing both in one commit.

All types take their payload under `"value"` except `forbiddenWords`, which takes `"words"`. That inconsistency is historical, but the cost of it is not: every other type uses `value`, so `value` is the natural guess, and a guessed-but-wrong field name produced a rule that silently never fired — a draft using the forbidden word scored **100/ship**. `forbiddenWords` now accepts both spellings, with `words` canonical. Tolerating the near-miss is the right call here precisely because the alternative is a silent no-op.

For the same reason, a violation whose `detect.message` is an empty string falls back to the rule text. The schemas hand models `"message": ""`, and `d.message ?? rule.text` keeps the blank — so the report read `violation: HARD vp-instagram-001 | ` with nothing after the pipe, at exactly the moment the agent needs to know what broke.

**Layer 1 also runs against rules that carry no `detect`** — it falls back to the channel's declared constraints and the lexicon. So a profile with zero predicates still gets useful checking on day one, and gains precision as predicates are added.

**Layer 2 is a skill instruction, not a command.** `SKILL.md` tells the agent: after running `check`, assess the draft against the pack yourself and report `voiceDrift` and `keep`. No second model, no API key, no extra latency — the judgment layer is the agent that was already going to read the output.

### The voice pack

Compiled, plain text, token-budgeted. Target 700 tokens, hard cap 1,200.

```
# KUNCI KUPPI — INSTAGRAM / launch
Voice: warm, plain-spoken, first-person plural. Numbers before adjectives.
Rhythm: short sentences (~9 words). Max 3 lines per paragraph. Generous line breaks.

HARD RULES (never violate)
1. Open with a concrete number or detail — never a claim. (vp-ig-004)
2. No announcing announcements. (nv-001)
3. Max 2 emoji, from: 🥐 ☕ 🔑 (ig-001)
4. 3-6 lowercase-mixed hashtags at the end. (ig-003)

STRUCTURE: hook -> context -> substance -> open invitation
CLOSE WITH: a question, not a CTA.

NEVER USE: delve, elevate, unleash, game-changer, we're thrilled,
nestled in the heart of, "it's not just a X, it's a Y". Avoid em-dashes.

HERE IS THE VOICE (do not copy, match the register):
-- exemplar 1 --
5,223 bagels since January.
Nobody asked us to make bagels. We just kept making them — 4am trays,
Bu Sri on the bench, dough that refused to cooperate for the first three months.
That's the whole trick. Show up, fail small, adjust, repeat.
Which one's your regular? 🥐
-- exemplar 2 --
<…>
```

Everything above is machine-generated from the JSON. Nothing is hand-maintained in the pack.

### The critique

`voicepack check` returns structured output, not prose:

```json
{
  "score": 78,
  "verdict": "revise",
  "violations": [
    { "ruleId": "nv-001", "severity": "hard",
      "evidence": "We're excited to announce our new sourdough schedule…",
      "fix": "Lead with the detail. E.g. 'Sourdough comes out at 5:40am now.'" },
    { "ruleId": "vp-ig-004", "severity": "soft",
      "evidence": "Our bagels have been incredibly popular.",
      "fix": "Replace the adjective with the number: 5,223 bagels." }
  ],
  "voiceDrift": [
    { "signal": "generic-cta", "evidence": "Don't miss out — come visit us today!" }
  ],
  "keep": ["Paragraph 2 is exactly the register we want."]
}
```

**Scoring.** A hard violation caps the score at 60. Soft violations deduct 5–10 each. A small bonus applies for register proximity to the channel's exemplars. `verdict` is `ship` (≥85), `revise` (60–84), or `rewrite` (<60).

The `keep` field matters more than it looks — it tells you what *not* to touch during revision, which is how you avoid flattening a good draft while fixing a bad line.

---

## 7. The Learning Loop

Three inputs, one destination: a proposed diff you approve or reject.

### 7.1 Teach (highest signal)

You state a rule in plain language. It is stored with a source and a date.

```bash
npx voicepack teach --channel threads \
  --rule "Threads posts do better when the first line is under 60 characters." \
  --why "Scannable in one glance on mobile." --strength soft
```

Corrections to a draft you just rejected are also teach events — the highest-quality signal in the system, because they are grounded in a specific failure.

### 7.2 Ingest (published posts)

Three sources, in order of preference:

1. **Official APIs** for your own accounts (Instagram Graph API, Threads API). Stable, sanctioned, and they return insights a page read cannot.
2. **Browser bridge capture** — your own posts, competitors' public posts, and one-off viral posts you point at (§8). Read-only, human-scale, never a crawler.
3. **Manual capture** — copy-paste into `captures/`. Always available, never breaks.

All three feed the same pipeline: raw → parse → candidate → human approves → merge. Automation is confined to the reading; the learning still requires a signature.

Weight exemplars by engagement — a post with 3× your median saves is worth more as a teaching example than one that flopped. And your own data is the better signal: `app.kuncikuppi.com` and Supabase hold ordering and loyalty data. Joining "which caption" to "which orders" is something no page read can give you.

### 7.3 Paste a link (the chat-driven flow)

The primary way this gets used is not a CLI session. It is: you are mid-conversation, you see something that nails a style you want, and you paste the link. That flow has to work in one step.

```
you:   https://www.threads.net/@someone/post/ABC123 — learn this, put it in kunci-kuppi/threads

agent: 1. voicepack doctor            -> is the bridge up?
       2. voicepack capture --url ... -> captures/kunci-kuppi/threads/<ts>-abc123.raw.json
       3. voicepack ingest --capture ... --profile kunci-kuppi --channel threads
          -> parses offline, synthesizes a pattern, writes candidates/L-0047.candidate.json
       4. shows you the proposed diff

       PROPOSED (candidate — 1 instance, cannot become a hard rule yet)

       pattern   first line under 60 chars, no emoji, lowercase opener
       evidence  1 post · threads/@someone · captured 2026-09-19
       transfer  structure + rhythm only — no text from the source is stored

       merges as a SOFT signal now. 3 independent instances -> promotable to a hard rule.
       -> npx voicepack merge L-0047
```

**Synthesis is the step that matters, and it must extract a pattern rather than a text.** The candidate records:

| Field | What it holds |
|---|---|
| `pattern` | The transferable rule in plain language — "opens with a bare number, then a two-line context beat" |
| `transfer` | Which axes were extracted: `structure`, `rhythm`, `devices`, `register` |
| `notTransferred` | What was deliberately **not** taken: the topic, the specific phrasing, the author's identity |
| `evidence` | Source URL, capture timestamp, platform, observed metrics |
| `provenance` | `human-written` / `human-approved` / `ai-assisted` / `third-party` |

**The own-content / third-party split is enforced, not advisory:**

- **Your own post** may become an **exemplar** — it is your voice, and the text can be stored.
- **Someone else's post** may only become a **candidate or a rule about structure.** It can never become an exemplar, and its verbatim text is never promoted out of the gitignored `captures/` directory.

This is the right call for two independent reasons. Legally, storing and reproducing a stranger's post to train your brand voice is not defensible. Practically, it is also wrong: an exemplar teaches the model to imitate *that author's* voice including their subject matter, when what you actually wanted was the structural trick. A rule generalizes; a copied post does not.

**Why it lands as a candidate, not a rule.** One post is one data point. The synthesis can say "this pattern exists," but it cannot say "this pattern is yours." It becomes a soft signal immediately — it influences the next draft — and only promotes to a hard rule after three independent instances agree (§7.4).

### 7.4 Viral adaptation

When a post takes off — yours or someone else's — the instinct is "learn this immediately." That instinct needs a brake.

**A single post is evidence, not a rule.** A pattern enters `candidates` with its evidence links. It is promoted to a rule only when ≥3 *independent* instances agree. Until then it can influence drafts as a soft signal, but it cannot become a hard rule.

This is what stops one viral post from rewriting the brand, and it gives a clean answer to "why didn't the system learn that?" — *because we've seen it once.*

Operationally: the post is captured (§8), parsed into a candidate, and lands in `diff` with its source URL attached. It can influence drafts as a soft signal the same day. It cannot become a hard rule until seen three independent times. **Speed to influence, brake on authority** — that is the whole design.

### 7.5 Review

```
$ npx voicepack diff

PENDING LEARNINGS (3)

L-0042  threads   soft   first line < 60 chars, no emoji
        evidence: 3 posts · avg engagement +41% vs. median
        -> voicepack merge L-0042

L-0044  instagram hard?  "one cup at a time" should always be lowercase
        evidence: 1 post · needs 2 more to promote
        -> voicepack merge L-0044 --as candidate

L-0045  blog      soft   open with a scene, not a thesis
        evidence: user-teach · 2026-09-19
        -> voicepack merge L-0045
```

Nothing changes until you run `merge`. Every merge bumps the version and snapshots to `history/`. Every merge is revertible with `voicepack rollback --to 1.0.0`.

---

## 8. Ingestion via Browser Bridge

### 8.1 What the bridge changes

The bridge is an MCP server that drives your **already-authenticated Chrome** through an unpacked extension over a local WebSocket (port 8766 for WorkBuddy, 8765 for Antigravity).

The mechanism that matters: **it never logs in.** No credential is handed to a script and no sign-in flow runs — it attaches to a session that already exists. That single property is what makes capture viable where a crawler is not.

| | Headless crawler | Browser bridge |
|---|---|---|
| Session | Must authenticate | Already authenticated |
| Credentials | Scripted or stored | Never touched |
| Login / 2FA / CAPTCHA | Blocked or fragile | Never triggered |
| Rate | Bulk | Human-scale |
| Human present | No | Yes |

Google's "this browser may not be secure" wall, WebAuthn failures and CAPTCHA dead-ends simply never arise — none of those flows ever start.

### 8.2 Dependency preflight

Capture is optional. Everything else must work without it.

```bash
npx voicepack doctor
```

| Check | How | On failure |
|---|---|---|
| Node ≥ 18 | `process.versions.node` | report; the bridge needs ≥ 18 too |
| Repo present | `mcp/server.js` exists | offer the install path (§8.3) |
| MCP registered | `~/.workbuddy-ai/mcp.json` has a `browser-bridge` entry | `npm run install-mcp` |
| MCP trusted | `~/.workbuddy-ai/mcp-approvals.json` has a `::browser-bridge` key | **human step** (§8.3 step 5) |
| Extension connected | `bb status` | load unpacked; check the Chrome profile |
| Agent reachable | `browser_status` returns `connected: true` | new conversation if trust was just granted |

**The bridge ships its own `npm run doctor` and that is authoritative** — run it rather than reimplementing the checks. A healthy run:

```
PASS  Node.js            v22.22.2
PASS  MCP registration   browser-bridge -> .../mcp/server.js
PASS  MCP trust          browser-bridge approved
PASS  Live bridge        port 8766, mode direct
PASS  Chrome extension   connected v2.0.0 — loaded in Default (Chrome)
8 passed · 0 warnings · 0 failures
```

If the bridge is unavailable, `voicepack ingest --source <file>` falls back to manual paste and says so. **It never blocks a draft.**

### 8.3 Install, if missing

```bash
node --version                              # needs >= 18
git clone <workbuddy-browser-bridge> && cd workbuddy-browser-bridge
npm run install-mcp                         # merges into ~/.workbuddy-ai/mcp.json, preserves others
npm run doctor                              # PASS / WARN / FAIL
```

No `npm install` — the project has no dependencies. Then three steps only a human can perform:

```
5. Trust "browser-bridge" in connector management
6. chrome://extensions -> Developer mode -> Load unpacked -> select the REPO ROOT
7. Start a NEW conversation
```

**Step 7 is not optional, and step 6 has a trap.**

- **Trust is not retroactive.** WorkBuddy re-resolves `mcp.json` per conversation, so a newly registered server appears in connector management without a restart — but approving it mid-conversation does *not* add the tools to that conversation. The next one gets them.
- **An unpacked extension is only active in the profile that loaded it.** `manifest.json` sits at the repo root; there is no `extension/` folder. Loading it in `Default` while browsing in `Profile 12` looks exactly like a successful install that never connects.

There is no need to restart WorkBuddy. Full diagnostic detail lives in the `browser-bridge-diagnostics` skill.

### 8.4 Capture recipes

**`get_dom` is the wrong tool for text.** It returns interactive elements — buttons, inputs, links — plus headings. It does **not** return body copy. A thin `get_dom` on a Threads post does not mean the page is empty; it means the tool is wrong for the job.

Read post text with `eval`, which runs JS over CDP. It is **not exposed as an MCP tool** — the `browser_*` tools stop at `get_dom`. Reach it over REST:

```bash
curl -s -X POST http://127.0.0.1:8766/command \
  -H "Content-Type: application/json" -d @payload.json
```

Build the payload in a file rather than hand-escaping multi-line JS in a shell string:

```json
{"command":"eval","params":{"code":"<js>"},"agentId":"workbuddy"}
```

Two rules that otherwise cost hours:

- **Keep expressions small and build them up.** Exceptions return a bare `{"error":"Uncaught"}` with no detail and no stack.
- **Never use `el.click()`.** Synthetic clicks are untrusted and frameworks that check `isTrusted` drop them silently. Use the bridge's `click`, which dispatches a trusted CDP `Input.dispatchMouseEvent` — required for anything that must fire a handler, such as a "More" link revealing a clamped caption.

**Prefer the `bb` CLI over raw MCP calls.** `bb find | click | wait | eval | text` returns ~630 bytes of JSON where a screenshot returns ~296 KB of base64, and it measures exact element rects instead of guessing coordinates from pixels.

### 8.5 The pipeline: capture → parse → propose

```
captures/<brand>/<channel>/<captured-at>-<slug>.raw.json    verbatim, never edited
        |
        v  ingest/parse.mjs — offline, no browser involved
candidates/<id>.candidate.json    { text, metrics, provenance, why-guess }
        |
        v  review
npx voicepack merge --id L-0042                             human approves
```

**Separating raw capture from parsing is the load-bearing decision.** Instagram and Threads ship markup changes constantly. Fused, every change means re-visiting the page. Split, a break costs one parser fix replayed against files you already have — no new requests, no new exposure. A parser bug can be fixed and re-run entirely offline.

Capture stays dumb on purpose: fetch, serialise, save. All interpretation happens downstream.

### 8.6 Guardrails

The bridge lowers the technical barrier. It does not change the rules.

- **Read-only, always.** Never automate a like, follow, comment, share, DM or post.
- **Never automate login.** No credential ever passes to a script. If a session is logged out, a human logs in.
- **Human-scale rate.** Seconds between requests, tens per session. A loop over hundreds of posts is a crawler wearing a browser — and that is the version that gets accounts actioned.
- **Own accounts first.** Prefer official APIs where they exist. The bridge is the fallback for what the APIs do not expose.
- **Others' content: targeted, not harvested.** Capturing one specific viral post a human pointed at is defensible. Bulk-collecting a competitor's feed is not.
- **Provenance is recorded, not assumed.** Every capture stores source URL, capture timestamp, and whether the text is `human-written`, `human-approved` or `ai-assisted`.

The honest position: driving your own browser is still automation, and Instagram and Threads prohibit automated collection. What makes this defensible is scale, ownership and presence — one person, their own session, a handful of posts they are actually looking at. **Risk scales with volume and with whose content it is, which is exactly what these guardrails bound.**

### 8.7 Why this doesn't break portability

The bridge is an **ingest adapter**, not a data format. It lives in `ingest/`, writes plain JSON into `captures/`, and touches nothing else. The store stays plain text. The write-time loop never calls the bridge.

An agent without the bridge loses only the capture convenience. It still packs, drafts, checks, teaches and merges.

---

## 9. Portability

**WorkBuddy AI first.** Phase 0 ships a WorkBuddy skill and nothing else. Adapters for other editors come in Phase 3, once the loop is proven.

The engine is plain JSON plus a dependency-free Node CLI. Any agent that can run a shell command or read a file can use it.

| Editor | Adapter | Mechanism |
|---|---|---|
| **WorkBuddy AI** | `SKILL.md` | Skill triggers on writing tasks; body mandates pack → draft → check |
| Claude Code | `SKILL.md` | Same file, different skill directory |
| Cursor / Antigravity | `adapters/cursorrules.template` | Rule file instructs the agent to run `voicepack pack` before writing |
| ChatGPT / Gemini | `adapters/chatgpt-instructions.md` | Paste the compiled pack into custom instructions |
| No tooling at all | `voicepack pack --print` | Copy-paste the output anywhere |

The one requirement: **the store must be readable by the CLI.** A git repo, a synced folder, or a local path. Since the whole store is text, it syncs anywhere and diffs meaningfully.

---

## 10. Governance

Personas rot. These mechanisms keep that visible.

| Mechanism | Rule |
|---|---|
| **Rule IDs** | Every rule is addressable (`vp-ig-004`). Critics cite IDs; any violation traces back to the rule and its source. |
| **Provenance** | Every rule records who taught it, when, and from what evidence. |
| **Confidence** | Rules carry a 0–1 confidence. Low-confidence rules are soft by definition. |
| **Evidence threshold** | ≥3 independent instances to promote a candidate to a rule. |
| **Contradiction lint** | `voicepack lint` fails if two active rules conflict — e.g. "keep captions under 100 chars" vs. "always include the full story." |
| **Decay** | Rules unused for 90 days are flagged for review. Stale rules get deleted, not accumulated. |
| **Versioning** | Every merge snapshots to `history/`. Rollback is one command. |
| **Quarterly review** | Scheduled audit: which rules are load-bearing, which are noise, what changed about the brand. |
| **Cache hygiene** | `index.json` is regenerable. `voicepack lint --rebuild-index` must produce an identical store. |

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Capture risks the account** | High | Read-only, human-scale, own-session. Raw capture separated from parsing so a DOM change costs a parser fix, not a re-visit. Official APIs preferred. Manual paste always available. |
| **Bridge not installed, not trusted, or in the wrong Chrome profile** | Medium | `voicepack doctor` preflight with a documented install path. Graceful fallback to `--source`. Drafting never depends on the bridge. |
| **Capture recipes rot as platforms change markup** | High | Dumb capture, offline parse. A break is one parser fix replayed against existing files. |
| **Overfitting to one viral post** | High | Candidate quarantine + 3-evidence promotion threshold. |
| **The agent reads the store and blows the context budget** | High | Principle 2, stated explicitly in `SKILL.md`. Store kept out of the paths the skill points at. Verified by testing the loop with only the CLI available. |
| **Pack budget drift** — the pack creeps past 1,200 tokens | Medium | Hard cap enforced in `pack.mjs`. `--verbose` reports what was dropped. CI asserts pack size against a fixture. |
| **Runtime dependency creep** — "just add one package" | High | `package.json` has no `dependencies` key. CI fails the build if one appears. |
| **Graft's Node ≥ 22.12 leaks into the runtime floor** | Medium | Graft is dev-only. CI tests the CLI on Node 18. |
| **Persona ossification** — voice freezes | Medium | 90-day decay, quarterly review, easy rule deletion. |
| **Context dilution** in long sessions | High | Re-emit the pack before *every* write. Never rely on an earlier turn. |
| **Language-mixing drift** (ID/EN) | Medium | Explicit `codeSwitching` block + lexicon. Review exemplars for the real ratio. |
| **Multi-brand bleed** | Medium | Namespacing by profile. No shared exemplars. Base layer holds only universal rules. |
| **Learning from AI-generated text** | High | `provenance` enforced. AI text can never become an exemplar without human approval. |
| **Silent rule conflicts** | Medium | `voicepack lint` contradiction check. |
| **Over-reliance** — the founder stops editing | Medium | The critique `keep` field and the edit-distance metric (§12) make drift visible. |

---

## 12. Success Metrics

| Metric | Baseline | Target | How |
|---|---|---|---|
| **First-draft voice score** | unknown | +25 pts in 30 days | Mean `voicepack check` score on first draft |
| **Human edit distance** | ~50% of words changed | <15% | Diff published vs. generated |
| **Time to publish** | manual | −40% | Brief to publish |
| **Blind voice test** | — | founder picks the AI version ≥70% | Monthly: AI vs. own post, unlabelled |
| **Adherence at draft 1** | — | zero hard violations in ≥80% of drafts | hard-rule count |
| **Context cost per draft** | — | ≤800 tokens injected | Measured pack size, tracked over time |
| **Learning hygiene** | — | ≥60% of candidates promoted | `learnings/log.jsonl` |
| **Rollback rate** | — | <5% of merges | `learnings/log.jsonl` |

The blind voice test is the one that matters. If the founder can't tell their own writing from the system's, the voice is real. If it's trivially easy to tell, we're not done.

**Context cost is now a first-class metric** — because a system that produces perfect voice at 8,000 tokens per draft will be abandoned, and the abandonment will look like a quality problem.

---

## 13. Roadmap

### Phase 0 — MVP, WorkBuddy only ✅ delivered

Goal: prove the loop on three real posts.

- `package.json` with **no dependencies**, `bin/voicepack.mjs`, `lib/{render,store,pack,check,lint,doctor,ingest,commands}.mjs`
- `profiles/_base/` + `profiles/<name>/` (`brand.json`, `voice.json`, `channels/*.json`, `lexicon.json`)
- 3 hand-picked exemplars with `why` annotations, in `examples/demo/`
- `lexicon.json` with the AI-slop list
- `pack` and `check` commands, with the token budget enforced
- `doctor` as a preflight — reports "capture unavailable" without requiring the bridge
- `SKILL.md` for WorkBuddy
- Agent-first output contract and exit codes (§3.6)
- `install/prompt.txt` + `INSTALL.md` + `voicepack install-prompt` — install with no terminal
- `test/smoke.mjs` — 89 assertions, no framework, no dependencies

**Exit criteria:** given the brief that produced a real post, the pack generates a
draft the founder rates ≥80% on-voice — and the pack is under 800 tokens. Run the
whole loop once with the bridge deliberately off.

*Not yet met:* the ≥80%-on-voice rating requires the real Kunci Kuppi profile, which
is still a scaffold. Everything else is done and tested.

*Deferred from the original plan:* `graft init` for dev-time navigation (§4.4). It
needs Node ≥ 22.12 and would raise the runtime floor if wired into scripts, so it
stays a manual, optional step.

### Phase 1 — Coverage and teaching

- All channels: threads, instagram, blog, x, linkedin, whatsapp
- `rules` — a read-only view of the active rule set (`teach`, `diff` and `merge` already ship)
- `index.mjs` facet index, built when exemplars exceed ~200
- `lint` — contradiction and staleness checks (both ship; add cross-profile checks)
- `history/` snapshots + `rollback` (already ships via the data repo's own git)

**Exit criteria:** the founder teaches a rule and sees it change the next draft. Rolling back a bad merge works.

### Phase 2 — Capture and learning at scale

- Official Instagram Graph API + Threads API ingestion
- Browser bridge capture: `doctor` preflight with install path, `ingest/recipes/*.json`, `capture` → `captures/*.raw.json`
- `ingest/parse.mjs` — offline raw → candidate
- Performance-weighted exemplars
- Candidate quarantine + promotion threshold

**Exit criteria:** a post's performance changes which exemplars the compiler picks. And: break a recipe selector on purpose, re-run the parser against existing captures, confirm the fix needs no new page visits.

### Phase 3 — Multi-profile and portability

- `rumah-bagel/` and `kunci-tech/` profiles with inheritance
- Cursor / Antigravity / ChatGPT adapters
- Publish to npm as `voicepack`
- A profile template + `voicepack init` so another business can adopt it without reading this PRD

**Exit criteria:** the same voice reproduces in three different editors, and a stranger can create a working profile from `voicepack init` alone.

---

## 14. Open Questions

These block Phase 0.

1. **Channels.** Which channels actually matter in the next 30 days? Building six channel files when you post on two is waste.
2. **Language.** What is the real ID/EN split in your posts? A bilingual brand needs explicit code-switching rules; guessing produces the worst of both.
3. **Accounts and capture.** Do you have Instagram Business and Threads accounts for official API access — and is the browser bridge installed on every machine you write from?
4. **Profile separation.** Should Rumah Bagel share the Kunci Kuppi voice with a different register, or be genuinely its own? This decides whether `_base` is thick or thin.
5. **Approval.** Who approves learnings — the founder alone, or does the team propose candidates?
6. **Capture scope.** Which surfaces do you actually want to read — your own posts, competitors, one-off viral posts? Each needs its own recipe and carries a different risk profile (§8.6).
7. **Open-source intent.** Publish as `voicepack` on npm under what license, and is the repo public from Phase 0 or only after Phase 3? This affects whether brand profiles live in the same repo or a separate private one.

---

## Appendix — CLI surface

The caller is a model, not a person at a keyboard, so the surface is specified as
an interface contract rather than a UI. See §3.6 for the rules that shape it.

```
voicepack context          [--json]                  orient a fresh session
voicepack install-prompt   [--repo <url>] [--json]   the bootstrap prompt
voicepack profile-prompt   [--brand "<brief>"] [-p P] [--json]   the intake prompt
voicepack doctor           [--json]                  preflight: node, data dir, bridge
voicepack recipes          [--json]                  capture recipes
voicepack list             [--json]                  profiles with counts

voicepack pack     -p P -c C [-i I] [--max-tokens N] [--json] [--verbose] [--quiet]
voicepack check    -p P -c C [-f draft.md | --text "..." | --stdin] [--json] [--quiet]

voicepack teach    -p P -c C --rule "..." [--why "..."] [--strength hard|soft]
voicepack capture  -p P -c C --url <url> [--recipe threads|instagram|generic]
voicepack ingest   -p P -c C [--url <url> | --capture <raw.json> | --source <file>] [--own]
voicepack diff     [--json]
voicepack merge    -p P --id L-0001 [--as rule|hard|exemplar] [--text "..."]

voicepack init     --dir <path> [-p name] [--force]
voicepack apply    --file <bundle.json> [-p P] [--force] [--json]
voicepack lint     -p P  |  voicepack lint --privacy
voicepack history  [--json]
voicepack rollback --to <ref> [-p P]
```

Every command also accepts `--dir <path>` and honours the resolution order in §3.3.

`doctor` never fails the build — it reports capability. `capture` requires the
bridge; `ingest --source` never does. Everything else works with no browser at all.

### Output contract

- `key: value` records, one per line, terminated by a `next:` line.
- `pack` writes **only** the pack to stdout; its diagnostics go to stderr, so
  `voicepack pack > pack.txt` yields the artefact and nothing else.
- `--json` returns full structure instead of the record stream.
- No ANSI, ever. Colour is invisible to a human and a parsing hazard to a model.
- Nothing blocks on stdin. Reading a piped draft requires an explicit `--stdin`.

### Exit codes

| Code | Meaning | Intended agent response |
|---|---|---|
| `0` | ok | continue |
| `1` | ran, but the answer is no — `check` not shippable, `merge` refused | read `next:`; do **not** retry unchanged |
| `2` | the agent called it wrong — bad flag, unknown command, profile or channel | fix the call and retry |
| `3` | environment not ready — `doctor` found failures | report the failure; do not work around it |

The `1`/`2` split is deliberate and load-bearing. Collapsing them into a single
non-zero code teaches an agent to retry refusals, which is the failure mode that
wastes the most turns. `voicepack --help --json` publishes this table so a calling
agent can read the contract rather than infer it.

Two implementation rules follow from it:

- **Never `process.exit()` after writing to a pipe.** It does not flush pending
  writes, so a caller can be handed a truncated report — worse than an error,
  because the agent cannot tell it is reading half a document. Commands set
  `process.exitCode` and return; Node drains and exits.
- **Every error carries a `next:` line.** An agent told what broke but not what to
  do will guess, and guessing produces confident wrong answers.

