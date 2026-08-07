import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";

const SERVICE = "gmail-multi-mcp";

export interface StoredToken {
  refresh_token: string;
  access_token?: string;
  expiry_date?: number;
  scope?: string;
}

export interface TokenStore {
  /** Human-readable name of the backend actually in use, for `doctor` output. */
  readonly backend: string;
  get(email: string): Promise<StoredToken | null>;
  set(email: string, token: StoredToken): Promise<void>;
  delete(email: string): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Backend 1 (preferred): OS keychain.
 * Windows Credential Manager / macOS Keychain / libsecret on Linux.
 * ------------------------------------------------------------------ */

interface KeyringEntry {
  getPassword(): string;
  setPassword(pw: string): void;
  deletePassword(): boolean;
}

type KeyringCtor = new (service: string, account: string) => KeyringEntry;

async function loadKeyring(): Promise<KeyringCtor | null> {
  try {
    const mod = (await import("@napi-rs/keyring")) as unknown as {
      Entry?: KeyringCtor;
    };
    if (!mod.Entry) return null;
    // Prove the native backend actually works before committing to it. On
    // headless Linux the module imports fine but has no secret service.
    const probe = new mod.Entry(SERVICE, "__probe__");
    try {
      probe.getPassword();
    } catch (err) {
      // "not found" is a healthy backend; anything else means it is unusable.
      if (!/not found|no matching|no such/i.test(String(err))) return null;
    }
    return mod.Entry;
  } catch {
    return null;
  }
}

class KeychainStore implements TokenStore {
  readonly backend = "os-keychain";

  constructor(private readonly Entry: KeyringCtor) {}

  async get(email: string): Promise<StoredToken | null> {
    try {
      const raw = new this.Entry(SERVICE, email).getPassword();
      return raw ? (JSON.parse(raw) as StoredToken) : null;
    } catch {
      return null;
    }
  }

  async set(email: string, token: StoredToken): Promise<void> {
    new this.Entry(SERVICE, email).setPassword(JSON.stringify(token));
  }

  async delete(email: string): Promise<void> {
    try {
      new this.Entry(SERVICE, email).deletePassword();
    } catch {
      /* already absent */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Backend 2 (fallback): AES-256-GCM encrypted file.
 *
 * Key material comes from GMAIL_MCP_PASSPHRASE when set. Otherwise we
 * generate a machine-local random key. That protects tokens at rest against
 * casual disk reads and backups, but NOT against a process running as the
 * same user — which is exactly what an attacker who can read the key file
 * already is. Documented as such in SECURITY.md.
 * ------------------------------------------------------------------ */

interface Envelope {
  v: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

class EncryptedFileStore implements TokenStore {
  readonly backend: string;

  constructor(
    private readonly filePath: string,
    private readonly keyPath: string,
    private readonly passphrase: string | undefined,
  ) {
    this.backend = passphrase
      ? "encrypted-file (passphrase)"
      : "encrypted-file (machine key)";
  }

  private async secret(): Promise<string> {
    if (this.passphrase) return this.passphrase;
    try {
      return await fs.readFile(this.keyPath, "utf8");
    } catch {
      const generated = crypto.randomBytes(32).toString("hex");
      await fs.mkdir(path.dirname(this.keyPath), { recursive: true });
      await fs.writeFile(this.keyPath, generated, { mode: 0o600 });
      return generated;
    }
  }

  private async readAll(): Promise<Record<string, StoredToken>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch {
      return {};
    }
    const env = JSON.parse(raw) as Envelope;
    const key = crypto.scryptSync(
      await this.secret(),
      Buffer.from(env.salt, "base64"),
      32,
    );
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(env.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(env.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(env.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plain) as Record<string, StoredToken>;
  }

  private async writeAll(all: Record<string, StoredToken>): Promise<void> {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(await this.secret(), salt, 32);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(all), "utf8"),
      cipher.final(),
    ]);
    const env: Envelope = {
      v: 1,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(env), { mode: 0o600 });
  }

  async get(email: string): Promise<StoredToken | null> {
    return (await this.readAll())[email] ?? null;
  }

  async set(email: string, token: StoredToken): Promise<void> {
    const all = await this.readAll();
    all[email] = token;
    await this.writeAll(all);
  }

  async delete(email: string): Promise<void> {
    const all = await this.readAll();
    delete all[email];
    await this.writeAll(all);
  }
}

export async function createTokenStore(cfg: Config): Promise<TokenStore> {
  if (!process.env.GMAIL_MCP_FORCE_FILE_STORE) {
    const Entry = await loadKeyring();
    if (Entry) return new KeychainStore(Entry);
  }
  return new EncryptedFileStore(
    cfg.tokenFallbackPath,
    path.join(cfg.home, "store.key"),
    process.env.GMAIL_MCP_PASSPHRASE,
  );
}
