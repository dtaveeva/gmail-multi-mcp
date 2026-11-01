import type { OutgoingMessage } from "../gmail/mime.js";
import type { Attachment, ParsedMessage } from "../gmail/parse.js";

export type { Attachment, OutgoingMessage, ParsedMessage };

export type Backend = "gmail-api" | "imap";

export interface Label {
  id: string;
  name: string;
  system: boolean;
}

/** Headers needed to make a reply thread correctly in a mail client. */
export interface ThreadRef {
  messageId: string;
  references: string;
  threadId: string;
}

export interface SearchOptions {
  query: string;
  maxResults: number;
  includeBody: boolean;
}

/**
 * One mailbox, however it is reached.
 *
 * Two backends implement this: the Gmail REST API behind OAuth, and IMAP/SMTP
 * behind an app password. The tool layer talks only to this interface, so the
 * safeguards — tiers, confirmation, allowlists, rate limits, audit — apply
 * identically no matter how the user chose to connect.
 *
 * Message ids are Gmail's own ids in both backends: the REST API returns them
 * as hex, and IMAP exposes the same value as decimal via X-GM-MSGID, which the
 * IMAP implementation normalises to hex. An id from a search is therefore
 * usable regardless of which backend produced it.
 */
/** A draft as listed: enough to pick one, not the whole body. */
export interface DraftSummary {
  /** Identifier the draft tools take (Gmail draft id, or Drafts-folder UID over IMAP). */
  draftId: string;
  messageId: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface Mailbox {
  readonly backend: Backend;

  search(options: SearchOptions): Promise<ParsedMessage[]>;
  getMessage(id: string): Promise<ParsedMessage>;
  getThread(threadId: string): Promise<ParsedMessage[]>;
  listLabels(): Promise<Label[]>;

  /** Resolve In-Reply-To / References / thread for a reply to `messageId`. */
  threadingFor(messageId: string): Promise<ThreadRef>;

  createDraft(message: OutgoingMessage, thread?: ThreadRef): Promise<string>;
  getDraft(draftId: string): Promise<ParsedMessage>;
  send(message: OutgoingMessage, thread?: ThreadRef): Promise<string>;
  sendDraft(draftId: string): Promise<string>;
  listDrafts(maxResults: number, query?: string): Promise<DraftSummary[]>;
  /** Permanently delete a draft. Gmail drafts do not go to Trash. */
  deleteDraft(draftId: string): Promise<void>;

  modifyLabels(ids: string[], add: string[], remove: string[]): Promise<void>;
  trash(ids: string[]): Promise<void>;

  /** Release any held connection. Safe to call more than once. */
  dispose(): Promise<void>;
}
