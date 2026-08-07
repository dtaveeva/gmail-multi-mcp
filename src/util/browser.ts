import { spawn } from "node:child_process";

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
    const [cmd, args] =
      process.platform === "win32"
        ? (["cmd", ["/c", "start", "", url]] as const)
        : process.platform === "darwin"
          ? (["open", [url]] as const)
          : (["xdg-open", [url]] as const);
    spawn(cmd, [...args], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}
