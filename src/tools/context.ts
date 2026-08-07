import type { Account, AccountRegistry } from "../auth/accounts.js";
import type { Config } from "../config.js";
import { renderError } from "../errors.js";
import { explainGoogleError } from "../gmail/client.js";
import type { Mailbox, MailboxFactory } from "../mailbox/index.js";
import type { AuditLog } from "../safety/audit.js";
import type { ConfirmationStore } from "../safety/confirm.js";
import type { RateLimiter } from "../safety/ratelimit.js";

export interface ToolContext {
  cfg: Config;
  registry: AccountRegistry;
  mailboxes: MailboxFactory;
  confirmations: ConfirmationStore;
  limiter: RateLimiter;
  audit: AuditLog;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

export function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

export function failure(body: string): ToolResult {
  return { content: [{ type: "text", text: body }], isError: true };
}

/** Resolve an account reference and a mailbox for it, whatever its backend. */
export async function resolve(
  ctx: ToolContext,
  ref: string,
): Promise<{ account: Account; mailbox: Mailbox }> {
  const account = ctx.registry.require(ref);
  const mailbox = await ctx.mailboxes.forAccount(account);
  return { account, mailbox };
}

/**
 * Wraps a tool body so that every failure path is (a) rendered as safe text
 * rather than an unhandled rejection, (b) audited, and (c) stripped of raw
 * Google payloads that may echo message content.
 */
export function guarded(
  ctx: ToolContext,
  tool: string,
  phase: "read" | "preview" | "execute",
  accountRef: () => string,
  body: () => Promise<ToolResult>,
): Promise<ToolResult> {
  return body().catch(async (err: unknown) => {
    const account = (() => {
      try {
        return accountRef();
      } catch {
        return "unknown";
      }
    })();

    const explained =
      err instanceof Error && /invalid_grant|insufficient|quota|429|403/i.test(err.message)
        ? explainGoogleError(err, account)
        : err;

    await ctx.audit.record({
      ts: new Date().toISOString(),
      tool,
      account,
      phase,
      outcome: explained instanceof Error && explained.name === "PermissionError" ? "denied" : "error",
      detail: { message: explained instanceof Error ? explained.message : String(explained) },
    });

    return failure(renderError(explained));
  });
}
