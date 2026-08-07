import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfirmationStore } from "../src/safety/confirm.js";

const ACCOUNT = "user@example.com";
const PAYLOAD = { to: ["a@b.com"], subject: "Hi", body: "Hello" };

describe("ConfirmationStore", () => {
  it("redeems a token that matches the previewed payload exactly", () => {
    const store = new ConfirmationStore(60_000);
    const { token } = store.issue("gmail_send", ACCOUNT, PAYLOAD);
    assert.doesNotThrow(() => store.redeem(token, "gmail_send", ACCOUNT, PAYLOAD));
  });

  it("rejects a token whose payload changed after preview", () => {
    const store = new ConfirmationStore(60_000);
    const { token } = store.issue("gmail_send", ACCOUNT, PAYLOAD);
    assert.throws(
      () =>
        store.redeem(token, "gmail_send", ACCOUNT, {
          ...PAYLOAD,
          to: ["attacker@evil.com"],
        }),
      /changed after it was previewed/,
    );
  });

  it("rejects a swapped recipient even when every other field is identical", () => {
    const store = new ConfirmationStore(60_000);
    const { token } = store.issue("gmail_send", ACCOUNT, PAYLOAD);
    assert.throws(
      () =>
        store.redeem(token, "gmail_send", ACCOUNT, {
          ...PAYLOAD,
          to: ["a@b.com", "attacker@evil.com"],
        }),
      /changed after it was previewed/,
    );
  });

  it("is single use", () => {
    const store = new ConfirmationStore(60_000);
    const { token } = store.issue("gmail_send", ACCOUNT, PAYLOAD);
    store.redeem(token, "gmail_send", ACCOUNT, PAYLOAD);
    assert.throws(
      () => store.redeem(token, "gmail_send", ACCOUNT, PAYLOAD),
      /unknown, already used, or expired/,
    );
  });

  it("burns the token even when redemption fails, so it cannot be retried", () => {
    const store = new ConfirmationStore(60_000);
    const { token } = store.issue("gmail_send", ACCOUNT, PAYLOAD);
    assert.throws(() => store.redeem(token, "gmail_send", ACCOUNT, { ...PAYLOAD, body: "x" }));
    assert.throws(
      () => store.redeem(token, "gmail_send", ACCOUNT, PAYLOAD),
      /unknown, already used, or expired/,
    );
  });

  it("rejects a token issued for a different account", () => {
    const store = new ConfirmationStore(60_000);
    const { token } = store.issue("gmail_send", ACCOUNT, PAYLOAD);
    assert.throws(
      () => store.redeem(token, "gmail_send", "other@example.com", PAYLOAD),
      /issued for user@example.com/,
    );
  });

  it("rejects a token issued for a different action", () => {
    const store = new ConfirmationStore(60_000);
    const { token } = store.issue("gmail_send", ACCOUNT, PAYLOAD);
    assert.throws(
      () => store.redeem(token, "gmail_trash", ACCOUNT, PAYLOAD),
      /issued for "gmail_send"/,
    );
  });

  it("rejects a fabricated token", () => {
    const store = new ConfirmationStore(60_000);
    store.issue("gmail_send", ACCOUNT, PAYLOAD);
    assert.throws(
      () => store.redeem("not-a-real-token", "gmail_send", ACCOUNT, PAYLOAD),
      /unknown, already used, or expired/,
    );
  });

  it("expires tokens after the TTL", async () => {
    const store = new ConfirmationStore(10);
    const { token } = store.issue("gmail_send", ACCOUNT, PAYLOAD);
    await new Promise((r) => setTimeout(r, 30));
    assert.throws(
      () => store.redeem(token, "gmail_send", ACCOUNT, PAYLOAD),
      /unknown, already used, or expired/,
    );
  });

  it("treats key order as insignificant but values as significant", () => {
    const store = new ConfirmationStore(60_000);
    const { token } = store.issue("gmail_send", ACCOUNT, { a: 1, b: 2 });
    assert.doesNotThrow(() => store.redeem(token, "gmail_send", ACCOUNT, { b: 2, a: 1 }));
  });

  it("withholds the token from the caller in strict mode", () => {
    const store = new ConfirmationStore(60_000, "strict");
    const issued = store.issue("gmail_send", ACCOUNT, PAYLOAD);
    assert.equal(issued.token, "");
    assert.equal(issued.outOfBand, true);
  });
});
