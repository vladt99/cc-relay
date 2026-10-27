// `cc-relay setup [hub-url]`: first-run wizard. Pins the hub and registers the
// MCP server. Sharing a project is a separate, explicit step: `cc-relay share`.
import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import * as cfg from './config.js';
import * as ts from './tailscale.js';

const HOME = homedir();
const tilde = (p) => p.replace(HOME, '~');

function probeHub(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: 5000 });
    const done = (r) => { ws.terminate(); resolve(r); };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', session: 'setup-check' })));
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'welcome') done({ ok: true, id: m.id, peers: m.peers.length - 1 }); });
    ws.on('close', (code, reason) => done({ ok: false, error: `${code} ${reason}` }));
    ws.on('error', (e) => done({ ok: false, error: e.message }));
  });
}

// Stop Claude from editing the relay config with its file tools.
function protectConfig() {
  const path = join(HOME, '.claude', 'settings.json');
  const s = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const rules = ['Edit(~/.cc-relay/**)']; // Edit rules also cover the Write tool
  s.permissions ??= {};
  s.permissions.deny = [...new Set([...(s.permissions.deny || []), ...rules])];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 2) + '\n');
}

export async function runSetup(urlArg) {
  // Without a terminal (e.g. `! cc-relay setup …` inside Claude Code) nobody can
  // answer prompts, so take the defaults and say so.
  const interactive = Boolean(process.stdin.isTTY);
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q, def = '') => {
    if (!rl) { console.log(`${q} [${def}]: ${def}  (no terminal, using default)`); return def; }
    return (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def;
  };
  const old = cfg.load() || cfg.DEFAULTS;

  console.log('\n── cc-relay setup ─────────────────────────────────────────────');
  console.log('Your Claude Code sessions will be able to ask teammates\' shared projects');
  console.log('questions. Nothing of yours is shared until you run `cc-relay share`');
  console.log('in a project folder.\n');

  const me = await ts.self().catch(() => null);
  if (!me?.running) {
    throw new Error('Tailscale is not running. Open the Tailscale app (or run `tailscale up`), make sure ' +
      'you\'re on the team tailnet (`tailscale switch --list`), then run setup again.');
  }
  else console.log(`You are ${me.login} on tailnet "${me.tailnet}".\n`);

  if (!urlArg && !interactive) throw new Error('pass the hub address: cc-relay setup ws://<hub>:7777');
  const url = urlArg || await ask('Hub address (printed by `cc-relay hub`)', old.url || '');
  if (!/^wss?:\/\//.test(url)) throw new Error(`not a ws:// address: ${url}`);

  const host = new URL(url).hostname;
  const owner = await ts.whoisHost(host).catch(() => null);
  if (owner) console.log(`Hub ${host} is run by ${owner.login} (${owner.host}).`);
  const check = await probeHub(url);
  console.log(check.ok ? `Connected as ${check.id}; ${check.peers} other session(s) online.\n` : `! Could not join hub: ${check.error}\n`);
  if (!check.ok && (await ask('Continue anyway? (y/n)', 'n')).toLowerCase() !== 'y') {
    throw new Error('could not reach the hub. Is it running, and are you both on the same tailnet? Nothing was saved.');
  }

  const { mode, projects, allowFrom, ...keep } = old; // drop settings from older versions
  cfg.save({ ...keep, url, hubLogin: owner?.login || null });
  console.log(`Saved ${tilde(cfg.CONFIG_PATH)}`);

  if ((await ask('Block Claude from editing ~/.cc-relay with its Edit/Write tools? (adds deny rules to ~/.claude/settings.json) (y/n)', 'y')).toLowerCase() === 'y') {
    protectConfig();
    console.log('Added deny rules.');
  }

  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cc-relay.js');
  try { execFileSync('claude', ['mcp', 'remove', '--scope', 'user', 'cc-relay'], { stdio: 'ignore' }); } catch { /* first install */ }
  execFileSync('claude', ['mcp', 'add', '--scope', 'user', 'cc-relay', '--', process.execPath, resolve(bin), 'mcp'], { stdio: 'inherit' });
  console.log('\nDone. Restart Claude Code to get the relay_* tools.');
  console.log('To let teammates ask about a project, run this in its folder and keep it open:');
  console.log('\n    cc-relay share\n');
  rl?.close();
}
