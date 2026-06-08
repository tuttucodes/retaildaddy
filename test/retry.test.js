import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "../src/util/retry.js";

describe("withRetry", () => {
  it("returns the first successful result without extra attempts", async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls += 1; return "ok"; }, { retries: 3, baseDelayMs: 0 });
    assert.equal(result, "ok");
    assert.equal(calls, 1);
  });

  it("retries on failure then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error("flaky");
      return calls;
    }, { retries: 5, baseDelayMs: 0 });
    assert.equal(result, 3);
    assert.equal(calls, 3);
  });

  it("throws the last error after exhausting retries", async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => { calls += 1; throw new Error(`fail-${calls}`); }, { retries: 2, baseDelayMs: 0 }),
      /fail-3/
    );
    assert.equal(calls, 3);
  });

  it("calls onRetry with attempt number and error", async () => {
    const seen = [];
    await withRetry(async () => { throw new Error("x"); }, {
      retries: 1, baseDelayMs: 0, onRetry: (attempt, err) => seen.push([attempt, err.message])
    }).catch(() => {});
    assert.deepEqual(seen, [[1, "x"], [2, "x"]]);
  });
});
