// `cc-relay share`: share one project, read-only, for as long as this terminal
// runs. Every question and outcome is printed here; Ctrl+C stops sharing.
import { createInterface } from 'node:readline/promises';
import { basename } from 'node:path';
import { homedir } from 'node:os';
import * as cfg from './config.js';
import { createRelayClient } from './client.js';
import { createAnswerer } from './answerer.js';

const time = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const tilde = (p) => p.replace(homedir(), '~');
const oneLine = (s, n = 140) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export async function runShare({ dir = process.cwd(), allow = ['*'], approve = false }) {
  const config = cfg.load();
  if (!config?.url) throw new Error('not set up yet: run `cc-relay setup <hub-url>` first');
  const root = cfg.projectRootFor(dir);
  if (!cfg.isShareable(root)) throw new Error(`${tilde(root)} can't be shared (home folder or above). cd into a project first.`);
  const project = basename(root);

  const rl = approve ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const print = (line) => console.log(`${time()}  ${line}`);

  async function askOwner(m) {
    console.log(`\n  ${m.fromLogin} asks:\n  ${m.text.replace(/\n/g, '\n  ')}\n`);
    const ans = await Promise.race([
      rl.question('  Answer it? (y/N) '),
      new Promise((r) => setTimeout(() => r('timeout'), 120_000)),
    ]);
    if (ans === 'timeout') console.log('\n  (no answer in 2 minutes, declined)');
    return /^y(es)?$/i.test(String(ans).trim());
  }

  let client;
  const onAsk = createAnswerer({
    dir: root,
    project,
    allow,
    limits: config.limits,
    denyRead: config.denyRead,
    reply: (m, text) => client.reply(m, text),
    approve: approve ? askOwner : null,
    log: (e) => {
      cfg.audit(e);
      if (e.event === 'asked' && !approve) print(`? ${e.from}: ${oneLine(e.question)}`);
      if (e.event === 'answered') print(`✓ answered ${e.from} (${e.replyChars} chars)`);
      if (e.event === 'refused') print(`✗ declined ${e.from}: ${e.reason}`);
      if (e.event === 'failed') print(`! failed for ${e.from}: ${e.error || 'sandbox error'}`);
    },
  });

  let shownId = null;
  client = createRelayClient({
    url: config.url,
    hubLogin: config.hubLogin,
    session: process.env.CC_RELAY_SESSION || project,
    scope: { project, access: 'read' },
    onAsk,
    onMessage: (m) => print(`💬 ${m.fromLogin}: ${oneLine(m.text)}`),
    onState: ({ id, error }) => {
      if (id && id !== shownId) { shownId = id; print(`connected as ${id}`); }
      if (!id && error) print(`! ${error}`);
    },
  });

  console.log(`\n  Sharing ${tilde(root)} read-only on ${config.url}`);
  console.log(`  Who can ask: ${allow.includes('*') ? 'everyone on the relay' : allow.join(', ')}`);
  console.log(`  Answers come from a sandboxed Claude: Read/Grep/Glob in this folder only, no secret files.`);
  console.log(`  ${approve ? 'You approve each question here before it is answered.' : 'Questions are answered automatically and listed below.'}`);
  console.log('  Ctrl+C to stop sharing.\n');

  process.on('SIGINT', () => {
    client.close();
    rl?.close();
    console.log(`\n  Stopped sharing ${project}.`);
    process.exit(0);
  });
}
