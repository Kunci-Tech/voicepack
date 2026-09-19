// lib/render.mjs — agent-first output.
//
// The caller of this CLI is a model, not a person at a keyboard. So every
// command prints a flat stream of `key: value` records and ends with a `next:`
// line. That format is trivially greppable, needs no column padding, costs
// fewer tokens than a table or JSON, and gives the calling agent an
// unambiguous action rather than something to interpret.
//
// `--json` remains available when full structure is genuinely needed.
//
// No ANSI in command output, ever. Colour codes are invisible to a human
// reading a terminal and pure noise (and a parsing hazard) to a model.

/** Format a value for a `key: value` line. */
export function fmt(v) {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Build a record stream.
 *
 *   const r = report();
 *   r.kv('score', 60).kv('verdict', 'revise');
 *   r.rows('violation', [...]);
 *   r.next('fix the hard items');
 *   out(r);
 */
export function report() {
  const lines = [];
  const api = {
    kv(key, value) {
      if (!isEmpty(value)) lines.push(`${key}: ${fmt(value)}`);
      return api;
    },
    rows(key, values) {
      if (Array.isArray(values)) {
        for (const v of values) if (!isEmpty(v)) lines.push(`${key}: ${fmt(v)}`);
      } else if (!isEmpty(values)) {
        lines.push(`${key}: ${fmt(values)}`);
      }
      return api;
    },
    raw(text) {
      if (!isEmpty(text)) lines.push(String(text));
      return api;
    },
    next(text) {
      if (!isEmpty(text)) lines.push(`next: ${text}`);
      return api;
    },
    toString() {
      return lines.join('\n');
    },
    lines,
  };
  return api;
}

export function emit(r, stream = process.stdout) {
  stream.write(r.toString() + '\n');
}

/** Exit codes are part of the interface, not an afterthought. */
export const EXIT = {
  OK: 0,
  FAILED: 1, // ran, but the answer is no: not shippable, merge refused
  USAGE: 2, // the agent called it wrong: bad flags, missing args
  PREFLIGHT: 3, // environment is not ready: doctor found failures
};

/**
 * A structured error. Always carries a `next:` line, because an agent that is
 * told what went wrong but not what to do next will guess.
 */
export function errorReport(message, { code = EXIT.FAILED, fields = {}, next = null } = {}) {
  const r = report();
  r.kv('error', message);
  for (const [k, v] of Object.entries(fields)) r.kv(k, v);
  if (next) r.next(next);
  return r;
}

/**
 * Thrown when the *caller* got it wrong — an unknown channel, a missing flag,
 * a path that does not exist. Distinct from a plain Error, which means the
 * tool ran but the answer is no (a draft that is not shippable, a merge that
 * was refused).
 *
 * The distinction matters to an agent: exit 2 says "fix your call and retry",
 * exit 1 says "your call was fine, the answer is no — do not just retry".
 * Collapsing them teaches the agent to retry the wrong things.
 *
 * `next` is carried on the error so the top-level handler can surface it
 * without every throw site having to build a full report.
 */
export class UsageError extends Error {
  constructor(message, next = null, fields = {}) {
    super(message);
    this.name = 'UsageError';
    this.next = next;
    this.fields = fields;
  }
}

/** True for our UsageError, and for copies of it across module realms. */
export const isUsageError = (e) => e?.name === 'UsageError';

/**
 * Carries an already-rendered report and the exit code to use with it.
 *
 * Used where the command has produced a full, useful answer AND needs a
 * non-zero exit — `doctor` when a check failed, `lint` when it found errors.
 * Throwing rather than calling process.exit() matters: process.exit() does not
 * flush pending writes to a pipe, so a caller reading stdout can be handed a
 * truncated report. Setting process.exitCode and returning lets Node flush.
 */
export class ReportError extends Error {
  constructor(reportText, code = EXIT.FAILED) {
    super('report');
    this.name = 'ReportError';
    this.reportText = reportText;
    this.code = code;
  }
}

export const isReportError = (e) => e?.name === 'ReportError';
