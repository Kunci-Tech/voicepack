# Installing Voicepack

Voicepack is installed **by your agent, not by you**. You copy one block of text,
paste it into the agent you already use, and answer at most one question. You
never open a terminal.

---

## The 10-second version

1. Open the agent you write with — WorkBuddy AI, Cursor, Claude Code, whatever you use.
2. Copy everything between the markers below.
3. Replace `<ENGINE_REPO_URL>` with `https://github.com/Kunci-Tech/voicepack` — or your own fork, if you have one.
4. Paste it into the agent and send.
5. Answer the one question it may ask, then read its summary.

That's it. The agent checks Node, fetches the engine, scaffolds your private data
directory, wires it up, installs the usage instructions into itself, and runs
preflight. It reports back in plain language.

> **Skip step 3.** Ask the agent to run `voicepack install-prompt` and it prints the
> same text with the URL already filled in — add `--repo <your-fork-url>` to point it
> somewhere else. The block below keeps the placeholder so this page stays
> fork-agnostic.

---

## The prompt

<!-- BEGIN INSTALL PROMPT -->
You are installing Voicepack for me. Voicepack is a portable persona engine: it
keeps a writing persona as plain JSON and Markdown in a directory I control, and
compiles a small token-budgeted "voice pack" on demand so that anything you write
for me sounds like me instead of like a generic assistant.

I do not want to touch a terminal. Run every command yourself and report the
result in plain language. Do not hand me commands to paste — if something needs
running, run it.

The engine repository is: <ENGINE_REPO_URL>
(If that is still an unfilled placeholder, ask me for the URL once, then continue.)

## The one idea you must not break

There are two separate things, and keeping them separate is the whole design:

  ENGINE   the code. Public, forkable, contains no personal data, ever.
  DATA     the persona. Private, lives outside the engine, never committed to it.

A pull request against the engine can therefore never contain a persona. Do not
merge the two trees. Do not put DATA inside ENGINE.

## Steps

1. Confirm Node is present and is version 18 or newer.

     node --version

   If Node is missing or older than 18, stop and tell me what to install. Do not
   try to install Node yourself, and do not reach for Python or any other
   runtime — Voicepack is Node-only and has zero dependencies by design.

2. Find or fetch the engine.

   First look for an existing checkout: a directory containing
   `bin/voicepack.mjs`. If one exists in this workspace, use it.

   Otherwise clone it, preferring my fork if I have one:

     git clone <ENGINE_REPO_URL>

   Record the absolute path to that directory. Call it ENGINE.

3. Choose the data directory.

   This holds my persona, so it must NOT sit inside ENGINE and must not be a
   repository that pushes to the engine remote. Pick the first that applies:

     a. a path I have already named
     b. $VOICEPACK_DIR, if set
     c. ~/.voicepack

   Call the chosen path DATA.

4. Scaffold it.

     node ENGINE/bin/voicepack.mjs init --dir DATA --profile default

   If DATA already contains profiles, do NOT pass --force. Stop and ask me
   whether to keep what is there or scaffold somewhere else. Never overwrite a
   persona.

5. Give the data directory its own history.

     git -C DATA init
     git -C DATA add -A
     git -C DATA commit -m "voicepack: initial scaffold"

   DATA keeps its own history so I can roll back a bad rule. It must have no
   remote pointing at the engine.

6. Point the engine at DATA.

   Write `voicepack.config.json` in my project root:

     { "dir": "<absolute path to DATA>" }

   Resolution order is --dir, then $VOICEPACK_DIR, then this file, then
   ~/.voicepack. Setting the file means later commands need no --dir flag.

7. Put the usage instructions where you will actually see them.

   - WorkBuddy AI: copy ENGINE/SKILL.md to ~/.workbuddy-ai/skills/voicepack/SKILL.md
   - Cursor: append ENGINE/adapters/cursorrules.template to .cursorrules
   - ChatGPT or Claude: paste ENGINE/adapters/chatgpt-instructions.md into custom instructions

