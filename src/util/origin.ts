/**
 * CSRF guard for the loopback setup forms.
 *
 * These pages are served on 127.0.0.1 and carry an unguessable per-run state
 * token that is compared in constant time. That pair is the real defence: the
 * socket is unreachable from another machine, and a cross-site script can
 * neither read the form to learn the token nor guess the random port. The
 * Origin header is only belt-and-braces on top of that.
 *
 * So this must reject the one thing the header can meaningfully catch — a real
 * website POSTing here behind the user's back — while allowing every legitimate
 * case. Legitimate submissions do NOT always carry `http://127.0.0.1:<port>`:
 *
 *   - Sandboxed and embedded browser views (the setup page opened inside an app
 *     pane, not a standalone tab) post with `Origin: null`.
 *   - Some clients resolve the host as `localhost` and send that instead.
 *   - Some omit the header entirely.
 *
 * Demanding an exact match rejected all of these and dead-ended real users on a
 * "Blocked" page. A genuine attacker is always a web page, so it always arrives
 * with an http(s) Origin whose host is neither loopback nor localhost — which is
 * precisely, and only, what we reject here.
 */
export function isForeignOrigin(origin: string | undefined): boolean {
  // Missing or opaque ("null") — an embedded/sandboxed view. Allowed; the state
  // token is the real guard.
  if (!origin || origin === "null") return false;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // Not a parseable web origin, so not the cross-site web attacker this guard
    // exists to stop. Allowed.
    return false;
  }

  // Only web pages can mount the cross-site POST this defends against. A non-web
  // scheme (an app or extension host loading the local page) is not that.
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  return (
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "localhost" &&
    url.hostname !== "[::1]" &&
    url.hostname !== "::1"
  );
}
