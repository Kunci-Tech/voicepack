// lib/pack.mjs — compile a token-budgeted voice pack.
//
// This is the context firewall. The agent never reads the persona store; it
// runs this and receives a pack sized to fit. Everything discarded costs
// nothing, which is why store size does not affect agent context cost.
import { estimateTokens } from './util.mjs';
import { brandName, requireChannel, channelRules, loadExemplars, effectiveBanned } from './store.mjs';

const strengthRank = (r) => (r.strength === 'hard' ? 0 : 1);
const confidence = (r) => (typeof r.confidence === 'number' ? r.confidence : 0.5);

const byPriority = (a, b) => strengthRank(a) - strengthRank(b) || confidence(b) - confidence(a);

function signatureLine(voice) {
  const s = voice?.signature ?? {};
  const bits = [];
  if (s.person) bits.push(s.person);
  for (const [k, label] of [
    ['warmth', 'warmth'],
    ['playfulness', 'playfulness'],
    ['formality', 'formality'],
    ['humility', 'humility'],
    ['salesPressure', 'sales pressure'],
  ]) {
    if (typeof s[k] === 'number') bits.push(`${label} ${s[k]}`);
  }
  return bits.length ? `Voice: ${bits.join(' · ')}` : null;
}

function rhythmLine(voice) {
  const m = voice?.mechanics ?? {};
  const bits = [];
  if (m.avgSentenceWords) {
    bits.push(
      m.maxSentenceWords
        ? `~${m.avgSentenceWords} words per sentence (hard max ${m.maxSentenceWords})`
        : `~${m.avgSentenceWords} words per sentence`
    );
  }
  if (m.maxLinesPerParagraph) bits.push(`max ${m.maxLinesPerParagraph} lines per paragraph`);

  const lines = [];
  if (bits.length) lines.push(`Rhythm: ${bits.join('. ')}.`);

  // openingMove/closingMove are free text, and models write them as full
  // instructive sentences as often as they write short phrases. Splicing a
  // sentence into `open with ${x}` produced this:
  //
  //   Rhythm: max 3 lines per paragraph. open with Start from something real:
  //   an observation, ... Avoid opening with a generic promotional claim..
  //   close with End simply. A short statement, ... already lands..
  //
  // — doubled full stops, a 40-word "rhythm" line, and the instruction buried
  // inside a list it does not belong to. Give them their own lines instead;
  // it reads correctly whichever shape the model chose.
  const label = (k, text) => {
    const t = String(text).trim();
    return t ? `${k}: ${t}` : null;
  };
  const open = label('OPEN', m.openingMove);
  const close = label('CLOSE', m.closingMove);
  if (open) lines.push(open);
  if (close) lines.push(close);

  return lines.length ? lines.join('\n') : null;
}

function ruleLine(r, i) {
  const id = r.id ? ` (${r.id})` : '';
  return `${i + 1}. ${r.text}${id}`;
}

/**
 * The moves list, truncated to whatever budget is left.
 *
 * Moves are by far the longest block in a pack — ten of them with examples is
 * most of a 700-token budget. Under a first-come-first-served budget that means
 * they either starve everything after them, or, if dropped whole for being too
 * big, disappear entirely. A partial list is strictly better than none: six moves
 * and the banned-word list beats ten moves and no list, and both beat no moves at
 * all. So this returns as many as fit and says how many it left behind.
 */
function movesSection(voice, maxTokens = Infinity) {
  const moves = voice?.moves ?? [];
  if (!moves.length) return null;

  const heading = 'MOVES (do this)';
  const lines = [];
  let used = estimateTokens(heading) + 1;

  for (const m of moves) {
    const ex = m.example ? `\n   e.g. ${m.example}` : '';
    const line = `- ${m.text}${ex}`;
    const cost = estimateTokens(line) + 1;
    if (used + cost > maxTokens) break;
    lines.push(line);
    used += cost;
  }

  if (!lines.length) return null;
  const omitted = moves.length - lines.length;
  const tail = omitted
    ? `\n(+${omitted} more move${omitted === 1 ? '' : 's'} not shown — raise --max-tokens)`
    : '';
  return `${heading}\n${lines.join('\n')}${tail}`;
}

