import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { assertSingleUid } from "../src/mailbox/imap.js";
import {
  forgetCreatedDraft,
  isCreatedDraft,
  recordCreatedDraft,
} from "../src/safety/created-drafts.js";

describe("created-drafts registry", () => {
  it("only knows drafts recorded for that account, and forgets them", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "gmm-drafts-"));
    try {
      assert.equal(await isCreatedDraft(home, "a@x.com", "r1"), false);
      await recordCreatedDraft(home, "A@x.com", "r1");
      assert.equal(await isCreatedDraft(home, "a@x.com", "r1"), true);
      assert.equal(await isCreatedDraft(home, "b@x.com", "r1"), false);
      assert.equal(await isCreatedDraft(home, "a@x.com", "r2"), false);
      const mode = (await fs.stat(path.join(home, "created-drafts.json"))).mode & 0o777;
      assert.equal(mode, 0o600);
      await forgetCreatedDraft(home, "a@x.com", "r1");
      assert.equal(await isCreatedDraft(home, "a@x.com", "r1"), false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("treats a corrupt file as empty rather than trusting it", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "gmm-drafts-"));
    try {
      await fs.writeFile(path.join(home, "created-drafts.json"), "{not json");
      assert.equal(await isCreatedDraft(home, "a@x.com", "r1"), false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("assertSingleUid", () => {
  it("accepts one positive integer", () => {
    assert.doesNotThrow(() => assertSingleUid("42"));
  });
  for (const bad of ["1:*", "10,20", "0", "-1", "1 ", "", "abc", "12345678901"]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      assert.throws(() => assertSingleUid(bad), /Not a valid draft id/);
    });
  }
});
