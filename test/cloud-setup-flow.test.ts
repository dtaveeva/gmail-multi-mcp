import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { beginCloudSetupFlow, type PendingCloudSetup } from "../src/auth/cloud-setup-flow.js";

/**
 * The guided page is the product's onboarding surface. Every user has to create
 * their own Google Cloud project — Gmail's restricted scopes make a shared one
 * require a paid annual audit — so the only thing that can be improved is how
 * painful satisfying that requirement is.
 */
describe("guided Cloud setup page", () => {
  let flow: PendingCloudSetup;
  let state: string;
  let html: string;

  before(async () => {
    process.env.GMAIL_MCP_NO_BROWSER = "1";
    flow = await beginCloudSetupFlow();
    flow.completed.catch(() => {});

    html = await (await fetch(flow.setupUrl)).text();
    state = /name="state" value="([^"]+)"/.exec(html)?.[1] ?? "";
  });

  after(() => {
    flow.cancel();
  });

  const submit = (fields: Record<string, string>) =>
    fetch(new URL("/submit", flow.setupUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });

  it("serves on loopback only", () => {
    assert.equal(new URL(flow.setupUrl).hostname, "127.0.0.1");
  });

  it("links every console page in order", () => {
    assert.match(html, /console\.cloud\.google\.com\/projectcreate/);
    assert.match(html, /apis\/library\/gmail\.googleapis\.com/);
    assert.match(html, /console\.cloud\.google\.com\/auth\/overview/);
    assert.match(html, /console\.cloud\.google\.com\/auth\/clients/);
  });

  it("calls out the two choices that silently break setup", () => {
    // Desktop app is the only client type allowed the loopback redirect, and an
    // unpublished External app expires refresh tokens after 7 days. Both fail
    // long after the mistake, so the page has to be loud about them up front.
    assert.match(html, /Desktop app/);
    assert.match(html, /Publish app/);
    assert.match(html, /7 days/);
  });

  it("explains the Workspace versus personal choice", () => {
    assert.match(html, /Internal/);
    assert.match(html, /External/);
  });

  it("reassures that the pasted values are not a password", () => {
    // Source wraps this sentence, so match across the line break.
    assert.match(html, /not a\s+password/);
    assert.match(html, /grant access to nothing/);
  });

  it("accepts a well-formed client id and secret", async () => {
    const res = await submit({
      state,
      client_id: "1234567890-abc.apps.googleusercontent.com",
      client_secret: "GOCSPX-example",
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Setup complete/);

    const result = await flow.completed;
    assert.equal(result.clientId, "1234567890-abc.apps.googleusercontent.com");
    assert.equal(result.clientSecret, "GOCSPX-example");
  });
});

describe("guided Cloud setup rejections", () => {
  let flow: PendingCloudSetup;
  let state: string;

  before(async () => {
    process.env.GMAIL_MCP_NO_BROWSER = "1";
    flow = await beginCloudSetupFlow();
    flow.completed.catch(() => {});
    const html = await (await fetch(flow.setupUrl)).text();
    state = /name="state" value="([^"]+)"/.exec(html)?.[1] ?? "";
  });

  after(() => {
    flow.cancel();
  });

  const submit = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(new URL("/submit", flow.setupUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    });

  it("rejects a client id that is not a Google one, and says why", async () => {
    const res = await submit({ state, client_id: "nonsense", client_secret: "x" });
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.match(body, /apps\.googleusercontent\.com/);
    assert.match(body, /name="client_id"/, "should re-render the form to retry");
  });

  it("rejects an empty client secret", async () => {
    const res = await submit({
      state,
      client_id: "1-a.apps.googleusercontent.com",
      client_secret: "",
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /client secret was empty/);
  });

  it("rejects a forged state token", async () => {
    const res = await submit({
      state: "forged",
      client_id: "1-a.apps.googleusercontent.com",
      client_secret: "x",
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Session mismatch/);
  });

  it("rejects a foreign Origin", async () => {
    const res = await submit(
      { state, client_id: "1-a.apps.googleusercontent.com", client_secret: "x" },
      { origin: "https://evil.example" },
    );
    assert.equal(res.status, 403);
  });

  it("sets the same protective headers as the password form", async () => {
    const res = await fetch(flow.setupUrl);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  });
});
