import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxArgs } from '../src/sandbox.js';
import { projectRootFor, isShareable, DEFAULT_DENY } from '../src/config.js';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

const args = sandboxArgs({ project: 'p', from: 'a@example.org', denyRead: DEFAULT_DENY, maxBudgetUsd: 0.5 });
const flag = (name) => args[args.indexOf(name) + 1];

test('sandbox: question is never on argv (flag injection)', () => {
  assert.equal(args[0], '-p');
  assert.ok(args[1].startsWith('--'), 'the token after -p must be a flag, not a prompt');
});

test('sandbox: exact read-only tool set, deny-by-default, no customizations', () => {
  assert.equal(flag('--tools'), 'Read,Grep,Glob');
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.equal(flag('--setting-sources'), '');
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(flag('--mcp-config'), '{"mcpServers":{}}');
  assert.ok(!args.includes('--allowedTools'), 'allowlisting bare Read would permit every path on disk');
});

test('sandbox: secret patterns become Read deny rules', () => {
  const deny = JSON.parse(flag('--settings')).permissions.deny;
  assert.ok(deny.includes('Read(./**/.env*)'));
  assert.ok(deny.includes('Read(./**/*.pem)'));
});

test('projectRootFor finds the enclosing git repo; isShareable refuses home and above', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccr-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'lib', 'deep'), { recursive: true });
  assert.ok(projectRootFor(join(repo, 'lib', 'deep')).endsWith('/repo'));
  assert.equal(isShareable(repo), true);
  assert.equal(isShareable(homedir()), false);
  assert.equal(isShareable(dirname(homedir())), false);
  assert.equal(isShareable('/'), false);
});
