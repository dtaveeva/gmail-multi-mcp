import { RateLimitError } from "../errors.js";

export type LimitClass = "send" | "mutation";

const WINDOW_MS = 60 * 60 * 1000;

/**
 * Sliding-window cap per account, per action class.
 *
 * This bounds blast radius rather than preventing misuse: a runaway agent loop
 * or a successful injection can do at most N sends before it is refused, which
 * turns an unbounded incident into a bounded, auditable one.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limits: Record<LimitClass, number>,
  ) {}

  private key(email: string, cls: LimitClass): string {
    return `${cls}:${email.toLowerCase()}`;
  }

  /** Records one use, or throws if the window is already full. */
  consume(email: string, cls: LimitClass): void {
    const limit = this.limits[cls];
    if (limit <= 0) return;

    const now = Date.now();
    const key = this.key(email, cls);
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

    if (recent.length >= limit) {
      const oldest = recent[0] ?? now;
      const waitMin = Math.ceil((WINDOW_MS - (now - oldest)) / 60_000);
      this.hits.set(key, recent);
      throw new RateLimitError(
        `Hourly ${cls} limit reached for ${email} (${limit}/hour).`,
        `Try again in about ${waitMin} minute(s), or raise ` +
          `GMAIL_MCP_MAX_${cls === "send" ? "SENDS" : "MUTATIONS"}_PER_HOUR.`,
      );
    }

    recent.push(now);
    this.hits.set(key, recent);
  }

  remaining(email: string, cls: LimitClass): number {
    const now = Date.now();
    const recent = (this.hits.get(this.key(email, cls)) ?? []).filter(
      (t) => now - t < WINDOW_MS,
    );
    return Math.max(0, this.limits[cls] - recent.length);
  }
}
