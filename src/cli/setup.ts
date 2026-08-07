import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { AccountRegistry, type Account } from "../auth/accounts.js";
import { loadOAuthClientConfig } from "../auth/client.js";
import { runOAuthFlow } from "../auth/flow.js";
import { createTokenStore } from "../auth/store.js";
import { loadConfig, type Tier } from "../config.js";
import { UserFacingError } from "../errors.js";
import { normaliseAppPassword, verifyAppPassword } from "../mailbox/imap.js";
import { openBrowser } from "../util/browser.js";
import { promptSecret } from "../util/prompt.js";

const CONSOLE_URLS = {
  createProject: "https://console.cloud.google.com/projectcreate",
  enableGmail: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  consentScreen: "https://console.cloud.google.com/auth/overview",
  credentials: "https://console.cloud.google.com/auth/clients",
} as const;

function out(s = ""): void {
  process.stdout.write(`${s}\n`);
}

function rule(): void {
  out("─".repeat(64));
}

function step(n: number, total: number, title: string): void {
  out();
  rule();
  out(`  STEP ${n} of ${total }  ·  ${title}`);
  rule();
}

/** Open a console page, always printing the URL in case nothing launched. */
function visit(url: string): void {
  const launched = openBrowser(url);
  out(`  ${launched ? "Opening" : "Open this page"}:`);
  out(`  ${url}`);
  out();
}

/**
 * Where browsers put downloads. Checked in order; the first that exists wins.
 * Finding the credentials file automatically removes the step people most
 * often get wrong — "save it where, exactly?"
 */
function downloadDirs(): string[] {
  const home = os.homedir();
  return [
    process.env.GMAIL_MCP_DOWNLOAD_DIR,
    path.join(home, "Downloads"),
    path.join(home, "Descargas"),
    path.join(home, "Téléchargements"),
    path.join(home, "Downloads", "Downloads"),
    home,
  ].filter((d): d is string => !!d);
}

interface Candidate {
  file: string;
  mtimeMs: number;
}

