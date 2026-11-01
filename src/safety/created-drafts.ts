import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Drafts this server created, per account.
 *
 * gmail_delete_draft only accepts ids recorded here. Deleting a draft is
 * permanent (Gmail drafts skip Trash), so the tool is limited to undoing this
 * server's own work: a prompt-injected call cannot wipe drafts the user wrote
 * in Gmail. The list lives next to the audit log, mode 0600.
 */
interface Entry {
  account: string;
  draftId: string;
  createdAt: string;
}

const FILE = "created-drafts.json";
const MAX_ENTRIES = 1000;

function fileIn(home: string): string {
  return path.join(home, FILE);
}

async function load(home: string): Promise<Entry[]> {
  try {
    const raw = JSON.parse(await fs.readFile(fileIn(home), "utf8")) as unknown;
    return Array.isArray(raw)
      ? raw.filter(
          (e): e is Entry =>
            typeof e === "object" && e !== null &&
            typeof (e as Entry).account === "string" &&
            typeof (e as Entry).draftId === "string",
        )
      : [];
  } catch {
    return [];
  }
}

async function save(home: string, entries: Entry[]): Promise<void> {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const target = fileIn(home);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
}

const key = (account: string) => account.trim().toLowerCase();

export async function recordCreatedDraft(home: string, account: string, draftId: string): Promise<void> {
  if (!draftId) return;
  const entries = await load(home);
  entries.push({ account: key(account), draftId, createdAt: new Date().toISOString() });
  await save(home, entries);
}

export async function isCreatedDraft(home: string, account: string, draftId: string): Promise<boolean> {
  const entries = await load(home);
  return entries.some((e) => e.account === key(account) && e.draftId === draftId);
}

export async function forgetCreatedDraft(home: string, account: string, draftId: string): Promise<void> {
  const entries = await load(home);
  await save(
    home,
    entries.filter((e) => !(e.account === key(account) && e.draftId === draftId)),
  );
}
