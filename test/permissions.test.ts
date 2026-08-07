import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Account } from "../src/auth/accounts.js";
import { loadConfig, type Config, type Tier } from "../src/config.js";
import { PermissionError } from "../src/errors.js";
import {
  assertCapability,
  assertRecipientsAllowed,
  effectiveTier,
  parseAddresses,
} from "../src/safety/permissions.js";

function account(tier: Tier, extra: Partial<Account> = {}): Account {
  return {
    email: "user@example.com",
    tier,
    scopes: [],
    addedAt: new Date(0).toISOString(),
    ...extra,
  };
}

const cfg: Config = { ...loadConfig(), forceReadonly: false };
const readonlyCfg: Config = { ...cfg, forceReadonly: true };

describe("tier enforcement", () => {
  it("lets readonly read", () => {
    assert.doesNotThrow(() => assertCapability(account("readonly"), "read", cfg));
  });

  it("stops readonly from drafting", () => {
    assert.throws(
      () => assertCapability(account("readonly"), "draft", cfg),
      /Not permitted to create or edit drafts/,
    );
  });

  it("stops the draft tier from sending", () => {
    assert.throws(
      () => assertCapability(account("draft"), "send", cfg),
      /Not permitted to send mail/,
    );
  });

  it("lets the draft tier draft and read", () => {
    assert.doesNotThrow(() => assertCapability(account("draft"), "draft", cfg));
    assert.doesNotThrow(() => assertCapability(account("draft"), "read", cfg));
  });

  it("lets the send tier do everything", () => {
    for (const cap of ["read", "draft", "send", "modify"] as const) {
      assert.doesNotThrow(() => assertCapability(account("send"), cap, cfg));
    }
  });

  it("treats label and trash changes as send-tier operations", () => {
    assert.throws(() => assertCapability(account("draft"), "modify", cfg), /Not permitted/);
  });

  it("GMAIL_MCP_READONLY downgrades even a send-tier account", () => {
    assert.equal(effectiveTier(account("send"), readonlyCfg), "readonly");
    assert.throws(
      () => assertCapability(account("send"), "send", readonlyCfg),
      (err: unknown) => {
        assert.ok(err instanceof PermissionError);
        assert.match(err.message, /Not permitted to send mail/);
        // The reason lives in `hint`, which is what the user actually needs.
        assert.match(err.hint ?? "", /GMAIL_MCP_READONLY is set/);
        return true;
      },
    );
  });
});

describe("recipient allowlist", () => {
  it("is inert when unset", () => {
    assert.doesNotThrow(() =>
      assertRecipientsAllowed(account("send"), ["anyone@anywhere.com"]),
    );
  });

  it("permits an exact address match", () => {
    const a = account("send", { allowedRecipients: ["alice@client.com"] });
    assert.doesNotThrow(() => assertRecipientsAllowed(a, ["alice@client.com"]));
  });

  it("permits a domain suffix match", () => {
    const a = account("send", { allowedRecipients: ["@client.com"] });
    assert.doesNotThrow(() => assertRecipientsAllowed(a, ["bob@client.com"]));
  });

  it("blocks an address outside the list and names it", () => {
    const a = account("send", { allowedRecipients: ["@client.com"] });
    assert.throws(
      () => assertRecipientsAllowed(a, ["bob@client.com", "attacker@evil.com"]),
      /may not send to: attacker@evil.com/,
    );
  });

  it("does not let a lookalike domain slip through", () => {
    const a = account("send", { allowedRecipients: ["@client.com"] });
    assert.throws(
      () => assertRecipientsAllowed(a, ["bob@notclient.com.evil.com"]),
      /may not send to/,
    );
  });

  it("is case insensitive", () => {
    const a = account("send", { allowedRecipients: ["@Client.com"] });
    assert.doesNotThrow(() => assertRecipientsAllowed(a, ["Bob@CLIENT.com"]));
  });
});

describe("parseAddresses", () => {
  it("pulls addresses out of a display-name header", () => {
    assert.deepEqual(
      parseAddresses('"Alice Smith" <alice@x.com>, bob@y.com'),
      ["alice@x.com", "bob@y.com"],
    );
  });

  it("lowercases what it finds", () => {
    assert.deepEqual(parseAddresses("Alice@X.COM"), ["alice@x.com"]);
  });
});