/** Newest plausible OAuth client JSON sitting in a downloads folder. */
export async function findDownloadedCredentials(): Promise<Candidate[]> {
  const found: Candidate[] = [];

  for (const dir of downloadDirs()) {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }

    for (const name of entries) {
      const looksRight =
        /^client_secret.*\.json$/i.test(name) ||
        /apps\.googleusercontent\.com\.json$/i.test(name);
      if (!looksRight) continue;

      const full = path.join(dir, name);
      try {
        const stat = await fsp.stat(full);
        if (stat.isFile()) found.push({ file: full, mtimeMs: stat.mtimeMs });
      } catch {
        /* skip unreadable */
      }
    }
  }

  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function ago(mtimeMs: number): string {
  const secs = Math.max(0, Math.round((Date.now() - mtimeMs) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

/** Validate that a file really is a Desktop-app OAuth client before installing. */
export async function validateClientFile(file: string): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fsp.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    throw new UserFacingError(`${file} is not readable JSON.`);
  }

  const block = (parsed.installed ?? parsed.web ?? parsed) as Record<string, unknown>;
  if (typeof block.client_id !== "string" || typeof block.client_secret !== "string") {
    throw new UserFacingError(
      `${path.basename(file)} does not look like an OAuth client file.`,
      "It should contain client_id and client_secret. Re-download it from the " +
        "Credentials page, choosing the OAuth client you created.",
    );
  }

  if (parsed.web && !parsed.installed) {
    throw new UserFacingError(
      "That client was created as a Web application, not a Desktop app.",
      "Only Desktop app clients allow the 127.0.0.1 loopback redirect this tool " +
        "uses. Create a new client and pick 'Desktop app' as the type.",
    );
  }
}

export async function runSetup(): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new UserFacingError(
      "`setup` is interactive and needs a terminal.",
      "Run it directly in a shell, or follow the manual steps in README.md.",
    );
  }

  const cfg = loadConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => rl.question(q);
  const pause = async (q = "  Press Enter to continue… ") => {
    await rl.question(q);
  };

  try {
    out();
    rule();
    out("  gmail-multi-mcp setup");
    rule();
    out();
    out("  This connects your Gmail accounts — as many as you like — to Claude");
    out("  or any other MCP client. There are two ways to do it.");
    out();
    out("    [1] App password        ~30 seconds per mailbox, nothing else needed");
    out("    [2] Google Cloud OAuth  ~2 minutes of setup once, then 1 click each");
    out();
    out("  Option 1 is what most people want. You generate a password in your");
    out("  Google account settings and paste it in. No Cloud console at all.");
    out();
    out("  Option 2 is worth it for one reason: OAuth can grant read-only");
    out("  access, so a mailbox becomes physically incapable of sending — a");
    out("  guarantee Google enforces, not this program. An app password always");
    out("  carries full access, so with option 1 a 'readonly' account is only");
    out("  as safe as this code is correct.");
    out();
    out("  You can mix them: personal on an app password, work on OAuth.");
    out();

    const method = (await ask("  Choose 1 or 2 [1]: ")).trim() || "1";
    if (method !== "2") {
      await connectAppPasswordAccounts(rl);
      return;
    }

    out();
    out("  Google requires every person to create their own free API project");
    out("  before any tool can use OAuth for Gmail. Gmail's scopes are");
    out("  'restricted', and a shared app would need an annual paid security");
    out("  audit. The upside is real: your mail only ever touches your own");
    out("  Google project, and nobody else's.");
    out();

    // Already configured? Offer to skip straight to adding accounts.
    let alreadyConfigured = false;
    try {
      await loadOAuthClientConfig(cfg);
      alreadyConfigured = true;
    } catch {
      /* expected on first run */
    }

    if (alreadyConfigured) {
      out(`  You already have credentials at:`);
      out(`  ${cfg.oauthClientPath}`);
      out();
      const again = (await ask("  Redo the Google Cloud steps anyway? [y/N] ")).trim().toLowerCase();
      if (again !== "y" && again !== "yes") {
        await connectAccounts(rl, cfg.oauthClientPath);
        return;
      }
    } else {
      await pause("  Press Enter to begin, or Ctrl+C to quit. ");
    }

    const TOTAL = 5;

    step(1, TOTAL, "Create a Google Cloud project");
    out("  Sign in as whichever Google account you want to own the project.");
    out("  It does NOT have to be a mailbox you plan to connect.");
    out();
    visit(CONSOLE_URLS.createProject);
    out("  · Give it any name, e.g. \"gmail-mcp\"");
    out("  · Click CREATE and wait for it to finish");
    out();
    await pause("  Press Enter once the project exists… ");

    step(2, TOTAL, "Turn on the Gmail API");
    visit(CONSOLE_URLS.enableGmail);
    out("  · Check your new project is selected in the top bar");
    out("  · Click ENABLE");
    out();
    await pause("  Press Enter once it says the API is enabled… ");

    step(3, TOTAL, "Choose who is allowed to use it");
    out("  One question decides this, and getting it wrong is the single most");
    out("  common cause of the tool breaking a week later.");
    out();
    out("  Do you have Google Workspace — a paid Google account on your own");
    out("  domain — AND are all the mailboxes you want to connect on it?");
    out();
    out("    [1] Yes, all my mailboxes are on my Workspace domain");
    out("    [2] No — I want to connect personal @gmail.com accounts");
    out();
    const workspace = (await ask("  Choose 1 or 2: ")).trim();
    out();

    visit(CONSOLE_URLS.consentScreen);

    if (workspace === "1") {
      out("  · Under Audience, choose INTERNAL");
      out("  · Fill in the app name and your email, then save");
      out();
      out("  Internal is the good path: no verification, no warning screen,");
      out("  and sign-ins never expire.");
    } else {
      out("  · Under Audience, choose EXTERNAL");
      out("  · Fill in the app name and your email, then save");
      out("  · Then find the PUBLISH APP button and click it");
      out();
      out("  ⚠  Publishing matters. If you leave the app in 'Testing', Google");
      out("     expires your sign-in after 7 DAYS and the tool starts failing");
      out("     with 'invalid_grant' about a week from now.");
      out();
      out("  You will see a scary 'Google hasn't verified this app' screen when");
      out("  you sign in. That is expected — you are the publisher, so you are");
      out("  trusting yourself. Click Advanced, then 'Go to (unsafe)'.");
    }
    out();
    await pause("  Press Enter once that is saved… ");

    step(4, TOTAL, "Create the credentials");
    visit(CONSOLE_URLS.credentials);
    out("  · Click CREATE CLIENT (or + CREATE CREDENTIALS → OAuth client ID)");
    out("  · Application type: DESKTOP APP   ← this exact choice matters");
    out("  · Click CREATE");
    out("  · On the popup, click DOWNLOAD JSON");
    out();
    out("  Desktop app is required: it is the only type Google lets redirect to");
    out("  127.0.0.1, which is how the sign-in gets back to your machine.");
    out();
    await pause("  Press Enter once the file has downloaded… ");

    step(5, TOTAL, "Install the credentials");
    let chosen: string | undefined;
    const candidates = await findDownloadedCredentials();

    if (candidates.length) {
      const best = candidates[0]!;
      out(`  Found a credentials file:`);
      out(`    ${best.file}`);
      out(`    (modified ${ago(best.mtimeMs)})`);
      out();
      const useIt = (await ask("  Use this one? [Y/n] ")).trim().toLowerCase();
      if (useIt === "" || useIt === "y" || useIt === "yes") chosen = best.file;
    } else {
      out("  I could not find it automatically in your Downloads folder.");
      out();
    }

    while (!chosen) {
      const typed = (await ask("  Full path to the downloaded JSON file: ")).trim();
      const cleaned = typed.replace(/^["']|["']$/g, "");
      if (!cleaned) continue;
      try {
        await fsp.access(cleaned);
        chosen = cleaned;
      } catch {
        out(`  Cannot read ${cleaned} — check the path and try again.`);
        out();
      }
    }

    await validateClientFile(chosen);
    await fsp.mkdir(path.dirname(cfg.oauthClientPath), { recursive: true });
    await fsp.copyFile(chosen, cfg.oauthClientPath);
    await fsp.chmod(cfg.oauthClientPath, 0o600).catch(() => {});

    out();
    out(`  Installed to ${cfg.oauthClientPath}`);
    out();
    rule();
    out("  Google Cloud setup is done. You never have to do that again.");
    rule();

    await connectAccounts(rl, cfg.oauthClientPath);
  } finally {
    rl.close();
  }
}

/**
 * The no-Cloud-project path: generate an app password per mailbox and paste it.
 * Each one is verified against Gmail before being stored, so a typo or a
 * disabled IMAP setting surfaces here rather than on the first tool call.
 */
async function connectAppPasswordAccounts(rl: readline.Interface): Promise<void> {
  const cfg = loadConfig();
  const [registry, store] = await Promise.all([
    AccountRegistry.load(cfg),
    createTokenStore(cfg),
  ]);

  out();
  rule();
  out("  Connecting with app passwords");
  rule();
  out();
  out("  For each mailbox you want to connect:");
  out("    1. Sign in to that Google account");
  out("    2. Turn on 2-Step Verification if it is not already on");
  out("    3. Generate an app password and paste it here");
  out();
  out("  App passwords are unavailable if the account uses Advanced Protection,");
  out("  and a Workspace admin can switch them off for a whole domain. If the");
  out("  page says they are not available, that account needs option 2 (OAuth).");
  out();

  for (;;) {
    const existing = registry.list();
    if (existing.length) {
      out();
      out(`  Connected so far: ${existing.map((a) => a.email).join(", ")}`);
    }

    out();
    const more = (await rl.question("  Connect a mailbox now? [Y/n] ")).trim().toLowerCase();
    if (more === "n" || more === "no") break;

    const email = (await rl.question("  Gmail address: ")).trim();
    if (!email.includes("@")) {
      out("  That does not look like an email address.");
      continue;
    }

    out();
    out("  What should this account be allowed to do?");
    for (const c of TIER_CHOICES) out(`    [${c.key}] ${c.tier.padEnd(9)} ${c.blurb}`);
    out();
    out("  Remember: with an app password these are enforced by this program,");
    out("  not by Google. The credential itself always has full access.");
    out();
    const pick = (await rl.question("  Choose 1, 2 or 3 [1]: ")).trim() || "1";
    const tier = TIER_CHOICES.find((c) => c.key === pick)?.tier ?? "readonly";

    const label = (
      await rl.question("  Short name for it, e.g. work or personal (optional): ")
    ).trim();

    out();
    const openNow = (
      await rl.question("  Open the app-password page for this account? [Y/n] ")
    ).trim().toLowerCase();
    if (openNow === "" || openNow === "y" || openNow === "yes") {
      visit("https://myaccount.google.com/apppasswords");
    }

    const raw = await promptSecret("  Paste the app password (spaces are fine): ");
    const appPassword = normaliseAppPassword(raw);

    if (appPassword.length < 12) {
      out("  That is too short to be an app password — they are 16 characters.");
      continue;
    }

    try {
      out("  Checking it against Gmail…");
      const { folders } = await verifyAppPassword(email, appPassword);

      const previous = registry.find(email);
      await store.set(email, { app_password: appPassword });
      await registry.upsert({
        email,
        tier,
        auth: "app-password",
        ...(label ? { label } : previous?.label ? { label: previous.label } : {}),
        ...(previous?.allowedRecipients ? { allowedRecipients: previous.allowedRecipients } : {}),
      });

      out(`  Connected ${email} at tier "${tier}" — ${folders} folders visible.`);
    } catch (err) {
      out();
      out(`  Could not connect: ${err instanceof Error ? err.message : String(err)}`);
      out("  Check 2-Step Verification is on and IMAP is enabled in Gmail →");
      out("  Settings → Forwarding and POP/IMAP, then try again.");
    }
  }

  summarise(registry.list());
}

const TIER_CHOICES: { key: string; tier: Tier; blurb: string }[] = [
  { key: "1", tier: "readonly", blurb: "Read and search only. Cannot write — enforced by Google." },
  { key: "2", tier: "draft", blurb: "Read, plus write drafts you send yourself. Never sends." },
  { key: "3", tier: "send", blurb: "Read, draft, send, label, trash. Every send is confirmed." },
];

/** Loop connecting mailboxes until the user says they are done. */
async function connectAccounts(
  rl: readline.Interface,
  oauthClientPath: string,
): Promise<void> {
  const cfg = loadConfig();
  const clientConfig = await loadOAuthClientConfig({ ...cfg, oauthClientPath });
  const [registry, store] = await Promise.all([
    AccountRegistry.load(cfg),
    createTokenStore(cfg),
  ]);

  out();
  out("  Now connect your mailboxes. Add as many as you want — work, personal,");
  out("  a client's, whatever. Google shows its account chooser each time, so");
  out("  you can pick a different account on every run.");

  for (;;) {
    out();
    const existing = registry.list();
    if (existing.length) {
      out(`  Connected so far: ${existing.map((a) => a.email).join(", ")}`);
      out();
    }

    const more = (await rl.question("  Connect an account now? [Y/n] ")).trim().toLowerCase();
    if (more === "n" || more === "no") break;

    out();
    out("  What should this account be allowed to do?");
    for (const c of TIER_CHOICES) out(`    [${c.key}] ${c.tier.padEnd(9)} ${c.blurb}`);
    out();
    const pick = (await rl.question("  Choose 1, 2 or 3 [1]: ")).trim() || "1";
    const tier = TIER_CHOICES.find((c) => c.key === pick)?.tier ?? "readonly";

    const label = (
      await rl.question("  Short name for it, e.g. work or personal (optional): ")
    ).trim();

    out();
    out("  Your browser will open. Pick the Google account you want to connect.");
    out();

    try {
      const { email, token } = await runOAuthFlow(clientConfig, tier);
      const previous = registry.find(email);
      await store.set(email, token);
      await registry.upsert({
        email,
        tier,
        ...(label ? { label } : previous?.label ? { label: previous.label } : {}),
        ...(previous?.allowedRecipients ? { allowedRecipients: previous.allowedRecipients } : {}),
      });
      out();
      out(
        previous
          ? `  Re-authorised ${email} (now tier "${tier}").`
          : `  Connected ${email} at tier "${tier}".`,
      );
    } catch (err) {
      out();
      out(`  That did not work: ${err instanceof Error ? err.message : String(err)}`);
      out("  You can try again, or press n to stop and debug later.");
    }
  }

  summarise(registry.list());
}

/** Closing report, shared by both connection paths. */
function summarise(accounts: Account[]): void {
  out();
  rule();
  if (accounts.length) {
    out(`  Done — ${accounts.length} account(s) connected:`);
    for (const a of accounts) {
      const how = (a.auth ?? "oauth") === "app-password" ? "app password" : "OAuth";
      out(`    ${a.email}${a.label ? `  [${a.label}]` : ""}  ·  ${a.tier}  ·  ${how}`);
    }
    out();
    out("  Wire it into Claude Code with:");
    out("    claude mcp add gmail -- gmail-multi-mcp");
    out();
    out('  Then ask it to "list my gmail accounts".');
  } else {
    out("  No accounts connected yet. Add one any time with:");
    out("    gmail-multi-mcp auth add-password you@gmail.com   (simple)");
    out("    gmail-multi-mcp auth add --tier readonly          (OAuth)");
  }
  rule();
  out();
}
