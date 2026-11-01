import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { UserFacingError } from "../errors.js";
import type { OutgoingAttachment } from "./mime.js";

/** What a tool caller may pass: a local file path and an optional display name. */
export interface AttachmentSpec {
  path: string;
  filename?: string;
}

export interface AttachmentPolicy {
  roots: string[];
  maxBytes: number;
}

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".zip": "application/zip",
};

export function mimeTypeFor(filename: string): string {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

function refuse(message: string, hint?: string): never {
  throw new UserFacingError(message, hint);
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Read local files for attachment, enforcing the path policy.
 *
 * Rules, in order: absolute paths only; no `..` segments; no hidden path
 * components (dotfiles, ~/.ssh, ~/.config …); after resolving symlinks the file
 * must sit inside a configured root; it must be a regular file; the combined
 * size must stay under the limit. Roots are realpath'd too, so a symlinked
 * root still works.
 */
export async function loadLocalAttachments(
  specs: AttachmentSpec[],
  policy: AttachmentPolicy,
): Promise<OutgoingAttachment[]> {
  if (!specs.length) return [];
  const roots = await Promise.all(
    policy.roots.map(async (r) => {
      try {
        return await fs.realpath(r);
      } catch {
        return path.resolve(r);
      }
    }),
  );

  const out: OutgoingAttachment[] = [];
  let total = 0;
  for (const spec of specs) {
    const p = spec.path;
    if (!path.isAbsolute(p)) {
      refuse(`Attachment path must be absolute: ${p}`);
    }
    const segments = p.split(/[\\/]+/);
    if (segments.includes("..")) {
      refuse(`Attachment path must not contain "..": ${p}`);
    }
    if (segments.some((s) => s.startsWith("."))) {
      refuse(`Attachment path must not include hidden files or folders: ${p}`);
    }

    let real: string;
    try {
      real = await fs.realpath(p);
    } catch {
      refuse(`Attachment not found: ${p}`);
    }
    if (!roots.some((r) => isInside(r, real))) {
      refuse(
        `Attachment is outside the allowed folders: ${p}`,
        `Allowed: ${policy.roots.join(", ")}. Move the file there, or set ` +
          "GMAIL_MCP_ATTACHMENT_ROOTS (colon-separated absolute paths).",
      );
    }
    if (path.relative(roots.find((r) => isInside(r, real)) ?? "/", real)
      .split(path.sep)
      .some((s) => s.startsWith("."))) {
      refuse(`Attachment path must not include hidden files or folders: ${p}`);
    }

    // Open the resolved path once (refusing a final-component symlink), then
    // check and read through that same descriptor, so what we vetted is what
    // we send. The read is bounded by the remaining budget, so a file that
    // grows after the check still cannot exceed the limit.
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch {
      refuse(`Attachment could not be opened: ${p}`);
    }
    let content: Buffer;
    try {
      const st = await handle.stat();
      if (!st.isFile()) refuse(`Attachment is not a regular file: ${p}`);
      const lst = await fs.lstat(real);
      if (lst.ino !== st.ino || lst.dev !== st.dev) {
        refuse(`Attachment changed while it was being read: ${p}`);
      }
      content = await readBounded(handle, policy.maxBytes - total);
    } finally {
      await handle.close();
    }
    total += content.length;

    const filename = (spec.filename ?? path.basename(real)).trim();
    if (!filename || /[\r\n\\/]/.test(filename)) {
      refuse(`Attachment filename is not allowed: ${JSON.stringify(spec.filename)}`);
    }
    out.push({
      filename,
      mimeType: mimeTypeFor(filename),
      content,
      sourcePath: real,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  return out;
}

/** Read at most `budget` bytes; refuse if the file holds more than that. */
async function readBounded(handle: fs.FileHandle, budget: number): Promise<Buffer> {
  const limit = Math.max(0, budget);
  const chunks: Buffer[] = [];
  let read = 0;
  for (;;) {
    const want = Math.min(64 * 1024, limit + 1 - read);
    if (want <= 0) break;
    const buf = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buf, 0, want, null);
    if (bytesRead === 0) break;
    chunks.push(buf.subarray(0, bytesRead));
    read += bytesRead;
  }
  if (read > limit) {
    refuse("Attachments exceed the size limit.", "Share large files as a Drive link instead.");
  }
  return Buffer.concat(chunks, read);
}
