// The relay hub: any teammate can run one. Clients are identified by
// `tailscale whois` on their source IP, never by what they claim.
import { WebSocketServer } from 'ws';
import * as ts from './tailscale.js';

const MAX_PAYLOAD = 64 * 1024;
const MAX_TEXT = 16 * 1024;
const QUEUE_PER_PEER = 100;
const ASK_TTL_MS = 10 * 60 * 1000;
const RATE = { windowMs: 60_000, msgs: 60, asks: 10 };

// Default identity check: real tailnet peers only. Loopback maps to this node's owner.
async function tailscaleIdentify(req) {
  const ip = req.socket.remoteAddress.replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') {
    const me = await ts.self();
    return { login: me.login, host: me.dnsName?.split('.')[0] || 'localhost' };
  }
  return ts.whois(ip);
}

// What a session advertises it answers about. Informational only: the bridge,
// not the hub, decides whether to answer.
function cleanScope(sc) {
  if (!sc || typeof sc !== 'object') return { project: null, access: 'none' };
  return { project: sc.project ? String(sc.project).slice(0, 128) : null, access: sc.access === 'read' ? 'read' : 'none' };
}

export function isAllowed(login, { allowDomains = [], allowUsers = [] }) {
  if (!login) return false;
  if (allowUsers.includes(login)) return true;
  if (!allowDomains.length && !allowUsers.length) return true;
  return allowDomains.some((d) => login.endsWith('@' + d));
}

export function createHub({ port, host, allowDomains = [], allowUsers = [], identify = tailscaleIdentify, log = console.log }) {
  const peers = new Map();  // id -> { ws, login, host, scope, since }
  const queued = new Map(); // id -> [msg]
  const openAsks = new Map(); // askId -> { from, to, expires }
  const buckets = new Map(); // login -> rate-limit timestamps, shared across that user's connections

  const send = (ws, obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  const peerList = () => [...peers.entries()].map(([id, p]) => ({ id, login: p.login, host: p.host, scope: p.scope, since: p.since }));

  function enqueue(id, msg) {
    const q = queued.get(id) || [];
    q.push(msg);
    queued.set(id, q.slice(-QUEUE_PER_PEER));
  }

  function deliver(msg) {
    if (msg.to === '*') {
      let n = 0;
      for (const [id, p] of peers) if (id !== msg.from) { send(p.ws, { type: 'msg', ...msg }); n++; }
      return n;
    }
    const p = peers.get(msg.to);
    if (p) { send(p.ws, { type: 'msg', ...msg }); return 1; }
    enqueue(msg.to, msg);
    return 0;
  }

  function rateOk(bucket, kind) {
    const now = Date.now();
    bucket[kind] = (bucket[kind] || []).filter((t) => now - t < RATE.windowMs);
    if (bucket[kind].length >= RATE[kind]) return false;
    bucket[kind].push(now);
    return true;
  }

  const wss = new WebSocketServer({ port, host, maxPayload: MAX_PAYLOAD });

  wss.on('connection', (ws, req) => {
    // Attach handlers before the async identity lookup so an early hello isn't dropped.
    const identP = identify(req).catch(() => null);
    let id = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (raw) => {
      const ident = await identP;
      if (!ident) return ws.close(4001, 'not a tailnet peer');
      if (!isAllowed(ident.login, { allowDomains, allowUsers })) return ws.close(4003, 'user not allowed on this hub');
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      const err = (error) => send(ws, { type: 'error', ref: m.ref, error });

      if (m.type === 'hello') {
        if (id) return err('already said hello');
        const session = String(m.session || 'default').replace(/[^\w.-]/g, '-').slice(0, 64);
        // Full login, not just the local part: sam@example.com and sam@github must not collide.
        id = `${ident.login}/${session}`;
        peers.get(id)?.ws.close(4000, 'replaced by a newer connection with the same id');
        peers.set(id, { ws, ...ident, scope: cleanScope(m.scope), since: new Date().toISOString() });
        send(ws, { type: 'welcome', id, login: ident.login, peers: peerList() });
        for (const msg of queued.get(id) || []) send(ws, { type: 'msg', ...msg });
        queued.delete(id);
        log(`+ ${id} (${ident.host})`);
        return;
      }
      if (!id) return err('send hello first');

      if (m.type === 'scope') { peers.get(id).scope = cleanScope(m.scope); log(`~ ${id} ${peers.get(id).scope.access}`); return; }
      if (m.type === 'list') return send(ws, { type: 'peers', ref: m.ref, peers: peerList() });
      if (m.type !== 'send') return err(`unknown type ${m.type}`);

      const kind = ['chat', 'ask', 'reply'].includes(m.kind) ? m.kind : 'chat';
      const to = String(m.to || '');
      const text = String(m.text ?? '');
      if (!to) return err('missing recipient');
      if (text.length > MAX_TEXT) return err(`text over ${MAX_TEXT} chars`);
      if (!buckets.has(ident.login)) buckets.set(ident.login, {});
      if (!rateOk(buckets.get(ident.login), kind === 'ask' ? 'asks' : 'msgs')) return err('rate limited, slow down');

      const msg = { id: crypto.randomUUID(), kind, from: id, fromLogin: ident.login, to, text, ts: new Date().toISOString() };
      if (kind === 'ask') {
        if (to === '*') return err('questions cannot be broadcast; ask one session');
        openAsks.set(msg.id, { from: id, to, expires: Date.now() + ASK_TTL_MS });
      }
      if (kind === 'reply') {
        // A reply must answer a live question that was put to this session.
        const ask = openAsks.get(m.replyTo);
        if (!ask || ask.to !== id || ask.from !== to) return err('reply does not match an open question to you');
        openAsks.delete(m.replyTo);
        msg.replyTo = m.replyTo;
      }
      const delivered = deliver(msg);
      send(ws, { type: 'ack', ref: m.ref, msgId: msg.id, delivered, queued: delivered === 0 && to !== '*' });
    });

    ws.on('close', () => {
      if (id && peers.get(id)?.ws === ws) { peers.delete(id); log(`- ${id}`); }
    });
  });

  // Drop dead connections and expired questions.
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const [k, a] of openAsks) if (a.expires < now) openAsks.delete(k);
  }, 30_000);
  wss.on('close', () => clearInterval(sweep));

  return { wss, peers, ready: new Promise((r) => wss.on('listening', r)) };
}

