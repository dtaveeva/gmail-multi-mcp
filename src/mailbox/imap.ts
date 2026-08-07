import { ImapFlow, type FetchMessageObject, type MailboxLockObject } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import { UserFacingError } from "../errors.js";
import { buildRawMessage, type OutgoingMessage } from "../gmail/mime.js";
import { htmlToText, type ParsedMessage } from "../gmail/parse.js";
import type { Backend, Label, Mailbox, SearchOptions, ThreadRef } from "./types.js";

export interface ImapCredentials {
  email: string;
  appPassword: string;
}

const IMAP_HOST = "imap.gmail.com";
const SMTP_HOST = "smtp.gmail.com";

/**
 * Gmail API label ids that people (and this server's own docs) use, mapped to
 * the label names Gmail exposes over IMAP. Keeps `remove INBOX to archive`
 * working identically on both backends.
 */
const SYSTEM_LABELS: Record<string, string> = {
  INBOX: "\\Inbox",
  SENT: "\\Sent",
  DRAFT: "\\Draft",
  DRAFTS: "\\Draft",
  SPAM: "\\Junk",
  TRASH: "\\Trash",
  STARRED: "\\Starred",
  IMPORTANT: "\\Important",
};

/** X-GM-MSGID arrives as decimal over IMAP; the REST API uses hex for the same value. */
export function toHexId(emailId: string | undefined): string {
  if (!emailId) return "";
  const cleaned = emailId.trim();
  if (/^[0-9]+$/.test(cleaned)) {
    try {
      return BigInt(cleaned).toString(16);
    } catch {
      return cleaned;
    }
  }
  return cleaned.toLowerCase();
}

export function fromHexId(id: string): string {
  const cleaned = id.trim().toLowerCase();
  if (/^[0-9a-f]+$/.test(cleaned)) {
    try {
      return BigInt(`0x${cleaned}`).toString(10);
    } catch {
      return cleaned;
    }
  }
  return cleaned;
}

function headerMap(parsed: ParsedMail): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of parsed.headers) {
    if (typeof value === "string") headers[key.toLowerCase()] = value;
    else if (value && typeof value === "object" && "text" in value) {
      headers[key.toLowerCase()] = String((value as { text: unknown }).text);
    }
  }
  if (parsed.messageId) headers["message-id"] = parsed.messageId;
  return headers;
}

async function toParsedMessage(msg: FetchMessageObject): Promise<ParsedMessage> {
  const source = msg.source ?? Buffer.alloc(0);
  const parsed = await simpleParser(source);

  const body = (parsed.text ?? "").trim() || htmlToText(parsed.html || "");
  const labels = [...(msg.labels ?? [])];

  return {
    id: toHexId(msg.emailId),
    threadId: toHexId(msg.threadId),
    labelIds: labels,
    snippet: body.slice(0, 200).replace(/\s+/g, " ").trim(),
    headers: headerMap(parsed),
    from: parsed.from?.text ?? "",
    to: Array.isArray(parsed.to) ? parsed.to.map((a) => a.text).join(", ") : (parsed.to?.text ?? ""),
    cc: Array.isArray(parsed.cc) ? parsed.cc.map((a) => a.text).join(", ") : (parsed.cc?.text ?? ""),
    subject: parsed.subject || "(no subject)",
    date: parsed.date?.toUTCString() ?? "",
    body,
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename ?? "(unnamed)",
      mimeType: a.contentType ?? "application/octet-stream",
      sizeBytes: a.size ?? 0,
    })),
  };
}

/**
 * Mailbox reached over IMAP and SMTP with a Gmail app password.
 *
 * Setup is far simpler than OAuth — no Cloud project — but an app password is
 * an all-or-nothing credential: it cannot be scoped, so the `readonly` tier
 * becomes a check in this server's code rather than one Google enforces. That
 * difference is surfaced to the user at connect time and in gmail_list_accounts.
 */
