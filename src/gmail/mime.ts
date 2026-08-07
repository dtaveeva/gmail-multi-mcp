import { UserFacingError } from "../errors.js";

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
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: base64");

  // Base64 the body so UTF-8 and long lines both survive without folding rules.
  const encoded = Buffer.from(msg.body, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");

  return `${headers.join("\r\n")}\r\n\r\n${encoded}`;
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
  ];
  return lines.join("\n");
}
