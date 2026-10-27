// Decides whether to answer an incoming question and answers it in the sandbox.
// Questions are handled one at a time.
import { answerInSandbox } from './sandbox.js';

export function createAnswerer({ dir, project, allow, limits, denyRead, reply, approve, log = () => {}, answer = answerInSandbox }) {
  const askLog = new Map(); // asker login -> [timestamps]
  let today = { day: new Date().toDateString(), n: 0 };
  let queue = Promise.resolve();

  function refusal(m) {
    if (!allow.includes('*') && !allow.includes(m.fromLogin)) return `${m.fromLogin} is not allowed to ask about ${project}`;
    const now = Date.now();
    const recent = (askLog.get(m.fromLogin) || []).filter((t) => now - t < 10 * 60_000);
    if (recent.length >= limits.perAskerPer10Min) return 'too many questions, try again in a few minutes';
    if (today.day !== new Date().toDateString()) today = { day: new Date().toDateString(), n: 0 };
    if (today.n >= limits.answersPerDay) return 'daily answer limit reached';
    askLog.set(m.fromLogin, [...recent, now]);
    today.n++;
    return null;
  }

  const base = (m) => ({ from: m.fromLogin, session: m.from, project, question: m.text.slice(0, 500) });

  return function onAsk(m) {
    const why = refusal(m);
    if (why) {
      log({ event: 'refused', reason: why, ...base(m) });
      return reply(m, `declined: ${why}.`);
    }
    queue = queue.then(async () => {
      log({ event: 'asked', ...base(m) });
      if (approve && !(await approve(m))) {
        log({ event: 'refused', reason: 'owner declined', ...base(m) });
        return reply(m, 'declined: the owner chose not to answer this one.');
      }
      const res = await answer({ dir, project, from: m.fromLogin, question: m.text, denyRead, limits });
      log({ event: res.ok ? 'answered' : 'failed', replyChars: res.text.length, ...base(m) });
      reply(m, res.ok ? res.text : `could not answer: ${res.text}`);
    }).catch((e) => log({ event: 'failed', error: String(e?.message || e), ...base(m) }));
  };
}
