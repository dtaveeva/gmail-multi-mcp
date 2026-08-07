import crypto from "node:crypto";
import { ConfirmationError } from "../errors.js";

export type ConfirmMode = "inline" | "strict";

/**
 * Two-phase commit for every irreversible action.
 *
 * Phase 1 renders a preview and mints a token bound to a fingerprint of the
 * exact payload. Phase 2 executes only if the token is unexpired, unused, and
 * the payload still fingerprints identically.
 *
 * What this buys you, precisely:
 *
 *   - BINDING. An injected instruction cannot preview a benign message and then
 *     execute a different one; changing a single recipient invalidates the token.
 *   - VISIBILITY. The full payload is rendered into the transcript before
 *     anything leaves the mailbox, so a human scrolling the conversation sees
 *     what was about to be sent.
 *
 * What it does NOT buy you in `inline` mode: authorization. The model receives
 * the token and can immediately redeem it. Inline mode relies on the MCP host's
 * own tool-approval prompt as the human gate.
 *
 * `strict` mode closes that gap: the token goes to stderr — the server's own
 * log, which the model cannot read — so redeeming it requires a human to read
 * it off the terminal and hand it over. Slower, and genuinely human-in-the-loop.
 */
export interface PendingAction {
  fingerprint: string;
  expiresAt: number;
  action: string;
  account: string;
}

export interface Issued {
  token: string;
  expiresAt: number;
  /** True when the token was withheld from the model and printed to stderr. */
  outOfBand: boolean;
}

/** Stable key ordering so semantically identical payloads fingerprint alike. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

export function fingerprint(action: string, account: string, params: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([action, account.toLowerCase(), canonical(params)]))
    .digest("hex");
}

export class ConfirmationStore {
  private readonly pending = new Map<string, PendingAction>();

  constructor(
    private readonly ttlMs: number,
    private readonly mode: ConfirmMode = "inline",
  ) {}

  issue(action: string, account: string, params: unknown): Issued {
    this.sweep();
    const token = crypto.randomBytes(9).toString("base64url");
    const expiresAt = Date.now() + this.ttlMs;
    this.pending.set(token, {
      fingerprint: fingerprint(action, account, params),
      expiresAt,
      action,
      account,
    });

    if (this.mode === "strict") {
      process.stderr.write(
        `\n[gmail-multi-mcp] CONFIRMATION REQUIRED\n` +
          `  action:  ${action}\n` +
          `  account: ${account}\n` +
          `  token:   ${token}\n` +
          `  expires: ${new Date(expiresAt).toISOString()}\n` +
          `  Give this token to the assistant only if you approve the action.\n\n`,
      );
      return { token: "", expiresAt, outOfBand: true };
    }

    return { token, expiresAt, outOfBand: false };
  }

  /** Consumes the token. Throws with an actionable reason on any mismatch. */
  redeem(token: string, action: string, account: string, params: unknown): void {
    this.sweep();
    const entry = this.pending.get(token);

    if (!entry) {
      throw new ConfirmationError(
        "That confirmation token is unknown, already used, or expired.",
        `Call ${action} again without a confirmation token to get a fresh preview.`,
      );
    }

    // Single use, regardless of whether the checks below pass.
    this.pending.delete(token);

    if (entry.action !== action) {
      throw new ConfirmationError(
        `Token was issued for "${entry.action}", not "${action}".`,
      );
    }
    if (entry.account.toLowerCase() !== account.toLowerCase()) {
      throw new ConfirmationError(
        `Token was issued for ${entry.account}, not ${account}.`,
      );
    }
    if (entry.fingerprint !== fingerprint(action, account, params)) {
      throw new ConfirmationError(
        "The action changed after it was previewed, so the token no longer applies.",
        "This is the expected outcome when a payload is modified between preview " +
          "and confirmation. Re-preview the exact action you intend to take.",
      );
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(token);
    }
  }
}