function structureSection(def) {
  const s = def.structure ?? {};
  const bits = [];
  if (Array.isArray(s.beats) && s.beats.length) bits.push(`STRUCTURE: ${s.beats.join(' -> ')}`);
  if (s.ctaStyle) bits.push(`CTA: ${s.ctaStyle}`);
  if (s.lineBreaks) bits.push(`LINE BREAKS: ${s.lineBreaks}`);
  const c = def.constraints ?? {};
  const limits = [];
  if (c.maxChars) limits.push(`max ${c.maxChars} chars`);
  if (c.hookWindowChars) limits.push(`hook must land in the first ${c.hookWindowChars} chars`);
  if (c.hashtags) limits.push(`${c.hashtags.min ?? 0}-${c.hashtags.max ?? '?'} hashtags (${c.hashtags.style ?? 'any style'})`);
  if (c.emojiPerPost) limits.push(`max ${c.emojiPerPost.max ?? 0} emoji`);
  if (limits.length) bits.push(`LIMITS: ${limits.join('; ')}`);
  return bits.length ? bits.join('\n') : null;
}

function lexiconSection(lexicon) {
  if (!lexicon) return null;
  const lines = [];

  // Deduplicated, because the two lists overlap by construction. `_base` ships a
  // generic aiSlop list and a profile adds its own brandSpecific words, and a
  // brand that bans "elevate" or "nestled in the heart of" is banning something
  // the base list already has — `deepMerge` concatenates arrays, so the pack
  // printed those words twice and spent budget saying the same thing again.
  //
  // The dedup itself lives in `effectiveBanned` because `check` needs the same
  // list, and when it was written out twice the two copies drifted into the same
  // bug independently.
  const banned = effectiveBanned(lexicon);
  if (banned.length) lines.push(`NEVER USE: ${banned.join(', ')}`);

  const sig = [];
  const sigSeen = new Set();
  for (const w of lexicon.signatureWords ?? []) {
    const key = String(w).trim().toLowerCase();
    if (!key || sigSeen.has(key)) continue;
    sigSeen.add(key);
    sig.push(w);
  }
  if (sig.length) lines.push(`WORDS THAT SOUND LIKE US: ${sig.join(', ')}`);

  const p = lexicon.punctuation ?? {};
  const punct = [];
  if (p.emDash) punct.push(`em-dash: ${p.emDash}`);
  if (p.ellipsis) punct.push(`ellipsis: ${p.ellipsis}`);
  if (typeof p.exclamationMax === 'number') punct.push(`max ${p.exclamationMax} exclamation mark`);
  if (punct.length) lines.push(`PUNCTUATION: ${punct.join('; ')}`);
  return lines.length ? lines.join('\n') : null;
}

function exemplarRank(ex, intent) {
  const p = ex.data?.performance ?? {};
  const engagement = (p.likes ?? 0) + 3 * (p.saves ?? 0) + 2 * (p.comments ?? 0);
  const intentBonus = intent && ex.data?.intent === intent ? 5000 : 0;
  const viralBonus = p.viral ? 2000 : 0;
  return engagement + intentBonus + viralBonus;
}

/**
 * @returns {{text:string, tokens:number, budget:number, dropped:string[], used:string[], channel:string}}
 */
