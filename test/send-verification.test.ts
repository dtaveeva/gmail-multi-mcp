import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { senderConfirmationBanner } from "../src/tools/write.js";

/**
 * The send preview must name the sending account and ask for it to be confirmed,
 * so an assistant cannot quietly send from a mailbox the user never chose in a
 * multi-account setup.
 */
describe("senderConfirmationBanner", () => {
  it("names the exact sending account", () => {
    assert.match(senderConfirmationBanner("work@acme.com"), /FROM: work@acme\.com/);
  });

  it("asks for confirmation when the account was not chosen by the user", () => {
    const banner = senderConfirmationBanner("a@b.com");
    assert.match(banner, /SENDING ACCOUNT/);
    assert.match(banner, /did not explicitly choose/);
    assert.match(banner, /confirm/i);
  });
});
