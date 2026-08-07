import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Connected accounts must survive a server restart.
 *
 * Each conversation with an assistant spawns a fresh server process, so if the
 * account registry lived in memory the user would have to re-authorise every
 * mailbox in every new session. The registry is on disk and the tokens are in
 * the OS keychain precisely so that "which mailboxes exist" is independent of
 * any conversation's lifetime.
 */

const HOME_KEY = "GMAIL_MCP_HOME";

const REGISTRY = {
  version: 1,
  accounts: [
    {
      email: "personal@example.com",
      tier: "readonly",
      label: "personal",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      addedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      email: "work@example.com",
      tier: "send",
      label: "work",
      allowedRecipients: ["@example.com"],
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      addedAt: "2026-01-02T00:00:00.000Z",
    },
  ],
};

async function listAccounts(home: string): Promise<string> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/src/index.js")],
    env: { ...process.env, [HOME_KEY]: home } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "persistence-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: "gmail_list_accounts", arguments: {} });
    return (res.content as { type: string; text: string }[])[0]?.text ?? "";
  } finally {
    await client.close();
  }
}

describe("account persistence across server restarts", () => {
  let home: string;

  before(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "gmail-mcp-persist-"));
    await fs.writeFile(
      path.join(home, "accounts.json"),
      JSON.stringify(REGISTRY, null, 2),
    );
  });

  after(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("reports both accounts on a cold start", async () => {
    const body = await listAccounts(home);
    assert.match(body, /personal@example\.com/);
    assert.match(body, /work@example\.com/);
    assert.match(body, /Connected accounts \(2\)/);
  });

  it("reports the same accounts from a second, independent process", async () => {
    // This is the actual claim: a brand new session sees the same mailboxes,
    // with no re-authorisation and no shared memory with the first process.
    const body = await listAccounts(home);
    assert.match(body, /personal@example\.com/);
    assert.match(body, /work@example\.com/);
  });

  it("preserves each account's tier and label across restarts", async () => {
    const body = await listAccounts(home);
    assert.match(body, /personal@example\.com\s+\[personal\]\s*\n\s*tier: readonly/);
    assert.match(body, /work@example\.com\s+\[work\]\s*\n\s*tier: send/);
  });

  it("preserves the recipient allowlist across restarts", async () => {
    const body = await listAccounts(home);
    assert.match(body, /recipient allowlist: @example\.com/);
  });

  it("surfaces labels so a new session can address accounts by short name", async () => {
    // Labels are how the durable naming survives: a fresh conversation learns
    // "work" and "personal" from this call, not from prior context.
    const body = await listAccounts(home);
    assert.match(body, /\[personal\]/);
    assert.match(body, /\[work\]/);
  });

  it("keeps registries separate per GMAIL_MCP_HOME", async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "gmail-mcp-persist-alt-"));
    try {
      const body = await listAccounts(other);
      assert.match(body, /No Gmail accounts are connected/);
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});
