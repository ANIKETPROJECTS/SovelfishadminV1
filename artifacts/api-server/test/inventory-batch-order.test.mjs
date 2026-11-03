import assert from "node:assert/strict";
import test from "node:test";
import {
  getOutstandingDeductionMovements,
  planBatchConsumption,
  restoreBatchAllocations,
  sortBatchesByExpiry,
} from "../src/routes/inventory-batch-order.mjs";

test("sorts by expiry even when a later-expiring batch was created or received earlier", () => {
  const batches = [
    {
      batchNumber: "later-expiry",
      expiryDate: new Date("2026-11-30T12:00:00.000Z"),
      receivedDate: new Date("2026-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      batchNumber: "earlier-expiry",
      expiryDate: new Date("2026-10-31T12:00:00.000Z"),
      receivedDate: new Date("2026-09-01T00:00:00.000Z"),
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    },
    { batchNumber: "no-expiry", expiryDate: null },
  ];

  assert.deepEqual(
    sortBatchesByExpiry(batches).map((batch) => batch.batchNumber),
    ["earlier-expiry", "later-expiry", "no-expiry"],
  );
});

test("does not use createdAt to order batches with the same expiry", () => {
  const batches = [
    {
      batchNumber: "first-in-list",
      expiryDate: new Date("2026-10-31T12:00:00.000Z"),
      createdAt: new Date("2026-09-15T00:00:00.000Z"),
    },
    {
      batchNumber: "older-created-at",
      expiryDate: new Date("2026-10-31T12:00:00.000Z"),
      createdAt: new Date("2026-08-15T00:00:00.000Z"),
    },
  ];

  assert.deepEqual(
    sortBatchesByExpiry(batches).map((batch) => batch.batchNumber),
    ["first-in-list", "older-created-at"],
  );
});

test("records the exact quantities taken from each expiry-ordered batch", () => {
  const batches = [
    { _id: "later", batchNumber: "LATER", quantity: 5, expiryDate: new Date("2026-12-01") },
    { _id: "earlier", batchNumber: "EARLIER", quantity: 2, expiryDate: new Date("2026-11-01") },
  ];

  const plan = planBatchConsumption(batches, 4);

  assert.deepEqual(plan.allocations, [
    { batchId: "earlier", batchNumber: "EARLIER", quantity: 2 },
    { batchId: "later", batchNumber: "LATER", quantity: 2 },
  ]);
  assert.equal(plan.remaining, 0);
  assert.equal(batches[0].quantity, 5);
  assert.equal(batches[1].quantity, 2);
});

test("a POS-selected batch is consumed without falling back to another batch", () => {
  const batches = [
    { _id: "earlier", batchNumber: "EARLIER", quantity: 1, expiryDate: new Date("2026-11-01") },
    { _id: "selected", batchNumber: "SELECTED", quantity: 1, expiryDate: new Date("2026-12-01") },
  ];

  const plan = planBatchConsumption(batches, 1, "selected");

  assert.deepEqual(plan.allocations, [
    { batchId: "selected", batchNumber: "SELECTED", quantity: 1 },
  ]);
  assert.equal(plan.remaining, 0);

  const insufficientPlan = planBatchConsumption(batches, 2, "selected");
  assert.deepEqual(insufficientPlan.allocations, [
    { batchId: "selected", batchNumber: "SELECTED", quantity: 1 },
  ]);
  assert.equal(insufficientPlan.remaining, 1);
});

test("restores stock to the exact deducted batch IDs, even if another batch is newer", () => {
  const batches = [
    { _id: "deducted-batch", batchNumber: "EARLY", quantity: 0, expiryDate: new Date("2026-10-01") },
    { _id: "other-batch", batchNumber: "LATE", quantity: 8, expiryDate: new Date("2026-12-01") },
  ];

  const result = restoreBatchAllocations(batches, [
    { batchId: "deducted-batch", batchNumber: "EARLY", quantity: 3 },
  ]);

  assert.equal(result.batches.find((batch) => batch._id === "deducted-batch").quantity, 3);
  assert.equal(result.batches.find((batch) => batch._id === "other-batch").quantity, 8);
  assert.equal(result.unmatchedAllocations.length, 0);
});

test("recreates a removed source batch using its saved ID and metadata", () => {
  const result = restoreBatchAllocations(
    [{ _id: "other-batch", batchNumber: "OTHER", quantity: 4 }],
    [{
      batchId: "removed-batch",
      batchNumber: "SOURCE",
      quantity: 2,
      batchSnapshot: {
        batchNumber: "SOURCE",
        expiryDate: new Date("2026-10-01"),
        receivedDate: new Date("2026-08-01"),
      },
    }],
  );

  assert.deepEqual(
    result.batches.find((batch) => batch._id === "removed-batch"),
    {
      batchNumber: "SOURCE",
      expiryDate: new Date("2026-10-01"),
      receivedDate: new Date("2026-08-01"),
      _id: "removed-batch",
      quantity: 2,
    },
  );
});

test("a repeated cancellation does not restore a deduction movement twice", () => {
  const deductions = [
    { _id: "deduct-1", batchAllocations: [{ batchId: "batch-1", quantity: 2 }] },
    { _id: "deduct-2", batchAllocations: [{ batchId: "batch-2", quantity: 1 }] },
  ];
  const restores = [{ _id: "restore-1", reversesMovementIds: ["deduct-1"] }];

  assert.deepEqual(
    getOutstandingDeductionMovements(deductions, restores).map((movement) => movement._id),
    ["deduct-2"],
  );
});

test("pairs old unlinked restore records with their old deductions", () => {
  const deductions = [
    { _id: "old-deduct-1", createdAt: "2026-10-01T10:00:00Z", change: -2 },
    { _id: "old-deduct-2", createdAt: "2026-10-02T10:00:00Z", change: -3 },
  ];
  const restores = [{ _id: "old-restore", createdAt: "2026-10-01T11:00:00Z", change: 2 }];

  assert.deepEqual(
    getOutstandingDeductionMovements(deductions, restores).map((movement) => movement._id),
    ["old-deduct-2"],
  );
});
