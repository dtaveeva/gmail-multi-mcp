import fs from "node:fs/promises";
import { OAuth2Client } from "google-auth-library";
import type { Config } from "../config.js";
import { UserFacingError } from "../errors.js";

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

const SETUP_HINT =
  "Create a Google Cloud project, enable the Gmail API, create an OAuth client " +
  "of type 'Desktop app', download the JSON, and save it to the path above " +
  "(or point GMAIL_MCP_OAUTH_CLIENT at it). Full walkthrough: see README.md.";

/**
 * Loads the user's own OAuth client. This server intentionally ships no
 * credentials of its own: Gmail's restricted scopes require a per-publisher
 * CASA security assessment, so a shared client would either be unverifiable
 * or would funnel every user's mailbox through one project. Bring your own.
 */
export async function loadOAuthClientConfig(cfg: Config): Promise<OAuthClientConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(cfg.oauthClientPath, "utf8");
  } catch {
    throw new UserFacingError(
      `No Google OAuth client found at ${cfg.oauthClientPath}`,
      SETUP_HINT,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new UserFacingError(
      `${cfg.oauthClientPath} is not valid JSON.`,
      SETUP_HINT,
    );
  }

  const block = (parsed.installed ?? parsed.web ?? parsed) as Record<string, unknown>;
  const clientId = block.client_id;
  const clientSecret = block.client_secret;

  if (typeof clientId !== "string" || typeof clientSecret !== "string") {
    throw new UserFacingError(
      `${cfg.oauthClientPath} is missing client_id or client_secret.`,
      SETUP_HINT,
    );
  }

  return { clientId, clientSecret };
}

export function createOAuth2Client(
  client: OAuthClientConfig,
  redirectUri?: string,
): OAuth2Client {
  return new OAuth2Client({
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    ...(redirectUri ? { redirectUri } : {}),
  });
}
