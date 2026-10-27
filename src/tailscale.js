// Thin wrappers around the tailscale CLI. Identity on the relay always comes
// from here, never from anything a client says about itself.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lookup } from 'node:dns/promises';

const run = promisify(execFile);

export async function status() {
  const { stdout } = await run('tailscale', ['status', '--json']);
  return JSON.parse(stdout);
}

// Who is this machine on the tailnet: login, MagicDNS name, Tailscale IPs.
export async function self() {
  const s = await status();
  const user = s.User?.[s.Self.UserID];
  return {
    running: s.BackendState === 'Running',
    tailnet: s.CurrentTailnet?.Name || null,
    login: user?.LoginName || null,
    dnsName: (s.Self.DNSName || '').replace(/\.$/, '') || null,
    ips: s.Self.TailscaleIPs || [],
  };
}

// Tailnet identity of the node and user behind a Tailscale IP.
export async function whois(ip) {
  const { stdout } = await run('tailscale', ['whois', '--json', ip]);
  const w = JSON.parse(stdout);
  return { login: w.UserProfile.LoginName, host: w.Node.ComputedName || w.Node.Name };
}

export async function whoisHost(hostname) {
  const { address } = await lookup(hostname);
  return whois(address);
}
