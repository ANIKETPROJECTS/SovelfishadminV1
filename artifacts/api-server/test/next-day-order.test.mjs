import test from "node:test";
import assert from "node:assert/strict";
import {
  getTodayISODateIST,
  getTomorrowISODateIST,
  isAfterFivePMIST,
  isFutureNextDayOrder,
} from "../src/lib/next-day-order.mjs";

test("uses the Indian calendar date across UTC midnight", () => {
  const utcBeforeIndianMidnight = new Date("2026-11-13T17:59:00.000Z");
  assert.equal(getTodayISODateIST(utcBeforeIndianMidnight), "2026-11-13");
  assert.equal(getTomorrowISODateIST(utcBeforeIndianMidnight), "2026-11-14");

  const utcAfterIndianMidnight = new Date("2026-11-13T18:31:00.000Z");
  assert.equal(getTodayISODateIST(utcAfterIndianMidnight), "2026-11-14");
  assert.equal(getTomorrowISODateIST(utcAfterIndianMidnight), "2026-11-15");
});

test("the automatic next-day window starts at 5 PM IST and ends at midnight", () => {
  assert.equal(isAfterFivePMIST(new Date("2026-11-13T11:29:00.000Z")), false); // 4:59 PM IST
  assert.equal(isAfterFivePMIST(new Date("2026-11-13T11:30:00.000Z")), true); // 5:00 PM IST
  assert.equal(isAfterFivePMIST(new Date("2026-11-13T18:30:00.000Z")), false); // 12:00 AM IST
});

test("a next-day order is blocked only while its delivery date is still ahead", () => {
  const order = { nextDayOrder: true, deliveryDate: "2026-11-14" };
  assert.equal(isFutureNextDayOrder(order, "2026-11-13"), true);
  assert.equal(isFutureNextDayOrder(order, "2026-11-14"), false);
  assert.equal(isFutureNextDayOrder({ ...order, nextDayOrder: false }, "2026-11-13"), false);
});
