import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { loadLocalAttachments, mimeTypeFor } from "../src/gmail/attachments.js";
import { buildRawMessage } from "../src/gmail/mime.js";

let root: string;
let outside: string;

before(async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gmm-att-")));
  root = path.join(base, "inbox");
  outside = path.join(base, "elsewhere");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.mkdir(path.join(root, ".hidden"));
  await fs.writeFile(path.join(root, "質問書.xlsx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]));
  await fs.writeFile(path.join(root, ".hidden", "secret.txt"), "nope");
  await fs.writeFile(path.join(outside, "id_rsa"), "nope");
  await fs.symlink(path.join(outside, "id_rsa"), path.join(root, "link.txt"));
});

after(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

const policy = () => ({ roots: [root], maxBytes: 1024 });

describe("loadLocalAttachments", () => {
  it("reads a file inside an allowed root", async () => {
    const [a] = await loadLocalAttachments([{ path: path.join(root, "質問書.xlsx") }], policy());
    assert.ok(a);
    assert.equal(a.filename, "質問書.xlsx");
    assert.equal(a.mimeType, mimeTypeFor("x.xlsx"));
    assert.equal(a.content.length, 5);
    assert.match(a.sha256 ?? "", /^[0-9a-f]{64}$/);
  });

  it("uses the given display name", async () => {
    const [a] = await loadLocalAttachments(
      [{ path: path.join(root, "質問書.xlsx"), filename: "Mugen.xlsx" }],
      policy(),
    );
    assert.equal(a?.filename, "Mugen.xlsx");
  });

  it("refuses relative paths", async () => {
    await assert.rejects(loadLocalAttachments([{ path: "質問書.xlsx" }], policy()), /absolute/);
  });

  it("refuses .. segments", async () => {
    await assert.rejects(
      loadLocalAttachments([{ path: `${root}/../elsewhere/id_rsa` }], policy()),
      /must not contain/,
    );
  });

  it("refuses hidden folders", async () => {
    await assert.rejects(
      loadLocalAttachments([{ path: path.join(root, ".hidden", "secret.txt") }], policy()),
      /hidden/,
    );
  });

  it("refuses files outside the roots", async () => {
    await assert.rejects(
      loadLocalAttachments([{ path: path.join(outside, "id_rsa") }], policy()),
      /outside the allowed folders/,
    );
  });

  it("refuses a symlink that escapes the root", async () => {
    await assert.rejects(
      loadLocalAttachments([{ path: path.join(root, "link.txt") }], policy()),
      /outside the allowed folders/,
    );
  });

  it("refuses directories", async () => {
    await assert.rejects(
      loadLocalAttachments([{ path: path.join(root) }], { ...policy(), roots: [path.dirname(root)] }),
      /hidden|regular file/,
    );
  });

  it("enforces the size limit across all files", async () => {
    const f = path.join(root, "質問書.xlsx");
    await assert.rejects(
      loadLocalAttachments([{ path: f }, { path: f }], { roots: [root], maxBytes: 8 }),
      /exceed/,
    );
  });

  it("accepts a root given with a trailing slash", async () => {
    const [a] = await loadLocalAttachments([{ path: path.join(root, "質問書.xlsx") }], {
      roots: [`${root}/`],
      maxBytes: 1024,
    });
    assert.equal(a?.content.length, 5);
  });

  it("accepts a root that is itself a symlink", async () => {
    const linkRoot = path.join(path.dirname(root), "inbox-link");
    await fs.symlink(root, linkRoot);
    const [a] = await loadLocalAttachments([{ path: path.join(linkRoot, "質問書.xlsx") }], {
      roots: [linkRoot],
      maxBytes: 1024,
    });
    assert.equal(a?.content.length, 5);
  });

  it("refuses a symlink that points at a hidden file inside the root", async () => {
    const link = path.join(root, "plain.txt");
    await fs.symlink(path.join(root, ".hidden", "secret.txt"), link);
    await assert.rejects(loadLocalAttachments([{ path: link }], policy()), /hidden/);
  });

  it("allows exactly the limit and refuses one byte over", async () => {
    const f = path.join(root, "質問書.xlsx");
    const ok = await loadLocalAttachments([{ path: f }], { roots: [root], maxBytes: 5 });
    assert.equal(ok[0]?.content.length, 5);
    await assert.rejects(loadLocalAttachments([{ path: f }], { roots: [root], maxBytes: 4 }), /exceed/);
  });

  it("refuses a display name with a slash or newline", async () => {
    await assert.rejects(
      loadLocalAttachments(
        [{ path: path.join(root, "質問書.xlsx"), filename: "a\r\nBcc: x@y.z" }],
        policy(),
      ),
      /not allowed/,
    );
  });
});

describe("buildRawMessage with attachments", () => {
  const content = Buffer.from("PK\u0003\u0004 binary ÿ", "latin1");
  const raw = buildRawMessage({
    from: "me@example.com",
    to: ["you@example.com"],
    subject: "質問書",
    body: "添付します",
    attachments: [{ filename: "業務過誤 質問書.xlsx", mimeType: mimeTypeFor("a.xlsx"), content }],
  });

  it("switches to multipart/mixed", () => {
    assert.match(raw, /\r\nContent-Type: multipart\/mixed; boundary="(=_gmm_[0-9a-f]+)"\r\n/);
  });

  it("keeps the body and the file byte-exact", () => {
    const boundary = /boundary="([^"]+)"/.exec(raw)?.[1] ?? "";
    const parts = raw.split(`--${boundary}`).slice(1, -1);
    assert.equal(parts.length, 2);
    const decode = (part: string) =>
      Buffer.from((part.split("\r\n\r\n")[1] ?? "").replace(/\r\n/g, ""), "base64");
    assert.equal(decode(parts[0] ?? "").toString("utf8"), "添付します");
    assert.deepEqual(decode(parts[1] ?? ""), content);
    assert.match(parts[1] ?? "", /Content-Disposition: attachment;\r\n\tfilename="=\?UTF-8\?B\?/);
    assert.match(parts[1] ?? "", /filename\*0\*=UTF-8''%E6%A5%AD/);
    assert.ok(raw.endsWith(`--${boundary}--`));
  });

  it("folds a long Japanese file name under the line limit and keeps it recoverable", () => {
    const name = `${"業".repeat(80)}.xlsx`;
    const long = buildRawMessage({
      from: "me@example.com",
      to: ["you@example.com"],
      subject: "x",
      body: "y",
      attachments: [{ filename: name, mimeType: mimeTypeFor(name), content: Buffer.from("z") }],
    });
    for (const line of long.split("\r\n")) assert.ok(line.length <= 998, `line ${line.length}`);
    const pieces = [...long.matchAll(/\tfilename\*(\d+)\*=(?:UTF-8'')?([^;\r\n]+)/g)]
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map((m) => m[2])
      .join("");
    assert.equal(decodeURIComponent(pieces), name);
    const quoted = /\tfilename="([^"]+)"/.exec(long)?.[1] ?? "";
    const words = [...quoted.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
    assert.ok(words.length > 1);
    for (const w of words) assert.ok(w[0].length <= 75);
    assert.equal(words.map((w) => Buffer.from(w[1] ?? "", "base64").toString("utf8")).join(""), name);
  });

  it("keeps a plain ASCII name as a simple quoted parameter", () => {
    const ascii = buildRawMessage({
      from: "me@example.com",
      to: ["you@example.com"],
      subject: "x",
      body: "y",
      attachments: [{ filename: "report.pdf", mimeType: "application/pdf", content: Buffer.from("z") }],
    });
    assert.match(ascii, /filename="report\.pdf"/);
    assert.doesNotMatch(ascii, /filename\*0\*/);
  });

  it("splits a very long ASCII name instead of emitting an over-long line", () => {
    const name = `${"a".repeat(1000)}.pdf`;
    const long = buildRawMessage({
      from: "me@example.com",
      to: ["you@example.com"],
      subject: "x",
      body: "y",
      attachments: [{ filename: name, mimeType: "application/pdf", content: Buffer.from("z") }],
    });
    for (const line of long.split("\r\n")) assert.ok(line.length <= 998, `line ${line.length}`);
  });

  it("escapes quotes in an ASCII name rather than mangling it", () => {
    const quoted = buildRawMessage({
      from: "me@example.com",
      to: ["you@example.com"],
      subject: "x",
      body: "y",
      attachments: [{ filename: 'report "final".pdf', mimeType: "application/pdf", content: Buffer.from("z") }],
    });
    assert.match(quoted, /filename="report \\"final\\"\.pdf"/);
  });

  it("stays plain text when there are no attachments", () => {
    const plain = buildRawMessage({
      from: "me@example.com",
      to: ["you@example.com"],
      subject: "x",
      body: "y",
      attachments: [],
    });
    assert.match(plain, /Content-Type: text\/plain/);
    assert.doesNotMatch(plain, /multipart/);
  });
});
