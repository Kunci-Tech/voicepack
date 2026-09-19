// lib/check.mjs — Layer 1: the deterministic linter.
//
// Runs in plain Node with no model, no API key, no network. Catches everything
// that is mechanically checkable: banned lexicon, length and count limits,
// sentence and paragraph shape, punctuation, and any rule carrying a `detect`
// predicate. Layer 2 (register and drift) is the agent itself, per SKILL.md.
import { requireChannel, channelRules } from './store.mjs';

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;

const sentences = (t) =>
  t
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const paragraphs = (t) =>
  t
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

const words = (t) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));

function count(text, re) {
  const m = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
  return m ? m.length : 0;
}

export function stats(text) {
  const lines = text.split('\n');
  const firstLine = (lines.find((l) => l.trim()) ?? '').trim();
  const ss = sentences(text);
  const lengths = ss.map((s) => words(s).length);
  return {
    chars: text.length,
    words: words(text).length,
    sentences: ss.length,
    paragraphs: paragraphs(text).length,
    avgSentenceWords: lengths.length ? Math.round((lengths.reduce((a, b) => a + b, 0) / lengths.length) * 10) / 10 : 0,
    maxSentenceWords: lengths.length ? Math.max(...lengths) : 0,
    maxParagraphLines: paragraphs(text).reduce((mx, p) => Math.max(mx, p.split('\n').filter((l) => l.trim()).length), 0),
    hashtags: count(text, HASHTAG_RE),
    emoji: count(text, EMOJI_RE),
    exclamations: count(text, /!/g),
    emDashes: count(text, /—/g),
    firstLineChars: firstLine.length,
    firstLine,
  };
}

function severityFor(rule) {
  return rule.strength === 'hard' ? 'hard' : 'soft';
}

