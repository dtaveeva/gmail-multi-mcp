import type { Account, AccountRegistry } from "../auth/accounts.js";
import type { Config } from "../config.js";
import { renderError } from "../errors.js";
import { explainGoogleError, type Gmail, type GmailClientFactory } from "../gmail/client.js";
import type { AuditLog } from "../safety/audit.js";
import type { ConfirmationStore } from "../safety/confirm.js";
import type { RateLimiter } from "../safety/ratelimit.js";

export interface ToolContext {
  cfg: Config;
  registry: AccountRegistry;
  clients: GmailClientFactory;
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

/** Resolve an account reference and its authenticated Gmail client together. */
export async function resolve(
  ctx: ToolContext,
  ref: string,
): Promise<{ account: Account; gmail: Gmail }> {
  const account = ctx.registry.require(ref);
  const gmail = await ctx.clients.forAccount(account);
  return { account, gmail };
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
