import { randomBytes } from "node:crypto";
import { UserFacingError } from "../errors.js";

/** A file attached to an outgoing message, already read and checked. */
export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
  /** Resolved local path the bytes were read from (for previews and audit). */
  sourcePath?: string;
  sha256?: string;
}

export interface OutgoingMessage {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** RFC 822 Message-ID of the message being replied to, angle brackets included. */
  inReplyTo?: string;
  references?: string;
  attachments?: OutgoingAttachment[];
}

/**
 * Strip anything that could terminate a header line.
 *
 * Without this, a recipient value of "ok@x.com\r\nBcc: attacker@evil.com" would
 * smuggle an extra header into the outgoing message — a header-injection
 * exfiltration path that bypasses the recipient allowlist entirely, because the
 * allowlist never sees the injected address.
 */
function headerValue(raw: string, field: string): string {
  if (/[\r\n]/.test(raw)) {
    throw new UserFacingError(
      `The ${field} value contains a line break, which is not allowed.`,
      "Line breaks in headers can be used to smuggle extra recipients. " +
        "Remove the newline and try again.",
    );
  }
  return raw.trim();
}

/** RFC 2047 encoded-word, so non-ASCII subjects survive transit intact. */
function encodeHeaderText(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function buildRawMessage(msg: OutgoingMessage): string {
  const to = msg.to.map((a) => headerValue(a, "to"));
  const cc = (msg.cc ?? []).map((a) => headerValue(a, "cc"));
  const bcc = (msg.bcc ?? []).map((a) => headerValue(a, "bcc"));

  if (!to.length && !cc.length && !bcc.length) {
    throw new UserFacingError("A message needs at least one recipient.");
  }

  const headers: string[] = [
    `From: ${headerValue(msg.from, "from")}`,
    `To: ${to.join(", ")}`,
  ];
  if (cc.length) headers.push(`Cc: ${cc.join(", ")}`);
  if (bcc.length) headers.push(`Bcc: ${bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderText(headerValue(msg.subject, "subject"))}`);
  if (msg.inReplyTo) {
    const id = headerValue(msg.inReplyTo, "inReplyTo");
    headers.push(`In-Reply-To: ${id}`);
    headers.push(`References: ${headerValue(msg.references ?? id, "references")}`);
  }
  headers.push("MIME-Version: 1.0");

  const textPart = base64Lines(Buffer.from(msg.body, "utf8"));
  const attachments = msg.attachments ?? [];

  if (!attachments.length) {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push("Content-Transfer-Encoding: base64");
    // Base64 the body so UTF-8 and long lines both survive without folding rules.
    return `${headers.join("\r\n")}\r\n\r\n${textPart}`;
  }

  const boundary = `=_gmm_${randomBytes(12).toString("hex")}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts: string[] = [
    [
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      textPart,
    ].join("\r\n"),
  ];
  for (const a of attachments) {
    const filename = headerValue(a.filename, "attachment filename");
    const mimeType = headerValue(a.mimeType, "attachment type");
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) {
      throw new UserFacingError(`Attachment type is not valid: ${mimeType}`);
    }
    parts.push(
      [
        `Content-Type: ${mimeType};${fileParams("name", filename)}`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment;${fileParams("filename", filename)}`,
        "",
        base64Lines(a.content),
      ].join("\r\n"),
    );
  }

  const body = parts.map((p) => `--${boundary}\r\n${p}`).join("\r\n") + `\r\n--${boundary}--`;
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

function base64Lines(buf: Buffer): string {
  return buf.toString("base64").replace(/(.{76})/g, "$1\r\n");
}

/**
 * Folded MIME parameters for a file name.
 *
 * RFC 2047 §5 says encoded-words do not belong inside parameters, and RFC 2231
 * (`filename*0*=UTF-8''…`) is the standard way. But Gmail ignores RFC 2231 and
 * shows the plain `filename=` value — verified against a live draft, where a
 * Japanese name came out as its ASCII stand-in. Gmail, Outlook and Apple Mail
 * all write and read encoded-words in the quoted value, so that is what goes
 * in `filename=`/`name=`, split into ≤75-char encoded-words joined by folding
 * whitespace so no line nears the 998-octet limit. The RFC 2231 form is added
 * as well for strict clients.
 */
function fileParams(param: string, filename: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(filename) && filename.length <= 200) {
    return `\r\n\t${param}="${filename.replace(/["\\]/g, (c) => `\\${c}`)}"`;
  }
  const lines: string[] = [`${param}="${encodedWords(filename).join("\r\n\t")}"`];
  const encoded = encodeRfc2231(filename);
  const chunks: string[] = [];
  for (let i = 0; i < encoded.length; ) {
    // Never split a %XX escape across chunks.
    let end = Math.min(i + 60, encoded.length);
    const pct = encoded.lastIndexOf("%", end - 1);
    if (end < encoded.length && pct > end - 3 && pct >= i) end = pct;
    chunks.push(encoded.slice(i, end));
    i = end;
  }
  chunks.forEach((chunk, n) => {
    lines.push(`${param}*${n}*=${n === 0 ? "UTF-8''" : ""}${chunk}`);
  });
  return lines.map((l) => `\r\n\t${l}`).join(";");
}

/** Split text into RFC 2047 B encoded-words of at most 75 chars, on character boundaries. */
function encodedWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  const word = (s: string) => `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
  for (const ch of value) {
    if (word(current + ch).length > 75 && current) {
      words.push(word(current));
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) words.push(word(current));
  return words;
}

/** RFC 2231 extended parameter value (percent-encoded UTF-8). */
function encodeRfc2231(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function toGmailRaw(msg: OutgoingMessage): string {
  return Buffer.from(buildRawMessage(msg), "utf8").toString("base64url");
}

/** Human-readable preview shown before anything is sent. */
export function previewText(msg: OutgoingMessage): string {
  const lines = [
    `From:    ${msg.from}`,
    `To:      ${msg.to.join(", ")}`,
    ...(msg.cc?.length ? [`Cc:      ${msg.cc.join(", ")}`] : []),
    ...(msg.bcc?.length ? [`Bcc:     ${msg.bcc.join(", ")}`] : []),
    `Subject: ${msg.subject}`,
    ...(msg.inReplyTo ? [`Reply to: ${msg.inReplyTo}`] : []),
    "",
    msg.body,
    ...(msg.attachments?.length
      ? [
          "",
          "Attachments:",
          ...msg.attachments.map(
            (a) =>
              `  - ${a.filename} (${formatBytes(a.content.length)}, ${a.mimeType})` +
              (a.sourcePath ? `\n      from ${a.sourcePath}` : ""),
          ),
        ]
      : []),
  ];
  return lines.join("\n");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
