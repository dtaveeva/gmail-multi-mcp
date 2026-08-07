import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export type AuditOutcome = "ok" | "denied" | "error";

export interface AuditEntry {
  ts: string;
  tool: string;
  account: string;
  phase: "preview" | "execute" | "read";
  outcome: AuditOutcome;
  detail?: Record<string, unknown>;
}

/**
 * Append-only JSONL record of everything this server did.
 *
 * Message bodies are never written — only a length and a digest, which is
 * enough to prove after the fact that a specific body was or was not the one
 * sent, without turning the log into a second copy of the user's mail.
 */
export class AuditLog {
  private warned = false;

  constructor(private readonly filePath: string) {}

  static digest(body: string): { chars: number; sha256: string } {
    return {
      chars: body.length,
      sha256: crypto.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16),
    };
  }

  async record(entry: AuditEntry): Promise<void> {
    const line = JSON.stringify(entry) + "\n";
    try {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      await fsp.appendFile(this.filePath, line, { mode: 0o600 });
    } catch (err) {
      // An unwritable audit log must be loud — a silent one is worse than none —
      // but it must not take the mailbox offline. Warn once per process.
      if (!this.warned) {
        this.warned = true;
        process.stderr.write(
          `[gmail-multi-mcp] WARNING: audit log at ${this.filePath} is not writable ` +
            `(${err instanceof Error ? err.message : String(err)}). ` +
            `Actions will proceed UNAUDITED.\n`,
        );
      }
    }
  }

  /** Best-effort synchronous write for shutdown paths. */
  recordSync(entry: AuditEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }
}
