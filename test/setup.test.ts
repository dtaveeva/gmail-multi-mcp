import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { findDownloadedCredentials, validateClientFile } from "../src/cli/setup.js";

const DESKTOP_CLIENT = {
  installed: {
    client_id: "000000000000-abc.apps.googleusercontent.com",
    client_secret: "GOCSPX-example",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    redirect_uris: ["http://localhost"],
  },
};

const WEB_CLIENT = {
  web: {
    client_id: "000000000000-web.apps.googleusercontent.com",
    client_secret: "GOCSPX-example",
  },
};

describe("validateClientFile", () => {
  let dir: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gmail-mcp-setup-"));
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const write = async (name: string, body: unknown): Promise<string> => {
    const file = path.join(dir, name);
    await fs.writeFile(file, typeof body === "string" ? body : JSON.stringify(body));
    return file;
  };

  it("accepts a Desktop app client", async () => {
    const file = await write("good.json", DESKTOP_CLIENT);
    await assert.doesNotReject(() => validateClientFile(file));
  });

  it("rejects a Web application client with an actionable message", async () => {
    // The most common wrong turn in the console: Web clients cannot use the
    // 127.0.0.1 loopback redirect, and the failure otherwise appears much
    // later as an opaque redirect_uri_mismatch from Google.
    const file = await write("web.json", WEB_CLIENT);
    await assert.rejects(
      () => validateClientFile(file),
      /created as a Web application, not a Desktop app/,
    );
  });

  it("rejects a file missing client_secret", async () => {
    const file = await write("partial.json", { installed: { client_id: "x" } });
    await assert.rejects(() => validateClientFile(file), /does not look like an OAuth client/);
  });

  it("rejects a file that is not JSON at all", async () => {
    const file = await write("junk.json", "not json {{{");
    await assert.rejects(() => validateClientFile(file), /not readable JSON/);
  });

  it("rejects a missing file", async () => {
    await assert.rejects(
      () => validateClientFile(path.join(dir, "absent.json")),
      /not readable JSON/,
    );
  });
});

describe("findDownloadedCredentials", () => {
  let dir: string;
  let previous: string | undefined;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gmail-mcp-dl-"));
    previous = process.env.GMAIL_MCP_DOWNLOAD_DIR;
    process.env.GMAIL_MCP_DOWNLOAD_DIR = dir;
  });

  after(async () => {
    if (previous === undefined) delete process.env.GMAIL_MCP_DOWNLOAD_DIR;
    else process.env.GMAIL_MCP_DOWNLOAD_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("finds a client_secret file", async () => {
    await fs.writeFile(
      path.join(dir, "client_secret_123-abc.apps.googleusercontent.com.json"),
      JSON.stringify(DESKTOP_CLIENT),
    );
    const found = await findDownloadedCredentials();
    assert.ok(found.some((c) => c.file.includes("client_secret_123")));
  });

  it("ignores unrelated files in the same folder", async () => {
    await fs.writeFile(path.join(dir, "invoice.json"), "{}");
    await fs.writeFile(path.join(dir, "notes.txt"), "hello");
    const found = await findDownloadedCredentials();
    assert.ok(!found.some((c) => c.file.endsWith("invoice.json")));
    assert.ok(!found.some((c) => c.file.endsWith("notes.txt")));
  });

  it("returns the newest candidate first", async () => {
    const older = path.join(dir, "client_secret_old.json");
    const newer = path.join(dir, "client_secret_new.json");
    await fs.writeFile(older, JSON.stringify(DESKTOP_CLIENT));
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(newer, JSON.stringify(DESKTOP_CLIENT));

    const found = await findDownloadedCredentials();
    const idxNew = found.findIndex((c) => c.file === newer);
    const idxOld = found.findIndex((c) => c.file === older);
    assert.ok(idxNew >= 0 && idxOld >= 0);
    assert.ok(idxNew < idxOld, "newest download should be offered first");
  });
});