export class ImapMailbox implements Mailbox {
  readonly backend: Backend = "imap";

  private client: ImapFlow | undefined;
  private folders: { all: string; drafts: string; trash: string } | undefined;

  constructor(private readonly creds: ImapCredentials) {}

  /* ----------------------------- connection ----------------------------- */

  private async connect(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;

    const client = new ImapFlow({
      host: IMAP_HOST,
      port: 993,
      secure: true,
      auth: { user: this.creds.email, pass: this.creds.appPassword },
      logger: false,
    });

    try {
      await client.connect();
    } catch (err) {
      throw explainImapError(err, this.creds.email);
    }

    this.client = client;
    return client;
  }

  /**
   * Resolve Gmail's special folders by their SPECIAL-USE flags rather than by
   * name. Folder names are localised — a Thai or French account has no folder
   * literally called "[Gmail]/All Mail" — so matching on names breaks for
   * anyone outside an English locale.
   */
  private async specialFolders(): Promise<{ all: string; drafts: string; trash: string }> {
    if (this.folders) return this.folders;

    const client = await this.connect();
    const list = await client.list();

    const bySpecialUse = (use: string): string | undefined =>
      list.find((m) => m.specialUse === use)?.path;

    this.folders = {
      all: bySpecialUse("\\All") ?? "[Gmail]/All Mail",
      drafts: bySpecialUse("\\Drafts") ?? "[Gmail]/Drafts",
      trash: bySpecialUse("\\Trash") ?? "[Gmail]/Trash",
    };
    return this.folders;
  }

  private async withFolder<T>(
    folder: string,
    fn: (client: ImapFlow) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    const client = await this.connect();
    let lock: MailboxLockObject | undefined;
    try {
      lock = await client.getMailboxLock(folder, { readOnly });
      return await fn(client);
    } catch (err) {
      throw explainImapError(err, this.creds.email);
    } finally {
      lock?.release();
    }
  }

  /* -------------------------------- read -------------------------------- */

  async search({ query, maxResults, includeBody }: SearchOptions): Promise<ParsedMessage[]> {
    const { all } = await this.specialFolders();

    return this.withFolder(
      all,
      async (client) => {
        // X-GM-RAW passes the query to Gmail's own search engine, so the exact
        // same syntax works here as on the REST backend.
        const uids = await client.search({ gmraw: query }, { uid: true });
        if (!uids || !uids.length) return [];

        const newest = uids.slice(-maxResults).reverse();
        const messages: ParsedMessage[] = [];

        for await (const msg of client.fetch(
          newest,
          { source: true, labels: true, threadId: true, uid: true },
          { uid: true },
        )) {
          const parsed = await toParsedMessage(msg);
          if (!includeBody) parsed.body = "";
          messages.push(parsed);
        }

        // fetch() yields in server order; restore newest-first.
        return messages.reverse();
      },
      true,
    );
  }

  async getMessage(id: string): Promise<ParsedMessage> {
    const { all } = await this.specialFolders();

    return this.withFolder(
      all,
      async (client) => {
        const msg = await client.fetchOne(
          { emailId: fromHexId(id) } as never,
          { source: true, labels: true, threadId: true, uid: true },
        );
        if (!msg) throw new UserFacingError(`No message with id ${id} in ${this.creds.email}.`);
        return toParsedMessage(msg);
      },
      true,
    );
  }

  async getThread(threadId: string): Promise<ParsedMessage[]> {
    const { all } = await this.specialFolders();

    return this.withFolder(
      all,
      async (client) => {
        const uids = await client.search({ threadId: fromHexId(threadId) }, { uid: true });
        if (!uids || !uids.length) {
          throw new UserFacingError(`No thread with id ${threadId} in ${this.creds.email}.`);
        }

        const messages: ParsedMessage[] = [];
        for await (const msg of client.fetch(
          uids,
          { source: true, labels: true, threadId: true, uid: true },
          { uid: true },
        )) {
          messages.push(await toParsedMessage(msg));
        }
        return messages;
      },
      true,
    );
  }

