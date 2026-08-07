import { UserFacingError } from "../errors.js";
import type { Gmail } from "../gmail/client.js";
import { toGmailRaw, type OutgoingMessage } from "../gmail/mime.js";
import { parseMessage, type ParsedMessage } from "../gmail/parse.js";
import type { Backend, Label, Mailbox, SearchOptions, ThreadRef } from "./types.js";

/** Mailbox backed by the Gmail REST API, authorised by scoped OAuth. */
export class GmailApiMailbox implements Mailbox {
  readonly backend: Backend = "gmail-api";

  constructor(private readonly gmail: Gmail) {}

  async search({ query, maxResults, includeBody }: SearchOptions): Promise<ParsedMessage[]> {
    const list = await this.gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults,
    });
    const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);

    return Promise.all(
      ids.map(async (id) => {
        const res = await this.gmail.users.messages.get({
          userId: "me",
          id,
          format: includeBody ? "full" : "metadata",
          ...(includeBody ? {} : { metadataHeaders: ["From", "To", "Subject", "Date"] }),
        });
        return parseMessage(res.data);
      }),
    );
  }

  async getMessage(id: string): Promise<ParsedMessage> {
    const res = await this.gmail.users.messages.get({ userId: "me", id, format: "full" });
    return parseMessage(res.data);
  }

  async getThread(threadId: string): Promise<ParsedMessage[]> {
    const res = await this.gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });
    return (res.data.messages ?? []).map(parseMessage);
  }

  async listLabels(): Promise<Label[]> {
    const res = await this.gmail.users.labels.list({ userId: "me" });
    return (res.data.labels ?? []).map((l) => ({
      id: l.id ?? "",
      name: l.name ?? "",
      system: l.type === "system",
    }));
  }

  async threadingFor(messageId: string): Promise<ThreadRef> {
    const res = await this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["Message-ID", "References"],
    });
    const parsed = parseMessage(res.data);
    const original = parsed.headers["message-id"];
    if (!original) {
      throw new UserFacingError(
        `Message ${messageId} has no Message-ID; cannot thread a reply.`,
      );
    }
    const priorRefs = parsed.headers["references"];
    return {
      messageId: original,
      references: priorRefs ? `${priorRefs} ${original}` : original,
      threadId: parsed.threadId,
    };
  }

  async createDraft(message: OutgoingMessage, thread?: ThreadRef): Promise<string> {
    const res = await this.gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw: toGmailRaw(message),
          ...(thread?.threadId ? { threadId: thread.threadId } : {}),
        },
      },
    });
    return res.data.id ?? "";
  }

  async getDraft(draftId: string): Promise<ParsedMessage> {
    const res = await this.gmail.users.drafts.get({
      userId: "me",
      id: draftId,
      format: "full",
    });
    if (!res.data.message) {
      throw new UserFacingError(`Draft ${draftId} has no message content.`);
    }
    return parseMessage(res.data.message);
  }

  async send(message: OutgoingMessage, thread?: ThreadRef): Promise<string> {
    const res = await this.gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: toGmailRaw(message),
        ...(thread?.threadId ? { threadId: thread.threadId } : {}),
      },
    });
    return res.data.id ?? "";
  }

  async sendDraft(draftId: string): Promise<string> {
    const res = await this.gmail.users.drafts.send({
      userId: "me",
      requestBody: { id: draftId },
    });
    return res.data.id ?? "";
  }

  async modifyLabels(ids: string[], add: string[], remove: string[]): Promise<void> {
    await this.gmail.users.messages.batchModify({
      userId: "me",
      requestBody: {
        ids,
        ...(add.length ? { addLabelIds: add } : {}),
        ...(remove.length ? { removeLabelIds: remove } : {}),
      },
    });
  }

  async trash(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.gmail.users.messages.trash({ userId: "me", id });
    }
  }

  async dispose(): Promise<void> {
    /* stateless HTTP client */
  }
}
