import type { Account } from "../auth/accounts.js";
import { isAppPassword, type TokenStore } from "../auth/store.js";
import { UserFacingError } from "../errors.js";
import type { GmailClientFactory } from "../gmail/client.js";
import { GmailApiMailbox } from "./gmail-api.js";
import { ImapMailbox } from "./imap.js";
import type { Mailbox } from "./types.js";

export * from "./types.js";
export { GmailApiMailbox } from "./gmail-api.js";
export { ImapMailbox, explainImapError, explainSmtpError } from "./imap.js";

/**
 * Hands out a Mailbox for an account, picking the backend from how that account
 * was connected. Everything above this line is backend-agnostic: the tools, the
 * tiers, the confirmations, and the audit log behave identically either way.
 */
export class MailboxFactory {
  private readonly cache = new Map<string, Mailbox>();

  constructor(
    private readonly gmailClients: GmailClientFactory,
    private readonly store: TokenStore,
  ) {}

  async forAccount(account: Account): Promise<Mailbox> {
    const key = account.email.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) return cached;

    const mailbox =
      (account.auth ?? "oauth") === "app-password"
        ? await this.imapFor(account)
        : new GmailApiMailbox(await this.gmailClients.forAccount(account));

    this.cache.set(key, mailbox);
    return mailbox;
  }

  private async imapFor(account: Account): Promise<Mailbox> {
    const credential = await this.store.get(account.email);
    if (!credential) {
      throw new UserFacingError(
        `No stored app password for ${account.email}.`,
        `Reconnect it with: gmail-multi-mcp auth add-password`,
      );
    }
    if (!isAppPassword(credential)) {
      throw new UserFacingError(
        `${account.email} is registered as an app-password account but holds an OAuth token.`,
        "Reconnect it with `gmail-multi-mcp auth add-password`, or switch it back " +
          "to OAuth with `gmail-multi-mcp auth add`.",
      );
    }
    return new ImapMailbox({
      email: account.email,
      appPassword: credential.app_password,
    });
  }

  async invalidate(email: string): Promise<void> {
    const key = email.toLowerCase();
    const existing = this.cache.get(key);
    this.cache.delete(key);
    this.gmailClients.invalidate(email);
    await existing?.dispose();
  }

  /** Close every open IMAP connection. Called on server shutdown. */
  async disposeAll(): Promise<void> {
    const open = [...this.cache.values()];
    this.cache.clear();
    await Promise.all(open.map((m) => m.dispose().catch(() => {})));
  }
}