export function buildPack(profile, opts = {}) {
  const { channel, intent = null, maxTokens = 700, includeExemplars = true } = opts;
  const def = requireChannel(profile, channel);
  const rules = channelRules(profile, channel);

  const hard = rules.filter((r) => r.strength === 'hard').sort(byPriority);
  const soft = rules.filter((r) => r.strength !== 'hard').sort(byPriority);

  const blocks = [];
  const add = (id, text) => {
    if (text && String(text).trim()) blocks.push({ id, text: String(text).trim() });
  };

  const title = `# ${brandName(profile).toUpperCase()} — ${channel.toUpperCase()}${intent ? ` / ${intent}` : ''}`;
  add('header', [title, signatureLine(profile.voice), rhythmLine(profile.voice)].filter(Boolean).join('\n'));

  // This is PRIORITY order, not just reading order: the budget below walks the
  // list once and drops whatever does not fit. Lexicon sits above moves because
  // `lint` calls the banned-word list the highest-leverage artefact in the store,
  // and moves are the longest block in a pack — left above lexicon they starve it
  // out of the pack entirely, which is exactly what happened to the first real
  // profile this compiled.
  if (hard.length) add('hard-rules', `HARD RULES (never violate)\n${hard.map(ruleLine).join('\n')}`);
  add('lexicon', lexiconSection(profile.lexicon));
  add('structure', structureSection(def));

  let used = 0;
  const kept = [];
  const dropped = [];
  const included = [];

  for (const b of blocks) {
    const t = estimateTokens(b.text) + 1;
    if (used + t > maxTokens) {
      dropped.push(b.id);
      continue;
    }
    kept.push(b.text);
    included.push(b.id);
    used += t;
  }

  // Moves are the one list-shaped block, so they take what is left and are cut to
  // fit rather than dropped whole.
  const movesText = movesSection(profile.voice, maxTokens - used);
  if (movesText) {
    kept.push(movesText);
    included.push('moves');
    used += estimateTokens(movesText) + 1;
  } else if ((profile.voice?.moves ?? []).length) {
    dropped.push('moves');
  }

  // Soft rules last: they are preferences, and a move with a real example teaches
  // more per token than a rule without one.
  if (soft.length) {
    const text = `SOFT RULES (prefer)\n${soft.map(ruleLine).join('\n')}`;
    const t = estimateTokens(text) + 1;
    if (used + t <= maxTokens) {
      kept.push(text);
      included.push('soft-rules');
      used += t;
    } else {
      dropped.push('soft-rules');
    }
  }

  if (includeExemplars) {
    const ranked = loadExemplars(profile, channel)
      .filter((e) => !e.missing && e.text)
      .sort((a, b) => exemplarRank(b, intent) - exemplarRank(a, intent));

    if (ranked.length) {
      const heading = 'HERE IS THE VOICE (do not copy — match the register):';
      const headingCost = estimateTokens(heading) + 1;
      // Reserve the heading only if at least one exemplar will fit beneath it.
      // A heading with nothing under it is worse than no heading at all.
      const room = maxTokens - used - headingCost;
      const exBlocks = [];
      let spent = 0;

      if (room >= 60) {
        let n = 0;
        for (const ex of ranked) {
          n += 1;
          const label = `-- exemplar ${n}${ex.data?.why ? ` — ${ex.data.why}` : ''} --`;
          const body = ex.text;
          const full = `${label}\n${body}`;
          const remaining = room - spent;
          let t = estimateTokens(full) + 1;

          if (t <= remaining) {
            exBlocks.push(full);
            spent += t;
            continue;
          }

          const truncRoom = remaining - estimateTokens(label) - 3;
          if (truncRoom < 40) {
            dropped.push(`exemplar:${ex.id}`);
            break;
          }
          let cut = body.slice(0, truncRoom * 4);
          const nl = cut.lastIndexOf('\n');
          if (nl > 0) cut = cut.slice(0, nl);
          const truncated = `${label}\n${cut}\n[...]`;
          t = estimateTokens(truncated) + 1;
          if (t > remaining) {
            dropped.push(`exemplar:${ex.id}`);
            break;
          }
          exBlocks.push(truncated);
          spent += t;
          dropped.push(`exemplar:${ex.id} (truncated)`);
          break;
        }
      } else {
        for (const ex of ranked) dropped.push(`exemplar:${ex.id}`);
      }

      if (exBlocks.length) {
        kept.push(heading);
        kept.push(...exBlocks);
        included.push('exemplars');
        used += headingCost + spent;
      }
    }
  }

  const text = kept.join('\n\n') + '\n';
  return {
    text,
    tokens: estimateTokens(text),
    budget: maxTokens,
    included,
    dropped,
    channel,
    profile: profile.name,
    intent,
  };
}
