import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { UserFacingError } from "../errors.js";

const TIMEOUT_MS = 30 * 60 * 1000;

export interface CloudSetupResult {
  clientId: string;
  clientSecret: string;
}

export interface PendingCloudSetup {
  setupUrl: string;
  completed: Promise<CloudSetupResult>;
  cancel(): void;
}

const CONSOLE = {
  createProject: "https://console.cloud.google.com/projectcreate",
  enableGmail: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  consent: "https://console.cloud.google.com/auth/overview",
  credentials: "https://console.cloud.google.com/auth/clients",
};

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6;
         max-width: 40rem; margin: 6vh auto 12vh; padding: 0 1.5rem; }
  h1 { font-size: 1.45rem; margin-bottom: .2rem; }
  .sub { opacity: .72; margin-top: 0; }
  .step { border: 1px solid rgba(128,128,128,.35); border-radius: 10px;
          padding: 1rem 1.2rem; margin: 1rem 0; }
  .step h2 { font-size: 1rem; margin: 0 0 .4rem; display: flex; gap: .55rem;
             align-items: center; }
  .n { display: inline-flex; align-items: center; justify-content: center;
       width: 1.6rem; height: 1.6rem; border-radius: 50%; background: #1a73e8;
       color: #fff; font-size: .85rem; flex: 0 0 auto; }
  .step p { margin: .4rem 0; }
  a.btn { display: inline-block; margin-top: .5rem; padding: .5rem 1rem;
          background: #1a73e8; color: #fff; text-decoration: none;
          border-radius: 6px; font-size: .95rem; }
  a.btn:hover { background: #1666cc; }
  .warn { background: rgba(230,160,20,.14); border-left: 3px solid #e6a014;
          padding: .7rem .9rem; border-radius: 4px; margin: .7rem 0; }
  .err { background: rgba(220,50,50,.12); border-left: 3px solid #d33;
         padding: .7rem .9rem; border-radius: 4px; margin: 1rem 0; }
  label { display: block; margin: 1rem 0 .3rem; font-weight: 600; }
  input { width: 100%; padding: .6rem .7rem; font-size: .95rem; border-radius: 6px;
          border: 1px solid rgba(128,128,128,.5); background: transparent;
          color: inherit; font-family: ui-monospace, monospace; }
  button { margin-top: 1.3rem; padding: .65rem 1.4rem; font-size: 1rem;
           border-radius: 6px; border: 0; background: #1a73e8; color: #fff;
           cursor: pointer; }
  button:hover { background: #1666cc; }
  code { background: rgba(128,128,128,.18); padding: .1rem .35rem; border-radius: 4px; }
  .note { font-size: .9rem; opacity: .75; margin-top: 2rem;
          border-top: 1px solid rgba(128,128,128,.3); padding-top: 1rem; }
  .ok { font-size: 2.4rem; margin: 0; }
`;

function shell(body: string): string {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Set up Gmail access</title><style>${STYLE}</style><body>${body}</body>`;
}

function step(n: number, title: string, inner: string): string {
  return `<div class="step"><h2><span class="n">${n}</span>${title}</h2>${inner}</div>`;
}

function setupPage(state: string, error?: string): string {
  return shell(
    `<h1>Set up Gmail access</h1>
     <p class="sub">A one-time setup, about two minutes. Everything happens in
     your own Google account — this program never sees your Google password, and
     your mail is only ever reachable through a project you own.</p>

     ${error ? `<div class="err">${error}</div>` : ""}

     ${step(
       1,
       "Create a Google project",
       `<p>Give it any name — <code>gmail-mcp</code> is fine — then click
        <strong>Create</strong> and wait for it to finish.</p>
        <a class="btn" href="${CONSOLE.createProject}" target="_blank" rel="noopener noreferrer">Open step 1 &rarr;</a>`,
     )}

     ${step(
       2,
       "Turn on the Gmail API",
       `<p>Check your new project is selected in the bar at the top, then click
        <strong>Enable</strong>.</p>
        <a class="btn" href="${CONSOLE.enableGmail}" target="_blank" rel="noopener noreferrer">Open step 2 &rarr;</a>`,
     )}

     ${step(
       3,
       "Say who may use it",
       `<p>Fill in an app name and your email, then save.</p>
        <p><strong>If you use Google Workspace</strong> and every mailbox you want
        is on your own domain, choose <strong>Internal</strong> and you are done
        with this step.</p>
        <p><strong>Otherwise</strong> choose <strong>External</strong>, save, then
        find and click <strong>Publish app</strong>.</p>
        <div class="warn"><strong>Do not skip publishing.</strong> Left as
        "Testing", Google expires your sign-in after 7 days and everything stops
        working about a week from now.</div>
        <a class="btn" href="${CONSOLE.consent}" target="_blank" rel="noopener noreferrer">Open step 3 &rarr;</a>`,
     )}

     ${step(
       4,
       "Create the credentials",
       `<p>Click <strong>Create client</strong>. For application type choose
        <strong>Desktop app</strong> — this one matters, it is the only type
        allowed to hand the sign-in back to your own machine. Then click
        <strong>Create</strong>.</p>
        <a class="btn" href="${CONSOLE.credentials}" target="_blank" rel="noopener noreferrer">Open step 4 &rarr;</a>`,
     )}

     ${step(
       5,
       "Paste what Google gives you",
       `<p>Google shows a <strong>Client ID</strong> and a <strong>Client
        secret</strong>. Copy them here.</p>
        <form method="POST" action="/submit">
          <input type="hidden" name="state" value="${state}">
          <label for="cid">Client ID</label>
          <input id="cid" name="client_id" required autocomplete="off"
                 placeholder="1234567890-abc123.apps.googleusercontent.com">
          <label for="csec">Client secret</label>
          <input id="csec" name="client_secret" required autocomplete="off"
                 placeholder="GOCSPX-...">
          <button type="submit">Finish setup</button>
        </form>`,
     )}

     <p class="note">These two values identify your project — they are not a
     password and grant access to nothing on their own. Google treats a Desktop
     app client as a public client for exactly this reason. Signing in to a
     mailbox is a separate step that happens on Google's own page.</p>`,
  );
}

/**
 * Walk a user through creating their own Google Cloud OAuth client.
 *
 * Every user needs their own, because Gmail's restricted scopes mean a shared
 * client would require an annual paid security assessment. That requirement is
 * not removable — but the experience of satisfying it is, and a wall of console
 * links in a chat window is where a non-technical user gives up. This puts the
 * steps in the browser, next to the console tabs they are already opening, and
 * ends with the form that captures the result.
 */
export async function beginCloudSetupFlow(): Promise<PendingCloudSetup> {
  const state = crypto.randomBytes(24).toString("base64url");

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;
  const setupUrl = `http://127.0.0.1:${port}/`;

  let timer: NodeJS.Timeout | undefined;

  const completed = new Promise<CloudSetupResult>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new UserFacingError("Timed out waiting for the Google Cloud setup."));
    }, TIMEOUT_MS);
    timer.unref();

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", setupUrl);

      const html = (status: number, body: string) =>
        res
          .writeHead(status, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "content-security-policy":
              "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
            "x-frame-options": "DENY",
          })
          .end(body);

      if (req.method === "GET" && url.pathname === "/") {
        html(200, setupPage(state));
        return;
      }

      if (req.method !== "POST" || url.pathname !== "/submit") {
        res.writeHead(404).end();
        return;
      }

      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}`) {
        html(403, shell("<h1>Blocked</h1><p>That request came from another site.</p>"));
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 8192) req.destroy();
      });

      req.on("end", () => {
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

        const clientId = (fields.get("client_id") ?? "").trim();
        const clientSecret = (fields.get("client_secret") ?? "").trim();

        if (!clientId.endsWith(".apps.googleusercontent.com")) {
          html(
            400,
            setupPage(
              state,
              "That client ID does not look right — it should end with " +
                "<code>.apps.googleusercontent.com</code>. Copy it from the " +
                "Credentials page in step 4.",
            ),
          );
          return;
        }
        if (!clientSecret) {
          html(400, setupPage(state, "The client secret was empty."));
          return;
        }

        clearTimeout(timer);
        html(
          200,
          shell(
            `<p class="ok">✓</p><h1>Setup complete</h1>
             <p>You only ever have to do that once.</p>
             <p>Go back to your conversation — you can now connect as many
             mailboxes as you like, and each one is just a Google sign-in.</p>`,
          ),
        );
        resolve({ clientId, clientSecret });
      });
    });
  }).finally(() => server.close());

  return {
    setupUrl,
    completed,
    cancel: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}
