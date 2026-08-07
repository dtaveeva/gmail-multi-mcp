import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gmail } from "@googleapis/gmail";
import type { OAuth2Client } from "google-auth-library";
import { type Tier, SCOPES_BY_TIER } from "../config.js";
import { UserFacingError } from "../errors.js";
import { openBrowser } from "../util/browser.js";
import { createOAuth2Client, type OAuthClientConfig } from "./client.js";
import type { StoredToken } from "./store.js";

const CALLBACK_PATH = "/oauth2callback";
const TIMEOUT_MS = 5 * 60 * 1000;

export interface AuthResult {
  email: string;
  token: StoredToken;
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.6">
<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`;
}

/**
 * Runs the OAuth authorization-code flow against a loopback listener.
 *
 * Hardening notes:
 * - PKCE (S256) so an intercepted code cannot be redeemed without the verifier.
 * - `state` is compared with timingSafeEqual to bind the callback to this run.
 * - The listener binds 127.0.0.1 explicitly, never 0.0.0.0.
 * - `prompt=consent` is required: without it Google omits refresh_token on
 *   re-authorization, and the account silently stops working when the access
 *   token expires an hour later.
 * - `select_account` is required alongside it. This is a multi-account tool,
 *   and with `consent` alone Google sends a user who is already signed in
 *   straight to the consent screen for *that* account. Connecting a second
 *   mailbox would then silently re-authorize the first one.
 */
export interface PendingOAuth {
  /** The Google sign-in URL. Already opened in a browser by the caller if able. */
  authUrl: string;
  /** Resolves when the user finishes in the browser; rejects on decline or timeout. */
  completed: Promise<AuthResult>;
  /** Abandon the flow and release the listener. */
  cancel(): void;
}

/**
 * Start the flow and return immediately with the sign-in URL.
 *
 * Split out from runOAuthFlow so an MCP tool call can kick off a sign-in,
 * return "your browser is open" straight away, and let a later call collect the
 * result. Blocking a tool call for the minute a human takes to click through
 * Google would hit client-side timeouts.
 */
export async function beginOAuthFlow(
  clientConfig: OAuthClientConfig,
  tier: Tier,
  loginHint?: string,
): Promise<PendingOAuth> {
  const scopes = [...SCOPES_BY_TIER[tier]];
  const state = crypto.randomBytes(24).toString("base64url");

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const oauth: OAuth2Client = createOAuth2Client(clientConfig, redirectUri);
  const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();

  const authUrl = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "select_account consent",
    scope: scopes,
    state,
    code_challenge_method: "S256" as never,
    code_challenge: codeChallenge,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });

  // Hoisted so cancel() can clear it, and unref'd so an abandoned sign-in does
  // not keep the process alive for the full timeout with nothing left to do.
  let timer: NodeJS.Timeout | undefined;

  const codePromise = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new UserFacingError("Timed out waiting for Google authorization."));
    }, TIMEOUT_MS);
    timer.unref();

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }

      const finish = (status: number, html: string, outcome: Error | string) => {
        clearTimeout(timer);
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(html);
        if (outcome instanceof Error) reject(outcome);
        else resolve(outcome);
      };

      const returnedState = url.searchParams.get("state") ?? "";
      const expected = Buffer.from(state);
      const actual = Buffer.from(returnedState);
      if (
        actual.length !== expected.length ||
        !crypto.timingSafeEqual(actual, expected)
      ) {
        finish(
          400,
          page("Authorization failed", "State mismatch — the request did not originate from this session."),
          new UserFacingError("OAuth state mismatch; aborting for safety."),
        );
        return;
      }

      const err = url.searchParams.get("error");
      if (err) {
        finish(
          400,
          page("Authorization declined", `Google returned: <code>${err}</code>`),
          new UserFacingError(`Authorization declined: ${err}`),
        );
        return;
      }

      const returnedCode = url.searchParams.get("code");
      if (!returnedCode) {
        finish(
          400,
          page("Authorization failed", "No authorization code was returned."),
          new UserFacingError("No authorization code returned."),
        );
        return;
      }

      finish(
        200,
        page("Account connected", "You can close this tab and go back to where you were."),
        returnedCode,
      );
    });
  }).finally(() => server.close());

  const completed = codePromise.then(async (code) => {
    const { tokens } = await oauth.getToken({ code, codeVerifier });

    if (!tokens.refresh_token) {
      throw new UserFacingError(
        "Google did not return a refresh token.",
        "Revoke this app's access at https://myaccount.google.com/permissions and " +
          "try again, so the consent screen is shown fresh.",
      );
    }

    oauth.setCredentials(tokens);
    const profile = await gmail({ version: "v1", auth: oauth }).users.getProfile({
      userId: "me",
    });
    const email = profile.data.emailAddress;
    if (!email) {
      throw new UserFacingError("Could not read the email address for this account.");
    }

    return {
      email,
      token: {
        refresh_token: tokens.refresh_token,
        ...(tokens.access_token ? { access_token: tokens.access_token } : {}),
        ...(tokens.expiry_date ? { expiry_date: tokens.expiry_date } : {}),
        scope: scopes.join(" "),
      },
    };
  });

  return {
    authUrl,
    completed,
    cancel: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

/** Blocking variant used by the CLI, where waiting at a prompt is expected. */
export async function runOAuthFlow(
  clientConfig: OAuthClientConfig,
  tier: Tier,
  loginHint?: string,
): Promise<AuthResult> {
  const pending = await beginOAuthFlow(clientConfig, tier, loginHint);

  process.stderr.write(
    `\nOpening your browser to authorize Gmail access (tier: ${tier}).\n` +
      `If it does not open, paste this URL:\n\n${pending.authUrl}\n\n`,
  );
  openBrowser(pending.authUrl);

  return pending.completed;
}
