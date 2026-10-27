// Connection to a hub, shared by the chat bridge and `cc-relay share`.
import WebSocket from 'ws';
import * as ts from './tailscale.js';

export function createRelayClient({ url, hubLogin, session, scope, onAsk = () => {}, onMessage = () => {}, onState = () => {} }) {
  const pending = new Map(); // ref -> { resolve, reject }
  let ws = null;
  let id = null;
  let error = null;
  let closed = false;

  const setError = (e) => { error = e; onState({ id, error }); };

  // Refuse to talk to a hub run by anyone other than the one pinned at setup.
  async function hubTrusted() {
    if (!hubLogin) return true;
    const host = new URL(url).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return true;
    const owner = await ts.whoisHost(host).catch(() => null);
    if (owner?.login === hubLogin) return true;
    setError(`hub at ${host} is run by ${owner?.login || 'unknown'}, expected ${hubLogin}; re-run cc-relay setup`);
    return false;
  }

  async function connect() {
    if (closed) return;
    if (!(await hubTrusted())) return setTimeout(connect, 30_000);
    ws = new WebSocket(url, { maxPayload: 64 * 1024 });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', session, scope })));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'welcome') { id = m.id; error = null; onState({ id, error }); }
      else if (m.type === 'msg' && m.kind === 'ask') onAsk(m);
      else if (m.type === 'msg') onMessage(m);
      else if (m.ref && pending.has(m.ref)) {
        const p = pending.get(m.ref);
        pending.delete(m.ref);
        m.type === 'error' ? p.reject(new Error(m.error)) : p.resolve(m);
      }
    });
    ws.on('close', (code, reason) => {
      id = null;
      if (code >= 4000) setError(`${code} ${reason}`);
      else onState({ id, error });
      if (!closed && code !== 4000) setTimeout(connect, 3000); // 4000: same id took over elsewhere, stand down
    });
    ws.on('error', (e) => setError(e.message));
  }

  function request(obj) {
    if (ws?.readyState !== WebSocket.OPEN || !id) {
      return Promise.reject(new Error(`not connected to ${url}${error ? `: ${error}` : ''}`));
    }
    const ref = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(ref, { resolve, reject });
      ws.send(JSON.stringify({ ...obj, ref }));
      setTimeout(() => pending.delete(ref) && reject(new Error('relay timeout')), 5000);
    });
  }

  const reply = (m, text) => ws?.readyState === WebSocket.OPEN &&
    ws.send(JSON.stringify({ type: 'send', kind: 'reply', replyTo: m.id, to: m.from, text }));

  connect();
  return {
    request,
    reply,
    state: () => ({ id, connected: !!id, error }),
    close: () => { closed = true; ws?.close(1000); },
  };
}
