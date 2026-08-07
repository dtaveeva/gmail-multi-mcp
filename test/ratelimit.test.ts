import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RateLimiter } from "../src/safety/ratelimit.js";

describe("RateLimiter", () => {
  it("allows up to the limit then refuses", () => {
    const limiter = new RateLimiter({ send: 3, mutation: 10 });
    for (let i = 0; i < 3; i++) limiter.consume("a@x.com", "send");
    assert.throws(() => limiter.consume("a@x.com", "send"), /Hourly send limit reached/);
  });

  it("counts accounts separately", () => {
    const limiter = new RateLimiter({ send: 1, mutation: 10 });
    limiter.consume("a@x.com", "send");
    assert.doesNotThrow(() => limiter.consume("b@x.com", "send"));
  });

  it("counts action classes separately", () => {
    const limiter = new RateLimiter({ send: 1, mutation: 5 });
    limiter.consume("a@x.com", "send");
    assert.doesNotThrow(() => limiter.consume("a@x.com", "mutation"));
  });

  it("treats an account reference case-insensitively", () => {
    const limiter = new RateLimiter({ send: 1, mutation: 5 });
    limiter.consume("A@X.com", "send");
    assert.throws(() => limiter.consume("a@x.com", "send"), /Hourly send limit/);
  });

  it("reports remaining quota", () => {
    const limiter = new RateLimiter({ send: 5, mutation: 10 });
    assert.equal(limiter.remaining("a@x.com", "send"), 5);
    limiter.consume("a@x.com", "send");
    assert.equal(limiter.remaining("a@x.com", "send"), 4);
  });

  it("does not consume quota on a refused call", () => {
    const limiter = new RateLimiter({ send: 1, mutation: 5 });
    limiter.consume("a@x.com", "send");
    assert.throws(() => limiter.consume("a@x.com", "send"));
    assert.throws(() => limiter.consume("a@x.com", "send"));
    assert.equal(limiter.remaining("a@x.com", "send"), 0);
  });

  it("treats a limit of zero as unlimited", () => {
    const limiter = new RateLimiter({ send: 0, mutation: 0 });
    for (let i = 0; i < 50; i++) limiter.consume("a@x.com", "send");
  });
});
