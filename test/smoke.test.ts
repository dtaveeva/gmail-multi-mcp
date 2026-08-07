import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * End-to-end check that the built server speaks MCP correctly with no Google
 * credentials present. This is the state every new user starts in, so it must
 * degrade gracefully: the server boots, advertises its tools, and explains
 * what is missing rather than crashing.
 */
describe("server smoke test", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let home: string;

  before(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "gmail-mcp-smoke-"));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("dist/src/index.js")],
      env: { ...process.env, GMAIL_MCP_HOME: home } as Record<string, string>,
      stderr: "ignore",
    });
    client = new Client({ name: "smoke-test", version: "0.0.0" });
    await client.connect(transport);
  });

  after(async () => {
    await client?.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("completes the MCP handshake without credentials", () => {
    assert.ok(client.getServerVersion());
    assert.equal(client.getServerVersion()?.name, "gmail-multi-mcp");
  });

  it("advertises every expected tool", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "gmail_configure_oauth_client",
      "gmail_connect_account",
      "gmail_connection_status",
      "gmail_create_draft",
      "gmail_disconnect_account",
      "gmail_list_accounts",
      "gmail_list_labels",
      "gmail_modify_labels",
      "gmail_read_message",
      "gmail_read_thread",
      "gmail_search",
      "gmail_send",
      "gmail_send_draft",
      "gmail_setup_status",
      "gmail_trash",
    ]);
  });

  it("explains what setup is missing rather than failing", async () => {
    const res = await client.callTool({ name: "gmail_setup_status", arguments: {} });
    const body = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    assert.match(body, /OAuth client: NOT configured/);
    assert.match(body, /console\.cloud\.google\.com/);
    assert.match(body, /Desktop app/);
  });

  it("routes an account connection to setup guidance when unconfigured", async () => {
    // Must not open a browser or hang: with no OAuth client there is nothing to
    // sign in to, and the model needs to be told what the user has to do.
    const res = await client.callTool({
      name: "gmail_connect_account",
      arguments: { tier: "readonly", wait_seconds: 5 },
    });
    const body = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    assert.match(body, /no Google OAuth client yet/);
  });

  it("rejects a client id that is not a Google OAuth client id", async () => {
    const res = await client.callTool({
      name: "gmail_configure_oauth_client",
      arguments: { client_id: "totally-made-up", client_secret: "x" },
    });
    const body = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    assert.equal(res.isError, true);
    assert.match(body, /does not look like a Google OAuth client id/);
  });

  it("warns against collecting an app password through the conversation", async () => {
    // An app password pasted into chat is written into the transcript. The
    // guidance must send the user to the terminal for that path instead.
    const res = await client.callTool({ name: "gmail_setup_status", arguments: {} });
    const body = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    assert.match(body, /Do not ask them to paste an app password here/);
  });

  it("exposes no permanent-delete or mail-settings tool", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const forbidden of ["delete", "forward", "filter", "settings"]) {
      assert.ok(
        !names.some((n) => n.includes(forbidden)),
        `tool list must not contain anything matching "${forbidden}"`,
      );
    }
  });

  it("marks read tools readOnly and write tools destructive", async () => {
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.equal(byName.get("gmail_search")?.annotations?.readOnlyHint, true);
    assert.equal(byName.get("gmail_send")?.annotations?.destructiveHint, true);
    assert.equal(byName.get("gmail_trash")?.annotations?.destructiveHint, true);
  });

  it("tells the user how to connect an account instead of crashing", async () => {
    const res = await client.callTool({ name: "gmail_list_accounts", arguments: {} });
    const body = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    assert.match(body, /No Gmail accounts are connected/);
    assert.match(body, /gmail-multi-mcp auth add/);
  });

  it("returns a usable error, not a crash, for an unknown account", async () => {
    const res = await client.callTool({
      name: "gmail_search",
      arguments: { account: "nobody@example.com", query: "is:unread" },
    });
    const body = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    assert.equal(res.isError, true);
    assert.match(body, /No connected account matches/);
  });
});
