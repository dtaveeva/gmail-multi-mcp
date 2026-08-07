import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fromHexId,
  mapLabels,
  normaliseAppPassword,
  toHexId,
} from "../src/mailbox/imap.js";

/**
 * The IMAP backend has to present the same message ids as the REST backend, or
 * an id from gmail_search would not work in gmail_read_message. Gmail exposes
 * one value two ways: hex in the API, decimal as X-GM-MSGID over IMAP.
 */
describe("Gmail message id conversion", () => {
  it("converts a decimal X-GM-MSGID to the API's hex form", () => {
    assert.equal(toHexId("1790000000000000000"), (1790000000000000000n).toString(16));
  });

  it("round-trips through both directions", () => {
    const decimal = "1234567890123456789";
    assert.equal(fromHexId(toHexId(decimal)), decimal);
  });

  it("round-trips a hex id back to itself", () => {
    const hex = "18c3a4b5d6e7f890";
    assert.equal(toHexId(fromHexId(hex)), hex);
  });

  it("handles ids far beyond Number.MAX_SAFE_INTEGER without precision loss", () => {
    // Gmail ids exceed 2^53, so any implementation using Number would corrupt
    // them silently. BigInt is load-bearing here, not incidental.
    const big = "9223372036854775807";
    assert.ok(BigInt(big) > BigInt(Number.MAX_SAFE_INTEGER));
    assert.equal(fromHexId(toHexId(big)), big);
  });

  it("lowercases hex so ids compare consistently", () => {
    assert.equal(toHexId("18C3A4B5"), "18c3a4b5");
  });

  it("returns empty string for a missing id rather than throwing", () => {
    assert.equal(toHexId(undefined), "");
    assert.equal(toHexId(""), "");
  });

  it("passes through anything that is not a recognisable id", () => {
    assert.equal(toHexId("not-an-id"), "not-an-id");
    assert.equal(fromHexId("not-an-id"), "not-an-id");
  });
});

describe("normaliseAppPassword", () => {
  it("strips the spaces Gmail displays between groups", () => {
    // Gmail shows "abcd efgh ijkl mnop" and people paste exactly that.
    assert.equal(normaliseAppPassword("abcd efgh ijkl mnop"), "abcdefghijklmnop");
  });

  it("strips leading and trailing whitespace and newlines", () => {
    assert.equal(normaliseAppPassword("  abcdefghijklmnop\n"), "abcdefghijklmnop");
  });

  it("leaves an already-clean password untouched", () => {
    assert.equal(normaliseAppPassword("abcdefghijklmnop"), "abcdefghijklmnop");
  });
});

describe("mapLabels", () => {
  it("maps Gmail API system label ids to their IMAP names", () => {
    assert.deepEqual(mapLabels(["INBOX"]), ["\\Inbox"]);
    assert.deepEqual(mapLabels(["TRASH"]), ["\\Trash"]);
    assert.deepEqual(mapLabels(["STARRED"]), ["\\Starred"]);
  });

  it("is case insensitive on system ids", () => {
    assert.deepEqual(mapLabels(["inbox"]), ["\\Inbox"]);
  });

  it("passes user labels through unchanged", () => {
    assert.deepEqual(mapLabels(["Clients/Acme"]), ["Clients/Acme"]);
  });

  it("drops UNREAD, which is a flag rather than a label", () => {
    // UNREAD maps to the \Seen flag and is handled separately and inverted;
    // leaving it in the label list would create a literal "UNREAD" label.
    assert.deepEqual(mapLabels(["UNREAD"]), []);
    assert.deepEqual(mapLabels(["UNREAD", "INBOX"]), ["\\Inbox"]);
  });

  it("handles a mixed list", () => {
    assert.deepEqual(mapLabels(["INBOX", "Work", "UNREAD", "SPAM"]), [
      "\\Inbox",
      "Work",
      "\\Junk",
    ]);
  });
});
