import fsp from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { beginOAuthFlow, type AuthResult, type PendingOAuth } from "../auth/flow.js";
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
class PendingConnection {
  private current:
    | {
        tier: Tier;
        label: string | undefined;
        flow: PendingOAuth;
        settled: Promise<{ ok: true; email: string } | { ok: false; error: string }>;
        done: boolean;
      }
    | undefined;

  get active(): boolean {
    return !!this.current && !this.current.done;
  }

  get authUrl(): string | undefined {
    return this.current?.flow.authUrl;
  }

  start(
    tier: Tier,
    label: string | undefined,
    flow: PendingOAuth,
    onSuccess: (result: AuthResult, tier: Tier, label: string | undefined) => Promise<void>,
  ): void {
    const entry = {
      tier,
      label,
      flow,
      done: false,
      settled: flow.completed.then(
        async (result) => {
          await onSuccess(result, tier, label);
          entry.done = true;
          return { ok: true as const, email: result.email };
        },
        (err: unknown) => {
          entry.done = true;
          return {
            ok: false as const,
            error: err instanceof Error ? err.message : String(err),
          };
        },
      ),
    };
    this.current = entry;
  }

  /** Wait up to `ms` for the in-flight sign-in, or return null if still pending. */
  async settle(ms: number): Promise<{ ok: true; email: string } | { ok: false; error: string } | null> {
    if (!this.current) return null;
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), ms));
    return Promise.race([this.current.settled, timeout]);
  }

  cancel(): void {
    this.current?.flow.cancel();
    this.current = undefined;
  }
}

const pending = new PendingConnection();

function setupGuidance(oauthClientPath: string): string {
  return (
    `This server has no Google OAuth client yet, so it cannot sign anyone in.\n\n` +
    `Tell the user they need to create one — it is free, takes about two\n` +
    `minutes, and is done entirely in a browser:\n\n` +
    `  1. Create a project:      ${CONSOLE.createProject}\n` +
    `  2. Enable the Gmail API:  ${CONSOLE.enableGmail}\n` +
    `  3. Consent screen:        ${CONSOLE.consent}\n` +
    `       Choose Internal if every mailbox is on their Google Workspace domain.\n` +
    `       Otherwise choose External and click PUBLISH APP — if it is left in\n` +
    `       "Testing", Google expires the sign-in after 7 days.\n` +
    `  4. Create credentials:    ${CONSOLE.credentials}\n` +
    `       Application type MUST be "Desktop app". Then click DOWNLOAD JSON.\n\n` +
    `Then either:\n` +
    `  - call gmail_configure_oauth_client with the client_id and client_secret\n` +
    `    from that file, or\n` +
    `  - save the file to ${oauthClientPath}\n\n` +
    `Alternative with no Google project at all: the user can run\n` +
    `\`gmail-multi-mcp auth add-password <email>\` in a terminal, which uses a\n` +
    `Gmail app password instead. Do not ask them to paste an app password here —\n` +
    `it would be written into this conversation.`
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

        if (!configured) {
          return text(
            `OAuth client: NOT configured\nConnected accounts: ${accounts.length}\n\n` +
              setupGuidance(ctx.cfg.oauthClientPath),
          );
        }

        return text(
          `OAuth client: configured\n` +
            `Connected accounts: ${accounts.length}` +
            (accounts.length
              ? `\n${accounts.map((a) => `  ${a.email} (${a.tier})`).join("\n")}`
              : "") +
            `\n\nReady to connect accounts with gmail_connect_account.`,
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
        "Open a Google sign-in window so the user can connect a mailbox. Returns as " +
        "soon as the browser opens; if the user has not finished by then, call " +
        "gmail_connection_status to collect the result. Choose the LOWEST tier that " +
        "does the job — readonly accounts are enforced by Google and cannot send at all.",
      inputSchema: {
        tier: z
          .enum(TIERS)
          .default("readonly")
          .describe("readonly = read only; draft = read + drafts; send = full, confirmed"),
        label: z.string().optional().describe("Short handle, e.g. work or personal"),
        email_hint: z
          .string()
          .optional()
          .describe("Pre-select this address in Google's account chooser"),
        wait_seconds: z.number().int().min(5).max(120).default(45),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ tier, label, email_hint, wait_seconds }) =>
      guarded(ctx, "gmail_connect_account", "execute", () => email_hint ?? "-", async () => {
        if (pending.active) {
          return text(
            `A sign-in is already open in the browser.\n\n` +
              `Ask the user to finish or close it, then call gmail_connection_status. ` +
              `Only one sign-in can be in progress at a time.`,
          );
        }

        let clientConfig;
        try {
          clientConfig = await ctx.oauthClient();
        } catch {
          return text(setupGuidance(ctx.cfg.oauthClientPath));
        }

        const flow = await beginOAuthFlow(clientConfig, tier, email_hint);
        const opened = openBrowser(flow.authUrl);

        // Registration runs in the success handler rather than inline, because
        // the user may still be clicking when this tool call returns.
        pending.start(tier, label, flow, async (result, connectedTier, connectedLabel) => {
          const previous = ctx.registry.find(result.email);
          await ctx.store.set(result.email, result.token);
          await ctx.registry.upsert({
            email: result.email,
            tier: connectedTier,
            auth: "oauth",
            ...(connectedLabel
              ? { label: connectedLabel }
              : previous?.label
                ? { label: previous.label }
                : {}),
            ...(previous?.allowedRecipients
              ? { allowedRecipients: previous.allowedRecipients }
              : {}),
          });
          await ctx.mailboxes.invalidate(result.email);
          await ctx.audit.record({
            ts: new Date().toISOString(),
            tool: "gmail_connect_account",
            account: result.email,
            phase: "execute",
            outcome: "ok",
            detail: { tier: connectedTier, auth: "oauth", reconnect: !!previous },
          });
        });

        const settled = await pending.settle(wait_seconds * 1000);

        if (settled?.ok) {
          return text(
            `Connected ${settled.email} at tier "${tier}".\n\n` +
              `It is available now — call gmail_list_accounts to confirm.`,
          );
        }
        if (settled && !settled.ok) {
          return text(`The sign-in did not complete: ${settled.error}`);
        }

        return text(
          (opened
            ? `A Google sign-in window is open in the user's browser.\n\n`
            : `Could not open a browser automatically. Give the user this link:\n${flow.authUrl}\n\n`) +
            `Tell them to pick the account they want to connect and approve access.\n` +
            `They will see an "unverified app" warning if the Cloud project is not\n` +
            `verified — that is expected, since they are the publisher.\n\n` +
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
