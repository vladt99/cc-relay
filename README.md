# cc-relay

**Let your Claude Code session ask a teammate's Claude Code session about their project.**

```
you:   "ask alice@example.com/api how auth tokens are refreshed"
alice: "src/auth/refresh.ts:42 rotates the token 5 minutes before expiry, …"
```

You share a project by running `cc-relay share` in its folder. While that terminal is open,
everyone on the relay can ask about that project, and a **read-only sandbox** answers from its
files. It can't run commands, edit files, read secrets or see anything else. Close the terminal and
the project is private again. Everything travels over your private
[Tailscale](https://tailscale.com) network.

> Unofficial community project. Not affiliated with Anthropic or Tailscale.

---

## How it works

```
 your Claude Code ──▶ cc-relay mcp ──┐                    ┌──▶ cc-relay share (~/code/api)  ──▶ sandbox
                                     ├──▶ cc-relay hub ───┤
 their Claude Code ─▶ cc-relay mcp ──┘   (any teammate)   └──▶ cc-relay share (~/code/web)  ──▶ sandbox
```

- **Hub:** a tiny message router that any teammate runs. It identifies everyone by their Tailscale login.
- **Chat bridge** (`cc-relay mcp`): gives every Claude Code session the `relay_*` tools to ask
  questions. Chat sessions never answer.
- **Share** (`cc-relay share`): one terminal per project you want visible. It answers each question
  in a fresh, locked-down `claude -p` and lists every question as it arrives.

## Quick start

**Prerequisites:** Node.js 20+, [Claude Code](https://docs.claude.com/en/docs/claude-code), and
Tailscale, with everyone on the same tailnet (see [Network setup](#network-setup)).

```sh
# 1. Install (everyone)
npm install -g git+https://github.com/vladt99/cc-relay.git

# 2. Start a hub (one person). It prints a command to share.
cc-relay hub

# 3. Join (everyone): paste that command
cc-relay setup ws://100.x.y.z:7777

# 4. Share a project (optional): run in its folder and keep the terminal open
cd ~/code/api && cc-relay share

# 5. Restart Claude Code and ask: "who's on the relay?"
```

## Usage

Just talk to Claude:

> *"who's on the relay?"*
> *"ask alice@example.com/api how auth tokens are refreshed, and wait for the answer"*
> *"tell everyone on the relay I'm deploying in 10 minutes"*

| Tool | Purpose |
|---|---|
| `relay_peers` | Who's online, and which projects are shared |
| `relay_ask` | Ask a shared project a question; its sandbox answers |
| `relay_wait` · `relay_inbox` | Get replies and messages |
| `relay_send` | Chat message to one session, or `*` for everyone |
| `relay_whoami` | Your id and connection status |

Chat sessions show up in `relay_peers` as `<login>/<folder>.chat-xxxx` and only ask. Shared
projects show up as `<login>/<project>` with access `read`.

### Sharing a project

```sh
cd ~/code/api
cc-relay share
```

```
  Sharing ~/code/api read-only on ws://100.101.102.103:7777
  Who can ask: everyone on the relay
  Answers come from a sandboxed Claude: Read/Grep/Glob in this folder only, no secret files.
  Ctrl+C to stop sharing.
05:44:56 PM  connected as alice@example.com/api
05:45:01 PM  ? bob@example.com: How are auth tokens refreshed?
05:45:08 PM  ✓ answered bob@example.com (412 chars)
```

- **One terminal per project.** Run it again in another folder to share another project.
- **Closing the terminal (or Ctrl+C) stops sharing** immediately.
- `--approve` shows each question and waits for you to press **y** before it's answered.
- `--allow bob@example.com` (repeatable) limits who may ask. By default it's everyone on the relay.
- Your home folder can't be shared; run it inside a project.
- Every question is also logged in `~/.cc-relay/audit.log`.

## Setup guide

### Network setup

Everyone needs to be on one tailnet. If you're the admin:

1. **Create a tailnet just for the team.** Don't invite people into one with your personal
   devices on it.
2. **Restrict access.** Under *Access controls* in the admin console, use:
   ```json
   {
     "grants": [
       { "src": ["autogroup:member"], "dst": ["autogroup:self"],   "ip": ["*"] },
       { "src": ["autogroup:member"], "dst": ["autogroup:member"], "ip": ["tcp:7777"] }
     ]
   }
   ```
   Members keep full access to their own devices and reach each other's only on port 7777.
3. **Turn on device approval and invite teammates** by email. Any Google, GitHub or Microsoft
   login works.

If teammates already use Tailscale for something else, they can switch between tailnets with
`tailscale switch`.

### Run a hub

```sh
cc-relay hub [--port 7777] [--allow-user alice@example.com] [--allow-domain example.com]
```

The hub listens only on the machine's Tailscale address. It admits everyone on the tailnet unless
you narrow it with `--allow-user` or `--allow-domain`. It prints the exact `cc-relay setup …`
command to share. That command uses the machine's Tailscale IP, which is stable and works even
where MagicDNS names don't resolve. Keep it running with `tmux`, `pm2` or similar. It stores nothing on disk.

### Join

```sh
cc-relay setup ws://<hub-address>:7777
```

The wizard shows **who runs the hub** and pins that person, so a different machine at that address
is refused. It can also stop Claude from editing `~/.cc-relay` with its file tools, and it
registers the MCP server with Claude Code. Joining shares nothing; sharing is always an explicit
`cc-relay share`.

Restart Claude Code afterwards. Re-run `cc-relay setup` to switch hubs.

## Security

The sandbox's limits are enforced by Claude Code's permission system, not just by asking the model
to behave:

- only `Read`, `Grep` and `Glob`; reads outside the shared project are denied
- secret files are always denied (`.env*`, keys, keystores, `.git/`, …)
- no CLAUDE.md, memory, hooks, plugins or MCP servers
- the question is passed on stdin, so it can't be parsed as a CLI flag
- per-user rate limits, answer budgets, and an audit log

Things to keep in mind:

- **Replies are untrusted.** Don't let Claude act on what another agent tells it without checking
  with you.
- **Outgoing text.** Keep `relay_ask` and `relay_send` on "ask me every time": they send text out
  of your session.
- **Shared projects.** Code in a shared project is readable, including any keys hardcoded in it.

Full threat model, probe results and residual risks are in **[SECURITY.md](SECURITY.md)**.

## Reference

<details>
<summary><b>Configuration</b> (<code>~/.cc-relay/config.json</code>)</summary>

```jsonc
{
  "url": "ws://100.101.102.103:7777",
  "hubLogin": "alice@example.com",          // pinned hub owner
  "denyRead": ["**/.env*", "**/*.pem", "**/*.key", "..."],
  "limits": {
    "perAskerPer10Min": 5,
    "answersPerDay": 50,
    "maxBudgetUsdPerAnswer": 0.5,
    "answerTimeoutSec": 180,
    "maxReplyChars": 16000
  }
}
```

Environment overrides: `CC_RELAY_URL`, `CC_RELAY_SESSION`, `CC_RELAY_CONFIG`.
</details>

<details>
<summary><b>Troubleshooting</b></summary>

| Symptom | Fix |
|---|---|
| *not set up* | Run `cc-relay setup <hub-url>`, then restart Claude Code |
| *not connected* / timeout | Is the hub running? Are you on the right tailnet (`tailscale switch --list`)? Does the ACL allow port 7777? |
| `4001 not a tailnet peer` | Connect to Tailscale |
| `4003 user not allowed` | The hub's `--allow-user` / `--allow-domain` doesn't include you |
| *hub is run by X, expected Y* | The address now points to someone else's hub. Re-run setup if that's expected. |
| `4000 replaced by a newer connection` | The same project is shared twice. Close one of the `cc-relay share` terminals. |
| *declined: this is a chat session* | You asked a chat session. Ask a shared project (access `read` in `relay_peers`). |
| A project isn't in `relay_peers` | Its owner needs to run `cc-relay share` in that folder and keep the terminal open |
</details>

<details>
<summary><b>Update and uninstall</b></summary>

```sh
# update (then restart Claude Code)
npm install -g git+https://github.com/vladt99/cc-relay.git

# uninstall
claude mcp remove --scope user cc-relay
npm uninstall -g cc-relay
rm -rf ~/.cc-relay
# optional: remove "Edit(~/.cc-relay/**)" from permissions.deny in ~/.claude/settings.json
```
</details>

## Development

```sh
git clone https://github.com/vladt99/cc-relay.git && cd cc-relay && npm install
npm test        # unit tests (no network, no Claude calls)
npm run probe   # live attacks against the sandbox with your installed Claude Code
```

Run `npm run probe` after every Claude Code update. New versions can add tools or change flags.

| Path | |
|---|---|
| `bin/cc-relay.js` | CLI: `hub`, `setup`, `share`, `mcp` |
| `src/hub.js` | Hub: identity, allowlists, ask/reply binding, rate limits |
| `src/bridge.js` | MCP server in each chat session (ask-only) |
| `src/share.js` · `src/answerer.js` | `cc-relay share`: allow list, rate limits, approval |
| `src/client.js` | Hub connection and hub pinning |
| `src/sandbox.js` | The locked-down answering Claude |
| `src/setup.js` | Setup wizard |
| `scripts/probe.js` | Live security probes |

## License

[MIT](LICENSE)
