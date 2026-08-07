import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { beginAppPasswordFlow, type PendingAppPassword } from "../src/auth/app-password-flow.js";

/**
 * The local form is what lets an app password be collected from a chat-driven
 * flow without the password ever entering the conversation. These cover the
 * page itself and every rejection path; a successful submission is not covered
 * because it necessarily authenticates against Gmail.
 */
describe("app password browser form", () => {
  let flow: PendingAppPassword;
  let state: string;

  before(async () => {
    process.env.GMAIL_MCP_NO_BROWSER = "1";
    flow = await beginAppPasswordFlow();
    // Keep the rejection from going unhandled while we poke at the server.
    flow.completed.catch(() => {});

    const html = await (await fetch(flow.formUrl)).text();
    state = /name="state" value="([^"]+)"/.exec(html)?.[1] ?? "";
  });

  after(() => {
    flow.cancel();
  });

  const submit = (fields: Record<string, string>) =>
    fetch(new URL("/submit", flow.formUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });

  it("serves the form on loopback only", () => {
    const url = new URL(flow.formUrl);
    assert.equal(url.hostname, "127.0.0.1");
    assert.ok(Number(url.port) > 0);
  });

  it("renders email and password fields", async () => {
    const html = await (await fetch(flow.formUrl)).text();
    assert.match(html, /name="email"/);
    assert.match(html, /name="password"/);
    assert.match(html, /type="password"/);
  });

  it("carries an unguessable per-run state token", () => {
    assert.ok(state.length >= 32, "state token should be long enough to resist guessing");
  });

  it("links to Google's app password page", async () => {
    const html = await (await fetch(flow.formUrl)).text();
    assert.match(html, /myaccount\.google\.com\/apppasswords/);
  });

  it("tells the user the password stays on their machine", async () => {
    const html = await (await fetch(flow.formUrl)).text();
    assert.match(html, /never appears in your conversation/);
  });

  it("rejects a submission with a forged state token", async () => {
    const res = await submit({
      state: "forged",
      email: "someone@gmail.com",
      password: "abcdefghijklmnop",
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Session mismatch/);
  });

  it("rejects a submission with no state at all", async () => {
    const res = await submit({ email: "someone@gmail.com", password: "abcdefghijklmnop" });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Session mismatch/);
  });

  it("rejects a malformed email and re-renders the form", async () => {
    const res = await submit({ state, email: "not-an-email", password: "abcdefghijklmnop" });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /does not look like an email address/);
    assert.match(html, /name="password"/, "should re-render the form, not dead-end");
  });

  it("rejects a password that is too short to be an app password", async () => {
    const res = await submit({ state, email: "someone@gmail.com", password: "short" });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /16 characters/);
  });

  it("ignores unrelated paths", async () => {
    const res = await fetch(new URL("/admin", flow.formUrl));
    assert.equal(res.status, 404);
  });

  it("stays open after a rejected attempt so the user can retry", async () => {
    await submit({ state, email: "bad", password: "short" });
    const res = await fetch(flow.formUrl);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /name="password"/);
  });
});
