import fsp from "node:fs/promises";
import path from "node:path";
import { AccountRegistry } from "../auth/accounts.js";
import { loadOAuthClientConfig } from "../auth/client.js";
import { runOAuthFlow } from "../auth/flow.js";
import { createTokenStore } from "../auth/store.js";
import { loadConfig, TIERS, type Tier } from "../config.js";
import { renderError, UserFacingError } from "../errors.js";

const HELP = `gmail-multi-mcp — multi-account Gmail for MCP clients

USAGE
  gmail-multi-mcp                        Run the MCP server on stdio (default)
  gmail-multi-mcp auth add [options]     Connect a Gmail account
  gmail-multi-mcp auth list              Show connected accounts
  gmail-multi-mcp auth tier <email> <t>  Change an account's tier (re-authorises)
  gmail-multi-mcp auth allow <email> ... Set a send allowlist for an account
  gmail-multi-mcp auth remove <email>    Disconnect an account and erase its token
  gmail-multi-mcp doctor                 Diagnose configuration problems

AUTH ADD OPTIONS
  --tier <readonly|draft|send>   Permission level (default: readonly)
  --label <name>                 Short handle, e.g. "work"
  --email <address>              Pre-select this account in Google's chooser

  Run auth add once per mailbox. Google always shows its account chooser, so
  you can sign into a different account each time — including one your browser
  is not currently signed into.

TIERS
  readonly   Read and search only. Enforced by Google — the granted scope
             physically cannot write, even if this process is compromised.
  draft      Read, plus create and edit drafts. Never sends.
  send       Read, draft, send, label, trash. Every write is confirmed.

ALLOWLIST ENTRIES
  Full addresses ("alice@client.com") or domain suffixes ("@client.com").
  When set, sends from that account to anyone else are refused.

ENVIRONMENT
  GMAIL_MCP_HOME             Data directory (default: ~/.gmail-multi-mcp)
  GMAIL_MCP_OAUTH_CLIENT     Path to your Google OAuth client JSON
  GMAIL_MCP_READONLY=1       Force every account to readonly
  GMAIL_MCP_DRY_RUN=1        Validate and log writes without executing them
  GMAIL_MCP_CONFIRM_MODE     "inline" (default) or "strict" (token to terminal)
  GMAIL_MCP_NO_BROWSER=1     Print the auth URL instead of opening a browser
                             (use this over SSH or on a headless machine)
  GMAIL_MCP_MAX_SENDS_PER_HOUR       Default 10
  GMAIL_MCP_MAX_MUTATIONS_PER_HOUR   Default 60
`;

