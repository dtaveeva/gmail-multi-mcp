import os from "node:os";
import path from "node:path";
import type { ConfirmMode } from "./safety/confirm.js";

/**
 * Permission tiers, ordered least to most privileged.
 *
 * `readonly` is the only tier whose limits are enforced by Google itself: the
 * granted OAuth scope physically cannot perform a write, so even a total
 * compromise of this process cannot mutate that mailbox. The `draft` and `send`
 * tiers are enforced in this server's own code — defense in depth, not a
 * guarantee from the provider. This distinction is deliberate and documented;
 * do not paper over it.
 */
export type Tier = "readonly" | "draft" | "send";

export const TIERS = ["readonly", "draft", "send"] as const;

export const TIER_RANK: Record<Tier, number> = {
  readonly: 0,
  draft: 1,
  send: 2,
};

/**
 * Minimal scope set per tier. We request the least Google offers for the job.
 *
 * - readonly: gmail.readonly       — provider-enforced read-only
 * - draft:    + gmail.compose      — create/update drafts (also technically
 *                                    permits send; we never expose send here)
 * - send:     gmail.modify         — read, draft, send, label, trash.
 *                                    Never gmail.settings.* (forwarding rules)
 *                                    and never a scope permitting hard delete.
 */
export const SCOPES_BY_TIER: Record<Tier, readonly string[]> = {
  readonly: ["https://www.googleapis.com/auth/gmail.readonly"],
  draft: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ],
  send: ["https://www.googleapis.com/auth/gmail.modify"],
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envBool(name: string): boolean {
  const raw = process.env[name];
  return raw === "1" || raw?.toLowerCase() === "true";
}

export interface Config {
  /** Root data directory: account registry, audit log, encrypted token fallback. */
  home: string;
  /** Path to the user's own Google OAuth client JSON (BYO Cloud project). */
  oauthClientPath: string;
  accountsPath: string;
  auditPath: string;
  tokenFallbackPath: string;
  /** Global kill switch: force every account to readonly regardless of its tier. */
  forceReadonly: boolean;
  /** Mutations are validated and audited but never executed against Gmail. */
  dryRun: boolean;
  maxSendsPerHour: number;
  maxMutationsPerHour: number;
  confirmTtlMs: number;
  /**
   * `inline` returns the confirmation token to the model (fast; relies on the
   * MCP host's approval prompt as the human gate). `strict` prints it to stderr
   * only, so a human must read it off the terminal — true human-in-the-loop.
   */
  confirmMode: ConfirmMode;
  /** Max message bodies to inline in one search result before truncating. */
  maxBodyChars: number;
}

export function loadConfig(): Config {
  const home =
    process.env.GMAIL_MCP_HOME ?? path.join(os.homedir(), ".gmail-multi-mcp");

  return {
    home,
    oauthClientPath:
      process.env.GMAIL_MCP_OAUTH_CLIENT ?? path.join(home, "oauth-client.json"),
    accountsPath: path.join(home, "accounts.json"),
    auditPath: path.join(home, "audit.log"),
    tokenFallbackPath: path.join(home, "tokens.enc"),
    forceReadonly: envBool("GMAIL_MCP_READONLY"),
    dryRun: envBool("GMAIL_MCP_DRY_RUN"),
    maxSendsPerHour: envInt("GMAIL_MCP_MAX_SENDS_PER_HOUR", 10),
    maxMutationsPerHour: envInt("GMAIL_MCP_MAX_MUTATIONS_PER_HOUR", 60),
    confirmTtlMs: envInt("GMAIL_MCP_CONFIRM_TTL_MS", 5 * 60 * 1000),
    confirmMode:
      process.env.GMAIL_MCP_CONFIRM_MODE === "strict" ? "strict" : "inline",
    maxBodyChars: envInt("GMAIL_MCP_MAX_BODY_CHARS", 20_000),
  };
}