/** Run one rule's `detect` predicate. Returns a violation or null. */
function runDetect(rule, text, st) {
  const d = rule.detect;
  if (!d || !d.type) return null;
  const sev = severityFor(rule);
  const id = rule.id ?? 'unnamed';
  const fail = (message, evidence) => ({ ruleId: id, severity: sev, message, evidence, source: 'detect' });

  switch (d.type) {
    case 'regex': {
      const m = new RegExp(d.pattern, d.flags ?? '').exec(text);
      if (m) {
        const idx = Math.max(0, m.index - 20);
        return fail(d.message ?? rule.text, `"…${text.slice(idx, m.index + m[0].length + 20).replace(/\n/g, ' ')}…"`);
      }
      return null;
    }
    case 'maxChars':
      return st.chars > d.value ? fail(d.message ?? `Exceeds ${d.value} chars.`, `${st.chars} chars`) : null;
    case 'minChars':
      return st.chars < d.value ? fail(d.message ?? `Under ${d.value} chars.`, `${st.chars} chars`) : null;
    case 'maxEmoji':
      return st.emoji > d.value ? fail(d.message ?? `More than ${d.value} emoji.`, `${st.emoji} emoji`) : null;
    case 'maxHashtags':
      return st.hashtags > d.value ? fail(d.message ?? `More than ${d.value} hashtags.`, `${st.hashtags} hashtags`) : null;
    case 'minHashtags':
      return st.hashtags < d.value ? fail(d.message ?? `Fewer than ${d.value} hashtags.`, `${st.hashtags} hashtags`) : null;
    case 'maxExclamations':
      return st.exclamations > d.value ? fail(d.message ?? `More than ${d.value} exclamation marks.`, `${st.exclamations}`) : null;
    case 'maxSentenceWords':
      return st.maxSentenceWords > d.value
        ? fail(d.message ?? `A sentence runs past ${d.value} words.`, `longest is ${st.maxSentenceWords} words`)
        : null;
    case 'maxParagraphLines':
      return st.maxParagraphLines > d.value
        ? fail(d.message ?? `A paragraph runs past ${d.value} lines.`, `longest is ${st.maxParagraphLines} lines`)
        : null;
    case 'forbiddenWords': {
      const hits = (d.words ?? []).filter((w) => new RegExp(escapeRe(w), 'i').test(text));
      return hits.length ? fail(d.message ?? `Uses forbidden wording: ${hits.join(', ')}`, hits.join(', ')) : null;
    }
    default:
      return null;
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function checkDraft(profile, { channel, text }) {
  const def = requireChannel(profile, channel);
  const rules = channelRules(profile, channel);
  const st = stats(text);
  const violations = [];

  // --- declared channel constraints -------------------------------------
  const con = def.constraints ?? {};
  if (con.maxChars && st.chars > con.maxChars) {
    violations.push({
      ruleId: 'channel:maxChars',
      severity: 'hard',
      message: `Draft is ${st.chars} chars; the channel limit is ${con.maxChars}.`,
      evidence: `${st.chars - con.maxChars} over`,
      source: 'constraint',
    });
  }
  if (con.hashtags) {
    const { min, max } = con.hashtags;
    if (typeof max === 'number' && st.hashtags > max) {
      violations.push({
        ruleId: 'channel:hashtags',
        severity: 'soft',
        message: `${st.hashtags} hashtags; the channel allows at most ${max}.`,
        evidence: `${st.hashtags} hashtags`,
        source: 'constraint',
      });
    }
    if (typeof min === 'number' && st.hashtags < min) {
      violations.push({
        ruleId: 'channel:hashtags',
        severity: 'soft',
        message: `${st.hashtags} hashtags; the channel expects at least ${min}.`,
        evidence: `${st.hashtags} hashtags`,
        source: 'constraint',
      });
    }
  }
  if (con.emojiPerPost && typeof con.emojiPerPost.max === 'number' && st.emoji > con.emojiPerPost.max) {
    violations.push({
      ruleId: 'channel:emoji',
      severity: 'soft',
      message: `${st.emoji} emoji; the channel allows at most ${con.emojiPerPost.max}.`,
      evidence: `${st.emoji} emoji`,
      source: 'constraint',
    });
  }
  if (con.hookWindowChars && st.firstLineChars > con.hookWindowChars) {
    violations.push({
      ruleId: 'channel:hookWindow',
      severity: 'soft',
      message: `First line is ${st.firstLineChars} chars; the hook window is ${con.hookWindowChars}.`,
      evidence: `"${st.firstLine.slice(0, 60)}${st.firstLine.length > 60 ? '…' : ''}"`,
      source: 'constraint',
    });
  }
  if (con.emojiPerPost?.allowed?.length) {
    const found = text.match(new RegExp(EMOJI_RE.source, 'gu')) ?? [];
    const stray = [...new Set(found.filter((e) => !con.emojiPerPost.allowed.includes(e)))];
    if (stray.length) {
      violations.push({
        ruleId: 'channel:emojiSet',
        severity: 'soft',
        message: `Emoji outside the approved set: ${stray.join(' ')}`,
        evidence: `approved: ${con.emojiPerPost.allowed.join(' ')}`,
        source: 'constraint',
      });
    }
  }

  // --- lexicon ----------------------------------------------------------
  const lex = profile.lexicon ?? {};
  const banned = [...(lex.banned?.aiSlop ?? []), ...(lex.banned?.brandSpecific ?? [])];
  const hits = banned.filter((w) => new RegExp(escapeRe(w), 'i').test(text));
  if (hits.length) {
    violations.push({
      ruleId: 'lexicon:banned',
      severity: 'hard',
      message: `Uses banned wording: ${hits.join(', ')}`,
      evidence: hits.join(', '),
      source: 'lexicon',
    });
  }
  const punct = lex.punctuation ?? {};
  if (punct.emDash === 'avoid' && st.emDashes > 0) {
    violations.push({
      ruleId: 'lexicon:emDash',
      severity: 'soft',
      message: `Contains ${st.emDashes} em-dash${st.emDashes > 1 ? 'es' : ''}; the lexicon says avoid them.`,
      evidence: `${st.emDashes}`,
      source: 'lexicon',
    });
  }
  if (typeof punct.exclamationMax === 'number' && st.exclamations > punct.exclamationMax) {
    violations.push({
      ruleId: 'lexicon:exclamation',
      severity: 'soft',
      message: `${st.exclamations} exclamation marks; the limit is ${punct.exclamationMax}.`,
      evidence: `${st.exclamations}`,
      source: 'lexicon',
    });
  }
  const mech = profile.voice?.mechanics ?? {};
  if (mech.maxSentenceWords && st.maxSentenceWords > mech.maxSentenceWords) {
    violations.push({
      ruleId: 'voice:maxSentenceWords',
      severity: 'soft',
      message: `Longest sentence is ${st.maxSentenceWords} words; the voice caps at ${mech.maxSentenceWords}.`,
      evidence: `${st.maxSentenceWords} words`,
      source: 'voice',
    });
  }
  if (mech.maxLinesPerParagraph && st.maxParagraphLines > mech.maxLinesPerParagraph) {
    violations.push({
      ruleId: 'voice:maxParagraphLines',
      severity: 'soft',
      message: `Longest paragraph is ${st.maxParagraphLines} lines; the voice caps at ${mech.maxLinesPerParagraph}.`,
      evidence: `${st.maxParagraphLines} lines`,
      source: 'voice',
    });
  }

  // --- rule predicates --------------------------------------------------
  for (const r of rules) {
    const v = runDetect(r, text, st);
    if (v) violations.push(v);
  }

  // --- score ------------------------------------------------------------
  const hardCount = violations.filter((v) => v.severity === 'hard').length;
  const softCount = violations.filter((v) => v.severity !== 'hard').length;
  let score = 100 - softCount * 6;
  if (hardCount) score = Math.min(score, 60);
  score = Math.max(0, Math.min(100, score));
  const verdict = score >= 85 ? 'ship' : score >= 60 ? 'revise' : 'rewrite';

  return {
    layer: 'deterministic',
    profile: profile.name,
    channel,
    score,
    verdict,
    hardViolations: hardCount,
    softViolations: softCount,
    violations,
    stats: st,
    note:
      hardCount === 0 && softCount === 0
        ? 'No mechanical violations. Layer 2 (register and drift) still needs the agent\'s judgement.'
        : 'Fix the flagged items, then have the agent assess register and drift.',
  };
}
