import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRawMessage, toGmailRaw } from "../src/gmail/mime.js";

const base = {
  from: "me@example.com",
  to: ["you@example.com"],
  subject: "Hello",
  body: "Hi there",
};

describe("buildRawMessage", () => {
  it("emits the expected headers", () => {
    const raw = buildRawMessage(base);
    assert.match(raw, /^From: me@example\.com\r\n/);
    assert.match(raw, /\r\nTo: you@example\.com\r\n/);
    assert.match(raw, /\r\nSubject: Hello\r\n/);
    assert.match(raw, /\r\nMIME-Version: 1\.0\r\n/);
  });

  it("refuses a recipient containing a header break", () => {
    assert.throws(
      () =>
        buildRawMessage({
          ...base,
          to: ["ok@x.com\r\nBcc: attacker@evil.com"],
        }),
      /contains a line break/,
    );
  });

  it("refuses a bare newline too", () => {
    assert.throws(
      () => buildRawMessage({ ...base, to: ["ok@x.com\nBcc: attacker@evil.com"] }),
      /contains a line break/,
    );
  });

  it("refuses a smuggled header in the subject", () => {
    assert.throws(
      () => buildRawMessage({ ...base, subject: "Hi\r\nBcc: attacker@evil.com" }),
      /contains a line break/,
    );
  });

  it("keeps a newline-laden body intact, since bodies are encoded not folded", () => {
    const raw = buildRawMessage({ ...base, body: "line one\nline two\n\nline four" });
    const encoded = raw.split("\r\n\r\n")[1] ?? "";
    const decoded = Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf8");
    assert.equal(decoded, "line one\nline two\n\nline four");
  });

  it("RFC 2047 encodes a non-ASCII subject", () => {
    const raw = buildRawMessage({ ...base, subject: "สวัสดี" });
    assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  });

  it("round-trips a non-ASCII body", () => {
    const body = "ราคา 50,000 บาท — ok?";
    const raw = buildRawMessage({ ...base, body });
    const encoded = raw.split("\r\n\r\n")[1] ?? "";
    assert.equal(Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf8"), body);
  });

  it("requires at least one recipient", () => {
    assert.throws(() => buildRawMessage({ ...base, to: [] }), /at least one recipient/);
  });

  it("includes threading headers when replying", () => {
    const raw = buildRawMessage({
      ...base,
      inReplyTo: "<abc@mail.gmail.com>",
      references: "<old@x> <abc@mail.gmail.com>",
    });
    assert.match(raw, /\r\nIn-Reply-To: <abc@mail\.gmail\.com>\r\n/);
    assert.match(raw, /\r\nReferences: <old@x> <abc@mail\.gmail\.com>\r\n/);
  });
});

describe("toGmailRaw", () => {
  it("produces base64url with no padding or unsafe characters", () => {
    const raw = toGmailRaw(base);
    assert.doesNotMatch(raw, /[+/=]/);
  });
});
