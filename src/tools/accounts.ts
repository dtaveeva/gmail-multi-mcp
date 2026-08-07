import fsp from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { beginAppPasswordFlow } from "../auth/app-password-flow.js";
import { beginCloudSetupFlow } from "../auth/cloud-setup-flow.js";
import { beginOAuthFlow } from "../auth/flow.js";
import { TIERS, type Tier } from "../config.js";
import { UserFacingError } from "../errors.js";
import { openBrowser } from "../util/browser.js";
import { guarded, text, type ToolContext, type ToolResult } from "./context.js";

const CONSOLE = {
  createProject: "https://console.cloud.google.com/projectcreate",
  enableGmail: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  consent: "https://console.cloud.google.com/auth/overview",
  credentials: "https://console.cloud.google.com/auth/clients",
};

/**
 * Tracks the one sign-in that may be in flight.
 *
 * A browser sign-in takes a human up to a minute, which is longer than many MCP
 * clients will wait on a single tool call. So the connect tool starts the flow,
 * waits briefly, and hands back control; a follow-up call collects the result.
 * Only one at a time — concurrent sign-ins would race on the same browser and
 * make it impossible to tell which account the user actually picked.
 */
type Settled = { ok: true; email: string } | { ok: false; error: string };

class PendingConnection {
  private current:
    | { url: string; settled: Promise<Settled>; cancel: () => void; done: boolean }
    | undefined;

  get active(): boolean {
    return !!this.current && !this.current.done;
  }

  get url(): string | undefined {
    return this.current?.url;
  }

  /**
   * Track an in-flight connection. `work` must resolve to the connected address
   * *after* the account has been registered, so a caller that sees `ok` can
   * rely on the account already being usable.
   */
  track(url: string, work: Promise<string>, cancel: () => void): void {
    const entry = {
      url,
      cancel,
      done: false,
      settled: null as unknown as Promise<Settled>,
    };
    entry.settled = work.then(
      (email) => {
        entry.done = true;
        return { ok: true as const, email };
      },
      (err: unknown) => {
        entry.done = true;
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      },
    );
    this.current = entry;
  }

  /** Wait up to `ms` for the in-flight connection, or null if still pending. */
  async settle(ms: number): Promise<Settled | null> {
    if (!this.current) return null;
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), ms));
    return Promise.race([this.current.settled, timeout]);
  }

  cancel(): void {
    this.current?.cancel();
    this.current = undefined;
  }
}

const pending = new PendingConnection();

/** Persist a user's own OAuth client and make it live immediately. */
async function writeOAuthClient(
  ctx: ToolContext,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  await fsp.mkdir(path.dirname(ctx.cfg.oauthClientPath), { recursive: true });
  await fsp.writeFile(
    ctx.cfg.oauthClientPath,
    JSON.stringify({ installed: { client_id: clientId, client_secret: clientSecret } }, null, 2),
    { mode: 0o600 },
  );
  ctx.resetOAuthClient();
}

