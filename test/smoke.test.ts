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
      env: {
        ...process.env,
        GMAIL_MCP_HOME: home,
        // Never let a test spawn a real browser window.
        GMAIL_MCP_NO_BROWSER: "1",
      } as Record<string, string>,
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

  it("reports ready even with no Google Cloud project configured", async () => {
    // The whole point of the app-password path: a fresh install can connect a
    // mailbox immediately. Reporting "not configured" here would send users off
    // to the Cloud console for no reason.
    const res = await client.callTool({ name: "gmail_setup_status", arguments: {} });
    const body = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    assert.match(body, /READY/);
    assert.match(body, /app_password\s+ready, no setup needed/);
    assert.match(body, /google_signin\s+needs a one-time setup/);
  });

  it("opens the guided setup page when google_signin has no Cloud project", async () => {
    // Rather than dumping console links into the chat, it should put the steps
    // in the browser next to the console tabs the user will be opening.
    const res = await client.callTool({
      name: "gmail_connect_account",
      arguments: { method: "google_signin", tier: "readonly", wait_seconds: 5 },
    });
    const body = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    assert.match(body, /one-time setup/);
    assert.match(body, /step by step on the page/);
    assert.match(body, /PUBLISH APP/);
    // The browser is disabled in tests, so it must surface the URL instead.
    assert.match(body, /http:\/\/127\.0\.0\.1:\d+/);
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

  it("tells the model never to collect an app password in conversation", async () => {
    // An app password pasted into chat is written into the transcript forever.
    // The browser form exists precisely so it never has to be.
    const res = await client.callTool({ name: "gmail_setup_status", arguments: {} });
    const body = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    assert.match(body, /Do not ask the user to type an app\s+password here/);
    assert.match(body, /collects it locally/);
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
