import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Drafts this server created, per account.
 *
 * gmail_delete_draft only accepts drafts recorded here. Deleting a draft is
 * permanent (Gmail drafts skip Trash), so the tool is limited to undoing this
 * server's own work: a prompt-injected call cannot wipe drafts the user wrote
 * in Gmail.
 *
 * Each entry pins both the draft id and the Gmail message id behind it. Draft
 * ids alone are not enough: over IMAP a draft id is a Drafts-folder UID, and
 * UIDs can be reassigned to a different message after a UIDVALIDITY change.
 * The Gmail message id (X-GM-MSGID / REST message id) is never reused, and on
 * the REST backend it changes whenever the draft is edited — so a match means
 * "the exact draft this server wrote, unchanged".
 *
 * The list lives next to the audit log, mode 0600. Writers take a lock file so
 * concurrent servers or calls cannot lose each other's entries.
 */
interface Entry {
  account: string;
  draftId: string;
  messageId: string;
  createdAt: string;
}

const FILE = "created-drafts.json";
const MAX_ENTRIES = 1000;
const LOCK_WAIT_MS = 5_000;

const fileIn = (home: string) => path.join(home, FILE);
const key = (account: string) => account.trim().toLowerCase();

async function load(home: string, repair = false): Promise<Entry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(fileIn(home), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Empty is the safe direction: it can only make deletion refuse, never
    // allow it. Writers (holding the lock) set the damaged file aside first
    // so it is kept for inspection rather than overwritten.
    if (repair) {
      await fs.rename(fileIn(home), `${fileIn(home)}.corrupt-${Date.now()}`).catch(() => {});
    }
    return [];
  }
  return Array.isArray(parsed)
    ? parsed.filter(
        (e): e is Entry =>
          typeof e === "object" && e !== null &&
          typeof (e as Entry).account === "string" &&
          typeof (e as Entry).draftId === "string" &&
          typeof (e as Entry).messageId === "string",
      )
    : [];
}

async function save(home: string, entries: Entry[]): Promise<void> {
  const target = fileIn(home);
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
}

/**
 * Serialise read-modify-write across calls and processes with an O_EXCL lock
 * file holding a per-call token. Only the holder removes it. A lock is never
 * taken over automatically: two waiters can't both safely decide it is stale,
 * and the cost of waiting out a crashed holder is only that a draft can't be
 * registered (so can't be deleted by this tool) — the safe direction.
 */
async function withLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const lock = `${fileIn(home)}.lock`;
  const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const h = await fs.open(lock, "wx", 0o600);
      await h.writeFile(token);
      await h.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        throw new Error(
          `created-drafts registry is locked (${lock}). If no gmail-multi-mcp is running, delete that file.`,
        );
      }
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
    }
  }
  try {
    return await fn();
  } finally {
    const held = await fs.readFile(lock, "utf8").catch(() => "");
    if (held === token) await fs.rm(lock, { force: true });
  }
}

export async function recordCreatedDraft(
  home: string,
  account: string,
  draftId: string,
  messageId: string,
): Promise<void> {
  if (!draftId || !messageId) return;
  await withLock(home, async () => {
    const entries = await load(home, true);
    entries.push({ account: key(account), draftId, messageId, createdAt: new Date().toISOString() });
    await save(home, entries);
  });
}

/** True only if this exact draft (id and current message id) was created here. */
export async function isCreatedDraft(
  home: string,
  account: string,
  draftId: string,
  messageId: string,
): Promise<boolean> {
  const entries = await load(home);
  return entries.some(
    (e) => e.account === key(account) && e.draftId === draftId && e.messageId === messageId,
  );
}

export async function forgetCreatedDraft(home: string, account: string, draftId: string): Promise<void> {
  await withLock(home, async () => {
    const entries = await load(home, true);
    await save(
      home,
      entries.filter((e) => !(e.account === key(account) && e.draftId === draftId)),
    );
  });
}
