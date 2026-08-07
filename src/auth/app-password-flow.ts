import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { UserFacingError } from "../errors.js";
import { normaliseAppPassword, verifyAppPassword } from "../mailbox/imap.js";
import { isForeignOrigin } from "../util/origin.js";

const TIMEOUT_MS = 10 * 60 * 1000;

export interface AppPasswordResult {
  email: string;
  appPassword: string;
}

export interface PendingAppPassword {
  /** Local page where the user types the password. Never leaves this machine. */
  formUrl: string;
  completed: Promise<AppPasswordResult>;
  cancel(): void;
}

const APP_PASSWORD_URL = "https://myaccount.google.com/apppasswords";

function shell(body: string): string {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect a Gmail account</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6;
         max-width: 34rem; margin: 8vh auto; padding: 0 1.5rem; }
  h1 { font-size: 1.3rem; margin-bottom: .25rem; }
  .sub { opacity: .7; margin-top: 0; }
  ol { padding-left: 1.2rem; }
  li { margin: .4rem 0; }
  label { display: block; margin: 1.1rem 0 .3rem; font-weight: 600; }
  input { width: 100%; padding: .6rem .7rem; font-size: 1rem; border-radius: 6px;
          border: 1px solid rgba(128,128,128,.5); background: transparent;
          color: inherit; font-family: inherit; }
  button { margin-top: 1.4rem; padding: .65rem 1.3rem; font-size: 1rem;
           border-radius: 6px; border: 0; background: #1a73e8; color: #fff;
           cursor: pointer; }
  button:hover { background: #1666cc; }
  .note { font-size: .9rem; opacity: .75; margin-top: 1.5rem;
          border-top: 1px solid rgba(128,128,128,.3); padding-top: 1rem; }
  code { background: rgba(128,128,128,.18); padding: .1rem .35rem; border-radius: 4px; }
  .err { background: rgba(220,50,50,.12); border-left: 3px solid #d33;
         padding: .7rem .9rem; border-radius: 4px; margin: 1rem 0; }
  .ok { font-size: 2.2rem; }
</style>
<body>${body}</body>`;
}

function formPage(state: string, error?: string): string {
  return shell(
    `<h1>Connect a Gmail account</h1>
     <p class="sub">This page is running on your own computer. Nothing here is sent
     anywhere except to Gmail.</p>
     ${error ? `<div class="err">${error}</div>` : ""}
     <ol>
       <li>Make sure 2-Step Verification is on for the account you want to connect.</li>
       <li>Open <a href="${APP_PASSWORD_URL}" target="_blank" rel="noopener noreferrer">Google app passwords</a>
           and generate one. Google shows it as four groups of four letters.</li>
       <li>Paste it below. The spaces do not matter.</li>
     </ol>
     <form method="POST" action="/submit">
       <input type="hidden" name="state" value="${state}">
       <label for="email">Gmail address</label>
       <input id="email" name="email" type="email" required autocomplete="username"
              placeholder="you@gmail.com" autofocus>
       <label for="password">App password</label>
       <input id="password" name="password" type="password" required
              autocomplete="off" placeholder="abcd efgh ijkl mnop">
       <button type="submit">Connect</button>
     </form>
     <p class="note">The password goes straight from this page to the program
     running on your machine, and from there only to Gmail. It is never shown to
     the assistant and never appears in your conversation. It is stored in your
     operating system's keychain.<br><br>
     If Google says app passwords are unavailable, the account either has
     2-Step Verification switched off, is using Advanced Protection, or belongs
     to a Workspace domain whose administrator disabled them.</p>`,
  );
}

/**
 * Collect a Gmail app password through a page served on loopback.
 *
 * The point is what it avoids. Asking for an app password in a chat writes a
 * full-access mailbox credential into a conversation transcript that is stored
 * and synced. Asking for it in a terminal means the user needs a terminal. A
 * local form keeps the credential on the machine while still being driven from
 * a chat message: the tool opens the page, the user types into it, and the
 * secret travels browser → 127.0.0.1 → Gmail without ever passing through the
 * model or the transcript.
 */
export async function beginAppPasswordFlow(): Promise<PendingAppPassword> {
  const state = crypto.randomBytes(24).toString("base64url");

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;
  const formUrl = `http://127.0.0.1:${port}/`;

  // Hoisted so cancel() can clear it. unref() matters independently: this timer
  // is a safety net, and without it an abandoned form would keep the process
  // alive for the full timeout with nothing left to do.
  let timer: NodeJS.Timeout | undefined;

  const completed = new Promise<AppPasswordResult>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new UserFacingError("Timed out waiting for the app password."));
    }, TIMEOUT_MS);
    timer.unref();

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", formUrl);

      const html = (status: number, body: string) =>
        res
          .writeHead(status, {
            "content-type": "text/html; charset=utf-8",
            // The page carries a live state token and, on error, echoes back
            // field values. Nothing about it should be cached or referred out.
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "content-security-policy":
              "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
            "x-frame-options": "DENY",
          })
          .end(body);

      if (req.method === "GET" && url.pathname === "/") {
        html(200, formPage(state));
        return;
      }

      if (req.method !== "POST" || url.pathname !== "/submit") {
        res.writeHead(404).end();
        return;
      }

      // Defence in depth against a web page posting here behind the user's
      // back. The state token already blocks this — a cross-origin script
      // cannot read the form to learn it — but rejecting a foreign Origin costs
      // nothing. Only a genuine website is rejected: opaque ("null") origins
      // from embedded browser views, localhost, and a missing header are all
      // legitimate and must be let through.
      if (isForeignOrigin(req.headers.origin)) {
        html(403, shell("<h1>Blocked</h1><p>That request came from another site.</p>"));
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        // A form this small has no business being large; refuse anything odd.
        if (body.length > 8192) req.destroy();
      });

      req.on("end", () => {
        void (async () => {
          const fields = new URLSearchParams(body);
          const submitted = fields.get("state") ?? "";

          const expected = Buffer.from(state);
          const actual = Buffer.from(submitted);
          if (
            actual.length !== expected.length ||
            !crypto.timingSafeEqual(actual, expected)
          ) {
            html(400, shell("<h1>Session mismatch</h1><p>Please start again.</p>"));
            return;
          }

          const email = (fields.get("email") ?? "").trim();
          const appPassword = normaliseAppPassword(fields.get("password") ?? "");

          if (!email.includes("@")) {
            html(400, formPage(state, "That does not look like an email address."));
            return;
          }
          if (appPassword.length < 12) {
            html(
              400,
              formPage(state, "App passwords are 16 characters — that looks too short."),
            );
            return;
          }

          try {
            await verifyAppPassword(email, appPassword);
          } catch (err) {
            html(
              400,
              formPage(
                state,
                `Gmail rejected that: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            );
            return;
          }

          clearTimeout(timer);
          html(
            200,
            shell(
              `<p class="ok">✓</p><h1>${email} is connected</h1>
               <p>You can close this tab and go back to your conversation.</p>`,
            ),
          );
          resolve({ email, appPassword });
        })();
      });
    });
  }).finally(() => server.close());

  return {
    formUrl,
    completed,
    cancel: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}
