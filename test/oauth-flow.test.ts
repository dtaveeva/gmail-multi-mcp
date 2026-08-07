import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runOAuthFlow } from "../src/auth/flow.js";
import type { Tier } from "../src/config.js";

/**
 * Exercises the authorization flow up to the point where a human must type a
 * Google password — the loopback listener, PKCE generation, authorization URL
 * construction, and every callback rejection path.
 *
 * No network, no browser, and no credentials: the flow is driven by calling its
 * own loopback endpoint directly. The token exchange that follows a *valid*
 * callback is the only part not covered here, because it necessarily talks to
 * Google with a real authorization code.
 */

const FAKE_CLIENT = {
  clientId: "000000000000-testonly.apps.googleusercontent.com",
  clientSecret: "GOCSPX-not-a-real-secret",
};

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the auth URL");
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Started {
  settled: Promise<{ ok: boolean; error?: string }>;
  url: URL;
}

/** Start a flow and capture the authorization URL it writes to stderr. */
async function startFlow(tier: Tier, loginHint?: string): Promise<Started> {
  process.env.GMAIL_MCP_NO_BROWSER = "1";

  const captured: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  const settled = runOAuthFlow(FAKE_CLIENT, tier, loginHint).then(
    () => ({ ok: true }),
    (err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );

  try {
    await waitFor(() => captured.join("").includes("https://accounts.google.com"));
  } finally {
    process.stderr.write = original;
  }

  const match = /https:\/\/accounts\.google\.com\/\S+/.exec(captured.join(""));
  assert.ok(match, "flow should print an authorization URL to stderr");
  return { settled, url: new URL(match[0]) };
}

function callbackUrl(authUrl: URL, params: Record<string, string>): string {
  const redirect = new URL(authUrl.searchParams.get("redirect_uri") ?? "");
  for (const [k, v] of Object.entries(params)) redirect.searchParams.set(k, v);
  return redirect.toString();
}

describe("OAuth authorization URL", () => {
  it("targets Google with the caller's client id and a loopback redirect", async () => {
    const { settled, url } = await startFlow("readonly");

    assert.equal(url.origin, "https://accounts.google.com");
    assert.equal(url.searchParams.get("client_id"), FAKE_CLIENT.clientId);
    assert.equal(url.searchParams.get("response_type"), "code");

    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    assert.equal(redirect.hostname, "127.0.0.1", "must bind loopback, never 0.0.0.0");
    assert.equal(redirect.pathname, "/oauth2callback");
    assert.ok(Number(redirect.port) > 0);

    await fetch(callbackUrl(url, { state: "wrong", code: "x" })).catch(() => {});
    await settled;
  });

  it("requests offline access and forces both the chooser and consent", async () => {
    const { settled, url } = await startFlow("readonly");

    // offline+consent: without both, Google omits refresh_token on
    // re-authorization and the account dies when the access token expires.
    assert.equal(url.searchParams.get("access_type"), "offline");

    // select_account: without it, a user already signed into one Google
    // account gets sent straight to consent for that account, so connecting a
    // second mailbox would silently re-authorize the first.
    const prompt = (url.searchParams.get("prompt") ?? "").split(" ");
    assert.ok(prompt.includes("consent"), "prompt must include consent");
    assert.ok(prompt.includes("select_account"), "prompt must include select_account");

    await fetch(callbackUrl(url, { state: "wrong" })).catch(() => {});
    await settled;
  });

  it("omits login_hint unless one is supplied", async () => {
    const { settled, url } = await startFlow("readonly");
    assert.equal(url.searchParams.get("login_hint"), null);
    await fetch(callbackUrl(url, { state: "wrong" })).catch(() => {});
    await settled;
  });

  it("passes login_hint through so a specific account is pre-selected", async () => {
    const { settled, url } = await startFlow("readonly", "someone@example.com");
    assert.equal(url.searchParams.get("login_hint"), "someone@example.com");
    await fetch(callbackUrl(url, { state: "wrong" })).catch(() => {});
    await settled;
  });

  it("uses PKCE with S256 and a per-run state", async () => {
    const { settled, url } = await startFlow("readonly");

    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const challenge = url.searchParams.get("code_challenge") ?? "";
    assert.ok(challenge.length >= 43, "S256 challenge should be a 43-char base64url digest");
    assert.ok((url.searchParams.get("state") ?? "").length >= 32);

    await fetch(callbackUrl(url, { state: "wrong" })).catch(() => {});
    await settled;
  });

  it("requests only the scopes the tier needs", async () => {
    const cases: [Tier, string[]][] = [
      ["readonly", ["https://www.googleapis.com/auth/gmail.readonly"]],
      [
        "draft",
        [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
        ],
      ],
      ["send", ["https://www.googleapis.com/auth/gmail.modify"]],
    ];

    for (const [tier, expected] of cases) {
      const { settled, url } = await startFlow(tier);
      const scopes = (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean);
      assert.deepEqual(scopes.sort(), [...expected].sort(), `wrong scopes for ${tier}`);

      // No tier may ever request settings access — that is how forwarding rules
      // get created, and this server must be incapable of it.
      assert.ok(!scopes.some((s) => s.includes("gmail.settings")));

      await fetch(callbackUrl(url, { state: "wrong" })).catch(() => {});
      await settled;
    }
  });
});

describe("OAuth callback handling", () => {
  it("rejects a callback whose state does not match", async () => {
    const { settled, url } = await startFlow("readonly");

    const res = await fetch(callbackUrl(url, { state: "forged", code: "stolen" }));
    assert.equal(res.status, 400);
    assert.match(await res.text(), /State mismatch/);

    const outcome = await settled;
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? "", /state mismatch/i);
  });

  it("rejects a user-declined authorization", async () => {
    const { settled, url } = await startFlow("readonly");
    const state = url.searchParams.get("state") ?? "";

    const res = await fetch(callbackUrl(url, { state, error: "access_denied" }));
    assert.equal(res.status, 400);

    const outcome = await settled;
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? "", /access_denied/);
  });

  it("rejects a callback carrying neither a code nor an error", async () => {
    const { settled, url } = await startFlow("readonly");
    const state = url.searchParams.get("state") ?? "";

    const res = await fetch(callbackUrl(url, { state }));
    assert.equal(res.status, 400);

    const outcome = await settled;
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? "", /No authorization code/);
  });

  it("ignores requests to any path other than the callback", async () => {
    const { settled, url } = await startFlow("readonly");
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");

    const stray = await fetch(`${redirect.origin}/not-the-callback`);
    assert.equal(stray.status, 404);

    // The flow is still waiting, so a correct callback still works afterwards.
    const res = await fetch(callbackUrl(url, { state: "forged" }));
    assert.equal(res.status, 400);
    await settled;
  });
});
