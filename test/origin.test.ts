import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isForeignOrigin } from "../src/util/origin.js";

/**
 * The loopback forms rejected legitimate submissions when this guard demanded
 * an exact `http://127.0.0.1:<port>` match, because embedded browser views post
 * with `Origin: null`. These pin down the contract: reject a real foreign
 * website, allow everything a genuine local user can produce.
 */
describe("isForeignOrigin", () => {
  it("allows a missing Origin header", () => {
    assert.equal(isForeignOrigin(undefined), false);
  });

  it("allows an opaque 'null' Origin from a sandboxed/embedded view", () => {
    // This is the case that dead-ended real users on the Blocked page.
    assert.equal(isForeignOrigin("null"), false);
  });

  it("allows loopback regardless of port", () => {
    assert.equal(isForeignOrigin("http://127.0.0.1:49213"), false);
    assert.equal(isForeignOrigin("http://localhost:8080"), false);
    assert.equal(isForeignOrigin("http://[::1]:3000"), false);
  });

  it("allows a non-web scheme (app or extension host)", () => {
    assert.equal(isForeignOrigin("app://gmail-mcp"), false);
    assert.equal(isForeignOrigin("chrome-extension://abcdef"), false);
  });

  it("rejects a genuine foreign website — the one case this exists to stop", () => {
    assert.equal(isForeignOrigin("https://evil.example"), true);
    assert.equal(isForeignOrigin("http://attacker.test:1234"), true);
  });
});
