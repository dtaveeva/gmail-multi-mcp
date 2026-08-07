import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserCommand } from "../src/util/browser.js";

const OAUTH_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=select_account%20consent&response_type=code&client_id=abc.apps.googleusercontent.com";

/**
 * Regression: on Windows the OAuth URL was handed to `cmd /c start` unquoted, so
 * cmd split it at the first `&` and the browser received a URL missing
 * `response_type` and `client_id` — Google rejected it with invalid_request.
 */
describe("browserCommand", () => {
  it("passes the URL to cmd as a single quoted token on Windows", () => {
    const { cmd, args, verbatim } = browserCommand(OAUTH_URL, "win32");
    assert.equal(cmd, "cmd");
    assert.equal(verbatim, true);
    // The whole URL, quotes included, must be one argument — not split on '&'.
    assert.ok(
      args.includes(`"${OAUTH_URL}"`),
      "the quoted URL must be a single argument so cmd does not split on &",
    );
    // start needs an (empty) window-title argument before a quoted URL.
    const titleIdx = args.indexOf('""');
    const urlIdx = args.indexOf(`"${OAUTH_URL}"`);
    assert.ok(titleIdx >= 0 && titleIdx < urlIdx, "empty title must precede the URL");
  });

  it("passes the URL untouched to open on macOS", () => {
    const { cmd, args, verbatim } = browserCommand(OAUTH_URL, "darwin");
    assert.equal(cmd, "open");
    assert.deepEqual(args, [OAUTH_URL]);
    assert.equal(verbatim, false);
  });

  it("passes the URL untouched to xdg-open on Linux", () => {
    const { cmd, args, verbatim } = browserCommand(OAUTH_URL, "linux");
    assert.equal(cmd, "xdg-open");
    assert.deepEqual(args, [OAUTH_URL]);
    assert.equal(verbatim, false);
  });
});