  async listLabels(): Promise<Label[]> {
    const client = await this.connect();
    const list = await client.list();

    return list
      .filter((m) => !m.path.match(/^\[Gmail\]$/))
      .map((m) => ({
        id: m.specialUse ?? m.path,
        name: m.path,
        system: !!m.specialUse,
      }));
  }

  async threadingFor(messageId: string): Promise<ThreadRef> {
    const msg = await this.getMessage(messageId);
    const original = msg.headers["message-id"];
    if (!original) {
      throw new UserFacingError(`Message ${messageId} has no Message-ID; cannot thread a reply.`);
    }
    const priorRefs = msg.headers["references"];
    return {
      messageId: original,
      references: priorRefs ? `${priorRefs} ${original}` : original,
      threadId: msg.threadId,
    };
  }

  /* -------------------------------- write ------------------------------- */

  async createDraft(message: OutgoingMessage, thread?: ThreadRef): Promise<string> {
    const { drafts } = await this.specialFolders();
    const raw = buildRawMessage(thread ? { ...message, ...threadHeaders(thread) } : message);

    const client = await this.connect();
    const res = await client.append(drafts, raw, ["\\Draft"]);
    if (!res || !res.uid) {
      throw new UserFacingError("Gmail accepted the draft but returned no identifier.");
    }
    // Over IMAP a draft is identified by its UID in the Drafts folder.
    return String(res.uid);
  }

  async getDraft(draftId: string): Promise<ParsedMessage> {
    const { drafts } = await this.specialFolders();

    return this.withFolder(
      drafts,
      async (client) => {
        const msg = await client.fetchOne(
          draftId,
          { source: true, labels: true, threadId: true, uid: true },
          { uid: true },
        );
        if (!msg) throw new UserFacingError(`No draft with id ${draftId} in ${this.creds.email}.`);
        return toParsedMessage(msg);
      },
      true,
    );
  }

  async send(message: OutgoingMessage, thread?: ThreadRef): Promise<string> {
    const full = thread ? { ...message, ...threadHeaders(thread) } : message;
    const raw = buildRawMessage(full);

    const transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: 465,
      secure: true,
      auth: { user: this.creds.email, pass: this.creds.appPassword },
    });

    try {
      // Envelope is passed explicitly so Bcc recipients are delivered without
      // appearing in the transmitted headers.
      const info = await transport.sendMail({
        raw,
        envelope: {
          from: full.from,
          to: [...full.to, ...(full.cc ?? []), ...(full.bcc ?? [])],
        },
      });
      return info.messageId ?? "sent";
    } catch (err) {
      throw explainSmtpError(err, this.creds.email);
    } finally {
      transport.close();
    }
  }

  async sendDraft(draftId: string): Promise<string> {
    const draft = await this.getDraft(draftId);
    const { drafts } = await this.specialFolders();

    const sent = await this.send({
      from: this.creds.email,
      to: draft.to.split(",").map((s) => s.trim()).filter(Boolean),
      ...(draft.cc ? { cc: draft.cc.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
      subject: draft.subject,
      body: draft.body,
    });

    // Gmail keeps the draft after SMTP send, so remove it to match REST behaviour.
    await this.withFolder(drafts, async (client) => {
      await client.messageDelete(draftId, { uid: true });
    });

    return sent;
  }

  async modifyLabels(ids: string[], add: string[], remove: string[]): Promise<void> {
    const { all } = await this.specialFolders();
    const uids = await this.uidsForIds(ids);
    if (!uids.length) return;

    await this.withFolder(all, async (client) => {
      // UNREAD is a flag in IMAP, not a label, and inverted: adding UNREAD
      // means clearing \Seen.
      if (add.includes("UNREAD")) await client.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
      if (remove.includes("UNREAD")) await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });

      const addLabels = mapLabels(add);
      const removeLabels = mapLabels(remove);

      if (addLabels.length) {
        await client.messageFlagsAdd(uids, addLabels, { uid: true, useLabels: true });
      }
      if (removeLabels.length) {
        await client.messageFlagsRemove(uids, removeLabels, { uid: true, useLabels: true });
      }
    });
  }

  async trash(ids: string[]): Promise<void> {
    const { all, trash } = await this.specialFolders();
    const uids = await this.uidsForIds(ids);
    if (!uids.length) return;

    await this.withFolder(all, async (client) => {
      await client.messageMove(uids, trash, { uid: true });
    });
  }

  /** Translate Gmail message ids into UIDs within All Mail. */
  private async uidsForIds(ids: string[]): Promise<number[]> {
    const { all } = await this.specialFolders();

    return this.withFolder(
      all,
      async (client) => {
        const uids: number[] = [];
        for (const id of ids) {
          const found = await client.search({ emailId: fromHexId(id) } as never, { uid: true });
          if (found && found.length) uids.push(...found);
        }
        return uids;
      },
      true,
    );
  }

  async dispose(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    try {
      await client.logout();
    } catch {
      /* connection already gone */
    }
  }
}

