// lib/doctor.mjs — preflight. Reports capability, never fails a build.
//
// Capture is optional. Everything except `capture` works with the bridge absent,
// so this reports status rather than gating.
import path from 'node:path';
import os from 'node:os';
import { exists, readJsonIfExists } from './util.mjs';
import { listProfiles, profilesRoot } from './store.mjs';

const BRIDGE_PORT = Number(process.env.VOICEPACK_BRIDGE_PORT ?? 8766);
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const MCP_CONFIG = path.join(os.homedir(), '.workbuddy-ai', 'mcp.json');
const MCP_APPROVALS = path.join(os.homedir(), '.workbuddy-ai', 'mcp-approvals.json');

async function probeBridge(timeoutMs = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE_URL}/status`, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = await res.json();
    return { ok: true, detail: `${body.status ?? '?'} · connected ${body.connected} · agent ${body.agent ?? '?'}` };
  } catch (err) {
    return { ok: false, detail: err.name === 'AbortError' ? 'no response (timeout)' : 'not reachable' };
  } finally {
    clearTimeout(timer);
  }
}

export async function doctor(dataDir) {
  const checks = [];
  const add = (name, status, detail, hint) => checks.push({ name, status, detail, hint });

  // --- runtime ----------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  add(
    'Node.js',
    major >= 18 ? 'pass' : 'fail',
    `v${process.versions.node}`,
    major >= 18 ? null : 'Voicepack needs Node >= 18.'
  );

  const deps = readJsonIfExists(path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), 'package.json'));
  add(
    'Runtime dependencies',
    deps && deps.dependencies && Object.keys(deps.dependencies).length ? 'warn' : 'pass',
    deps ? `${Object.keys(deps.dependencies ?? {}).length} declared` : 'n/a',
    'Voicepack ships with zero runtime dependencies by design.'
  );

  // --- data -------------------------------------------------------------
  const dirExists = exists(dataDir);
  add('Data directory', dirExists ? 'pass' : 'fail', dataDir, dirExists ? null : `Run: voicepack init --dir ${dataDir}`);

  const profiles = dirExists ? listProfiles(dataDir) : [];
  add(
    'Profiles',
    profiles.length ? 'pass' : dirExists ? 'warn' : 'fail',
    profiles.length ? profiles.join(', ') : 'none found',
    profiles.length ? null : `Expected profiles under ${profilesRoot(dataDir)}`
  );

  const baseOk = exists(path.join(profilesRoot(dataDir), '_base'));
  add('Base profile', baseOk ? 'pass' : 'warn', baseOk ? '_base present' : '_base missing', baseOk ? null : 'Inheritance will be empty.');

  // --- browser bridge (optional) ---------------------------------------
  const mcp = readJsonIfExists(MCP_CONFIG);
  const registered = Boolean(mcp?.mcpServers?.['browser-bridge']);
  add(
    'Bridge registered',
    registered ? 'pass' : 'info',
    registered ? 'browser-bridge in mcp.json' : 'not registered',
    registered ? null : 'Optional. Only needed for `capture`.'
  );

  const approvals = readJsonIfExists(MCP_APPROVALS);
  const trusted = Boolean(approvals && Object.keys(approvals).some((k) => k.endsWith('::browser-bridge')));
  add(
    'Bridge trusted',
    trusted ? 'pass' : 'info',
    trusted ? 'approved' : 'no approval record',
    trusted ? null : 'Approve it in connector management, then start a NEW conversation. Trust is not retroactive.'
  );

  const probe = await probeBridge();
  add(
    'Bridge live',
    probe.ok ? 'pass' : 'info',
    probe.ok ? `port ${BRIDGE_PORT} · ${probe.detail}` : probe.detail,
    probe.ok ? null : 'Capture unavailable. `ingest --source` and every other command still work.'
  );

  const failing = checks.filter((c) => c.status === 'fail').length;
  const warning = checks.filter((c) => c.status === 'warn').length;
  const captureReady = registered && trusted && probe.ok;

  return {
    checks,
    failing,
    warning,
    captureReady,
    dataDir,
    summary: `${checks.filter((c) => c.status === 'pass').length} passed · ${warning} warnings · ${failing} failures`,
  };
}
