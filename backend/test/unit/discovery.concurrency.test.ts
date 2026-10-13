import assert from "node:assert/strict";
import { test } from "node:test";
import { isDiscoveryConcurrencyConflict } from "../../src/discovery/automation.js";

test("Discovery recognizes Prisma and PostgreSQL serialization/deadlock conflicts", () => {
  assert.equal(isDiscoveryConcurrencyConflict({ code: "P2034" }), true);
  assert.equal(isDiscoveryConcurrencyConflict({ code: "P2010", meta: { code: "40001" } }), true);
  assert.equal(isDiscoveryConcurrencyConflict({ code: "P2010", meta: { code: "40P01" } }), true);
  assert.equal(isDiscoveryConcurrencyConflict({ code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "40001", kind: "TransactionWriteConflict" } } } }), true);
  assert.equal(isDiscoveryConcurrencyConflict({ code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "40P01", kind: "TransactionWriteConflict" } } } }), true);
});

test("Discovery does not swallow unrelated database failures as concurrency skips", () => {
  for (const error of [null, new Error("40001"), { code: "P2010" }, { code: "P2010", meta: { code: "23503" } }, { code: "P2010", meta: { message: "40001" } }, { code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "23503" } } } }, { code: "P2028" }]) assert.equal(isDiscoveryConcurrencyConflict(error), false);
});
