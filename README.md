# gmail-multi-mcp

An MCP server that gives an AI assistant access to **several Gmail accounts at once** — work, personal, and one per client — with safeguards that assume the assistant will, sooner or later, read a hostile email.

Most Gmail MCP servers connect one account and expose `send_email`. That is fine until the assistant is reading an inbox that strangers can write to. This one is built around three ideas:

- **Tiered access per account.** Each account is connected at `readonly`, `draft`, or `send`. Your personal inbox can be read-only forever while one work account is allowed to send.
- **Two-phase writes.** Nothing irreversible happens on one tool call. The first call returns a preview and a token; the second call executes, and only if every argument is byte-identical to what was previewed.
- **Mail is untrusted input.** Message bodies are fenced with a random nonce and labelled as data, and known coercion patterns are flagged to the model and written to an audit log.

---

> **Status: 0.1.0.** 140 tests cover the safety logic, the MCP protocol layer (an end-to-end handshake against the built server), the OAuth flow, the browser setup pages, and the IMAP backend's pure logic.
>
> **Verified live on real Gmail:** connecting two accounts by in-chat Google sign-in, the OAuth token exchange, reading and searching, and two-phase sending in both directions between the accounts. The **IMAP / app-password backend's** live calls are so far exercised only by their pure-logic tests — if you connect a mailbox that way and something breaks, please [open an issue](https://github.com/dtaveeva/gmail-multi-mcp/issues) with whatever you hit.

## Quick start

