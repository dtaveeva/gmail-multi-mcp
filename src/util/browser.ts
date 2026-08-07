import { spawn } from "node:child_process";

export interface BrowserCommand {
  cmd: string;
  args: string[];
  /**
   * Pass the args to the OS verbatim instead of letting Node re-quote them.
   * Needed on Windows: we quote the URL ourselves so cmd keeps it intact, and
   * Node's own quoting would double it up.
   */
  verbatim: boolean;
}

/**
 * Build the command that opens a URL in the default browser for a platform.
 *
 * Split out from openBrowser so it can be tested without spawning anything.
 *
 * The Windows case is the whole reason this is careful. `start` is a cmd
 * built-in, so the URL passes through cmd's parser, which treats `&` (and
 * `|`, `^`, `<`, `>`) as command separators. An OAuth URL is full of `&`, so
 * an unquoted URL gets chopped at the first one — the browser receives only
 * `...auth?access_type=offline`, Google sees no `response_type`, and the
 * sign-in dies with "invalid_request". Wrapping the URL in double quotes stops
 * cmd from splitting it; the empty `""` ahead of it is start's window-title
 * argument, required so a quoted URL is not itself taken as the title.
 */
export function browserCommand(url: string, platform: NodeJS.Platform): BrowserCommand {
  if (platform === "win32") {
    return { cmd: "cmd", args: ["/c", "start", '""', `"${url}"`], verbatim: true };
  }
  if (platform === "darwin") {
    return { cmd: "open", args: [url], verbatim: false };
  }
  return { cmd: "xdg-open", args: [url], verbatim: false };
}

/**
 * Open a URL in the user's default browser.
 *
 * Returns false when nothing was launched, so callers can fall back to printing
 * the URL. Honours GMAIL_MCP_NO_BROWSER for headless and SSH sessions, where
 * spawning a browser is either impossible or actively unhelpful.
 */
export function openBrowser(url: string): boolean {
  if (process.env.GMAIL_MCP_NO_BROWSER === "1") return false;
  try {
    const { cmd, args, verbatim } = browserCommand(url, process.platform);
    spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: verbatim,
    }).unref();
    return true;
  } catch {
    return false;
  }
}
