import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnswerer } from '../src/answerer.js';

const limits = { perAskerPer10Min: 2, answersPerDay: 50, maxReplyChars: 1000 };
const ask = (fromLogin, text = 'q') => ({ id: crypto.randomUUID(), from: `${fromLogin}/x`, fromLogin, text });

function setup(opts = {}) {
  const replies = [];
  const events = [];
  const onAsk = createAnswerer({
    dir: '/tmp', project: 'demo-app', allow: ['*'], limits, denyRead: [],
    reply: (m, text) => replies.push({ to: m.fromLogin, text }),
    log: (e) => events.push(e),
    answer: async ({ question }) => ({ ok: true, text: `answer to ${question}` }),
    ...opts,
  });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { onAsk, replies, events, settle };
}

test('answers everyone on the relay by default', async () => {
  const { onAsk, replies, settle } = setup();
  onAsk(ask('bob@example.com', 'port?'));
  await settle();
  assert.deepEqual(replies, [{ to: 'bob@example.com', text: 'answer to port?' }]);
});

test('--allow narrows who may ask', async () => {
  const { onAsk, replies, settle } = setup({ allow: ['bob@example.com'] });
  onAsk(ask('bob@example.com'));
  onAsk(ask('eve@example.com'));
  await settle();
  assert.match(replies.find((r) => r.to === 'eve@example.com').text, /not allowed/);
  assert.match(replies.find((r) => r.to === 'bob@example.com').text, /^answer/);
});

test('per-asker rate limit', async () => {
  const { onAsk, replies, settle } = setup();
  for (let i = 0; i < 3; i++) onAsk(ask('spam@example.com'));
  await settle();
  assert.equal(replies.filter((r) => /too many/.test(r.text)).length, 1);
});

test('--approve: owner can decline', async () => {
  let asked = 0;
  const { onAsk, replies, settle } = setup({ approve: async () => { asked++; return false; } });
  onAsk(ask('bob@example.com'));
  await settle();
  assert.equal(asked, 1);
  assert.match(replies[0].text, /owner chose not to answer/);
});
