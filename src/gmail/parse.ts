import type { gmail_v1 } from "@googleapis/gmail";

export interface Attachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  attachmentId?: string;
}

export interface ParsedMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  headers: Record<string, string>;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  body: string;
  attachments: Attachment[];
}

function decode(data: string | null | undefined): string {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf8");
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** Good-enough HTML flattening for messages that ship no text/plain part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface Collected {
  plain: string[];
  html: string[];
  attachments: Attachment[];
}

function walk(part: gmail_v1.Schema$MessagePart | undefined, acc: Collected): void {
  if (!part) return;

  const mime = part.mimeType ?? "";
  const filename = part.filename ?? "";

  if (filename) {
    acc.attachments.push({
      filename,
      mimeType: mime || "application/octet-stream",
      sizeBytes: part.body?.size ?? 0,
      ...(part.body?.attachmentId ? { attachmentId: part.body.attachmentId } : {}),
    });
  } else if (mime === "text/plain") {
    acc.plain.push(decode(part.body?.data));
  } else if (mime === "text/html") {
    acc.html.push(decode(part.body?.data));
  }

  for (const child of part.parts ?? []) walk(child, acc);
}

export function parseMessage(msg: gmail_v1.Schema$Message): ParsedMessage {
  const acc: Collected = { plain: [], html: [], attachments: [] };
  walk(msg.payload ?? undefined, acc);

  const headers: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) {
    if (h.name && h.value) headers[h.name.toLowerCase()] = h.value;
  }

  const plain = acc.plain.join("\n").trim();
  const body = plain || htmlToText(acc.html.join("\n"));

  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    labelIds: msg.labelIds ?? [],
    snippet: msg.snippet ?? "",
    headers,
    from: headers.from ?? "",
    to: headers.to ?? "",
    cc: headers.cc ?? "",
    subject: headers.subject ?? "(no subject)",
    date: headers.date ?? "",
    body,
    attachments: acc.attachments,
  };
}
