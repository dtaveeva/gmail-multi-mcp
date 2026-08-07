import fs from "node:fs/promises";
import path from "node:path";
import { type Config, type Tier, SCOPES_BY_TIER } from "../config.js";
import { UserFacingError } from "../errors.js";

export interface Account {
  email: string;
  tier: Tier;
  /** Short handle the model can use instead of the full address, e.g. "work". */
  label?: string;
  /**
   * Optional send guard. Entries are either full addresses ("a@b.com") or
   * domain suffixes ("@client.com"). When present, a send whose recipients
   * fall outside the list is refused before it reaches Gmail.
   */
  allowedRecipients?: string[];
  scopes: string[];
  addedAt: string;
}

interface Registry {
  version: 1;
  accounts: Account[];
}

export class AccountRegistry {
  private constructor(
    private readonly filePath: string,
    private registry: Registry,
  ) {}

  static async load(cfg: Config): Promise<AccountRegistry> {
    let registry: Registry = { version: 1, accounts: [] };
    try {
      const raw = await fs.readFile(cfg.accountsPath, "utf8");
      const parsed = JSON.parse(raw) as Registry;
      if (Array.isArray(parsed.accounts)) registry = parsed;
    } catch {
      /* first run */
    }
    return new AccountRegistry(cfg.accountsPath, registry);
  }

  list(): Account[] {
    return [...this.registry.accounts];
  }

  /** Resolve by exact email or by label. Case-insensitive. */
  find(ref: string): Account | undefined {
    const needle = ref.trim().toLowerCase();
    return this.registry.accounts.find(
      (a) => a.email.toLowerCase() === needle || a.label?.toLowerCase() === needle,
    );
  }

  /** Resolve or throw a message that tells the model exactly what is available. */
  require(ref: string): Account {
    const found = this.find(ref);
    if (found) return found;
    const available = this.registry.accounts.length
      ? this.registry.accounts
          .map((a) => (a.label ? `${a.email} (${a.label})` : a.email))
          .join(", ")
      : "none — run `gmail-multi-mcp auth add` first";
    throw new UserFacingError(
      `No connected account matches "${ref}".`,
      `Available accounts: ${available}`,
    );
  }

  async upsert(account: Omit<Account, "addedAt" | "scopes"> & { addedAt?: string }): Promise<Account> {
    const existing = this.find(account.email);
    const record: Account = {
      ...existing,
      ...account,
      scopes: [...SCOPES_BY_TIER[account.tier]],
      addedAt: existing?.addedAt ?? account.addedAt ?? new Date().toISOString(),
    };
    this.registry.accounts = [
      ...this.registry.accounts.filter(
        (a) => a.email.toLowerCase() !== record.email.toLowerCase(),
      ),
      record,
    ];
    await this.save();
    return record;
  }

  async remove(email: string): Promise<boolean> {
    const before = this.registry.accounts.length;
    this.registry.accounts = this.registry.accounts.filter(
      (a) => a.email.toLowerCase() !== email.toLowerCase(),
    );
    if (this.registry.accounts.length === before) return false;
    await this.save();
    return true;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(
      this.filePath,
      JSON.stringify(this.registry, null, 2),
      { mode: 0o600 },
    );
  }
}