function setupGuidance(oauthClientPath: string): string {
  return (
    `Google sign-in is not available: this server has no Google OAuth client.\n\n` +
    `You do NOT need one to connect a mailbox. Call gmail_connect_account with\n` +
    `the default method instead — it opens a local page where the user enters a\n` +
    `Gmail app password, needs no Google Cloud project, and works right now.\n\n` +
    `Only set up OAuth if the user specifically wants a mailbox that is provably\n` +
    `incapable of sending. OAuth can grant read-only access that Google itself\n` +
    `enforces; an app password always carries full access, so a readonly tier on\n` +
    `one is enforced by this server rather than by Google.\n\n` +
    `If they do want that, it is free, takes about two minutes, and is entirely\n` +
    `in a browser:\n\n` +
    `  1. Create a project:      ${CONSOLE.createProject}\n` +
    `  2. Enable the Gmail API:  ${CONSOLE.enableGmail}\n` +
    `  3. Consent screen:        ${CONSOLE.consent}\n` +
    `       Choose Internal if every mailbox is on their Workspace domain.\n` +
    `       Otherwise choose External and click PUBLISH APP — left in "Testing",\n` +
    `       Google expires the sign-in after 7 days.\n` +
    `  4. Create credentials:    ${CONSOLE.credentials}\n` +
    `       Application type MUST be "Desktop app". Then click DOWNLOAD JSON.\n\n` +
    `Then call gmail_configure_oauth_client with the client_id and client_secret\n` +
    `from that file, or save the file to ${oauthClientPath}`
  );
}

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "gmail_setup_status",
    {
      title: "Check Gmail setup",
      description:
        "Report whether this server can connect accounts yet, and what is missing. " +
        "Call this when the user asks to add a Gmail account and you are unsure " +
        "whether setup is complete.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guarded(ctx, "gmail_setup_status", "read", () => "-", async () => {
        const accounts = ctx.registry.list();
        let configured = true;
        try {
          await ctx.oauthClient();
        } catch {
          configured = false;
        }

        const listing = accounts.length
          ? `\n${accounts.map((a) => `  ${a.email} (${a.tier}, ${a.auth ?? "oauth"})`).join("\n")}`
          : "";

        return text(
          `READY — accounts can be connected right now.\n\n` +
            `Connected accounts: ${accounts.length}${listing}\n\n` +
            `Available methods:\n` +
            `  app_password    ready, no setup needed. Opens a local page where the\n` +
            `                  user enters a Gmail app password.\n` +
            `  google_signin   ${
              configured
                ? "ready. Opens Google's sign-in."
                : "needs a one-time setup of the user's own free Google project.\n" +
                  "                  Calling gmail_connect_account with this method opens a\n" +
                  "                  guided page that walks them through it in about two\n" +
                  "                  minutes, then signs them in automatically. Worth it for\n" +
                  "                  a mailbox that must be provably unable to send."
            }\n\n` +
            `Just call gmail_connect_account. Do not ask the user to type an app\n` +
            `password here — the browser page collects it locally so it never\n` +
            `enters this conversation.`,
        );
      }),
  );

  server.registerTool(
    "gmail_configure_oauth_client",
    {
      title: "Save a Google OAuth client",
      description:
        "Store the client_id and client_secret from a Google Cloud 'Desktop app' " +
        "OAuth client, so accounts can be connected. Only ask the user for these " +
        "after gmail_setup_status says the client is missing.",
      inputSchema: {
        client_id: z.string().describe("Ends with .apps.googleusercontent.com"),
        client_secret: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ client_id, client_secret }) =>
      guarded(ctx, "gmail_configure_oauth_client", "execute", () => "-", async () => {
        if (!client_id.trim().endsWith(".apps.googleusercontent.com")) {
          throw new UserFacingError(
            "That does not look like a Google OAuth client id.",
            "It should end with .apps.googleusercontent.com and come from the " +
              "Credentials page of your Google Cloud project.",
          );
        }

        await fsp.mkdir(path.dirname(ctx.cfg.oauthClientPath), { recursive: true });
        await fsp.writeFile(
          ctx.cfg.oauthClientPath,
          JSON.stringify(
            { installed: { client_id: client_id.trim(), client_secret: client_secret.trim() } },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        ctx.resetOAuthClient();

        await ctx.audit.record({
          ts: new Date().toISOString(),
          tool: "gmail_configure_oauth_client",
          account: "-",
          phase: "execute",
          outcome: "ok",
          detail: { clientId: client_id.trim() },
        });

        return text(
          `Saved. This server can now sign accounts in.\n\n` +
            `Next: call gmail_connect_account to open a Google sign-in window.`,
        );
      }),
  );

  server.registerTool(
    "gmail_connect_account",
    {
      title: "Connect a Gmail account",
      description:
        "Connect a Gmail mailbox by opening a page in the user's browser. Returns as " +
        "soon as the browser opens; if the user has not finished by then, call " +
        "gmail_connection_status. Default method needs no Google Cloud project. " +
        "Choose the LOWEST tier that does the job. Never ask the user to type an app " +
        "password into this conversation — the browser page collects it locally.",
      inputSchema: {
        method: z
          .enum(["app_password", "google_signin"])
          .default("app_password")
          .describe(
            "app_password needs no Google Cloud project and works immediately. " +
              "google_signin requires the user to have set one up, but can grant " +
              "read-only access that Google itself enforces.",
          ),
        tier: z
          .enum(TIERS)
          .default("readonly")
          .describe("readonly = read only; draft = read + drafts; send = full, confirmed"),
        label: z.string().optional().describe("Short handle, e.g. work or personal"),
        email_hint: z
          .string()
          .optional()
          .describe("Pre-select this address in Google's account chooser (google_signin only)"),
        wait_seconds: z.number().int().min(5).max(120).default(45),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ method, tier, label, email_hint, wait_seconds }) =>
      guarded(ctx, "gmail_connect_account", "execute", () => email_hint ?? "-", async () => {
        if (pending.active) {
          return text(
            `A connection is already open in the browser at ${pending.url}\n\n` +
              `Ask the user to finish or close it, then call gmail_connection_status. ` +
              `Only one can be in progress at a time.`,
          );
        }

        /** Register a connected account and report its address. */
        const register = async (
          email: string,
          credential: Parameters<typeof ctx.store.set>[1],
          auth: "oauth" | "app-password",
        ): Promise<string> => {
          const previous = ctx.registry.find(email);
          await ctx.store.set(email, credential);
          await ctx.registry.upsert({
            email,
            tier,
            auth,
            ...(label ? { label } : previous?.label ? { label: previous.label } : {}),
            ...(previous?.allowedRecipients
              ? { allowedRecipients: previous.allowedRecipients }
              : {}),
          });
          await ctx.mailboxes.invalidate(email);
          await ctx.audit.record({
            ts: new Date().toISOString(),
            tool: "gmail_connect_account",
            account: email,
            phase: "execute",
            outcome: "ok",
            detail: { tier, auth, reconnect: !!previous },
          });
          return email;
        };

        let url: string;
        let guidance: string;

        if (method === "google_signin") {
          let clientConfig;
          try {
            clientConfig = await ctx.oauthClient();
          } catch {
            clientConfig = undefined;
          }

          if (!clientConfig) {
            // First time: walk them through creating their own Cloud project in
            // the browser, then chain straight into the sign-in so they do not
            // have to come back and ask again.
            const setup = await beginCloudSetupFlow();
            url = setup.setupUrl;
            pending.track(
              url,
              setup.completed.then(async (creds) => {
                await writeOAuthClient(ctx, creds.clientId, creds.clientSecret);
                const flow = await beginOAuthFlow(await ctx.oauthClient(), tier, email_hint);
                openBrowser(flow.authUrl);
                const result = await flow.completed;
                return register(result.email, result.token, "oauth");
              }),
              setup.cancel,
            );
            guidance =
              `This is the one-time setup for their own free Google project, laid\n` +
              `out step by step on the page. It takes about two minutes. When they\n` +
              `finish it, the Google sign-in opens by itself and they just pick the\n` +
              `account — no need to call this tool again.\n\n` +
              `The page tells them to click PUBLISH APP on the consent screen. If\n` +
              `they skip that, Google expires the sign-in after 7 days.`;
          } else {
            const flow = await beginOAuthFlow(clientConfig, tier, email_hint);
            url = flow.authUrl;
            pending.track(
              url,
              flow.completed.then((r) => register(r.email, r.token, "oauth")),
              flow.cancel,
            );
            guidance =
              `Tell them to pick the account they want and approve access. They will\n` +
              `see an "unverified app" warning if their Cloud project is unverified —\n` +
              `that is expected, since they are the publisher.`;
          }
        } else {
          const flow = await beginAppPasswordFlow();
          url = flow.formUrl;
          pending.track(
            url,
            flow.completed.then((r) =>
              register(r.email, { app_password: r.appPassword }, "app-password"),
            ),
            flow.cancel,
          );
          guidance =
            `The page runs on their own machine and explains how to generate a\n` +
            `Gmail app password. They paste it into that page — NOT into this\n` +
            `conversation. It goes straight to the local program and then to Gmail,\n` +
            `so it never appears here. The page checks it against Gmail before\n` +
            `accepting it.`;
        }

        const opened = openBrowser(url);
        const settled = await pending.settle(wait_seconds * 1000);

        if (settled?.ok) {
          return text(
            `Connected ${settled.email} at tier "${tier}".\n\n` +
              `It is available now — call gmail_list_accounts to confirm.`,
          );
        }
        if (settled && !settled.ok) {
          return text(`That did not complete: ${settled.error}`);
        }

        return text(
          (opened
            ? `A page is now open in the user's browser.\n\n`
            : `Could not open a browser automatically. Give the user this link:\n${url}\n\n`) +
            `${guidance}\n\n` +
            `When they say they are done, call gmail_connection_status.`,
        );
      }),
  );

  server.registerTool(
    "gmail_connection_status",
    {
      title: "Check a pending Gmail sign-in",
      description:
        "Collect the result of a sign-in started by gmail_connect_account. Call this " +
        "after the user says they finished in the browser.",
      inputSchema: {
        wait_seconds: z.number().int().min(1).max(120).default(30),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ wait_seconds }) =>
      guarded(ctx, "gmail_connection_status", "read", () => "-", async () => {
        const settled = await pending.settle(wait_seconds * 1000);

        if (settled === null && !pending.active) {
          return text(
            "No sign-in is in progress. Start one with gmail_connect_account.",
          );
        }
        if (settled === null) {
          return text(
            "Still waiting for the user to finish in the browser.\n\n" +
              "Ask them whether the Google window is still open, and whether they " +
              "reached a page saying the account was connected.",
          );
        }
        if (settled.ok) {
          return text(
            `Connected ${settled.email}.\n\nCall gmail_list_accounts to confirm.`,
          );
        }
        return text(
          `The sign-in failed: ${settled.error}\n\n` +
            `You can start again with gmail_connect_account.`,
        );
      }),
  );

  server.registerTool(
    "gmail_disconnect_account",
    {
      title: "Disconnect a Gmail account (two-phase)",
      description:
        "Remove an account and erase its stored credentials. Call without " +
        "confirm_token to preview, then again with the token to apply.",
      inputSchema: {
        account: z.string(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ account, confirm_token }) =>
      guarded(
        ctx,
        "gmail_disconnect_account",
        confirm_token ? "execute" : "preview",
        () => account,
        async () => {
          const acct = ctx.registry.require(account);
          const payload = { email: acct.email };

          if (!confirm_token) {
            const issued = ctx.confirmations.issue(
              "gmail_disconnect_account",
              acct.email,
              payload,
            );
            return text(
              `PREVIEW — confirmation required\n${"=".repeat(60)}\n` +
                `Disconnect ${acct.email} (tier ${acct.tier}, ${acct.auth ?? "oauth"})\n` +
                `Its stored credentials will be erased from this machine.\n` +
                `No mail is deleted, and access can be re-granted by connecting again.\n` +
                `${"=".repeat(60)}\n\n` +
                (issued.outOfBand
                  ? `A confirmation token was printed to the server terminal. Ask the user for it.`
                  : `To proceed, call again with confirm_token: "${issued.token}"`),
            );
          }

          ctx.confirmations.redeem(
            confirm_token,
            "gmail_disconnect_account",
            acct.email,
            payload,
          );

          await ctx.store.delete(acct.email);
          await ctx.registry.remove(acct.email);
          await ctx.mailboxes.invalidate(acct.email);

          await ctx.audit.record({
            ts: new Date().toISOString(),
            tool: "gmail_disconnect_account",
            account: acct.email,
            phase: "execute",
            outcome: "ok",
          });

          return text(
            `Disconnected ${acct.email} and erased its credentials.\n\n` +
              `To revoke this app's access at Google's end too, the user should visit\n` +
              `https://myaccount.google.com/permissions`,
          );
        },
      ),
  );
}

export function __resetPendingForTests(): void {
  pending.cancel();
}