function threadHeaders(thread: ThreadRef): { inReplyTo: string; references: string } {
  return { inReplyTo: thread.messageId, references: thread.references };
}

export function mapLabels(ids: string[]): string[] {
  return ids
    .filter((id) => id !== "UNREAD")
    .map((id) => SYSTEM_LABELS[id.toUpperCase()] ?? id);
}

/**
 * Gmail shows app passwords as four space-separated groups. People paste them
 * exactly as shown, and Gmail rejects the spaces — so normalise before use
 * rather than blaming the user for a working password.
 */
export function normaliseAppPassword(raw: string): string {
  return raw.replace(/\s+/g, "");
}

/** Prove an app password works before storing it, so failures surface now. */
export async function verifyAppPassword(
  email: string,
  appPassword: string,
): Promise<{ folders: number }> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: email, pass: appPassword },
    logger: false,
  });

  try {
    await client.connect();
    const list = await client.list();
    return { folders: list.length };
  } catch (err) {
    throw explainImapError(err, email);
  } finally {
    await client.logout().catch(() => {});
  }
}

export function explainImapError(err: unknown, email: string): UserFacingError {
  const message = err instanceof Error ? err.message : String(err);

  if (/AUTHENTICATIONFAILED|Invalid credentials|Username and password/i.test(message)) {
    return new UserFacingError(
      `Gmail rejected the app password for ${email}.`,
      "Check that 2-Step Verification is on, that the app password was copied " +
        "without spaces, and that IMAP is enabled in Gmail → Settings → " +
        "Forwarding and POP/IMAP. Regenerate one at " +
        "https://myaccount.google.com/apppasswords and reconnect with " +
        "`gmail-multi-mcp auth add-password`.",
    );
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET/i.test(message)) {
    return new UserFacingError(
      `Could not reach Gmail's IMAP server for ${email}.`,
      "Check your network. Some corporate networks block port 993.",
    );
  }
  return new UserFacingError(`IMAP error for ${email}: ${message}`);
}

export function explainSmtpError(err: unknown, email: string): UserFacingError {
  const message = err instanceof Error ? err.message : String(err);

  if (/535|Username and Password not accepted|BadCredentials/i.test(message)) {
    return new UserFacingError(
      `Gmail rejected the app password when sending from ${email}.`,
      "Regenerate the app password at https://myaccount.google.com/apppasswords " +
        "and reconnect the account.",
    );
  }
  if (/550|551|552|553|554/.test(message)) {
    return new UserFacingError(
      `Gmail refused the message from ${email}: ${message}`,
      "This is usually a rejected recipient address or a sending limit.",
    );
  }
  return new UserFacingError(`SMTP error for ${email}: ${message}`);
}
