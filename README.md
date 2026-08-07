# gmail-multi-mcp

An MCP server that gives an AI assistant access to **several Gmail accounts at once** — work, personal, and one per client — with safeguards that assume the assistant will, sooner or later, read a hostile email.

Most Gmail MCP servers connect one account and expose `send_email`. That is fine until the assistant is reading an inbox that strangers can write to. This one is built around three ideas:

- **Tiered access per account.** Each account is connected at `readonly`, `draft`, or `send`. Your personal inbox can be read-only forever while one client account is allowed to send.
- **Two-phase writes.** Nothing irreversible happens on one tool call. The first call returns a preview and a token; the second call executes, and only if every argument is byte-identical to what was previewed.
- **Mail is untrusted input.** Message bodies are fenced with a random nonce and labelled as data, and known coercion patterns are flagged to the model and written to an audit log.

---

## Install

Requires Node 18+.

```bash
npx -y gmail-multi-mcp doctor
```

That prints your configuration state and creates nothing. You will need your own Google Cloud OAuth client before anything works — see below.

---

## Setting up Google Cloud

This server ships **no OAuth credentials of its own**, on purpose. Gmail's scopes are "restricted", which means a publisher offering a shared client must pass an annual third-party CASA security assessment. Any project that skips it is capped and warning-screened. Rather than route every user's mail through one unverifiable client, you bring your own — your mail only ever touches your own Cloud project.

### 1. Create a project and enable the API

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and create a project.
2. In **APIs & Services → Library**, search for **Gmail API** and click **Enable**.

### 2. Configure the OAuth consent screen

Go to **APIs & Services → OAuth consent screen**. Your choice here has real consequences, so pick deliberately:

| User type | Who it is for | Verification | Refresh tokens |
|---|---|---|---|
| **Internal** | You have Google Workspace and all accounts are on your domain | Not required | Do not expire |
| **External → Testing** | Personal `@gmail.com` accounts, quick trial | Not required | **Expire after 7 days** |
| **External → Production** | Personal accounts, long-term use | Unverified is allowed, with a warning screen and a 100-user cap | Do not expire |

> **The single most common problem with this server.** If you leave an External app in **Testing**, Google expires every refresh token after 7 days and the server starts failing with `invalid_grant` about a week after it worked perfectly. This is Google's behaviour, not a bug here. Move the app to **Production** (you can stay unverified for personal use — you will just click through an "unverified app" warning once), or use **Internal** if you have Workspace.

Add the scopes you intend to use — you only need the ones matching your highest tier:

- `readonly` tier → `.../auth/gmail.readonly`
- `draft` tier → `.../auth/gmail.readonly` and `.../auth/gmail.compose`
- `send` tier → `.../auth/gmail.modify`

If you chose **External → Testing**, add each Gmail address you plan to connect under **Test users**.

### 3. Create the OAuth client

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Desktop app**. (This matters — desktop clients permit the `127.0.0.1` loopback redirect this server uses.)
3. Download the JSON.
4. Save it as `~/.gmail-multi-mcp/oauth-client.json`, or put it anywhere and point `GMAIL_MCP_OAUTH_CLIENT` at it.

Confirm it landed correctly:

```bash
npx -y gmail-multi-mcp doctor
```

---

## Connecting accounts

Each account is connected separately, at whatever tier you want it to have.

```bash
npx -y gmail-multi-mcp auth add --tier readonly --label personal
npx -y gmail-multi-mcp auth add --tier send --label acme
```

Your browser opens, you pick the Google account, you approve. The refresh token goes into your OS keychain (Windows Credential Manager, macOS Keychain, or libsecret); if no keychain is available it falls back to an AES-256-GCM encrypted file.

Restrict who a sending account is allowed to mail — strongly recommended for any account at `send` tier:

```bash
npx -y gmail-multi-mcp auth allow acme@yourdomain.com @acme.com @yourdomain.com
```

Now that account can only send to those two domains. Everything else is refused before it reaches Gmail.

Other commands:

```bash
gmail-multi-mcp auth list                          # what is connected, at what tier
gmail-multi-mcp auth tier personal@gmail.com draft # change tier (re-authorises)
gmail-multi-mcp auth remove personal@gmail.com     # disconnect and erase the token
gmail-multi-mcp doctor                             # diagnose setup problems
```

---

## Wiring it into a client

**Claude Code:**

```bash
claude mcp add gmail -- npx -y gmail-multi-mcp
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["-y", "gmail-multi-mcp"]
    }
  }
}
```

Ask it to `list my gmail accounts` to confirm the connection.

---

## Tools

| Tool | Tier needed | Confirmation |
|---|---|---|
| `gmail_list_accounts` | — | — |
| `gmail_search` | readonly | — |
| `gmail_read_message` | readonly | — |
| `gmail_read_thread` | readonly | — |
| `gmail_list_labels` | readonly | — |
| `gmail_create_draft` | draft | no — drafts never leave the mailbox |
| `gmail_send` | send | **yes** |
| `gmail_send_draft` | send | **yes** |
| `gmail_modify_labels` | send | **yes** |
| `gmail_trash` | send | **yes** |

**Deliberately absent:** permanent deletion, and anything under `gmail.settings` — auto-forwarding rules and filters are a standing exfiltration channel that survives long after a session ends, so this server never requests a scope that can create one. Trash is recoverable for 30 days; permanent deletion is not, so it stays a human action.