// `cc-relay hub`: bind to this node's Tailscale address only and print what to share.
export async function runHub({ port = 7777, host, allowDomains, allowUsers }) {
  const me = await ts.self().catch(() => null);
  if (!me?.running) throw new Error('Tailscale is not running. Start it and log in to the team tailnet first.');
  const bindHost = host || me.ips.find((ip) => ip.includes('.'));
  // Default: anyone the tailnet admits. Members may use mixed identity providers
  // (gmail, GitHub, ...), so the tailnet itself is the boundary; flags narrow it.
  const domains = allowDomains || [];
  const users = allowUsers || [];
  const hub = createHub({ port, host: bindHost, allowDomains: domains, allowUsers: users });
  await hub.ready;

  // Share the Tailscale IP: it's stable per device and works even where MagicDNS
  // resolution is broken on the client.
  const url = `ws://${bindHost}:${port}`;
  console.log(`\n  cc-relay hub running on tailnet "${me.tailnet}" as ${me.login}`);
  console.log(`  listening on ${bindHost}:${port} (Tailscale interface only)`);
  const allowed = [...domains.map((d) => '*@' + d), ...users];
  console.log(`  allowed: ${allowed.length ? allowed.join(', ') : `every user on tailnet "${me.tailnet}"`}\n`);
  console.log('  Share this with teammates:\n');
  console.log(`      cc-relay setup ${url}\n`);
  if (me.dnsName) console.log(`  (or by name: ws://${me.dnsName}:${port})\n`);
  return hub;
}
