import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createHub, isAllowed } from '../src/hub.js';

// Tests stand in for `tailscale whois` with a header; production never reads it.
const identify = async (req) => {
  const login = req.headers['x-test-login'];
  if (!login) throw new Error('no identity');
  return { login, host: 'test' };
};

let hub, url;
before(async () => {
  hub = createHub({ port: 0, host: '127.0.0.1', allowDomains: ['example.org'], identify, log: () => {} });
  await hub.ready;
  url = `ws://127.0.0.1:${hub.wss.address().port}`;
});
after(() => { for (const c of hub.wss.clients) c.terminate(); hub.wss.close(); });

function client(login, session, scope) {
  const ws = new WebSocket(url, { headers: login ? { 'x-test-login': login } : {} });
  const msgs = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else msgs.push(m);
  });
  const next = (pred = () => true) => {
    const i = msgs.findIndex(pred);
    if (i >= 0) return Promise.resolve(msgs.splice(i, 1)[0]);
    return new Promise((resolve) => waiters.push({ pred, resolve }));
  };
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  const sendJ = (o) => ws.send(JSON.stringify(o));
  const ready = new Promise((r) => ws.on('open', r)).then(() => sendJ({ type: 'hello', session, scope }));
  return { ws, next, closed, send: sendJ, ready };
}

test('isAllowed: domains and explicit users', () => {
  assert.equal(isAllowed('a@example.org', { allowDomains: ['example.org'] }), true);
  assert.equal(isAllowed('a@evil.example', { allowDomains: ['example.org'] }), false);
  assert.equal(isAllowed('a@example.org.evil.example', { allowDomains: ['example.org'] }), false);
  assert.equal(isAllowed('guest@example.net', { allowDomains: ['example.org'], allowUsers: ['guest@example.net'] }), true);
  assert.equal(isAllowed(null, {}), false);
});

test('rejects peers without tailnet identity and outside the domain', async () => {
  const anon = client(null, 's');
  await anon.ready;
  assert.equal(await anon.closed, 4001);
  const outsider = client('mallory@evil.example', 's');
  await outsider.ready;
  assert.equal(await outsider.closed, 4003);
});

test('id is the full verified login, not the claimed session name', async () => {
  const c = client('alice@example.org', 'bob/../root');
  await c.ready;
  const w = await c.next((m) => m.type === 'welcome');
  assert.equal(w.id, 'alice@example.org/bob-..-root');
  c.ws.close();
});

test('ask -> reply binding: spoofed replies are rejected, the real one delivered', async () => {
  const asker = client('alice@example.org', 'a');
  const target = client('bob@example.org', 'b', { project: 'demo-app', access: 'read' });
  const third = client('carol@example.org', 'c');
  await Promise.all([asker.ready, target.ready, third.ready]);
  await Promise.all([asker.next((m) => m.type === 'welcome'), target.next((m) => m.type === 'welcome'), third.next((m) => m.type === 'welcome')]);

  asker.send({ type: 'send', kind: 'ask', to: 'bob@example.org/b', text: 'port?', ref: 'r1' });
  const ask = await target.next((m) => m.type === 'msg');
  assert.equal(ask.kind, 'ask');
  assert.equal(ask.fromLogin, 'alice@example.org');

  third.send({ type: 'send', kind: 'reply', replyTo: ask.id, to: 'alice@example.org/a', text: 'fake', ref: 'r2' });
  assert.match((await third.next((m) => m.ref === 'r2')).error, /does not match/);

  target.send({ type: 'send', kind: 'reply', replyTo: ask.id, to: 'alice@example.org/a', text: '8080', ref: 'r3' });
  const got = await asker.next((m) => m.type === 'msg');
  assert.equal(got.text, '8080');
  assert.equal(got.fromLogin, 'bob@example.org');

  target.send({ type: 'send', kind: 'reply', replyTo: ask.id, to: 'alice@example.org/a', text: 'again', ref: 'r4' });
  assert.match((await target.next((m) => m.ref === 'r4')).error, /does not match/);
  for (const c of [asker, target, third]) c.ws.close();
});

test('questions cannot be broadcast; oversize text is refused', async () => {
  const c = client('dave@example.org', 'd');
  await c.ready;
  await c.next((m) => m.type === 'welcome');
  c.send({ type: 'send', kind: 'ask', to: '*', text: 'hi', ref: 'b' });
  assert.match((await c.next((m) => m.ref === 'b')).error, /broadcast/);
  c.send({ type: 'send', kind: 'chat', to: 'x/y', text: 'x'.repeat(17000), ref: 'big' });
  assert.match((await c.next((m) => m.ref === 'big')).error, /over/);
  c.ws.close();
});

test('asks are rate limited per user', async () => {
  const c = client('erin@example.org', 'e');
  await c.ready;
  await c.next((m) => m.type === 'welcome');
  let limited = false;
  for (let i = 0; i < 12; i++) {
    c.send({ type: 'send', kind: 'ask', to: 'nobody/x', text: 'q', ref: `q${i}` });
    const r = await c.next((m) => m.ref === `q${i}`);
    if (r.error?.includes('rate')) limited = true;
  }
  assert.ok(limited);
  c.ws.close();
});

test('messages to an offline session are queued and delivered on hello', async () => {
  const a = client('frank@example.org', 'f');
  await a.ready;
  await a.next((m) => m.type === 'welcome');
  a.send({ type: 'send', kind: 'chat', to: 'gina@example.org/later', text: 'hello later', ref: 'q' });
  assert.equal((await a.next((m) => m.ref === 'q')).queued, true);
  const g = client('gina@example.org', 'later');
  await g.ready;
  assert.equal((await g.next((m) => m.type === 'msg')).text, 'hello later');
  a.ws.close(); g.ws.close();
});

test('a session can update the scope it advertises', async () => {
  const a = client('hank@example.org', 'h');
  await a.ready;
  await a.next((m) => m.type === 'welcome');
  a.send({ type: 'scope', scope: { project: 'demo-app', access: 'read' } });
  a.send({ type: 'list', ref: 'l' });
  const me = (await a.next((m) => m.ref === 'l')).peers.find((p) => p.id === 'hank@example.org/h');
  assert.deepEqual(me.scope, { project: 'demo-app', access: 'read' });
  a.ws.close();
});
