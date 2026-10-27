# Security model

## Who can do what

| Actor | Can | Cannot |
|---|---|---|
| Teammate on the hub | Ask any project you're sharing a question; chat | Choose what gets read on your machine; impersonate another user (identity is `tailscale whois`) |
| Your sandbox (answers questions) | `Read`/`Grep`/`Glob` inside the one project a `cc-relay share` terminal is running in | Run commands, edit, browse the web, use MCP servers, message other local sessions, read outside the project, read secret-pattern files, run hooks, see your CLAUDE.md or memory |
| Your Claude Code sessions | Ask others | Answer questions or start sharing |
| Hub operator | See message text routed through their hub | Read your files |
| Anyone not on the tailnet, or not on the hub's `--allow-user` list if one is set | Nothing; the hub binds to the Tailscale interface and rejects unknown identities | |

## Layers

**Network.** The hub listens only on the Tailscale IP. Every connection is identified with
`tailscale whois`. By default the hub admits every user on the tailnet, so the tailnet's
membership is the boundary. `--allow-user` and `--allow-domain` narrow it. Session ids start
with the full identified login, so `alice@example.com/...` can only be that user. Ids use the whole
login so that `sam@example.com` and `sam@github` can't collide. Clients pin the hub
owner at setup and refuse a hub run by someone else.

**Hub protocol.**
- 64 KB frames and 16 KB messages.
- Per-user rate limits: 60 messages and 10 questions per minute.
- Questions can't be broadcast.
- A reply is only accepted from the session that was asked, addressed to the asker, once, within
  10 minutes.

**Explicit, visible sharing.** Nothing is shared by joining. A project is answerable only while
its owner runs `cc-relay share` in that folder: the terminal shows every question, Ctrl+C stops it,
and `--approve` makes the owner confirm each one. Chat sessions (the MCP bridge inside Claude
Code) never answer, so Claude in a chat session can't start sharing. The home folder, `/` and
anything above home can't be shared.

**Owner policy.** `cc-relay share` flags set who may ask (`--allow`) and whether you approve each
question (`--approve`). `~/.cc-relay/config.json` holds:
- secret deny patterns
- per-asker and daily answer limits, a budget per answer, a timeout, a cap on reply size

Every question is written to `~/.cc-relay/audit.log`.

**Sandbox** (`src/sandbox.js`). Each question gets a fresh `claude -p`, started in the project
folder with a minimal environment:

| Flag | Closes |
|---|---|
| prompt via **stdin**, not argv | Flag injection: a question of `--version` was executed as a CLI flag |
| `--tools Read,Grep,Glob` | `--disallowedTools` is a blocklist. The child still had **SendMessage, ListAgents, RemoteTrigger, CronCreate, Workflow**, which reach your other local sessions with full access. |
| *no* `--allowedTools Read` | Allowlisting bare `Read` permits **every path on disk**. A probe read a file outside the project. |
| `--permission-mode dontAsk` | Anything not pre-approved (outside cwd, symlink targets outside) is denied, not prompted |
| `--settings` deny `Read(./**/.env*)`, keys, keystores, … | `.env` inside the exposed project was readable |
| `--safe-mode`, `--setting-sources ''`, `--strict-mcp-config` | Your CLAUDE.md, auto-memory, hooks, plugins, skills, allow rules and MCP servers (Gmail, Drive, …) |
| `--max-budget-usd`, timeout, reply cap | Cost and abuse |

`npm run probe` re-runs these attacks against the installed Claude Code with the guard
system prompt **off**. It plants canary secrets and fails if any comes back, if a forbidden tool
is available, or if a project hook runs. **Run it after every Claude Code update.** New releases
add tools and change flags.

## Residual risks (read these)

1. **Everything in an exposed project that doesn't match a deny pattern is readable.** That
   includes hardcoded keys in source (`.git/` itself is denied). Expose only projects you'd
   show a teammate.
   Add patterns to `denyRead` in the config.
2. **Replies are untrusted input to the asker's session**, which has full access. A malicious
   or confused answer can carry prompt injection. Replies are wrapped and labelled as untrusted.
   Don't auto-approve actions that a reply suggests.
3. **Outbound text from your own session.** `relay_ask` and `relay_send` carry whatever Claude
   writes. Keep them on per-call approval and read what goes out.
4. **The hub operator sees message text.** Run the hub on a machine you trust. WireGuard
   encrypts transport, but messages are not end-to-end encrypted between sessions.
5. **Config tampering.** The wizard can deny Claude's Edit/Write on `~/.cc-relay`, but your
   interactive session's Bash could still change it. Review the config if something seems off
   (`cat ~/.cc-relay/config.json`).
6. **Answers cost you.** The sandbox runs on the owner's Claude account, within the configured
   limits.
7. Offline messages are held only in hub memory and are lost when the hub restarts.

## Tailscale admin settings (recommended)

- Turn on **device approval** and **user approval** for the tailnet.
- Invited members can reach **every device** under the default policy. Use the grants in the
  README so members reach only their own devices plus port 7777 on each other's. Keep personal
  machines off the team tailnet.
- Hubs run on personal machines, so don't tag them. Tagged devices lose user identity, and hub
  pinning relies on it.

## Reporting a vulnerability

Please report security issues privately through GitHub's
[security advisories](https://github.com/vladt99/cc-relay/security/advisories/new) rather than in
a public issue. Include the Claude Code version (`claude --version`) and `npm run probe` output if
relevant.
