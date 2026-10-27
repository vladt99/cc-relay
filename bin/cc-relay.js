#!/usr/bin/env node
import { parseArgs } from 'node:util';

const HELP = `cc-relay: let Claude Code sessions on your tailnet ask each other questions

  cc-relay hub [--port 7777] [--allow-domain example.com]... [--allow-user a@example.com]...
      Run a hub on this machine (Tailscale interface only) and print the
      address to share. By default everyone on the tailnet may join.

  cc-relay setup [ws://hub-address:7777]
      First-run wizard: pick and pin the hub, register the MCP server with
      Claude Code. Re-run to switch hubs.

  cc-relay share [--approve] [--allow login]...
      Share the project in the current folder, read-only, while this terminal
      runs. Everyone on the relay can ask unless --allow narrows it; --approve
      makes you confirm each question. Ctrl+C stops sharing.

  cc-relay mcp
      The MCP server Claude Code starts (registered by setup).
`;

const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === 'hub') {
    const { values } = parseArgs({
      args: rest,
      options: {
        port: { type: 'string', default: '7777' },
        host: { type: 'string' },
        'allow-domain': { type: 'string', multiple: true },
        'allow-user': { type: 'string', multiple: true },
      },
    });
    const { runHub } = await import('../src/hub.js');
    await runHub({ port: Number(values.port), host: values.host, allowDomains: values['allow-domain'], allowUsers: values['allow-user'] });
  } else if (cmd === 'setup') {
    const { runSetup } = await import('../src/setup.js');
    await runSetup(rest[0]);
  } else if (cmd === 'share') {
    const { values } = parseArgs({
      args: rest,
      options: { approve: { type: 'boolean', default: false }, allow: { type: 'string', multiple: true } },
    });
    const { runShare } = await import('../src/share.js');
    await runShare({ allow: values.allow?.length ? values.allow : ['*'], approve: values.approve });
  } else if (cmd === 'mcp') {
    const { runBridge } = await import('../src/bridge.js');
    await runBridge();
  } else {
    console.log(HELP);
    process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0);
  }
} catch (e) {
  console.error(`cc-relay: ${e.message}`);
  process.exit(1);
}
