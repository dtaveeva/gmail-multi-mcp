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
      assert.equal(await isCreatedDraft(home, "a@x.com", "r1", "m1"), false);
      await recordCreatedDraft(home, "A@x.com", "r1", "m1");
      assert.equal(await isCreatedDraft(home, "a@x.com", "r1", "m1"), true);
      assert.equal(await isCreatedDraft(home, "b@x.com", "r1", "m1"), false);
      assert.equal(await isCreatedDraft(home, "a@x.com", "r2", "m1"), false);
      // Same draft id now pointing at a different message (UID reuse, or an edit).
      assert.equal(await isCreatedDraft(home, "a@x.com", "r1", "m2"), false);
      const mode = (await fs.stat(path.join(home, "created-drafts.json"))).mode & 0o777;
      assert.equal(mode, 0o600);
      await forgetCreatedDraft(home, "a@x.com", "r1");
      assert.equal(await isCreatedDraft(home, "a@x.com", "r1", "m1"), false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("keeps every entry when many are recorded at once", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "gmm-drafts-"));
    try {
      await Promise.all(
        Array.from({ length: 20 }, (_, i) => recordCreatedDraft(home, "a@x.com", `r${i}`, `m${i}`)),
      );
      for (let i = 0; i < 20; i++) {
        assert.equal(await isCreatedDraft(home, "a@x.com", `r${i}`, `m${i}`), true, `r${i}`);
      }
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("treats a corrupt file as empty rather than trusting it", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "gmm-drafts-"));
    try {
      await fs.writeFile(path.join(home, "created-drafts.json"), "{not json");
      assert.equal(await isCreatedDraft(home, "a@x.com", "r1", "m1"), false);
      const kept = (await fs.readdir(home)).filter((f) => f.includes(".corrupt-"));
      assert.equal(kept.length, 1);
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
