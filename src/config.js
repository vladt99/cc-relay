import { readFileSync, writeFileSync, mkdirSync, appendFileSync, realpathSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, sep, parse } from 'node:path';

export const CONFIG_PATH = process.env.CC_RELAY_CONFIG || join(homedir(), '.cc-relay', 'config.json');
export const AUDIT_PATH = join(dirname(CONFIG_PATH), 'audit.log');

// Files the read-only responder may never open, even inside an exposed project.
export const DEFAULT_DENY = [
  '**/.env*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.keystore',
  '**/id_rsa*', '**/id_ed25519*', '**/*secret*', '**/*credential*', '**/*.mobileprovision',
  '**/google-services.json', '**/GoogleService-Info.plist', '**/key.properties', '**/.npmrc',
  '**/.netrc', '**/.git/**', '**/.aws/**', '**/.ssh/**',
];

export const DEFAULTS = {
  url: null,
  hubLogin: null,            // pinned at setup: whose hub we trust
  denyRead: DEFAULT_DENY,
  limits: { perAskerPer10Min: 5, answersPerDay: 50, maxBudgetUsdPerAnswer: 0.5, answerTimeoutSec: 180, maxReplyChars: 16000 },
};

export function load() {
  try {
    const c = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULTS, ...c, limits: { ...DEFAULTS.limits, ...c.limits } };
  } catch {
    return null;
  }
}

export function save(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export function audit(entry) {
  try {
    mkdirSync(dirname(AUDIT_PATH), { recursive: true, mode: 0o700 });
    appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch { /* auditing must never break answering */ }
}

const real = (p) => { try { return realpathSync(p); } catch { return p; } };

// The folder `cc-relay share` shares: the enclosing git repo, else cwd itself.
export function projectRootFor(cwd) {
  let dir = real(cwd);
  for (let d = dir; d !== parse(d).root; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
  }
  return dir;
}

// Never offer to share the home folder, the filesystem root, or anything above home.
export function isShareable(dir) {
  const home = real(homedir());
  const d = real(dir);
  return d !== parse(d).root && d !== home && !home.startsWith(d + sep);
}
