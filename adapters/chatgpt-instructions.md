# Voicepack — ChatGPT / Gemini / any no-tooling editor

These editors cannot run shell commands, so they cannot call the CLI. Instead you
compile the pack yourself and paste it in.

## One-time setup

```bash
# compile the pack for the channel you write on most
npx voicepack pack --profile <p> --channel <c> --intent promo --max-tokens 900 --print
```

Paste the output into **Custom Instructions** (ChatGPT) or the system instruction
field (Gemini), above your own notes. Keep it under ~900 tokens; beyond that the
model starts ignoring parts of it.

## Per-channel setup

A pack is channel-specific. If you write for several channels, keep one pack per
channel in a note and paste the relevant one at the start of the conversation:

```
<paste the instagram pack here>

---
Write an Instagram post about the new sourdough schedule.
```

## The trade-off, stated plainly

Without the CLI you lose three things:

1. **Freshness.** A pasted pack is a snapshot. When you teach a new rule or merge a
   candidate, you must re-compile and re-paste.
2. **Budgeting.** The compiler selects and ranks to fit a budget. A manual paste
   can't, so the pack will drift larger over time and adherence will fall.
3. **The critique.** `voicepack check` is deterministic and offline — it catches
   banned lexicon, length limits, sentence shape and rule regexes. Without it you
   are relying on the model's judgement alone.

## The one instruction that matters most

Add this to your custom instructions regardless of editor:

> Never write brand prose from memory or from earlier in the conversation. If the
> voice pack is not in front of you, ask for it before writing.

The most common failure is not a bad pack — it is a pack from twenty turns ago that
has been diluted to nothing.

## Checking without the CLI

You can still ask the model to self-critique, but be aware it is weaker than the
deterministic linter:

```
Now critique that draft against the voice pack above. Report two things:
1. voiceDrift — where it sounds like a generic AI rather than this brand. Cite
   the specific line.
2. keep — what is already right and must not be touched when I revise.
Then list any banned words that appear.
```

Expect this to catch register problems well and mechanical problems poorly. The
deterministic checks (counts, limits, exact banned strings) are exactly what a
model is worst at and a script is best at — which is why the CLI exists.