1. **Install it** (needs [Node 18+](https://nodejs.org)):

   ```bash
   npm install -g gmail-multi-mcp
   ```

   Or from source: `git clone https://github.com/dtaveeva/gmail-multi-mcp.git && cd gmail-multi-mcp && npm install && npm run build`.

2. **Wire it into your AI assistant** — one line for Claude Code, or a small config block for Claude Desktop. See [Wiring it into a client](#wiring-it-into-a-client).

3. **Connect a mailbox from the chat** — just ask your assistant:

   > connect my gmail with google sign-in

   A page opens on your own machine and walks you through a one-time (~2 minute) Google setup, then signs you in. Repeat the ask for each account you want. Prefer no Google project at all? See [Connecting accounts from inside the chat](#connecting-accounts-from-inside-the-chat).

4. **Use it** — "search my work inbox for unread invoices", "reply to Dana's last email from my work account". Every send shows you a preview and asks you to confirm the sending account and recipients before anything leaves your mailbox.

> By downloading or using this software you agree to the [Terms of Use](TERMS.md). It is provided **with no warranty — you use it at your own risk.**

---

## Install

Requires Node 18+.

**From npm (recommended):**

```bash
npm install -g gmail-multi-mcp
```

This puts the `gmail-multi-mcp` command on your PATH, which the rest of this README assumes.

**From source:**

```bash
git clone https://github.com/dtaveeva/gmail-multi-mcp.git
cd gmail-multi-mcp
npm install
npm run build
npm link
```

`npm link` puts the `gmail-multi-mcp` command on your PATH. If you would rather not link it globally, every command below also works as `node /path/to/gmail-multi-mcp/dist/src/index.js <args>`.

Then run the guided setup:

```bash
gmail-multi-mcp setup
```

It walks you through the whole thing — opens each Google page in the right order, tells you exactly what to click, finds the credentials file in your Downloads folder automatically, and finishes by connecting your first mailboxes. About two minutes, once.

If you would rather do it by hand, the same steps are written out below.

### Two ways to connect

The wizard asks which you want. You can mix them — personal on an app password, work on OAuth.

|  | **App password** | **Google Cloud OAuth** |
|---|---|---|
| Setup | ~30 seconds per mailbox | ~2 minutes once, then 1 click each |
| Google Cloud project | **not needed** | required (free) |
| Read-only accounts | enforced by this program | **enforced by Google** — the account physically cannot send |
| Works with | most personal Gmail | any account |
| Blocked by | Advanced Protection; Workspace admins can disable | nothing |

**Most people want app passwords.** You generate one in your Google account settings, paste it in, done. No console, no consent screen, no verification.

**OAuth earns its two minutes for exactly one reason:** it can grant scoped, read-only access. A mailbox connected `readonly` over OAuth is incapable of sending, and that is enforced by Google rather than by this code — so it holds even if this program is compromised. An app password is a single all-or-nothing credential, so with it a `readonly` account is only as safe as this code is correct.

If you want your personal inbox readable but provably un-sendable-from, use OAuth for that one. Otherwise app passwords are fine.

### Why does OAuth need a Google project?

Because Google requires it. Gmail's scopes are classified **restricted** — the most sensitive tier — and any app offering one shared sign-in for everybody must pass a third-party security audit that recurs annually and costs real money. Tools that skip it are capped at 100 users and show a warning screen to every one of them.

So each person creates their own free project. There is a real upside: your mail only ever touches your own Google project, with no shared server holding your tokens. But it is genuinely optional now — app passwords skip it entirely.

---

## Setting up Google Cloud by hand

`gmail-multi-mcp setup` does all of this for you and is the recommended path. These are the same steps, written out, for anyone who prefers to drive the console themselves or is debugging a setup that went wrong.

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
gmail-multi-mcp doctor
```

---

## Connecting accounts

Each account is connected separately, at whatever tier you want it to have.

```bash
gmail-multi-mcp auth add --tier readonly --label personal
gmail-multi-mcp auth add --tier send --label acme
```

Your browser opens, you pick the Google account, you approve. The refresh token goes into your OS keychain (Windows Credential Manager, macOS Keychain, or libsecret); if no keychain is available it falls back to an AES-256-GCM encrypted file.

Restrict who a sending account is allowed to mail — strongly recommended for any account at `send` tier:

```bash
gmail-multi-mcp auth allow acme@yourdomain.com @acme.com @yourdomain.com
```

Now that account can only send to those two domains. Everything else is refused before it reaches Gmail.

Other commands:

```bash
gmail-multi-mcp auth list                          # what is connected, at what tier
gmail-multi-mcp auth tier personal@gmail.com draft # change tier (re-authorises)
gmail-multi-mcp auth remove personal@gmail.com     # disconnect and erase the token
gmail-multi-mcp doctor                             # diagnose setup problems
```

### Connecting a second, third, fifth account

With an **app password** — no Cloud project involved:

```bash
gmail-multi-mcp auth add-password personal@gmail.com --tier readonly --label personal
gmail-multi-mcp auth add-password work@acme.com --tier send --label work
```

It opens Google's app-password page, takes the pasted password without echoing it, strips the spaces Gmail puts in it, and verifies it against Gmail before storing anything — so a typo or a disabled IMAP setting fails now rather than on your first search.

With **OAuth** — run `auth add` once per mailbox. Google's account chooser is always shown, so each run can target a different account, including one your browser is not currently signed into. You never need to sign out of anything.

```bash
gmail-multi-mcp auth add --tier readonly --label personal
gmail-multi-mcp auth add --tier send --label acme
gmail-multi-mcp auth add --tier draft --label agency --email me@agency.com
```

`--email` pre-selects an account in the chooser, which saves a click when you know exactly which one you want.

Re-running `auth add` for an account that is already connected **re-authorises** it rather than adding a duplicate — that is how you change a tier — and it tells you that is what happened. Its label and recipient allowlist are preserved.

### Does it remember accounts between conversations?

Yes, with one distinction worth understanding.

**The connections persist.** The account registry lives in `~/.gmail-multi-mcp/accounts.json` and refresh tokens live in your OS keychain. Both are on disk and have nothing to do with any conversation. Every new chat spawns a fresh server process that reads them at startup, so all your mailboxes are available immediately with no re-authorisation. There are tests asserting exactly this across independent processes.

**The assistant's habits do not.** A new conversation starts with no memory of "use `acme` for client work". What survives is the *labels* — any session can call `gmail_list_accounts` and discover `personal`, `acme`, and `agency`, along with each one's tier and allowlist. So choose labels that mean something; they are the durable naming.

If you want an assistant to reach for the right mailbox without being told every time, write it where that assistant reads persistent context. For Claude Code, a line in `CLAUDE.md`:

```markdown
Gmail: use the `acme` account for Acme client mail, `personal` for everything else.
Never send from `personal` without asking me first.
```

That is a project instruction, not something this server enforces. The controls that actually bind are tiers and allowlists — if `personal` should never send, connect it `readonly` and the question cannot arise.

---

## Wiring it into a client

**Claude Code** — with `gmail-multi-mcp` on your PATH (from the global npm install, or `npm link`):

```bash
claude mcp add gmail -- gmail-multi-mcp
```

**Claude Desktop** — add to `claude_desktop_config.json`. Use the absolute path rather than the linked command name: desktop apps are launched by the OS and often do not inherit your shell's `PATH`.

```json
{
  "mcpServers": {
    "gmail": {
      "command": "node",
      "args": ["/absolute/path/to/gmail-multi-mcp/dist/src/index.js"]
    }
  }
}
```

On Windows, escape the backslashes: `"C:\\Users\\you\\gmail-multi-mcp\\dist\\src\\index.js"`.

Ask it to `list my gmail accounts` to confirm the connection.

---

## Connecting accounts from inside the chat

No terminal and no Google Cloud project. Once the server is wired into your client, just ask:

> add my work gmail

A page opens **on your own machine** — `http://127.0.0.1:<port>` — explaining how to generate a Gmail app password, with a box to paste it into. You paste, it checks the password against Gmail, and the account is connected. Repeat for the next mailbox.

The credential goes **browser → localhost → Gmail**. It is never shown to the assistant and never written into your conversation. That is the entire reason the page exists: asking for an app password in chat would put a full-access mailbox credential into a transcript that gets stored and synced. The server's instructions tell assistants never to do that.

The tool returns as soon as the browser opens rather than blocking, so nothing times out while you are clicking around in Google's settings; the assistant calls `gmail_connection_status` afterwards to collect the result.

### If you want Google sign-in instead

Ask for it explicitly — `gmail_connect_account` takes `method: "google_signin"`. It needs the one-time Cloud project, and buys exactly one thing: **scoped read-only access that Google enforces**, so a mailbox becomes provably incapable of sending. Worth it for an inbox you want read but never written; unnecessary otherwise.

If the Cloud client is not set up, `gmail_setup_status` returns the console links and steps, and `gmail_configure_oauth_client` stores the client id and secret you paste back. That much *is* safe to put in chat: a Desktop-app client is a **public client** by OAuth's definition and Google does not treat its secret as confidential. It identifies your project; it grants access to nothing.

## Tools

| Tool | Tier needed | Confirmation |
|---|---|---|
| `gmail_setup_status` | — | — |
| `gmail_configure_oauth_client` | — | — |
| `gmail_connect_account` | — | browser sign-in |
| `gmail_connection_status` | — | — |
| `gmail_disconnect_account` | — | **yes** |
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

How strongly a tier binds depends on how the account was connected:

- **OAuth + `readonly`** — the granted scope is physically incapable of writing. Even total compromise of this process cannot alter that mailbox. This is the only guarantee here that does not depend on my code being correct.
- **OAuth + `draft` / `send`**, and **every app-password account** — enforced by this server's own logic. Real defense in depth, but a different kind of guarantee.

`gmail_list_accounts` reports which of these applies per account, so an assistant never describes an app-password `readonly` mailbox as if Google were enforcing it. This is spelled out rather than smoothed over, because a security control you misunderstand is worse than one you know you don't have.

`GMAIL_MCP_READONLY=1` forces every account down to readonly regardless of its configured tier — useful when you want an assistant triaging mail with no possibility of a write.

### Two-phase confirmation

Calling `gmail_send` without `confirm_token` returns a rendered preview and a token bound to a SHA-256 fingerprint of the exact arguments. Calling again with that token sends — but only if every argument still matches. Change one recipient between preview and confirmation and the token is refused.

What this buys you is **binding** and **visibility**: the exact payload is rendered into the transcript before anything leaves the mailbox, and an injected instruction cannot preview something benign and then send something else.

What it does *not* buy you by default is authorization — in `inline` mode the model receives the token and can redeem it immediately, so the human gate is your MCP client's own tool-approval prompt. If you want a real human in the loop:

```bash
GMAIL_MCP_CONFIRM_MODE=strict
```

In strict mode the token is printed to the **server's terminal** and never returned to the model, so redeeming it requires a human to read it off the screen. Slower, and genuinely un-bypassable by the model.

### Sender confirmation

In a multi-account setup the easiest mistake is sending from the *wrong* mailbox — an assistant picks a plausible account the user never actually named. The two-phase token binds the sending account (swap it after the preview and the token is refused), but binding only catches a change *after* the preview, not a wrong choice made before it.

So every send preview opens with a banner that names the sending account and asks for it to be confirmed, and the server instructs assistants to confirm *which* account to send from whenever the user did not say. The sender is also part of the confirmation fingerprint, so it cannot be quietly changed between preview and send. If you want to remove the question entirely for a given inbox, connect it below `send` tier — an account that cannot send cannot be the wrong sender.

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
| `GMAIL_MCP_NO_BROWSER` | off | Do not auto-open a browser during `auth add`; print the URL instead |

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

## Disclaimer

This software is provided free, **with no warranty of any kind, and you use it entirely at your own risk.** It sends and modifies real email from real accounts, frequently driven by an AI assistant that can be influenced by the very mail it reads. The safeguards documented above reduce that risk but do not eliminate it. The author is **not liable** for anything that results from using it — lost or exposed mail, mistaken sends, account suspensions, or actions taken by an AI on your behalf. You are responsible for what you connect it to and what it does.

Full terms: **[Terms of Use](TERMS.md)**. By downloading, installing, or running the Software you accept them.

## License

[MIT](LICENSE) — see also the [Terms of Use](TERMS.md).