function out(s: string): void {
  process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function parseTier(raw: string | undefined, fallback: Tier = "readonly"): Tier {
  if (!raw) return fallback;
  if ((TIERS as readonly string[]).includes(raw)) return raw as Tier;
  throw new UserFacingError(
    `Unknown tier "${raw}".`,
    `Valid tiers: ${TIERS.join(", ")}`,
  );
}

async function authAdd(args: string[]): Promise<void> {
  const cfg = loadConfig();
  const tier = parseTier(flag(args, "tier"));
  const label = flag(args, "label");

  const clientConfig = await loadOAuthClientConfig(cfg);
  const [registry, store] = await Promise.all([
    AccountRegistry.load(cfg),
    createTokenStore(cfg),
  ]);

  const { email, token } = await runOAuthFlow(clientConfig, tier, flag(args, "email"));

  // Captured before upsert so we can tell the user which of the two happened.
  // Silently "adding" an account that was already connected is how someone
  // ends up thinking a second mailbox failed to connect.
  const previous = registry.find(email);

  await store.set(email, token);
  await registry.upsert({
    email,
    tier,
    ...(label ? { label } : previous?.label ? { label: previous.label } : {}),
    ...(previous?.allowedRecipients ? { allowedRecipients: previous.allowedRecipients } : {}),
  });

  if (previous) {
    out(`\nRe-authorised ${email} (was tier "${previous.tier}", now "${tier}").`);
    out(`This account was already connected — nothing new was added.`);
    if (previous.allowedRecipients?.length) {
      out(`Its recipient allowlist was kept: ${previous.allowedRecipients.join(", ")}`);
    }
  } else {
    out(`\nConnected ${email} at tier "${tier}".`);
  }
  out(`Tokens stored via: ${store.backend}`);
  out(`Accounts now connected: ${registry.list().length}`);
  if (tier === "send") {
    out(
      `\nThis account can send mail. Consider restricting recipients:\n` +
        `  gmail-multi-mcp auth allow ${email} @yourdomain.com`,
    );
  }
}

async function authList(): Promise<void> {
  const cfg = loadConfig();
  const registry = await AccountRegistry.load(cfg);
  const accounts = registry.list();

  if (!accounts.length) {
    out("No accounts connected. Add one with: gmail-multi-mcp auth add");
    return;
  }

  for (const a of accounts) {
    out(`${a.email}${a.label ? `  [${a.label}]` : ""}`);
    out(`  tier:      ${a.tier}`);
    out(`  scopes:    ${a.scopes.join(" ")}`);
    out(`  added:     ${a.addedAt}`);
    if (a.allowedRecipients?.length) {
      out(`  allowlist: ${a.allowedRecipients.join(", ")}`);
    }
    out("");
  }
}

async function authTier(args: string[]): Promise<void> {
  const [email, rawTier] = args;
  if (!email || !rawTier) {
    throw new UserFacingError("Usage: gmail-multi-mcp auth tier <email> <readonly|draft|send>");
  }
  const tier = parseTier(rawTier);
  const cfg = loadConfig();
  const registry = await AccountRegistry.load(cfg);
  const account = registry.require(email);

  out(
    `Changing ${account.email} from "${account.tier}" to "${tier}" needs different\n` +
      `OAuth scopes, so Google will ask you to authorise again.\n`,
  );

  const clientConfig = await loadOAuthClientConfig(cfg);
  const store = await createTokenStore(cfg);
  // Pre-select the account being changed, so the chooser does not invite the
  // user to pick the wrong one.
  const result = await runOAuthFlow(clientConfig, tier, account.email);

  if (result.email.toLowerCase() !== account.email.toLowerCase()) {
    throw new UserFacingError(
      `You signed in as ${result.email}, but this command targets ${account.email}.`,
      "Nothing was changed. Re-run and choose the matching Google account.",
    );
  }

  await store.set(result.email, result.token);
  await registry.upsert({
    email: account.email,
    tier,
    ...(account.label ? { label: account.label } : {}),
    ...(account.allowedRecipients ? { allowedRecipients: account.allowedRecipients } : {}),
  });
  out(`${account.email} is now at tier "${tier}".`);
}

async function authAllow(args: string[]): Promise<void> {
  const [email, ...entries] = args;
  if (!email) {
    throw new UserFacingError(
      "Usage: gmail-multi-mcp auth allow <email> <entry...>   (no entries clears the list)",
    );
  }
  const cfg = loadConfig();
  const registry = await AccountRegistry.load(cfg);
  const account = registry.require(email);

  await registry.upsert({
    email: account.email,
    tier: account.tier,
    ...(account.label ? { label: account.label } : {}),
    ...(entries.length ? { allowedRecipients: entries } : { allowedRecipients: undefined }),
  });

  out(
    entries.length
      ? `${account.email} may now only send to: ${entries.join(", ")}`
      : `Cleared the recipient allowlist for ${account.email}. It may send anywhere.`,
  );
}

async function authRemove(args: string[]): Promise<void> {
  const email = args[0];
  if (!email) throw new UserFacingError("Usage: gmail-multi-mcp auth remove <email>");

  const cfg = loadConfig();
  const [registry, store] = await Promise.all([
    AccountRegistry.load(cfg),
    createTokenStore(cfg),
  ]);
  const account = registry.require(email);

  await store.delete(account.email);
  await registry.remove(account.email);

  out(`Disconnected ${account.email} and erased its stored token.`);
  out(
    `Google still lists this app under the account's third-party access.\n` +
      `Revoke it fully at: https://myaccount.google.com/permissions`,
  );
}

async function doctor(): Promise<void> {
  const cfg = loadConfig();
  out(`gmail-multi-mcp doctor\n`);
  out(`  node:        ${process.version}`);
  out(`  data dir:    ${cfg.home}`);

  try {
    await fsp.mkdir(cfg.home, { recursive: true });
    await fsp.access(cfg.home);
    out(`  writable:    yes`);
  } catch {
    out(`  writable:    NO — the server cannot store accounts or audit logs here`);
  }

  try {
    await loadOAuthClientConfig(cfg);
    out(`  oauth client: found at ${cfg.oauthClientPath}`);
  } catch (err) {
    out(`  oauth client: MISSING`);
    out(`                ${renderError(err).replace(/\n/g, "\n                ")}`);
  }

  const store = await createTokenStore(cfg);
  out(`  token store: ${store.backend}`);
  if (store.backend.startsWith("encrypted-file") && !process.env.GMAIL_MCP_PASSPHRASE) {
    out(
      `                note: no GMAIL_MCP_PASSPHRASE set, so the encryption key is\n` +
        `                stored beside the data at ${path.join(cfg.home, "store.key")}.`,
    );
  }

  const registry = await AccountRegistry.load(cfg);
  const accounts = registry.list();
  out(`  accounts:    ${accounts.length}`);
  for (const a of accounts) {
    const token = await store.get(a.email);
    out(`    ${a.email} — tier ${a.tier}, token ${token ? "present" : "MISSING"}`);
  }

  out(`\n  confirm mode: ${cfg.confirmMode}`);
  out(`  dry run:      ${cfg.dryRun ? "ON" : "off"}`);
  out(`  force readonly: ${cfg.forceReadonly ? "ON" : "off"}`);
  out(`  audit log:    ${cfg.auditPath}`);
}

export async function runCli(argv: string[]): Promise<number> {
  const [command, sub, ...rest] = argv;

  try {
    if (command === "auth") {
      switch (sub) {
        case "add":
          await authAdd(rest);
          return 0;
        case "list":
          await authList();
          return 0;
        case "tier":
          await authTier(rest);
          return 0;
        case "allow":
          await authAllow(rest);
          return 0;
        case "remove":
          await authRemove(rest);
          return 0;
        default:
          out(HELP);
          return sub ? 1 : 0;
      }
    }

    if (command === "doctor") {
      await doctor();
      return 0;
    }

    out(HELP);
    return 0;
  } catch (err) {
    process.stderr.write(`\n${renderError(err)}\n`);
    return 1;
  }
}