8. Verify before you report success.

     node ENGINE/bin/voicepack.mjs doctor --dir DATA
     node ENGINE/bin/voicepack.mjs context --dir DATA

   `doctor` exits 3 when the environment is not ready. Report failures verbatim
   instead of working around them. A failure of the browser-bridge check is not
   fatal — every command except `capture` works without the bridge.

   `context` exits 0 and tells you the data directory, the profiles, the
   channels, anything awaiting approval, and whether capture is ready.

9. Tell me, in plain language: where DATA is, the profile name, which channels
   exist, whether capture is ready, and the single next thing to do. Do not dump
   raw command output at me.

## From now on, the rule that makes this work

Never read the persona store into your context. Do not open brand.json,
voice.json, or any exemplar file. Instead run:

    node ENGINE/bin/voicepack.mjs pack -p <profile> -c <channel> -i <intent>

That returns a roughly 700-token pack holding exactly the rules and examples you
need for that channel and intent. The store can grow without limit; the pack
stays the same size. Opening the store directly defeats the design and burns my
context for no gain.

Then write the draft from the pack, and lint it before showing me:

    node ENGINE/bin/voicepack.mjs check -p <profile> -c <channel> -f draft.md

`check` is deterministic and offline — no model, no API key. It exits 1 when the
draft is not shippable. Fix the HARD violations first, and do not rewrite what
was not flagged. Then judge register and drift yourself; the linter cannot see
those.

## Do not

- Do not install Python or any runtime other than Node.
- Do not add npm dependencies. The engine has none, and adding one breaks the guarantee.
- Do not commit DATA into ENGINE.
- Do not invent a persona. Scaffold the empty one and let me fill it in.
- Do not ask me to run commands.
<!-- END INSTALL PROMPT -->

---

## What the agent actually does

| Step | Action | Why |
|---|---|---|
| 1 | `node --version` | Node ≥ 18, and nothing else |
| 2 | find or clone the engine | your fork wins over upstream |
| 3 | pick a data directory | outside the engine, so a PR can't leak a persona |
| 4 | `voicepack init` | scaffolds the empty persona — it invents nothing |
| 5 | `git init` inside the data directory | so a bad rule can be rolled back |
| 6 | write `voicepack.config.json` | later commands need no `--dir` |
| 7 | install `SKILL.md` / adapters | so the next session knows the rules |
| 8 | `doctor` then `context` | proves it works before claiming success |
| 9 | report in plain language | no raw output dumped at you |

The agent will not pass `--force`. If a persona already exists it stops and asks.
Your writing style is the one thing here that is not reproducible.

---

## Manual install

For people who *want* the terminal, or who are scripting this.

```sh
git clone <ENGINE_REPO_URL> ~/voicepack
node ~/voicepack/bin/voicepack.mjs init --dir ~/.voicepack --profile default
echo '{ "dir": "'"$HOME"'/.voicepack" }' > voicepack.config.json
node ~/voicepack/bin/voicepack.mjs doctor
node ~/voicepack/bin/voicepack.mjs context
```

No `npm install`. No build step. No dependencies. If you find yourself installing
a package to make this work, something has gone wrong — open an issue.

---

## Updating

The engine and your persona move independently. That is the point.

```sh
git -C ~/voicepack pull upstream main    # the code
git -C ~/.voicepack log --oneline        # your persona's own history
```

Because the data directory is not inside the engine, `git pull` never conflicts
with your persona, and a PR against the engine can never contain one.

---

## Troubleshooting

**The agent says Node is too old.** Install Node 18 or newer. Nothing else in the
project needs installing.

**`doctor` reports the browser bridge unavailable.** Not fatal. Every command
except `capture` works offline. You only need the bridge to fetch a post from a
URL; `voicepack ingest --source <file>` accepts pasted text instead.

**The agent asks for the repository URL.** You copied the block from this page and
left `<ENGINE_REPO_URL>` unfilled. It is `https://github.com/Kunci-Tech/voicepack`,
or ask the agent to run `voicepack install-prompt` instead, which fills it in for you.

**The agent wants to install Python.** Stop it. Voicepack is Node-only on purpose
— one runtime, zero dependencies, no version matrix to debug.