---

## How the safeguards actually work

### Tiers

`readonly` is the only tier whose limits are enforced by Google rather than by this code. The granted scope is physically incapable of writing, so even total compromise of this process cannot alter that mailbox. `draft` and `send` are enforced in this server's own logic — real defense in depth, but a different kind of guarantee. The README says this plainly because a security control you misunderstand is worse than one you don't have.

`GMAIL_MCP_READONLY=1` forces every account down to readonly regardless of its configured tier — useful when you want an assistant triaging mail with no possibility of a write.

### Two-phase confirmation

Calling `gmail_send` without `confirm_token` returns a rendered preview and a token bound to a SHA-256 fingerprint of the exact arguments. Calling again with that token sends — but only if every argument still matches. Change one recipient between preview and confirmation and the token is refused.

What this buys you is **binding** and **visibility**: the exact payload is rendered into the transcript before anything leaves the mailbox, and an injected instruction cannot preview something benign and then send something else.

What it does *not* buy you by default is authorization — in `inline` mode the model receives the token and can redeem it immediately, so the human gate is your MCP client's own tool-approval prompt. If you want a real human in the loop:

```bash
GMAIL_MCP_CONFIRM_MODE=strict
```

In strict mode the token is printed to the **server's terminal** and never returned to the model, so redeeming it requires a human to read it off the screen. Slower, and genuinely un-bypassable by the model.

### Untrusted content handling

Anyone can email an address this server can read, so every message body is attacker-controlled input. Bodies are wrapped in a fence carrying a per-call random nonce — content cannot guess the closing delimiter and "escape" into instruction context — and prefixed with an explicit statement that the block is data. Forged fence markers inside the content are stripped.

A heuristic scan flags instruction-override attempts, role reassignment, exfiltration requests, credential harvesting, and smuggled tool-call syntax. Matches are surfaced to the model as a warning banner and recorded in the audit log.

**This scan is a tripwire, not a filter.** It will never be complete, and it is not what makes the system safe. The controls that do real work are the tiers, the recipient allowlist, and confirmation.

### Rate limits and audit

Every account gets a sliding hourly cap — 10 sends and 60 other mutations by default. This bounds blast radius: a runaway loop or a successful injection can do at most N things before being refused, turning an unbounded incident into a bounded, auditable one.

Every action lands in `~/.gmail-multi-mcp/audit.log` as JSONL. Message bodies are never written — only a length and a truncated SHA-256, enough to prove after the fact which body was sent without making the log a second copy of your mail.

---

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `GMAIL_MCP_HOME` | `~/.gmail-multi-mcp` | Data directory |
| `GMAIL_MCP_OAUTH_CLIENT` | `$GMAIL_MCP_HOME/oauth-client.json` | Path to your OAuth client JSON |
| `GMAIL_MCP_READONLY` | off | Force every account to readonly |
| `GMAIL_MCP_DRY_RUN` | off | Validate and audit writes without executing them |
| `GMAIL_MCP_CONFIRM_MODE` | `inline` | `strict` sends tokens to the terminal instead of the model |
| `GMAIL_MCP_CONFIRM_TTL_MS` | `300000` | How long a confirmation token stays valid |
| `GMAIL_MCP_MAX_SENDS_PER_HOUR` | `10` | Per account; `0` disables the cap |
| `GMAIL_MCP_MAX_MUTATIONS_PER_HOUR` | `60` | Per account; `0` disables the cap |
| `GMAIL_MCP_MAX_BODY_CHARS` | `20000` | Truncation point for message bodies |
| `GMAIL_MCP_PASSPHRASE` | unset | Encrypts the file-based token store with your passphrase |
| `GMAIL_MCP_FORCE_FILE_STORE` | off | Skip the OS keychain and always use the encrypted file |

A cautious starting point for a shared or unattended machine:

```bash
GMAIL_MCP_CONFIRM_MODE=strict
GMAIL_MCP_MAX_SENDS_PER_HOUR=3
```

---

## Troubleshooting

**`invalid_grant` about a week after it worked.** Your OAuth app is in Testing status. See the table above; move it to Production or Internal, then re-run `auth add`.

**"Google hasn't verified this app".** Expected for an unverified External app in Production. Click **Advanced → Go to (unsafe)**. You are the app's publisher; you are trusting yourself.

**Google did not return a refresh token.** You previously authorised this app and Google skipped the consent screen. Revoke it at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and connect again.

**Tools appear but every call fails.** Run `gmail-multi-mcp doctor` — almost always a missing or misplaced `oauth-client.json`.

**Keychain unavailable on headless Linux.** Install `libsecret`, or set `GMAIL_MCP_PASSPHRASE` and let it use the encrypted file store.

---

## Development

```bash
npm install
npm run build
npm test
```

The suite covers the security-critical paths — confirmation binding, tier enforcement, allowlist matching, header-injection refusal, rate limiting, and containment — plus an end-to-end smoke test that spawns the built server and completes a real MCP handshake with no credentials present.

Note: `google-auth-library` is pinned to the exact version `googleapis-common` depends on. A looser range causes npm to install a second nested copy, and the two `OAuth2Client` types then fail to unify. If you bump `@googleapis/gmail`, check that pin.

See [SECURITY.md](SECURITY.md) for the threat model and what this server does *not* protect against.

## License

MIT
