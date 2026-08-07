import { gmail, type gmail_v1 } from "@googleapis/gmail";
import { OAuth2Client } from "google-auth-library";
import type { Account } from "../auth/accounts.js";
import { createOAuth2Client, type OAuthClientConfig } from "../auth/client.js";
import type { TokenStore } from "../auth/store.js";
import { UserFacingError } from "../errors.js";

export type Gmail = gmail_v1.Gmail;

/**
 * Builds and caches one authenticated Gmail client per account.
 *
 * Access tokens are refreshed by google-auth-library automatically; we listen
 * for the resulting `tokens` event so a rotated refresh token is written back
 * to the store rather than silently lost on the next process start.
 */
export class GmailClientFactory {
  private readonly cache = new Map<string, Gmail>();

  /**
   * The OAuth client is resolved lazily so the server still starts when it is
   * missing. A server that refuses to boot shows up in MCP clients as an opaque
   * "failed to start"; booting and explaining on first use is far more
   * debuggable for someone who has not finished the Google Cloud setup yet.
   */
  constructor(
    private readonly clientConfigProvider: () => Promise<OAuthClientConfig>,
    private readonly store: TokenStore,
  ) {}

  async forAccount(account: Account): Promise<Gmail> {
    const cached = this.cache.get(account.email);
    if (cached) return cached;

    const clientConfig = await this.clientConfigProvider();
    const stored = await this.store.get(account.email);
    if (!stored?.refresh_token) {
      throw new UserFacingError(
        `No stored credentials for ${account.email}.`,
        `Reconnect it with: gmail-multi-mcp auth add --tier ${account.tier}`,
      );
    }

    const auth: OAuth2Client = createOAuth2Client(clientConfig);
    auth.setCredentials({
      refresh_token: stored.refresh_token,
      ...(stored.access_token ? { access_token: stored.access_token } : {}),
      ...(stored.expiry_date ? { expiry_date: stored.expiry_date } : {}),
    });

    auth.on("tokens", (tokens) => {
      void this.store.set(account.email, {
        refresh_token: tokens.refresh_token ?? stored.refresh_token,
        ...(tokens.access_token ? { access_token: tokens.access_token } : {}),
        ...(tokens.expiry_date ? { expiry_date: tokens.expiry_date } : {}),
        ...(stored.scope ? { scope: stored.scope } : {}),
      });
    });

    const client = gmail({ version: "v1", auth });
    this.cache.set(account.email, client);
    return client;
  }

  /** Drop a cached client, e.g. after the account's tier changes. */
  invalidate(email: string): void {
    this.cache.delete(email);
  }
}

/**
 * Translates Google API failures into messages that tell the user what to do.
 * A bare `invalid_grant` is the single most common failure in this server and
 * is almost always the 7-day refresh-token expiry on Testing-mode OAuth apps.
 */
export function explainGoogleError(err: unknown, email: string): UserFacingError {
  const message = err instanceof Error ? err.message : String(err);

  if (/invalid_grant/i.test(message)) {
    return new UserFacingError(
      `Credentials for ${email} are no longer valid.`,
      "This usually means your Google Cloud OAuth consent screen is still in " +
        "'Testing' status, where refresh tokens expire after 7 days. Publish the " +
        "app (or set it to Internal for Workspace) and reconnect with " +
        "`gmail-multi-mcp auth add`. See README > Token expiry.",
    );
  }
  if (/insufficient|ACCESS_TOKEN_SCOPE|forbidden|403/i.test(message)) {
    return new UserFacingError(
      `${email} has not granted the scope this action needs.`,
      "Re-run `gmail-multi-mcp auth add` for this account at a higher tier.",
    );
  }
  if (/rate|quota|429/i.test(message)) {
    return new UserFacingError(
      `Gmail rate limit hit for ${email}. Wait a moment and retry.`,
    );
  }
  return new UserFacingError(`Gmail API error for ${email}: ${message}`);
}
