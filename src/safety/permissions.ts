import type { Account } from "../auth/accounts.js";
import { type Config, type Tier, TIER_RANK } from "../config.js";
import { PermissionError } from "../errors.js";

/** What a tool needs in order to run. */
export type Capability = "read" | "draft" | "send" | "modify";

const REQUIRED_TIER: Record<Capability, Tier> = {
  read: "readonly",
  draft: "draft",
  send: "send",
  /** Labels and trash are writes to the mailbox; they sit at the send tier. */
  modify: "send",
};

const CAPABILITY_LABEL: Record<Capability, string> = {
  read: "read messages",
  draft: "create or edit drafts",
  send: "send mail",
  modify: "modify labels or trash messages",
};

export function effectiveTier(account: Account, cfg: Config): Tier {
  return cfg.forceReadonly ? "readonly" : account.tier;
}

export function assertCapability(
  account: Account,
  capability: Capability,
  cfg: Config,
): void {
  const tier = effectiveTier(account, cfg);
  if (TIER_RANK[tier] >= TIER_RANK[REQUIRED_TIER[capability]]) return;

  const because = cfg.forceReadonly
    ? "GMAIL_MCP_READONLY is set, which forces every account to readonly."
    : `${account.email} is connected at the "${account.tier}" tier.`;

  throw new PermissionError(
    `Not permitted to ${CAPABILITY_LABEL[capability]} on ${account.email}.`,
    `${because} Raise it with: gmail-multi-mcp auth tier ${account.email} ${REQUIRED_TIER[capability]}`,
  );
}

/** Extract bare addresses from a header value like `Name <a@b.com>, c@d.com`. */
export function parseAddresses(header: string): string[] {
  return [...header.matchAll(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g)].map((m) =>
    m[0].toLowerCase(),
  );
}

/**
 * Enforce a per-account recipient allowlist when one is configured.
 *
 * Entries are either a full address (`someone@client.com`) or a domain suffix
 * (`@client.com`). This is the control that stops a compromised or
 * injection-steered session from mailing an arbitrary third party out of a
 * client mailbox.
 */
export function assertRecipientsAllowed(account: Account, recipients: string[]): void {
  const allow = account.allowedRecipients;
  if (!allow?.length) return;

  const normalized = allow.map((a) => a.trim().toLowerCase()).filter(Boolean);
  const blocked = recipients
    .map((r) => r.toLowerCase())
    .filter(
      (addr) =>
        !normalized.some((rule) =>
          rule.startsWith("@") ? addr.endsWith(rule) : addr === rule,
        ),
    );

  if (blocked.length) {
    throw new PermissionError(
      `${account.email} may not send to: ${blocked.join(", ")}`,
      `This account has a recipient allowlist (${normalized.join(", ")}). ` +
        `Change it with: gmail-multi-mcp auth allow ${account.email} <entry...>`,
    );
  }
}
