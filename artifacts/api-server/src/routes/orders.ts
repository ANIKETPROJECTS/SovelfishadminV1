import { Router } from "express";
import mongoose from "mongoose";
import crypto from "node:crypto";
import { getSubHubDbConnection } from "../db/sub-hub-connections.js";
import { getCustomersConnection } from "../db/customers-connection.js";
import { syncOrderBankPayments } from "./banking.js";
import {
  applyOrderInventoryOnCreate,
  applyOrderInventoryOnUpdate,
  applyOrderInventoryOnDelete,
  autoDeductUndedcutedOrders,
  InsufficientStockError,
} from "./inventory.js";
import { requireAuth } from "../middlewares/auth.js";
import { loadScope, type ScopedRequest } from "../middlewares/scope.js";
import { HubUser } from "../db/models/hub-user.js";
import { sendOrderConfirmed, sendOutForDelivery, sendOrderCancelled } from "../services/whatsapp.js";
import { createBorzoBatchOrder, createBorzoOrder, getBorzoOrderDetails } from "../services/borzo.mjs";
import {
  ensureFtwPendingPaymentExpiryDates,
  isFtwOrder,
  isFtwPaymentOnHold,
} from "../services/ftw-order-lifecycle.js";
import { DIRECT_ORDER_ONLY, TIMESLOT_FEATURE_ENABLED } from "../lib/feature-flags.js";

const router = Router();
router.use(requireAuth as any);
router.use(loadScope as any);

const VALID_ORDER_STATUSES = new Set([
  "pending",
  "confirmed",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "takeaway",
]);

/**
 * Returns a filter clause to scope orders to the user's hub set.
 * Master admins get an empty clause (no filtering). Non-master users without
 * any sub hubs get a filter that matches no documents.
 */
function scopeOrderFilter(req: ScopedRequest): Record<string, any> | null {
  const scope = req.scope;
  if (!scope || scope.isMaster) return {};
  if (scope.role === "delivery_person") {
    const uid = req.admin?.adminId;
    if (!uid) return null;
    return { assignedDeliveryPersonId: String(uid) };
  }
  if (scope.subHubIds.length === 0) return null; // sentinel: match nothing
  return { subHubId: { $in: scope.subHubIds } };
}

/** Combines an existing filter with the scope filter. Returns null when the
 *  scope is empty for a non-master user (caller should respond with empty). */
function applyOrderScope(filter: any, req: ScopedRequest): any | null {
  const scopeClause = scopeOrderFilter(req);
  if (scopeClause === null) return null;
  if (Object.keys(scopeClause).length === 0) return filter;
  if (filter.$and) {
    return { ...filter, $and: [...filter.$and, scopeClause] };
  }
  if (filter.$or) {
    // Wrap existing $or with $and so we don't lose either constraint.
    const { $or, ...rest } = filter;
    return { ...rest, $and: [{ $or }, scopeClause] };
  }
  return { ...filter, ...scopeClause };
}

async function getCustomersCollection() {
  const conn = await getCustomersConnection();
  return conn.db.collection("customers");
}

const ORDERS_DB = "orders";
const COLLECTION = "orders";

async function getOrdersDb() {
  return getSubHubDbConnection(ORDERS_DB);
}

/**
 * Delivery lifecycle timestamps are server-owned so assignment and status
 * changes from the admin UI, delivery UI, and QR dispatch stay consistent.
 */
function addDeliveryLifecycleTimestamps(update: any, existing: any, body: any, now: Date) {
  const previousAssignee = String(existing?.assignedDeliveryPersonId ?? "");
  const nextAssignee = body.assignedDeliveryPersonId !== undefined
    ? String(body.assignedDeliveryPersonId ?? "")
    : previousAssignee;

  if (nextAssignee && nextAssignee !== previousAssignee) {
    update.deliveryAssignedAt = now;
  } else if (nextAssignee && !existing?.deliveryAssignedAt && body.assignedDeliveryPersonId !== undefined) {
    // Give legacy orders a timestamp the next time their current assignment is
    // explicitly confirmed, without allowing clients to provide the value.
    update.deliveryAssignedAt = now;
  }

  if (
    body.status === "out_for_delivery" &&
    (String(existing?.status ?? "") !== "out_for_delivery" || !existing?.deliveryPickedUpAt)
  ) {
    update.deliveryPickedUpAt = now;
  }

  if (
    body.status === "delivered" &&
    (String(existing?.status ?? "") !== "delivered" || !existing?.deliveryDeliveredAt)
  ) {
    update.deliveryDeliveredAt = now;
  }
}

function extractOrderPincode(order: any): string {
  const detail = order?.deliveryAddressDetail;
  const candidates = [
    detail?.pincode,
    detail?.zipCode,
    detail?.zip,
    order?.deliveryPincode,
    order?.pincode,
  ];
  for (const value of candidates) {
    const match = String(value ?? "").match(/\b\d{6}\b/);
    if (match) return match[0];
  }
  const addressText = [
    order?.address,
    order?.deliveryArea,
    typeof detail === "string" ? detail : "",
    detail && typeof detail === "object" ? JSON.stringify(detail) : "",
  ].join(" ");
  return addressText.match(/\b\d{6}\b/)?.[0] ?? "";
}

function isBorzoOrder(order: any): boolean {
  const orderId = String(order?.orderId ?? "").trim().replace(/^#+/, "").toUpperCase();
  return orderId.startsWith("FTS") || orderId.startsWith("FTW");
}

function addMinutesToTimeString(timeString: string, minutes: number): string {
  if (!timeString || !minutes) return timeString;
  const match = String(timeString).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return timeString;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = match[3].toUpperCase();
  if (period === "PM" && hour !== 12) hour += 12;
  if (period === "AM" && hour === 12) hour = 0;
  const total = hour * 60 + minute + minutes;
  const nextHour = Math.floor(total / 60) % 24;
  const nextMinute = total % 60;
  const nextPeriod = nextHour >= 12 ? "PM" : "AM";
  const displayHour = nextHour === 0 ? 12 : nextHour > 12 ? nextHour - 12 : nextHour;
  return `${displayHour}:${String(nextMinute).padStart(2, "0")} ${nextPeriod}`;
}

/**
 * Rebuild a slot's displayed range from the current sub-hub configuration.
 * Orders created before pincode delays were persisted still have the original
 * end time, so reading only the order document makes the table and invoice
 * under-report the delivery window.
 */
async function enrichOrderTimeslots(orders: any[], log: any): Promise<any[]> {
  if (!TIMESLOT_FEATURE_ENABLED) return orders;
  const dbPromises = new Map<string, Promise<any>>();
  const getDb = (name: string) => {
    if (!dbPromises.has(name)) dbPromises.set(name, getSubHubDbConnection(name));
    return dbPromises.get(name)!;
  };

  return Promise.all(orders.map(async (order) => {
    if (
      order?.scheduleType !== "slot" ||
      !order?.timeslotId ||
      !order?.subHubName ||
      order?.deliveryType === "takeaway"
    ) return order;

    try {
      const db = await getDb(String(order.subHubName));
      const timeslotId = toId(String(order.timeslotId));
      if (!timeslotId) return order;
      const [slot, pincode] = await Promise.all([
        db.db.collection("timeslots").findOne({ _id: timeslotId }),
        db.db.collection("pincodes").findOne({ pincode: extractOrderPincode(order) }),
      ]);
      if (!slot?.startTime || !slot?.endTime) return order;

      const delay = Math.max(0, Number(pincode?.timeDelay) || 0);
      const adjustedEnd = addMinutesToTimeString(String(slot.endTime), delay);
      const label = String(slot.label ?? order.timeslotLabel ?? "");
      const adjustedLabel = label && slot.endTime
        ? label.replace(String(slot.endTime), adjustedEnd)
        : label;

      return {
        ...order,
        timeslotStart: String(slot.startTime),
        timeslotEnd: adjustedEnd,
        ...(adjustedLabel ? { timeslotLabel: adjustedLabel } : {}),
      };
    } catch (err) {
      log.warn({ err, orderId: order?.orderId, subHubName: order?.subHubName }, "Failed to enrich order timeslot");
      return order;
    }
  }));
}

/**
 * Atomically adjusts a customer's walletBalance and appends a transaction record.
 * Use this instead of bare `$inc: { walletBalance }` so the wallet tracker has full history.
 */
async function pushWalletTx(
  cCol: any,
  customerId: string | mongoose.Types.ObjectId,
  balanceDelta: number,
  reason: string,
  opts?: { orderId?: string; orderRef?: string }
): Promise<void> {
  if (!balanceDelta) return;
  const custOid = customerId instanceof mongoose.Types.ObjectId
    ? customerId
    : new mongoose.Types.ObjectId(String(customerId));
  const txEntry: Record<string, any> = {
    amount: balanceDelta,
    type: balanceDelta > 0 ? "credit" : "debit",
    reason,
    createdAt: new Date(),
  };
  if (opts?.orderId) txEntry.orderId = opts.orderId;
  if (opts?.orderRef) txEntry.orderRef = opts.orderRef;
  await cCol.updateOne(
    { _id: custOid },
    { $inc: { walletBalance: balanceDelta }, $push: { walletTransactions: txEntry } }
  );
}

function toId(id: string): mongoose.mongo.BSON.ObjectId | null {
  try { return new mongoose.mongo.ObjectId(id); } catch { return null; }
}

const ORDER_QR_PREFIX = "fishtokri-order-v1";
const ORDER_QR_PUBLIC_URL = "https://fishtokri.com/";

function createOrderQrToken(orderId: string): string {
  const payload = `${ORDER_QR_PREFIX}.${orderId}`;
  const signature = crypto
    .createHmac("sha256", process.env.SESSION_SECRET!)
    .update(payload)
    .digest("hex");
  return `${payload}.${signature}`;
}

function verifyOrderQrToken(token: unknown): string | null {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== ORDER_QR_PREFIX) return null;
  const orderId = parts[1];
  const signature = parts[2];
  if (!mongoose.isValidObjectId(orderId) || !/^[a-f0-9]{64}$/i.test(signature)) return null;
  const expected = crypto
    .createHmac("sha256", process.env.SESSION_SECRET!)
    .update(`${ORDER_QR_PREFIX}.${orderId}`)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))
    ? orderId
    : null;
}

/**
 * Normalizes coupon data from an order document into a flat array.
 * Handles both the multi-coupon `coupons[]` format and the legacy
 * single-coupon `couponId / couponCode / couponTitle` fields.
 */
function extractOrderCoupons(order: any): Array<{ couponId: string; couponCode: string; couponTitle: string }> {
  const result: Array<{ couponId: string; couponCode: string; couponTitle: string }> = [];
  if (Array.isArray(order.coupons) && order.coupons.length > 0) {
    for (const c of order.coupons) {
      const id = String(c?.id ?? c?._id ?? c?.couponId ?? "").trim();
      if (id) result.push({
        couponId: id,
        couponCode: String(c?.code ?? c?.couponCode ?? "").trim(),
        couponTitle: String(c?.title ?? c?.name ?? c?.couponTitle ?? "").trim(),
      });
    }
  }
  if (result.length === 0 && order.couponId) {
    result.push({
      couponId: String(order.couponId).trim(),
      couponCode: String(order.couponCode ?? "").trim(),
      couponTitle: String(order.couponTitle ?? "").trim(),
    });
  }
  return result;
}

/** Statuses where the order is live (not yet delivered or cancelled). */
const ACTIVE_ORDER_STATUSES = new Set(["pending", "confirmed", "out_for_delivery", "takeaway"]);

/**
 * Upserts an activeCoupons entry for a customer.
 * Each coupon gets ONE entry (keyed by couponId) with usedCount tracking
 * how many active orders are using it, and orderIds[] listing those orders.
 * If an entry already exists for this couponId, increments usedCount and
 * appends the orderId. Otherwise, creates a new entry with usedCount=1.
 */
async function upsertActiveCoupon(
  cCol: any,
  customerId: string,
  coupon: { couponId: string; couponCode: string; couponTitle: string },
  orderId: string,
  subHubId: string,
  log: any,
) {
  const cid = toId(customerId);
  if (!cid) return;
  try {
    const updateResult = await cCol.updateOne(
      { _id: cid, "activeCoupons.couponId": coupon.couponId },
      {
        $inc: { "activeCoupons.$.usedCount": 1 },
        $addToSet: { "activeCoupons.$.orderIds": orderId },
      },
    );
    if (updateResult.matchedCount === 0) {
      await cCol.updateOne(
        { _id: cid },
        {
          $push: {
            activeCoupons: {
              couponId: coupon.couponId,
              couponCode: coupon.couponCode,
              couponTitle: coupon.couponTitle,
              subHubId: subHubId ?? "",
              usedCount: 1,
              orderIds: [orderId],
              appliedAt: new Date(),
            },
          },
        },
      );
    }
  } catch (e) {
    log.error({ err: e, customerId, orderId }, "Failed to upsert activeCoupon");
  }
}

/**
 * Decrements usedCount for an activeCoupons entry and removes the orderId.
 * If usedCount drops to 0 (or below), removes the entire entry so the
 * coupon becomes available again.
 */
async function decrementActiveCoupon(
  cCol: any,
  customerId: string,
  couponId: string,
  orderId: string,
  log: any,
) {
  const cid = toId(customerId);
  if (!cid) return;
  try {
    await cCol.updateOne(
      { _id: cid, "activeCoupons.couponId": couponId },
      { $inc: { "activeCoupons.$.usedCount": -1 } },
    );
    await cCol.updateOne(
      { _id: cid },
      { $pull: { "activeCoupons.$[elem].orderIds": orderId } as any },
      { arrayFilters: [{ "elem.couponId": couponId }] },
    );
    await cCol.updateOne(
      { _id: cid },
      { $pull: { activeCoupons: { couponId, usedCount: { $lte: 0 } } } as any },
    );
  } catch (e) {
    log.error({ err: e, customerId, orderId, couponId }, "Failed to decrement activeCoupon");
  }
}

/**
 * Syncs a customer's activeCoupons / usedCoupons arrays whenever an order's
 * status changes. All coupon state transitions live here so the logic is in
 * one place and easy to audit.
 *
 *  active   → delivered  : decrement activeCoupons usedCount → add to usedCoupons
 *  active   → cancelled  : decrement activeCoupons usedCount (entry removed if 0)
 *  delivered→ active     : remove from usedCoupons → re-upsert into activeCoupons
 *  delivered→ cancelled  : remove from usedCoupons
 *  cancelled→ active     : re-upsert into activeCoupons
 *  cancelled→ delivered  : add directly to usedCoupons
 */
async function syncCustomerCouponsOnStatusChange(
  cCol: any,
  customerId: string,
  orderId: string,
  orderCoupons: Array<{ couponId: string; couponCode: string; couponTitle: string }>,
  prevStatus: string,
  newStatus: string,
  subHubId: string,
  log: any,
) {
  if (!customerId || orderCoupons.length === 0 || prevStatus === newStatus) return;
  const cid = toId(customerId);
  if (!cid) return;

  const prevActive = ACTIVE_ORDER_STATUSES.has(prevStatus);
  const prevDelivered = prevStatus === "delivered";
  const prevCancelled = prevStatus === "cancelled";
  const newActive = ACTIVE_ORDER_STATUSES.has(newStatus);
  const newDelivered = newStatus === "delivered";
  const newCancelled = newStatus === "cancelled";

  try {
    if ((prevActive || prevDelivered) && newDelivered && !prevDelivered) {
      // ✅ Order delivered → decrement activeCoupons, lock permanently in usedCoupons
      for (const c of orderCoupons) {
        await decrementActiveCoupon(cCol, customerId, c.couponId, orderId, log);
      }
      const entries = orderCoupons.map((c) => ({ ...c, orderId, subHubId: subHubId ?? "", usedAt: new Date() }));
      await cCol.updateOne({ _id: cid }, { $push: { usedCoupons: { $each: entries } } });
      log.info({ customerId, orderId }, "Coupon lifecycle: activeCoupons decremented → usedCoupons (delivered)");
    } else if (prevDelivered && newActive) {
      // ↩️ Un-deliver → remove from usedCoupons, re-upsert into activeCoupons
      await cCol.updateOne({ _id: cid }, { $pull: { usedCoupons: { orderId } } });
      for (const c of orderCoupons) {
        await upsertActiveCoupon(cCol, customerId, c, orderId, subHubId, log);
      }
      log.info({ customerId, orderId }, "Coupon lifecycle: usedCoupons removed → activeCoupons upserted (un-delivered)");
    } else if ((prevActive || prevDelivered) && newCancelled) {
      // ❌ Order cancelled → decrement activeCoupons, remove from usedCoupons
      for (const c of orderCoupons) {
        await decrementActiveCoupon(cCol, customerId, c.couponId, orderId, log);
      }
      await cCol.updateOne({ _id: cid }, { $pull: { usedCoupons: { orderId } } });
      log.info({ customerId, orderId }, "Coupon lifecycle: activeCoupons decremented (cancelled)");
    } else if (prevCancelled && newActive) {
      // 🔄 Un-cancel → re-upsert into activeCoupons
      for (const c of orderCoupons) {
        await upsertActiveCoupon(cCol, customerId, c, orderId, subHubId, log);
      }
      log.info({ customerId, orderId }, "Coupon lifecycle: activeCoupons upserted (un-cancelled)");
    } else if (prevCancelled && newDelivered) {
      // Rare: cancelled → delivered directly
      const entries = orderCoupons.map((c) => ({ ...c, orderId, subHubId: subHubId ?? "", usedAt: new Date() }));
      await cCol.updateOne({ _id: cid }, { $push: { usedCoupons: { $each: entries } } });
      log.info({ customerId, orderId }, "Coupon lifecycle: added to usedCoupons (cancelled→delivered)");
    }
  } catch (e) {
    log.error({ err: e, customerId, orderId }, "Failed to sync customer coupon lifecycle");
  }
}

/** Returns today's date string in YYYYMMDD format using IST (UTC+5:30). */
function getTodayIST(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** Returns today's date in YYYY-MM-DD format (IST), matching the deliveryDate field. */
function getTodayISODate(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Returns tomorrow's date in YYYY-MM-DD format (IST), matching the deliveryDate field. */
function getTomorrowISODate(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  ist.setUTCDate(ist.getUTCDate() + 1);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Atomically generates the next sequential FishTokri order ID for today.
 * Format: #FTSYYYYMMDD{N}  e.g. #FTS202605261, #FTS202605262 …
 * Counter resets each calendar day (IST).
 */
async function generateOrderId(db: any): Promise<string> {
  const dateStr = getTodayIST();
  const counter = await db.collection("order_id_counters").findOneAndUpdate(
    { _id: dateStr },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  const seq: number = counter?.seq ?? 1;
  return `#FTS${dateStr}${seq}`;
}

/**
 * Re-aggregates today's and tomorrow's order counts for a given timeslot and
 * writes them back to the timeslot document in the sub-hub's MongoDB database.
 * Called fire-and-forget after every order mutation that could affect a slot count.
 */
async function syncTimeslotOrderCounts(
  timeslotId: string,
  subHubName: string,
  log: any,
): Promise<void> {
  try {
    const now = new Date();
    const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const todayISO = `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
    const tomDate = new Date(ist.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowISO = `${tomDate.getUTCFullYear()}-${pad(tomDate.getUTCMonth() + 1)}-${pad(tomDate.getUTCDate())}`;

    const ordersConn = await getOrdersDb();
    const agg = await ordersConn.db.collection(COLLECTION).aggregate([
      {
        $match: {
          timeslotId,
          scheduleType: "slot",
          deliveryDate: { $in: [todayISO, tomorrowISO] },
          status: { $ne: "cancelled" },
        },
      },
      {
        $group: {
          _id: "$deliveryDate",
          count: { $sum: 1 },
        },
      },
    ]).toArray();

    let todaysOrderCount = 0;
    let nextDayOrderCount = 0;
    for (const row of agg as any[]) {
      if (row._id === todayISO) todaysOrderCount = row.count;
      else if (row._id === tomorrowISO) nextDayOrderCount = row.count;
    }

    const subHubConn = await getSubHubDbConnection(subHubName);
    await subHubConn.db.collection("timeslots").updateOne(
      { _id: new mongoose.Types.ObjectId(timeslotId) },
      {
        $set: { todaysOrderCount, nextDayOrderCount },
        $unset: { todaysOrderDate: "", nextDayOrderDate: "" },
      },
    );

    log.info({ timeslotId, subHubName, todaysOrderCount, nextDayOrderCount }, "Timeslot order counts synced to DB");
  } catch (e) {
    log.warn({ err: e, timeslotId, subHubName }, "Failed to sync timeslot order counts (non-fatal)");
  }
}

// GET /api/orders — list with search, filter, sort, pagination
router.get("/", async (req: ScopedRequest, res) => {
  try {
    const conn = await getOrdersDb();
    const db = conn.db;
    try {
      await ensureFtwPendingPaymentExpiryDates(db.collection(COLLECTION));
    } catch (err) {
      req.log.error({ err }, "Could not initialize FTW payment expiry timestamps");
    }

    const {
      q = "",
      status = "",
      deliveryType = "",
      tab = "",
      sort = "createdAt",
      order = "desc",
      page = "1",
      limit = "20",
      from = "",
      to = "",
      assignedTo = "",
      deliveryDateFilter = "",
      orderType = "",
    } = req.query as Record<string, string>;

    const filter: any = {};

    // Deleted tab: show only soft-deleted orders. All other tabs exclude them.
    const isDeletedTab = tab === "deleted";
    filter.isDeleted = isDeletedTab ? true : { $ne: true };
    if (orderType === "preorder") filter.orderType = "preorder";

    if (q) {
      const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const words = q.trim().split(/\s+/).filter(Boolean);

      const buildWordClause = (word: string) => {
        const re = { $regex: escapeRe(word), $options: "i" };
        const orClauses: any[] = [
          { customerName: re },
          { phone: re },
          { deliveryArea: re },
          { address: re },
          { "items.name": re },
          { orderId: re },
          // Match total amount — exact numeric match or partial string match
          ...(word.replace(/^#/, "").replace(/[^0-9.]/g, "").length > 0
            ? [
                {
                  $expr: {
                    $regexMatch: {
                      input: { $toString: "$total" },
                      regex: escapeRe(word.replace(/[^0-9.]/g, "")),
                    },
                  },
                },
              ]
            : []),
        ];
        // Also match by ObjectId hex — full (24 chars) or trailing fragment.
        // Strip leading '#' so searching '#FTS...' and 'FTS...' both work via orderId above;
        // hex fragment matching only applies to the raw _id hex string.
        const hex = word.replace(/^#/, "").toLowerCase();
        if (/^[0-9a-f]+$/.test(hex)) {
          if (hex.length === 24) {
            const oid = toId(hex);
            if (oid) orClauses.push({ _id: oid });
          } else {
            orClauses.push({
              $expr: {
                $regexMatch: {
                  input: { $toString: "$_id" },
                  regex: `${hex}$`,
                  options: "i",
                },
              },
            });
          }
        }
        return { $or: orClauses };
      };

      if (words.length === 1) {
        // Single word: set $or directly so the tab-history handler can wrap it.
        filter.$or = buildWordClause(words[0]).$or;
      } else {
        // Multiple words: each word must match at least one field ($and of $or).
        // The tab-history handler checks filter.$or — since it's unset here, it
        // will add the status clause as a new top-level $or which MongoDB ANDs
        // with our $and, giving correct results.
        filter.$and = words.map(buildWordClause);
      }
    }

    if (!isDeletedTab) {
      // Tab semantics: takeaway-deliveryType orders are always treated as completed (History).
      // - "current": active statuses AND deliveryType != takeaway
      // - "history": history statuses OR deliveryType == takeaway
      const ACTIVE = ["pending", "confirmed", "out_for_delivery"];
      const HISTORY = ["delivered", "cancelled"];

      const statusList = status
        ? status.split(",").map((s: string) => s.trim()).filter(Boolean)
        : [];

      if (tab === "current") {
        const list = statusList.length ? statusList.filter((s) => ACTIVE.includes(s)) : ACTIVE;
        filter.status = { $in: list };
        filter.deliveryType = { $ne: "takeaway" };
      } else if (tab === "history") {
        const list = statusList.length ? statusList.filter((s) => HISTORY.includes(s)) : HISTORY;
        filter.$or = [
          ...(filter.$or ?? []).map((c: any) => ({ ...c })),
        ];
        const historyClause = { $or: [{ status: { $in: list } }, { deliveryType: "takeaway" }] };
        if (filter.$or && filter.$or.length) {
          filter.$and = [{ $or: filter.$or }, historyClause];
          delete filter.$or;
        } else {
          Object.assign(filter, historyClause);
        }
      } else if (statusList.length) {
        filter.status = statusList.length === 1 ? statusList[0] : { $in: statusList };
      }
      if (deliveryType) filter.deliveryType = deliveryType;
      if (assignedTo) filter.assignedDeliveryPersonId = assignedTo;

      // Date range filter — matches on deliveryDate (YYYY-MM-DD string).
      // Orders with no deliveryDate set are excluded when a range is active,
      // since they have no scheduled delivery date to match against.
      if (from || to) {
        const dateRangeClause: any = {};
        if (from) dateRangeClause.$gte = from; // string comparison works for YYYY-MM-DD
        if (to) dateRangeClause.$lte = to;
        filter.deliveryDate = dateRangeClause;
      }

      // deliveryDateFilter: "today"    = today, past, or no date set (Current Orders)
      //                     "tomorrow" = only tomorrow's date (Next Day Orders)
      if (deliveryDateFilter === "today" || deliveryDateFilter === "tomorrow" || deliveryDateFilter === "other") {
        const todayISO = getTodayISODate();
        const tomorrowISO = getTomorrowISODate();
        if (deliveryDateFilter === "today") {
          // Current Orders: no date, empty, today, or any past date (deliveryDate <= today)
          const todayClause = {
            $or: [
              { deliveryDate: null },
              { deliveryDate: "" },
              { deliveryDate: { $exists: false } },
              { deliveryDate: { $lte: todayISO } },
            ],
          };
          if (!filter.$and) filter.$and = [];
          if (filter.$or) {
            filter.$and.unshift({ $or: filter.$or });
            delete filter.$or;
          }
          filter.$and.push(todayClause);
        } else {
          // "tomorrow" / "other": exactly tomorrow's date only
          filter.deliveryDate = tomorrowISO;
        }
      }
    }

    const sortDir = order === "asc" ? 1 : -1;
    const sortObj: any = {};
    const allowedSorts = ["createdAt", "customerName", "status"];
    sortObj[allowedSorts.includes(sort) ? sort : "createdAt"] = sortDir;

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (pageNum - 1) * limitNum;

    const scopedFilter = applyOrderScope(filter, req);
    if (scopedFilter === null) {
      res.json({ orders: [], total: 0, page: pageNum, limit: limitNum, pages: 0 });
      return;
    }

    const [orders, total] = await Promise.all([
      db.collection(COLLECTION).find(scopedFilter).sort(sortObj).skip(skip).limit(limitNum).toArray(),
      db.collection(COLLECTION).countDocuments(scopedFilter),
    ]);

    const displayOrders = await enrichOrderTimeslots(orders as any[], req.log);
    let mongoServerNow = new Date();
    if (displayOrders.some((order: any) => isFtwPaymentOnHold(order) && String(order.paymentStatus).toLowerCase() === "pending")) {
      try {
        const hello = await db.admin().command({ hello: 1 });
        if (hello.localTime instanceof Date) mongoServerNow = hello.localTime;
      } catch (err) {
        req.log.warn({ err }, "Could not read MongoDB server time for FTW payment countdown");
      }
    }
    res.json({
      orders: displayOrders,
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum),
      mongoServerNow,
    });

    // Fire-and-forget: deduct inventory for any active orders that arrived without
    // going through applyOrderInventoryOnCreate (e.g. customer-app-created orders).
    autoDeductUndedcutedOrders(conn.db, displayOrders as any[]).catch((e) =>
      req.log.error({ err: e }, "autoDeductUndedcutedOrders failed")
    );
  } catch (err) {
    req.log.error({ err }, "Failed to list orders");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch orders" });
  }
});

// GET /api/orders/stats — summary counts per status
router.get("/stats", async (req: ScopedRequest, res) => {
  try {
    const conn = await getOrdersDb();
    const scopeClause = scopeOrderFilter(req);
    if (scopeClause === null) {
      res.json({ stats: {}, rawStats: {}, total: 0, currentTotal: 0, historyTotal: 0, todayTotal: 0, otherDayTotal: 0, preorderTotal: 0 });
      return;
    }
    const pipeline: any[] = [];
    // Always exclude soft-deleted orders from normal stats.
    pipeline.push({ $match: { ...scopeClause, isDeleted: { $ne: true } } });
    pipeline.push({ $group: { _id: { status: "$status", deliveryType: "$deliveryType" }, count: { $sum: 1 } } });
    const agg = await conn.db.collection(COLLECTION).aggregate(pipeline).toArray();

    const ACTIVE = ["pending", "confirmed", "out_for_delivery"];
    const HISTORY = ["delivered", "cancelled"];

    // Raw per-status counts (used by some legacy callers).
    const rawStats: Record<string, number> = {};
    // Display stats: takeaway-deliveryType orders are bucketed under "takeaway",
    // not under their underlying status. Delivered/cancelled keep their status.
    const stats: Record<string, number> = {};
    let takeawayActive = 0;
    let takeawayHistory = 0;

    for (const row of agg) {
      const st = row._id?.status ?? "unknown";
      const dt = row._id?.deliveryType ?? "delivery";
      const c = row.count ?? 0;
      rawStats[st] = (rawStats[st] ?? 0) + c;
      if (dt === "takeaway") {
        if (HISTORY.includes(st)) {
          // Delivered/cancelled takeaway orders count under their final status,
          // not under the Takeaway bucket.
          stats[st] = (stats[st] ?? 0) + c;
          takeawayHistory += c;
        } else {
          takeawayActive += c;
        }
      } else {
        stats[st] = (stats[st] ?? 0) + c;
      }
    }
    stats.takeaway = takeawayActive;

    const total = Object.values(rawStats).reduce((a, b) => a + b, 0);
    const currentTotal = ACTIVE.reduce((s, k) => s + (stats[k] ?? 0), 0);
    const historyTotal = HISTORY.reduce((s, k) => s + (stats[k] ?? 0), 0) + takeawayActive;

    // Current / next-day counts for the tab badges
    // Current Orders = today, past, or no date set
    // Next Day Orders = exactly tomorrow's date
    const todayISO = getTodayISODate();
    const tomorrowISO = getTomorrowISODate();
    const activeNonTakeaway = {
      ...scopeClause,
      isDeleted: { $ne: true },
      status: { $in: ACTIVE },
      deliveryType: { $ne: "takeaway" },
    };
    const [todayTotal, otherDayTotal] = await Promise.all([
      conn.db.collection(COLLECTION).countDocuments({
        ...activeNonTakeaway,
        $or: [
          { deliveryDate: null },
          { deliveryDate: "" },
          { deliveryDate: { $exists: false } },
          { deliveryDate: { $lte: todayISO } },
        ],
      }),
      conn.db.collection(COLLECTION).countDocuments({
        ...activeNonTakeaway,
        deliveryDate: tomorrowISO,
      }),
    ]);

    // Count soft-deleted orders for the Deleted tab badge.
    const deletedTotal = await conn.db.collection(COLLECTION).countDocuments({ ...scopeClause, isDeleted: true });
    const preorderTotal = await conn.db.collection(COLLECTION).countDocuments({
      ...scopeClause,
      isDeleted: { $ne: true },
      orderType: "preorder",
    });

    res.json({ stats, rawStats, total, currentTotal, historyTotal, todayTotal, otherDayTotal, preorderTotal, deletedTotal });
  } catch (err) {
    req.log.error({ err }, "Failed to get order stats");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch order stats" });
  }
});

// GET /api/orders/delivery-stats?assignedTo=ID — scoped stats for a delivery person
router.get("/delivery-stats", async (req: ScopedRequest, res) => {
  try {
    const { assignedTo = "" } = req.query as Record<string, string>;
    if (!assignedTo) {
      res.status(400).json({ error: "ValidationError", message: "assignedTo is required" });
      return;
    }

    const conn = await getOrdersDb();
    const col = conn.db.collection(COLLECTION);
    // Hub admins (super_hub / sub_hub) see only delivery stats from their own
    // hubs. Master admin and the delivery person themself see everything for
    // the assigned ID.
    const baseFilter: any = { assignedDeliveryPersonId: assignedTo };
    const scope = req.scope;
    if (scope && !scope.isMaster && scope.role !== "delivery_person") {
      if (scope.subHubIds.length === 0) {
        res.json({
          statusCounts: { pending: 0, confirmed: 0, out_for_delivery: 0, delivered: 0, cancelled: 0 },
          totalAssigned: 0, activeCount: 0,
          today: { count: 0, revenue: 0, total: 0 }, week: { count: 0, revenue: 0, total: 0 },
          month: { count: 0, revenue: 0, total: 0 }, allTime: { count: 0, revenue: 0, total: 0 },
          monthly: [], recent: [],
        });
        return;
      }
      baseFilter.subHubId = { $in: scope.subHubIds };
    }

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfDay.getDate() - 6); // last 7 days inclusive
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    function totalExpr() {
      // Prefer order.total when present; otherwise sum items.price * items.quantity.
      return {
        $cond: [
          { $gt: [{ $ifNull: ["$total", 0] }, 0] },
          "$total",
          {
            $sum: {
              $map: {
                input: { $ifNull: ["$items", []] },
                as: "i",
                in: {
                  $multiply: [
                    { $ifNull: ["$$i.price", 0] },
                    { $ifNull: ["$$i.quantity", 1] },
                  ],
                },
              },
            },
          },
        ],
      };
    }

    const [statusAgg, todayAgg, weekAgg, monthAgg, totalsAgg, monthlyAgg, recent] = await Promise.all([
      // status counts
      col.aggregate([
        { $match: baseFilter },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]).toArray(),

      // today delivered (count + revenue collected)
      col.aggregate([
        { $match: { ...baseFilter, status: "delivered", updatedAt: { $gte: startOfDay } } },
        { $group: {
            _id: null,
            count: { $sum: 1 },
            revenue: { $sum: { $ifNull: ["$paidAmount", 0] } },
            total:   { $sum: totalExpr() },
        } },
      ]).toArray(),

      // last 7 days delivered
      col.aggregate([
        { $match: { ...baseFilter, status: "delivered", updatedAt: { $gte: startOfWeek } } },
        { $group: {
            _id: null,
            count: { $sum: 1 },
            revenue: { $sum: { $ifNull: ["$paidAmount", 0] } },
            total:   { $sum: totalExpr() },
        } },
      ]).toArray(),

      // current month delivered
      col.aggregate([
        { $match: { ...baseFilter, status: "delivered", updatedAt: { $gte: startOfMonth } } },
        { $group: {
            _id: null,
            count: { $sum: 1 },
            revenue: { $sum: { $ifNull: ["$paidAmount", 0] } },
            total:   { $sum: totalExpr() },
        } },
      ]).toArray(),

      // all-time delivered totals
      col.aggregate([
        { $match: { ...baseFilter, status: "delivered" } },
        { $group: {
            _id: null,
            count: { $sum: 1 },
            revenue: { $sum: { $ifNull: ["$paidAmount", 0] } },
            total:   { $sum: totalExpr() },
        } },
      ]).toArray(),

      // monthly trend (last 6 months) — delivered count + revenue collected
      col.aggregate([
        { $match: { ...baseFilter, status: "delivered", updatedAt: { $gte: sixMonthsAgo } } },
        { $group: {
            _id: { y: { $year: "$updatedAt" }, m: { $month: "$updatedAt" } },
            count:   { $sum: 1 },
            revenue: { $sum: { $ifNull: ["$paidAmount", 0] } },
            total:   { $sum: totalExpr() },
        } },
        { $sort: { "_id.y": 1, "_id.m": 1 } },
      ]).toArray(),

      // recent 5 orders (any status)
      col.find(baseFilter).sort({ createdAt: -1 }).limit(5).toArray(),
    ]);

    const statusCounts: Record<string, number> = {
      pending: 0, confirmed: 0, out_for_delivery: 0, delivered: 0, cancelled: 0,
    };
    for (const row of statusAgg) {
      const k = String((row as any)._id ?? "unknown");
      statusCounts[k] = (statusCounts[k] ?? 0) + ((row as any).count ?? 0);
    }
    const totalAssigned = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const activeCount =
      statusCounts.pending + statusCounts.confirmed +
      statusCounts.out_for_delivery;

    function pickAgg(rows: any[]) {
      const r = rows[0] ?? {};
      return {
        count:   Number(r.count   ?? 0),
        revenue: Number(r.revenue ?? 0),
        total:   Number(r.total   ?? 0),
      };
    }

    // Build a 6-month window (fill empty months with zeros).
    const monthlyMap = new Map<string, { count: number; revenue: number; total: number }>();
    for (const row of monthlyAgg) {
      const id: any = (row as any)._id;
      const key = `${id.y}-${String(id.m).padStart(2, "0")}`;
      monthlyMap.set(key, {
        count:   Number((row as any).count   ?? 0),
        revenue: Number((row as any).revenue ?? 0),
        total:   Number((row as any).total   ?? 0),
      });
    }
    const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthly: any[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const v = monthlyMap.get(key) ?? { count: 0, revenue: 0, total: 0 };
      monthly.push({
        month: `${monthLabels[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`,
        delivered: v.count,
        revenue:   v.revenue,
        total:     v.total,
      });
    }

    res.json({
      statusCounts,
      totalAssigned,
      activeCount,
      today:  pickAgg(todayAgg),
      week:   pickAgg(weekAgg),
      month:  pickAgg(monthAgg),
      allTime: pickAgg(totalsAgg),
      monthly,
      recent,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get delivery stats");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch delivery stats" });
  }
});

/** Returns true if the order document is in the request user's scope. */
function isOrderInScope(scope: ScopedRequest["scope"], order: any, req?: ScopedRequest): boolean {
  if (!scope || scope.isMaster) return true;
  if (scope.role === "delivery_person") {
    const uid = req?.admin?.adminId ? String(req.admin.adminId) : "";
    const assigned = order?.assignedDeliveryPersonId ? String(order.assignedDeliveryPersonId) : "";
    return !!uid && uid === assigned;
  }
  const subId = order?.subHubId ? String(order.subHubId) : "";
  return !!subId && scope.subHubIds.includes(subId);
}

// POST /api/orders — create new order manually (admin)
router.post("/", async (req: ScopedRequest, res) => {
  try {
    const {
      customerId,
      customerName,
      phone,
      email,
      items,
      deliveryType,
      address,
      deliveryArea,
      notes,
      status,
      subHubId,
      subHubName,
      superHubId,
      superHubName,
      createCustomerIfMissing,
      newCustomerExtras,
      deliveryAddressDetail,
      subtotal,
      discount,
      slotCharge,
      deliveryCharge,
      extraDiscount,
      extraDiscountType,
      total: totalIn,
      couponId,
      couponCode,
      couponTitle,
      couponIds,
      couponCodes,
      coupons,
      paymentStatus,
      payments,
      paidAmount,
      paymentMode,
      scheduleType,
      deliveryDate,
      timeslotId,
      timeslotLabel,
      timeslotStart,
      timeslotEnd,
      isExpress,
      orderType,
    } = req.body ?? {};

    // Fall back to the name stored in the delivery address if the account has no name
    let effectiveCustomerName = customerName && String(customerName).trim() ? String(customerName).trim() : "";
    if (!effectiveCustomerName && deliveryAddressDetail && typeof deliveryAddressDetail === "object") {
      const addrName = (deliveryAddressDetail as any).name || (deliveryAddressDetail as any).contactName || "";
      if (addrName && String(addrName).trim()) {
        effectiveCustomerName = String(addrName).trim();
      }
    }
    if (!effectiveCustomerName) {
      res.status(400).json({ error: "ValidationError", message: "Customer name is required" });
      return;
    }
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "ValidationError", message: "At least one item is required" });
      return;
    }
    const dt = deliveryType === "takeaway" ? "takeaway" : "delivery";
    if (dt === "delivery" && !String(address ?? "").trim()) {
      res.status(400).json({ error: "ValidationError", message: "Delivery address is required" });
      return;
    }
    const normalizedOrderType = DIRECT_ORDER_ONLY
      ? "normal"
      : orderType === "preorder" ? "preorder" : "normal";
    if (!DIRECT_ORDER_ONLY && normalizedOrderType === "preorder") {
      const preorderDate = String(deliveryDate ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(preorderDate) || preorderDate <= getTodayISODate()) {
        res.status(400).json({ error: "ValidationError", message: "Preorder delivery date must be a future date" });
        return;
      }
      if (dt !== "delivery") {
        res.status(400).json({ error: "ValidationError", message: "Preorders must use delivery" });
        return;
      }
    }

    const cleanItems = items.map((it: any) => ({
      productId: it.productId ? String(it.productId) : undefined,
      name: String(it.name ?? "").trim(),
      price: Number(it.price) || 0,
      quantity: Number(it.quantity) || 1,
      unit: it.unit ?? "",
      ...(it.inventoryBatchId ? {
        inventoryBatchId: String(it.inventoryBatchId),
        batchNumber: String(it.batchNumber ?? ""),
        fishWeightKg: Number(it.fishWeightKg) || undefined,
      } : {}),
      ...(Number(it.bulkWeightKg) > 0 ? { bulkWeightKg: Number(it.bulkWeightKg) } : {}),
    })).filter((it: any) => it.name);

    if (cleanItems.length === 0) {
      res.status(400).json({ error: "ValidationError", message: "Items must have a name" });
      return;
    }

    if (status !== undefined && status !== null && status !== "" && !VALID_ORDER_STATUSES.has(String(status))) {
      res.status(400).json({ error: "ValidationError", message: `Invalid order status: ${status}` });
      return;
    }

    // Enforce hub scope on order creation: hub admins can only create orders
    // inside their own sub hubs.
    if (req.scope && !req.scope.isMaster) {
      const reqSub = subHubId ? String(subHubId) : "";
      if (!reqSub || !req.scope.subHubIds.includes(reqSub)) {
        res.status(403).json({ error: "Forbidden", message: "You can only create orders for your assigned sub hubs." });
        return;
      }
    }

    let resolvedCustomerId: string | undefined = customerId ? String(customerId) : undefined;

    // Optionally create customer if missing
    if (!resolvedCustomerId && createCustomerIfMissing && (email || phone)) {
      const cCol = await getCustomersCollection();
      const existing = email
        ? await cCol.findOne({ email: String(email).toLowerCase().trim() })
        : await cCol.findOne({ phone: String(phone).trim() });
      if (existing) {
        resolvedCustomerId = String(existing._id);
      } else {
        const extras = (newCustomerExtras && typeof newCustomerExtras === "object") ? newCustomerExtras : {};
        const firstAddress =
          deliveryAddressDetail && typeof deliveryAddressDetail === "object"
            ? { label: "Home", ...deliveryAddressDetail }
            : dt === "delivery" && address
              ? { label: "Home", address: String(address).trim(), area: deliveryArea ?? "" }
              : null;
        const newCustomer = {
          name: effectiveCustomerName,
          email: email ? String(email).toLowerCase().trim() : "",
          phone: phone ? String(phone).trim() : "",
          alternatePhone: extras.alternatePhone ? String(extras.alternatePhone).trim() : "",
          dateOfBirth: extras.dateOfBirth ? String(extras.dateOfBirth).trim() : "",
          gender: extras.gender ? String(extras.gender).trim() : "",
          notes: extras.notes ? String(extras.notes).trim() : "",
          addresses: firstAddress ? [firstAddress] : [],
          orders: [],
          usedCoupons: [],
          activeCoupons: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const insert = await cCol.insertOne(newCustomer as any);
        resolvedCustomerId = String(insert.insertedId);
      }
    }

    const computedSubtotal = cleanItems.reduce((s: number, i: any) => s + i.price * i.quantity, 0);
    const sub = Number(subtotal);
    const subTotalNum = Number.isFinite(sub) && sub > 0 ? sub : computedSubtotal;
    const discountNum = Math.max(0, Number(discount) || 0);
    const slotChargeNum = DIRECT_ORDER_ONLY ? 0 : Math.max(0, Number(slotCharge) || 0);
    const deliveryChargeNum = Math.max(0, Number(deliveryCharge) || 0);
    const extraDiscountNum = Math.max(0, Number(extraDiscount) || 0);
    const hasIncomingTotal = totalIn !== undefined && totalIn !== null && totalIn !== "";
    const totalNum = DIRECT_ORDER_ONLY
      ? Math.max(0, subTotalNum - discountNum + deliveryChargeNum)
      : hasIncomingTotal && Number.isFinite(Number(totalIn))
        ? Math.max(0, Number(totalIn))
        : Math.max(0, subTotalNum - discountNum + slotChargeNum + deliveryChargeNum);

    const orderDoc: any = {
      customerId: resolvedCustomerId ?? undefined,
      customerName: effectiveCustomerName,
      phone: phone ? String(phone).trim() : "",
      email: email ? String(email).trim() : "",
      items: cleanItems,
      subtotal: subTotalNum,
      discount: discountNum,
      slotCharge: slotChargeNum,
      deliveryCharge: deliveryChargeNum,
      extraDiscount: extraDiscountNum,
      extraDiscountType: extraDiscountType ? String(extraDiscountType) : "flat",
      total: totalNum,
      deliveryType: dt,
      orderType: normalizedOrderType,
      address: dt === "delivery" ? String(address ?? "").trim() : "",
      deliveryArea: dt === "delivery" ? String(deliveryArea ?? "").trim() : "",
      deliveryAddressDetail: dt === "delivery" && deliveryAddressDetail ? deliveryAddressDetail : undefined,
      pickupLocation: dt === "takeaway" ? (subHubName || "FishTokri Store") : "",
      notes: notes ? String(notes).trim() : "",
      status: status || "pending",
      source: "admin_manual",
      subHubId: subHubId ? String(subHubId) : undefined,
      subHubName: subHubName ?? undefined,
      superHubId: superHubId ? String(superHubId) : undefined,
      superHubName: superHubName ?? undefined,
      // Coupons (single + multi)
      couponId: couponId ? String(couponId) : undefined,
      couponCode: couponCode ?? undefined,
      couponTitle: couponTitle ?? undefined,
      couponIds: Array.isArray(couponIds) ? couponIds.map((x: any) => String(x)) : undefined,
      couponCodes: Array.isArray(couponCodes) ? couponCodes.map((x: any) => String(x)) : undefined,
      coupons: Array.isArray(coupons) ? coupons : undefined,
      // Payment — if grand total is zero (e.g. fully covered by coupon/discount),
      // always mark the order as paid regardless of what the client sent.
      paymentStatus: totalNum === 0
        ? "paid"
        : ["paid", "partial", "unpaid"].includes(String(paymentStatus))
          ? String(paymentStatus)
          : "unpaid",
      payments: Array.isArray(payments)
        ? payments
            .map((p: any) => ({
              mode: String(p?.mode ?? "").trim(),
              amount: Math.max(0, Number(p?.amount) || 0),
              reference: p?.reference ? String(p.reference).trim() : "",
              paidAt: p?.paidAt ? new Date(p.paidAt) : new Date(),
            }))
            .filter((p: any) => p.mode && p.amount > 0)
        : [],
      paidAmount: totalNum === 0 ? 0 : Math.max(0, Number(paidAmount) || 0),
      dueAmount: (totalNum === 0 || String(paymentStatus) === "paid") ? 0 : Math.max(0, totalNum - (Number(paidAmount) || 0)),
      paymentMode: paymentMode ? String(paymentMode) : undefined,
      // Schedule
      scheduleType: DIRECT_ORDER_ONLY ? "instant" : scheduleType === "instant" ? "instant" : scheduleType === "express" ? "express" : "slot",
      isExpress: DIRECT_ORDER_ONLY ? false : !!isExpress,
      deliveryDate: DIRECT_ORDER_ONLY
        ? getTodayISODate()
        : deliveryDate ? String(deliveryDate) : undefined,
      timeslotId: TIMESLOT_FEATURE_ENABLED && timeslotId ? String(timeslotId) : undefined,
      timeslotLabel: TIMESLOT_FEATURE_ENABLED ? timeslotLabel ?? undefined : undefined,
      timeslotStart: TIMESLOT_FEATURE_ENABLED ? timeslotStart ?? undefined : undefined,
      timeslotEnd: TIMESLOT_FEATURE_ENABLED ? timeslotEnd ?? undefined : undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    Object.keys(orderDoc).forEach((k) => orderDoc[k] === undefined && delete orderDoc[k]);

    // --- Coupon maxUsage enforcement (BEFORE insert) ---
    // Check the coupon's maxUsage limit against the customer's total usage
    // (active orders + historically delivered orders). Blocks if the limit
    // has been reached. Also prunes any stale activeCoupons entries whose
    // referenced orders no longer exist.
    const preCheckCoupons = extractOrderCoupons(orderDoc);
    if (preCheckCoupons.length > 0 && resolvedCustomerId) {
      const cColPre = await getCustomersCollection();
      const customerDoc = await cColPre.findOne(
        { _id: toId(resolvedCustomerId) },
        { projection: { activeCoupons: 1, usedCoupons: 1 } },
      );

      for (const reqCoupon of preCheckCoupons) {
        // Count how many times this coupon is currently locked in active orders.
        const activeEntry = (customerDoc?.activeCoupons ?? []).find(
          (ac: any) => String(ac.couponId).trim() === reqCoupon.couponId,
        );
        // For old-format entries (no usedCount field), assume usedCount=1 if any entry exists.
        const activeUsedCount = activeEntry
          ? (activeEntry.usedCount != null ? (Number(activeEntry.usedCount) || 0) : 1)
          : 0;

        // Build the orderIds list — handle both new format (orderIds[]) and old format (orderId string).
        const rawOrderIds: string[] = activeEntry
          ? (Array.isArray(activeEntry.orderIds) && activeEntry.orderIds.length > 0
              ? activeEntry.orderIds
              : activeEntry.orderId
                ? [String(activeEntry.orderId)]
                : [])
          : [];

        // Prune stale orderIds from this entry (orders that no longer exist).
        if (activeEntry && rawOrderIds.length > 0) {
          const ordersConn = await getOrdersDb();
          const parsedIds = rawOrderIds
            .map((id: string) => { try { return toId(String(id)); } catch { return null; } })
            .filter(Boolean);
          const existingOrders = parsedIds.length > 0
            ? await ordersConn.db.collection(COLLECTION)
                .find({ _id: { $in: parsedIds } }, { projection: { _id: 1 } })
                .toArray()
            : [];
          const existingOrderIdSet = new Set(existingOrders.map((o: any) => String(o._id)));
          const staleOrderIds = rawOrderIds.filter((id: string) => !existingOrderIdSet.has(String(id)));
          if (staleOrderIds.length > 0) {
            for (const staleId of staleOrderIds) {
              await decrementActiveCoupon(cColPre, resolvedCustomerId!, reqCoupon.couponId, staleId, req.log);
            }
            req.log.info({ customerId: resolvedCustomerId, staleOrderIds }, "Pruned stale activeCoupons orderIds");
          }
          // Recompute activeUsedCount after pruning
          const refreshed = await cColPre.findOne(
            { _id: toId(resolvedCustomerId) },
            { projection: { activeCoupons: 1 } },
          );
          const refreshedEntry = (refreshed?.activeCoupons ?? []).find(
            (ac: any) => String(ac.couponId).trim() === reqCoupon.couponId,
          );
          // Use refreshed count going forward
          const liveActiveCount = refreshedEntry ? (Number(refreshedEntry.usedCount) || 0) : 0;

          // Count past (delivered) uses
          const historicalCount = (customerDoc?.usedCoupons ?? []).filter(
            (uc: any) => String(uc.couponId).trim() === reqCoupon.couponId,
          ).length;

          const totalUsage = liveActiveCount + historicalCount;

          // Fetch the coupon from the sub-hub DB to get maxUsage
          if (orderDoc.subHubName) {
            try {
              const subHubConn = await getSubHubDbConnection(String(orderDoc.subHubName));
              const couponDoc = await subHubConn.db.collection("coupons").findOne(
                { _id: toId(reqCoupon.couponId) },
                { projection: { maxUsage: 1, isActive: 1 } },
              );
              if (couponDoc && couponDoc.maxUsage != null) {
                const maxUsage = Number(couponDoc.maxUsage);
                if (maxUsage > 0 && totalUsage >= maxUsage) {
                  res.status(400).json({
                    error: "CouponUsageLimitReached",
                    message: `Coupon "${reqCoupon.couponCode || reqCoupon.couponId}" has reached its maximum usage limit for this customer.`,
                  });
                  return;
                }
              }
            } catch (e) {
              req.log.warn({ err: e, couponId: reqCoupon.couponId }, "Could not fetch coupon for maxUsage check — allowing");
            }
          }
          continue;
        }

        // No active entry with orderIds to prune — just check usage counts directly
        const historicalCount = (customerDoc?.usedCoupons ?? []).filter(
          (uc: any) => String(uc.couponId).trim() === reqCoupon.couponId,
        ).length;
        const totalUsage = activeUsedCount + historicalCount;

        if (orderDoc.subHubName) {
          try {
            const subHubConn = await getSubHubDbConnection(String(orderDoc.subHubName));
            const couponDoc = await subHubConn.db.collection("coupons").findOne(
              { _id: toId(reqCoupon.couponId) },
              { projection: { maxUsage: 1, isActive: 1 } },
            );
            if (couponDoc && couponDoc.maxUsage != null) {
              const maxUsage = Number(couponDoc.maxUsage);
              if (maxUsage > 0 && totalUsage >= maxUsage) {
                res.status(400).json({
                  error: "CouponUsageLimitReached",
                  message: `Coupon "${reqCoupon.couponCode || reqCoupon.couponId}" has reached its maximum usage limit for this customer.`,
                });
                return;
              }
            }
          } catch (e) {
            req.log.warn({ err: e, couponId: reqCoupon.couponId }, "Could not fetch coupon for maxUsage check — allowing");
          }
        }
      }
    }
    // --- End coupon maxUsage enforcement ---

    const conn = await getOrdersDb();
    orderDoc.orderId = await generateOrderId(conn.db);
    const result = await conn.db.collection(COLLECTION).insertOne(orderDoc);

    // Sync inventory (deduct stock for active orders).
    // Pre-claim the order with inventoryDeducted=true BEFORE calling applyOrderInventoryOnCreate.
    // This prevents the background deduction job from racing between the insert and the flag
    // being set — without this guard, both the POST handler and the background job could both
    // see inventoryDeducted=false and each deduct independently, causing a double deduction.
    const ORDER_DEDUCT_STATUSES = new Set(["pending", "confirmed", "out_for_delivery", "delivered", "takeaway"]);
    const shouldDeductOnCreate = ORDER_DEDUCT_STATUSES.has(String(orderDoc.status)) && !!orderDoc.subHubId;
    if (shouldDeductOnCreate) {
      await conn.db.collection(COLLECTION).updateOne(
        { _id: result.insertedId },
        { $set: { inventoryDeducted: true } }
      );
      orderDoc.inventoryDeducted = true;
    }
    try {
      req.log.info({ orderId: String(result.insertedId), subHubId: orderDoc.subHubId, status: orderDoc.status, itemCount: (orderDoc.items ?? []).length }, "order create: calling applyOrderInventoryOnCreate");
      const deducted = await applyOrderInventoryOnCreate({
        _id: result.insertedId,
        subHubId: orderDoc.subHubId,
        subHubName: orderDoc.subHubName,
        status: orderDoc.status,
        items: orderDoc.items,
      });
      req.log.info({ orderId: String(result.insertedId), deducted }, "order create: applyOrderInventoryOnCreate returned");
      if (!deducted && shouldDeductOnCreate) {
        // applyDelta found no matching products — reset flag so background job can retry later.
        await conn.db.collection(COLLECTION).updateOne(
          { _id: result.insertedId },
          { $set: { inventoryDeducted: false } }
        );
        orderDoc.inventoryDeducted = false;
      }
    } catch (e) {
      if (e instanceof InsufficientStockError) {
        // Race condition: another order just took the last unit inside the lock.
        // Reset the pre-claim flag and cancel the just-inserted order.
        req.log.warn(
          { orderId: String(result.insertedId), product: e.productName, available: e.available, requested: e.requested },
          "order create: insufficient stock — cancelling order and returning 409"
        );
        try {
          await conn.db.collection(COLLECTION).updateOne(
            { _id: result.insertedId },
            { $set: { status: "cancelled", cancelReason: "out_of_stock", updatedAt: new Date(), inventoryDeducted: false } }
          );
        } catch (cancelErr) {
          req.log.error({ err: cancelErr, orderId: String(result.insertedId) }, "order create: failed to cancel oversell order");
        }
        res.status(409).json({
          error: "InsufficientStock",
          message: `"${e.productName}" is out of stock (only ${e.available} available, you requested ${e.requested}). Please update your order.`,
          productName: e.productName,
          available: e.available,
          requested: e.requested,
        });
        return;
      }
      // General deduction error — reset flag so background job can retry.
      if (shouldDeductOnCreate) {
        await conn.db.collection(COLLECTION).updateOne(
          { _id: result.insertedId },
          { $set: { inventoryDeducted: false } }
        );
        orderDoc.inventoryDeducted = false;
      }
      req.log.error({ err: e }, "Failed to sync inventory on order create");
    }

    // Mirror order payments into banking ▸ payments so the ledger stays in sync.
    if (Array.isArray(orderDoc.payments) && orderDoc.payments.length > 0) {
      try {
        await syncOrderBankPayments({
          orderId: String(result.insertedId),
          customerName: orderDoc.customerName,
          payments: orderDoc.payments,
          orderRef: `#${String(result.insertedId).slice(-6).toUpperCase()}`,
        });
      } catch (e) {
        req.log.error({ err: e }, "Failed to sync order payments to banking");
      }
    }

    // Deduct wallet balance if customer paid (partially or fully) using wallet.
    // Guarded atomically against the live balance so a stale client-computed amount
    // (e.g. balance changed by another order between page load and submit) can never
    // push walletBalance negative — the update only applies if balance >= walletUsed.
    const walletPayments = (orderDoc.payments ?? []).filter((p: any) => p.mode === "wallet");
    const walletUsed = walletPayments.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
    if (walletUsed > 0 && resolvedCustomerId) {
      try {
        const cCol = await getCustomersCollection();
        const custOid = new mongoose.Types.ObjectId(String(resolvedCustomerId));
        const claim = await cCol.updateOne(
          { _id: custOid, walletBalance: { $gte: walletUsed } },
          {
            $inc: { walletBalance: -walletUsed },
            $push: {
              walletTransactions: {
                amount: -walletUsed,
                type: "debit",
                reason: "Order placed — wallet deducted",
                createdAt: new Date(),
                orderId: String(orderDoc.orderId || ""),
                orderRef: String(result.insertedId),
              },
            },
          }
        );
        if (claim.matchedCount === 0) {
          req.log.error(
            { customerId: resolvedCustomerId, walletUsed },
            "Wallet deduction on order create rejected — insufficient live balance (stale client amount)"
          );
        } else {
          req.log.info({ customerId: resolvedCustomerId, deducted: walletUsed }, "Wallet deducted on order create");
        }
      } catch (e) {
        req.log.error({ err: e }, "Failed to deduct wallet on order create");
      }
    }

    // Track coupon in customer's activeCoupons using the aggregated structure
    // (one entry per coupon, usedCount incremented per order).
    const orderCouponsOnCreate = extractOrderCoupons(orderDoc);
    if (orderCouponsOnCreate.length > 0 && resolvedCustomerId && orderDoc.status !== "cancelled") {
      const cCol = await getCustomersCollection();
      const orderId = String(result.insertedId);
      for (const c of orderCouponsOnCreate) {
        await upsertActiveCoupon(cCol, resolvedCustomerId, c, orderId, orderDoc.subHubId ?? "", req.log);
      }
      req.log.info({ customerId: resolvedCustomerId, orderId, coupons: orderCouponsOnCreate.length }, "Coupon lifecycle: upserted activeCoupons on order create");
    }

    res.status(201).json({ order: { ...orderDoc, _id: result.insertedId } });

    // Sync timeslot order counts to MongoDB immediately after creating an order.
    if (TIMESLOT_FEATURE_ENABLED && scheduleType === "slot" && timeslotId && orderDoc.subHubName) {
      syncTimeslotOrderCounts(String(timeslotId), String(orderDoc.subHubName), req.log);
    }
  } catch (err) {
    req.log.error({ err }, "Failed to create order");
    res.status(500).json({ error: "InternalError", message: "Failed to create order" });
  }
});

// GET /api/orders/:id/qr-token — generate the server-signed value printed on invoices.
router.get("/:id/qr-token", async (req: ScopedRequest, res) => {
  try {
    const oid = toId(req.params.id);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid order ID" }); return; }
    const conn = await getOrdersDb();
    const order = await conn.db.collection(COLLECTION).findOne({ _id: oid });
    if (!order || !isOrderInScope(req.scope, order, req)) {
      res.status(404).json({ error: "NotFound", message: "Order not found" }); return;
    }
    const token = createOrderQrToken(String(order._id));
    res.json({
      token,
      url: `${ORDER_QR_PUBLIC_URL}?order_qr=${encodeURIComponent(token)}`,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to create order QR token");
    res.status(500).json({ error: "InternalError", message: "Failed to create order QR token" });
  }
});

// POST /api/orders/dispatch-by-qr — claim an order for the authenticated delivery partner.
router.post("/dispatch-by-qr", async (req: ScopedRequest, res) => {
  try {
    if (req.scope?.role !== "delivery_person" || !req.admin?.adminId) {
      res.status(403).json({ error: "Forbidden", message: "Only delivery partners can scan order QR codes" });
      return;
    }
    const orderId = verifyOrderQrToken(req.body?.token);
    const oid = orderId ? toId(orderId) : null;
    if (!oid) {
      res.status(400).json({ error: "InvalidQr", message: "This is not a valid FishTokri order QR code" });
      return;
    }

    const conn = await getOrdersDb();
    const collection = conn.db.collection(COLLECTION);
    const existing = await collection.findOne({ _id: oid });
    if (!existing) {
      res.status(404).json({ error: "NotFound", message: "Order not found" });
      return;
    }
    if (isFtwPaymentOnHold(existing)) {
      res.status(409).json({
        error: "FtwPaymentPending",
        message: "This FTW order cannot be dispatched until payment is completed.",
      });
      return;
    }
    const orderStatus = String(existing.status ?? "").toLowerCase();
    if (["cancelled", "canceled", "delivered", "rejected"].includes(orderStatus)) {
      const statusLabel = orderStatus === "delivered"
        ? "delivered"
        : orderStatus === "rejected"
          ? "rejected"
          : "cancelled";
      res.status(409).json({
        error: "Unavailable",
        orderStatus,
        message: `This order is already ${statusLabel}.`,
      });
      return;
    }
    if (String(existing.deliveryType ?? "").toLowerCase() === "takeaway" || existing.status === "takeaway") {
      res.status(409).json({ error: "Unavailable", message: "Takeaway orders cannot be dispatched for delivery" });
      return;
    }
    if (orderStatus === "pending") {
      res.status(409).json({
        error: "Pending",
        orderStatus,
        message: "This order is currently pending.",
      });
      return;
    }
    const currentAssignee = String(existing.assignedDeliveryPersonId ?? "");
    if (currentAssignee) {
      const assignedName = String(
        existing.assignedDeliveryPersonName ||
        existing.deliveryPersonName ||
        "another delivery partner",
      );
      res.status(409).json({
        error: "AlreadyAssigned",
        assignedDeliveryPersonName: assignedName,
        message: `This order is already assigned to ${assignedName}`,
      });
      return;
    }
    if (!["pending", "confirmed", "out_for_delivery"].includes(String(existing.status))) {
      res.status(409).json({ error: "Unavailable", message: "This order is not ready for delivery dispatch" });
      return;
    }

    const person = await HubUser.findById(req.admin.adminId).lean();
    if (!person) {
      res.status(403).json({ error: "Forbidden", message: "Delivery partner account not found" });
      return;
    }
    const name = String((person as any).name ?? (person as any).fullName ?? req.admin.email ?? "Delivery Partner");
    const dispatchTime = new Date();
    const updated = await collection.findOneAndUpdate(
      {
        _id: oid,
        status: { $in: ["pending", "confirmed", "out_for_delivery"] },
        $or: [
          { assignedDeliveryPersonId: { $exists: false } },
          { assignedDeliveryPersonId: null },
          { assignedDeliveryPersonId: "" },
          { assignedDeliveryPersonId: String(req.admin.adminId) },
        ],
      },
      {
        $set: {
          assignedDeliveryPersonId: String(req.admin.adminId),
          assignedDeliveryPersonName: name,
          status: "out_for_delivery",
           deliveryAssignedAt: dispatchTime,
           deliveryPickedUpAt: dispatchTime,
           updatedAt: dispatchTime,
        },
      },
      { returnDocument: "after" },
    );
    if (!updated) {
      const latest = await collection.findOne({ _id: oid });
      const assignedName = String(
        latest?.assignedDeliveryPersonName ||
        latest?.deliveryPersonName ||
        "another delivery partner",
      );
      res.status(409).json({
        error: "AlreadyAssigned",
        assignedDeliveryPersonName: assignedName,
        message: `This order is already assigned to ${assignedName}`,
      });
      return;
    }

    // Keep QR dispatch behavior identical to manually marking an order
    // "Out for Delivery" from the admin panel.
    (async () => {
      try {
        let dpPhone = "";
        try {
          const dp = await HubUser.findById(String(req.admin.adminId), { phone: 1 }).lean();
          dpPhone = String((dp as any)?.phone ?? "").trim();
        } catch (e) {
          req.log.warn({ err: e }, "[WhatsApp] Could not fetch delivery person phone for QR dispatch");
        }
        await sendOutForDelivery(updated, dpPhone, req.log);
      } catch (e) {
        req.log.error({ err: e }, "[WhatsApp] QR out-for-delivery notification error");
      }
    })();

    res.json({ order: updated, message: "Order assigned and marked out for delivery" });
  } catch (err) {
    req.log.error({ err }, "Failed to dispatch order by QR");
    res.status(500).json({ error: "InternalError", message: "Failed to dispatch order" });
  }
});

// GET /api/orders/:id — single order
router.post("/:id/borzo-refresh", async (req: ScopedRequest, res) => {
  try {
    const oid = toId(req.params.id);
    if (!oid) {
      res.status(400).json({ error: "InvalidId", message: "Invalid order ID" });
      return;
    }
    const conn = await getOrdersDb();
    const collection = conn.db.collection(COLLECTION);
    const order = await collection.findOne({ _id: oid });
    if (!order || !isOrderInScope(req.scope, order, req)) {
      res.status(404).json({ error: "NotFound", message: "Order not found" });
      return;
    }

    const dispatch = order.borzoDispatch ?? {};
    const borzoOrderId = String(dispatch.borzoOrderId ?? "").trim();
    if (!/^\d+$/.test(borzoOrderId)) {
      res.status(409).json({
        error: "BorzoOrderUnavailable",
        message: "This app order does not have a saved Borzo order ID to look up.",
      });
      return;
    }
    if (dispatch.environment && dispatch.environment !== "test") {
      res.status(409).json({
        error: "BorzoEnvironmentMismatch",
        message: "This app is configured to query Borzo test orders only.",
      });
      return;
    }

    const result = await getBorzoOrderDetails(borzoOrderId);
    if (!result.success || !result.order) {
      const refreshedAt = result.fetchedAt ? new Date(result.fetchedAt) : new Date();
      await collection.updateOne(
        { _id: oid, "borzoDispatch.borzoOrderId": borzoOrderId },
        {
          $set: {
            "borzoDispatch.lastProviderRefreshAt": refreshedAt,
            "borzoDispatch.lastProviderHttpStatus": result.httpStatus ?? null,
            "borzoDispatch.lastProviderRefreshError": result.error?.message ?? "Borzo order lookup failed.",
          },
        },
      );
      req.log.warn({
        appOrderId: order.orderId,
        borzoOrderId,
        httpStatus: result.httpStatus,
        errorCode: result.error?.code,
      }, "Borzo live order lookup failed");
      const statusCode = result.error?.code === "order_not_found" ? 404 : 502;
      res.status(statusCode).json({
        error: result.error?.code ?? "BorzoLookupFailed",
        message: result.error?.message ?? "Could not refresh the Borzo order details.",
        httpStatus: result.httpStatus,
        fetchedAt: result.fetchedAt,
        responseBody: result.responseBody,
      });
      return;
    }

    const refreshedAt = new Date(result.fetchedAt ?? Date.now());
    const update = await collection.updateOne(
      { _id: oid, "borzoDispatch.borzoOrderId": borzoOrderId },
      {
        $set: {
          "borzoDispatch.latestProviderOrder": result.order,
          "borzoDispatch.lastProviderRefreshAt": refreshedAt,
          "borzoDispatch.lastProviderHttpStatus": result.httpStatus,
          "borzoDispatch.lastProviderRefreshError": null,
        },
      },
    );
    if (!update.matchedCount) {
      res.status(409).json({
        error: "BorzoOrderChanged",
        message: "The saved Borzo order ID changed while it was being refreshed. Reopen the details and try again.",
      });
      return;
    }

    req.log.info({
      appOrderId: order.orderId,
      borzoOrderId,
      borzoStatus: result.order.status,
      httpStatus: result.httpStatus,
    }, "Fetched live Borzo order details");
    res.json({
      success: true,
      order: result.order,
      fetchedAt: result.fetchedAt,
      httpStatus: result.httpStatus,
      requestMethod: result.requestMethod,
      requestUrl: result.requestUrl,
      authentication: result.authentication,
    });
  } catch (err) {
    req.log.error({ err, appOrderId: req.params.id }, "Failed to refresh live Borzo order details");
    res.status(500).json({ error: "InternalError", message: "Failed to refresh Borzo order details" });
  }
});

router.get("/:id", async (req: ScopedRequest, res) => {
  try {
    const oid = toId(req.params.id);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid order ID" }); return; }
    const conn = await getOrdersDb();
    await ensureFtwPendingPaymentExpiryDates(conn.db.collection(COLLECTION));
    const order = await conn.db.collection(COLLECTION).findOne({ _id: oid });
    if (!order || !isOrderInScope(req.scope, order, req)) {
      res.status(404).json({ error: "NotFound", message: "Order not found" }); return;
    }
    res.json({ order });
  } catch (err) {
    req.log.error({ err }, "Failed to get order");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch order" });
  }
});

// POST /api/orders/borzo-batch — dispatch paid orders as one Borzo route.
router.post("/borzo-batch", async (req: ScopedRequest, res) => {
  const attemptedAt = new Date();
  const claimedOrders: Array<{ order: any; previousDispatch: any }> = [];
  let batchId = "";
  let borzoRequestMayHaveStarted = false;

  try {
    const requestedIds = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds.map((id: unknown) => String(id ?? "").trim()).filter(Boolean)
      : [];
    if (requestedIds.length < 2 || requestedIds.length > 98) {
      res.status(400).json({
        error: "ValidationError",
        message: "Select between 2 and 98 orders for one Borzo route.",
      });
      return;
    }
    if (new Set(requestedIds).size !== requestedIds.length) {
      res.status(400).json({ error: "ValidationError", message: "The selected order list contains duplicates." });
      return;
    }

    const objectIds = requestedIds.map((id: string) => toId(id));
    if (objectIds.some((id: any) => !id)) {
      res.status(400).json({ error: "ValidationError", message: "One or more selected order IDs are invalid." });
      return;
    }

    const conn = await getOrdersDb();
    const ordersCollection = conn.db.collection(COLLECTION);
    await ensureFtwPendingPaymentExpiryDates(ordersCollection);
    const foundOrders = await ordersCollection.find({ _id: { $in: objectIds } }).toArray();
    const foundById = new Map(foundOrders.map((order: any) => [String(order._id), order]));
    const orders = objectIds.map((id: any) => foundById.get(String(id))).filter(Boolean) as any[];

    if (orders.length !== requestedIds.length) {
      res.status(404).json({ error: "NotFound", message: "One or more selected orders were not found." });
      return;
    }
    if (orders.some((order) => !isOrderInScope(req.scope, order, req))) {
      res.status(403).json({ error: "Forbidden", message: "One or more selected orders are outside your hub access." });
      return;
    }

    const dateKey = (value: unknown) => {
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      return String(value ?? "").trim().slice(0, 10);
    };
    const groupKey = (order: any) => [
      String(order?.subHubId ?? "").trim(),
      dateKey(order?.deliveryDate),
      String(order?.scheduleType ?? "instant").trim().toLowerCase(),
      String(order?.timeslotStart ?? "").trim().toLowerCase(),
      String(order?.timeslotEnd ?? "").trim().toLowerCase(),
    ].join("|");
    const firstGroup = groupKey(orders[0]);
    if (!orders[0]?.subHubId || !dateKey(orders[0]?.deliveryDate) ||
      orders.some((order) => groupKey(order) !== firstGroup)) {
      res.status(400).json({
        error: "ValidationError",
        message: "All selected orders must have the same sub-hub, delivery date, and delivery time window.",
      });
      return;
    }

    const notReady = orders.find((order) => {
      const orderNumber = String(order?.orderId ?? order?._id);
      if (!isBorzoOrder(order)) return `${orderNumber} is not an FTS/FTW order.`;
      if (String(order?.status ?? "").toLowerCase() !== "pending") return `${orderNumber} is not pending.`;
      if (String(order?.deliveryType ?? "delivery").toLowerCase() !== "delivery") {
        return `${orderNumber} is not a delivery order.`;
      }
      if (order?.isExpress || String(order?.scheduleType ?? "").toLowerCase() === "express") {
        return `${orderNumber} is an express order; express orders cannot be batched.`;
      }
      if (isFtwPaymentOnHold(order)) return `${orderNumber} is still on payment hold.`;

      const total = Math.max(0, Number(order?.total) || 0);
      const paidAmount = Math.max(0, Number(order?.paidAmount) || 0);
      const paymentStatus = String(order?.paymentStatus ?? "").trim().toLowerCase();
      const markedPaid = ["paid", "completed"].includes(paymentStatus);
      const dueAmount = order?.dueAmount === undefined
        ? (markedPaid ? 0 : Math.max(0, total - paidAmount))
        : Math.max(0, Number(order.dueAmount) || 0);
      if (dueAmount > 0 || (!markedPaid && (total > 0 && paidAmount < total))) {
        return `${orderNumber} is not fully paid. Batch routes currently require prepaid orders; COD is not enabled.`;
      }

      const dispatchStatus = String(order?.borzoDispatch?.status ?? "").toLowerCase();
      if (["sending", "sent", "unknown"].includes(dispatchStatus)) {
        return `${orderNumber} already has a Borzo request in ${dispatchStatus} state; check Borzo before retrying.`;
      }
      return "";
    });
    if (notReady) {
      res.status(409).json({ error: "OrderNotEligible", message: notReady });
      return;
    }

    const sourceOrderIds = orders.map((order) =>
      String(order?.orderId ?? order?._id).trim().replace(/^#+/, ""),
    );
    const documentIds = orders.map((order) => String(order._id));
    batchId = crypto.randomUUID();

    // Reserve every order before making the external request. If any reservation
    // fails, restore earlier reservations and do not send a partial batch.
    for (const order of orders) {
      const claim = await ordersCollection.updateOne(
        {
          _id: order._id,
          status: "pending",
          "borzoDispatch.status": { $nin: ["sending", "sent", "unknown"] },
        },
        {
          $set: {
            borzoDispatch: {
              status: "sending",
              batchId,
              batchOrderIds: sourceOrderIds,
              sourceOrderId: String(order?.orderId ?? order?._id),
              environment: "test",
              attemptedAt,
            },
          },
        },
      );
      if (claim.modifiedCount !== 1) {
        for (const claimed of claimedOrders) {
          const filter = { _id: claimed.order._id, "borzoDispatch.batchId": batchId, "borzoDispatch.status": "sending" };
          if (claimed.previousDispatch === undefined) {
            await ordersCollection.updateOne(filter, { $unset: { borzoDispatch: "" } });
          } else {
            await ordersCollection.updateOne(filter, { $set: { borzoDispatch: claimed.previousDispatch } });
          }
        }
        res.status(409).json({
          error: "OrderChanged",
          message: "At least one order changed or was accepted by another user. Refresh the list and select again.",
        });
        return;
      }
      claimedOrders.push({ order, previousDispatch: order?.borzoDispatch });
    }

    let borzoResult: any;
    borzoRequestMayHaveStarted = true;
    try {
      borzoResult = await createBorzoBatchOrder(orders);
    } catch (err: any) {
      borzoResult = {
        success: false,
        status: "unknown",
        error: {
          message: err?.message || "Borzo batch request failed unexpectedly; check the Borzo test cabinet before retrying.",
          outcomeMayBeUnknown: true,
        },
      };
    }
    borzoResult = { ...borzoResult, batchId, batchOrderIds: sourceOrderIds, serverRequestId: req.id };

    const dispatchStatus = borzoResult.success ? "sent" : borzoResult.status === "unknown" ? "unknown" : "failed";
    const completedAt = new Date();
    const dispatchRecord = {
      status: dispatchStatus,
      batchId,
      batchOrderIds: sourceOrderIds,
      environment: "test",
      attemptedAt,
      completedAt,
      requestMethod: borzoResult.requestMethod ?? "POST",
      requestUrl: borzoResult.requestUrl,
      authentication: borzoResult.authentication,
      httpStatus: borzoResult.httpStatus,
      borzoOrderId: borzoResult.borzoOrderId,
      borzoOrderStatus: borzoResult.borzoOrderStatus,
      requestPayload: borzoResult.requestPayload,
      responseBody: borzoResult.responseBody,
      warnings: borzoResult.warnings,
      error: borzoResult.error,
      errorMessage: borzoResult.error?.message,
      serverRequestId: req.id,
    };
    const saved = await Promise.all(orders.map((order) =>
      ordersCollection.updateOne(
        { _id: order._id, "borzoDispatch.batchId": batchId, "borzoDispatch.status": "sending" },
        { $set: { borzoDispatch: { ...dispatchRecord, sourceOrderId: String(order?.orderId ?? order?._id) } } },
      ),
    ));
    if (saved.some((result) => result.modifiedCount !== 1)) {
      await ordersCollection.updateMany(
        { "borzoDispatch.batchId": batchId, "borzoDispatch.status": "sending" },
        {
          $set: {
            "borzoDispatch.status": "unknown",
            "borzoDispatch.completedAt": new Date(),
            "borzoDispatch.errorMessage": "Borzo result could not be saved for every order; verify the batch in Borzo before retrying.",
          },
        },
      );
      req.log.error({ batchId, sourceOrderIds, dispatchStatus }, "[Borzo batch] Could not save dispatch result for every order");
      res.status(500).json({
        error: "DispatchStateUncertain",
        message: "The Borzo request was made, but its result could not be saved for every order. Check the Borzo test cabinet before retrying.",
        batchId,
        orderIds: documentIds,
        borzo: borzoResult,
      });
      return;
    }

    const logDetails = {
      batchId,
      orderIds: sourceOrderIds,
      orderCount: orders.length,
      environment: "test",
      requestMethod: borzoResult.requestMethod,
      requestUrl: borzoResult.requestUrl,
      authentication: borzoResult.authentication,
      requestPayload: borzoResult.requestPayload,
      httpStatus: borzoResult.httpStatus,
      responseBody: borzoResult.responseBody,
      borzoOrderId: borzoResult.borzoOrderId,
      success: borzoResult.success,
      status: borzoResult.status,
      warnings: borzoResult.warnings,
      error: borzoResult.error,
      serverRequestId: req.id,
    };
    if (borzoResult.success) {
      req.log.info(logDetails, "[Borzo batch] One route accepted for multiple orders");
    } else {
      req.log.error(logDetails, "[Borzo batch] Route submission failed or has uncertain outcome");
    }

    res.json({ batchId, orderIds: documentIds, sourceOrderIds, borzo: borzoResult });
  } catch (err) {
    if (claimedOrders.length > 0 && batchId) {
      try {
        const ordersCollection = (await getOrdersDb()).db.collection(COLLECTION);
        if (borzoRequestMayHaveStarted) {
          await ordersCollection.updateMany(
            { "borzoDispatch.batchId": batchId, "borzoDispatch.status": "sending" },
            {
              $set: {
                "borzoDispatch.status": "unknown",
                "borzoDispatch.completedAt": new Date(),
                "borzoDispatch.errorMessage": "The server could not finish saving the Borzo result. Verify the batch before retrying.",
              },
            },
          );
        } else {
          for (const claimed of claimedOrders) {
            const filter = { _id: claimed.order._id, "borzoDispatch.batchId": batchId, "borzoDispatch.status": "sending" };
            if (claimed.previousDispatch === undefined) {
              await ordersCollection.updateOne(filter, { $unset: { borzoDispatch: "" } });
            } else {
              await ordersCollection.updateOne(filter, { $set: { borzoDispatch: claimed.previousDispatch } });
            }
          }
        }
      } catch (rollbackError) {
        req.log.error({ err: rollbackError, batchId }, "[Borzo batch] Could not safely recover batch reservations");
      }
    }
    req.log.error({ err, batchId, orderIds: claimedOrders.map(({ order }) => order?.orderId) }, "[Borzo batch] Failed to dispatch batch");
    res.status(500).json({
      error: "InternalError",
      message: batchId
        ? "Could not complete the batch request safely. Check the Borzo test cabinet and refresh the orders before retrying."
        : "Failed to prepare Borzo batch.",
    });
  }
});

// PUT /api/orders/:id — update status / notes / customer info
router.put("/:id", async (req: ScopedRequest, res) => {
  try {
    const oid = toId(req.params.id);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid order ID" }); return; }
    const {
      status, notes,
      assignedDeliveryPersonId, assignedDeliveryPersonName,
      customerName, phone, email, address, deliveryArea, deliveryAddressDetail,
      paymentStatus, payments, paidAmount, paymentMode, upiVariant,
      razorpayPaymentId, razorpayOrderId, upiTransactionId, gatewayTransactionId,
      items, deliveryType,
      superHubId, superHubName, subHubId, subHubName,
      scheduleType, deliveryDate, timeslotId, timeslotLabel, timeslotStart, timeslotEnd,
      couponId, couponCode, couponTitle, couponIds, couponCodes, coupons,
      subtotal, discount, slotCharge, deliveryCharge, extraDiscount, extraDiscountType, total,
      cancellationReason,
      walletTopup,
      walletAdjustment,
      isExpress,
      orderType,
    } = req.body;
    if (status !== undefined && !VALID_ORDER_STATUSES.has(String(status))) {
      res.status(400).json({ error: "ValidationError", message: `Invalid order status: ${status}` });
      return;
    }
    const updateTime = new Date();
    const update: any = { updatedAt: updateTime };
    if (status !== undefined) update.status = status;
    if (notes !== undefined) update.notes = notes;
    if (assignedDeliveryPersonId !== undefined) update.assignedDeliveryPersonId = assignedDeliveryPersonId;
    if (assignedDeliveryPersonName !== undefined) update.assignedDeliveryPersonName = assignedDeliveryPersonName;
    if (customerName !== undefined) update.customerName = customerName;
    if (phone !== undefined) update.phone = phone;
    if (email !== undefined) update.email = email;
    if (address !== undefined) update.address = address;
    if (deliveryArea !== undefined) update.deliveryArea = deliveryArea;
    if (deliveryAddressDetail !== undefined) update.deliveryAddressDetail = deliveryAddressDetail;
    if (deliveryType !== undefined) update.deliveryType = deliveryType;
    if (orderType !== undefined) {
      if (!["normal", "preorder"].includes(String(orderType))) {
        res.status(400).json({ error: "ValidationError", message: "Invalid order type" });
        return;
      }
      update.orderType = DIRECT_ORDER_ONLY ? "normal" : String(orderType);
    }
    if (superHubId !== undefined) update.superHubId = superHubId;
    if (superHubName !== undefined) update.superHubName = superHubName;
    if (subHubId !== undefined) update.subHubId = subHubId;
    if (subHubName !== undefined) update.subHubName = subHubName;
    if (scheduleType !== undefined) {
      update.scheduleType = DIRECT_ORDER_ONLY ? "instant" : scheduleType;
      if (DIRECT_ORDER_ONLY) {
        update.deliveryDate = getTodayISODate();
        update.timeslotId = null;
        update.timeslotLabel = null;
        update.timeslotStart = null;
        update.timeslotEnd = null;
      }
    }
    if (isExpress !== undefined) update.isExpress = DIRECT_ORDER_ONLY ? false : !!isExpress;
    if (deliveryDate !== undefined) update.deliveryDate = DIRECT_ORDER_ONLY ? getTodayISODate() : deliveryDate;
    if (timeslotId !== undefined) update.timeslotId = DIRECT_ORDER_ONLY ? null : timeslotId;
    if (timeslotLabel !== undefined) update.timeslotLabel = DIRECT_ORDER_ONLY ? null : timeslotLabel;
    if (timeslotStart !== undefined) update.timeslotStart = DIRECT_ORDER_ONLY ? null : timeslotStart;
    if (timeslotEnd !== undefined) update.timeslotEnd = DIRECT_ORDER_ONLY ? null : timeslotEnd;
    if (couponId !== undefined) update.couponId = couponId;
    if (couponCode !== undefined) update.couponCode = couponCode;
    if (couponTitle !== undefined) update.couponTitle = couponTitle;
    if (Array.isArray(couponIds)) update.couponIds = couponIds;
    if (Array.isArray(couponCodes)) update.couponCodes = couponCodes;
    if (Array.isArray(coupons)) update.coupons = coupons;
    if (subtotal !== undefined) update.subtotal = Number(subtotal) || 0;
    if (discount !== undefined) update.discount = Number(discount) || 0;
    if (slotCharge !== undefined) update.slotCharge = DIRECT_ORDER_ONLY ? 0 : Number(slotCharge) || 0;
    if (deliveryCharge !== undefined) update.deliveryCharge = Number(deliveryCharge) || 0;
    if (extraDiscount !== undefined) update.extraDiscount = Number(extraDiscount) || 0;
    if (extraDiscountType !== undefined) update.extraDiscountType = String(extraDiscountType);
    if (total !== undefined) update.total = Number(total) || 0;
    if (cancellationReason !== undefined) {
      update.cancellationReason = cancellationReason ? String(cancellationReason).trim().slice(0, 500) : "";
    }
    if (Array.isArray(items)) {
      update.items = items.map((it: any) => ({
        productId: it?.productId ? String(it.productId) : undefined,
        name: String(it?.name ?? "").trim(),
        price: Number(it?.price) || 0,
        quantity: Number(it?.quantity) || 0,
        unit: String(it?.unit ?? "").trim(),
        ...(it?.inventoryBatchId ? {
          inventoryBatchId: String(it.inventoryBatchId),
          batchNumber: String(it.batchNumber ?? ""),
          fishWeightKg: Number(it.fishWeightKg) || undefined,
        } : {}),
        ...(Number(it?.bulkWeightKg) > 0 ? { bulkWeightKg: Number(it.bulkWeightKg) } : {}),
      })).filter((it: any) => it.name && it.quantity > 0);
    }

    if (paymentStatus !== undefined && ["paid", "completed", "failed", "partial", "unpaid"].includes(String(paymentStatus).trim().toLowerCase())) {
      update.paymentStatus = String(paymentStatus).trim().toLowerCase();
    }
    if (paymentMode !== undefined) update.paymentMode = paymentMode ? String(paymentMode) : "";
    if (upiVariant !== undefined) update.upiVariant = upiVariant ? String(upiVariant).trim() : null;
    if (razorpayPaymentId !== undefined) update.razorpayPaymentId = String(razorpayPaymentId ?? "").trim();
    if (razorpayOrderId !== undefined) update.razorpayOrderId = String(razorpayOrderId ?? "").trim();
    if (upiTransactionId !== undefined) update.upiTransactionId = String(upiTransactionId ?? "").trim();
    if (gatewayTransactionId !== undefined) update.gatewayTransactionId = String(gatewayTransactionId ?? "").trim();
    if (Array.isArray(payments)) {
      update.payments = payments
        .map((p: any) => ({
          mode: String(p?.mode ?? "").trim(),
          amount: Math.max(0, Number(p?.amount) || 0),
          reference: p?.reference ? String(p.reference).trim() : "",
          paidAt: p?.paidAt ? new Date(p.paidAt) : new Date(),
        }))
        .filter((p: any) => p.mode && p.amount > 0);
    }
    if (paidAmount !== undefined) {
      const requestedPaidNum = Math.max(0, Number(paidAmount) || 0);
      // recompute due against existing total (fall back to items sum for legacy orders)
      const conn0 = await getOrdersDb();
      const existing = await conn0.db.collection(COLLECTION).findOne(
        { _id: oid },
        { projection: { total: 1, items: 1 } }
      );
      // Use the incoming total if provided (edit may have changed it), else fall back to DB value
      let totalNum = total !== undefined ? (Number(total) || 0) : (Number(existing?.total) || 0);
      if (total === undefined && totalNum <= 0 && Array.isArray(existing?.items)) {
        totalNum = existing.items.reduce(
          (s: number, i: any) => s + (Number(i.price) || 0) * (Number(i.quantity) || 1),
          0
        );
        update.total = totalNum;
      }
      const effectivePaymentStatus = update.paymentStatus ?? (await (async () => {
        const o = await (await getOrdersDb()).db.collection(COLLECTION).findOne({ _id: oid }, { projection: { paymentStatus: 1 } });
        return o?.paymentStatus ?? "unpaid";
      })());
      // A fully discounted/zero-total order cannot have a collected payment.
      const paidNum = totalNum === 0 ? 0 : requestedPaidNum;
      update.paidAmount = paidNum;
      if (totalNum === 0) {
        update.payments = [];
        update.paymentMode = "";
        update.paymentStatus = "paid";
      }
      update.dueAmount = totalNum === 0 || ["paid", "completed"].includes(String(effectivePaymentStatus).toLowerCase())
        ? 0
        : Math.max(0, totalNum - paidNum);
    } else if (total !== undefined) {
      // Total changed (e.g. discount or delivery charge edited) but paidAmount was not sent —
      // recalculate dueAmount against the existing paidAmount so the invoice stays accurate.
      const conn0 = await getOrdersDb();
      const existing = await conn0.db.collection(COLLECTION).findOne(
        { _id: oid },
        { projection: { paidAmount: 1, paymentStatus: 1 } }
      );
      const existingPaid = Number(total) === 0 ? 0 : Math.max(0, Number(existing?.paidAmount) || 0);
      const effectivePaymentStatus = update.paymentStatus ?? existing?.paymentStatus ?? "unpaid";
      if (Number(total) === 0) {
        update.paidAmount = 0;
        update.payments = [];
        update.paymentMode = "";
        update.paymentStatus = "paid";
      }
      update.dueAmount = ["paid", "completed"].includes(String(effectivePaymentStatus).toLowerCase())
        ? 0
        : Math.max(0, (Number(total) || 0) - existingPaid);
    }
    const conn = await getOrdersDb();
    const prev = await conn.db.collection(COLLECTION).findOne({ _id: oid });
    if (!prev || !isOrderInScope(req.scope, prev, req)) {
      res.status(404).json({ error: "NotFound", message: "Order not found" }); return;
    }
    const ftwPaymentHold = isFtwPaymentOnHold(prev);
    const successfulFtwSettlement =
      isFtwOrder(prev) &&
      String(prev.paymentStatus ?? "").trim().toLowerCase() === "pending" &&
      String(paymentStatus ?? "").trim().toLowerCase() === "completed";
    const failedFtwPaymentSignal =
      isFtwOrder(prev) &&
      String(prev.paymentStatus ?? "").trim().toLowerCase() === "pending" &&
      String(paymentStatus ?? "").trim().toLowerCase() === "failed";
    const isStatusTransition = status !== undefined && String(status) !== String(prev.status ?? "");
    const otherPaymentDetailsChanged =
      payments !== undefined ||
      paidAmount !== undefined ||
      paymentMode !== undefined ||
      upiVariant !== undefined ||
      razorpayPaymentId !== undefined ||
      razorpayOrderId !== undefined ||
      upiTransactionId !== undefined ||
      gatewayTransactionId !== undefined;
    const paymentDetailsChanged =
      (paymentStatus !== undefined && !successfulFtwSettlement && !failedFtwPaymentSignal) ||
      (otherPaymentDetailsChanged && !successfulFtwSettlement);
    const fulfillmentAssignmentChanged =
      assignedDeliveryPersonId !== undefined ||
      assignedDeliveryPersonName !== undefined ||
      subHubId !== undefined ||
      subHubName !== undefined;
    if (ftwPaymentHold && (isStatusTransition || paymentDetailsChanged || fulfillmentAssignmentChanged)) {
      res.status(409).json({
        error: "FtwPaymentPending",
        message: "This FTW order is on hold until payment is completed.",
      });
      return;
    }
    if (successfulFtwSettlement) {
      const settledTotal = Number(update.total ?? prev.total) || 0;
      update.paidAmount = Math.max(0, Number(paidAmount) || settledTotal);
      update.dueAmount = 0;
    }
    addDeliveryLifecycleTimestamps(update, prev, { status, assignedDeliveryPersonId }, updateTime);
    // Validate preorder constraints after loading the current order so partial
    // edits can safely inherit its existing delivery type/date.
    const nextOrderType = orderType !== undefined ? String(orderType) : String(prev.orderType ?? "normal");
    if (nextOrderType === "preorder") {
      const nextDeliveryType = deliveryType !== undefined ? String(deliveryType) : String(prev.deliveryType ?? "");
      const nextDeliveryDate = deliveryDate !== undefined ? String(deliveryDate).trim() : String(prev.deliveryDate ?? "").slice(0, 10);
      if (nextDeliveryType === "takeaway") {
        res.status(400).json({ error: "ValidationError", message: "Preorders must use delivery" });
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDeliveryDate)) {
        res.status(400).json({ error: "ValidationError", message: "Preorder delivery date must be a valid date" });
        return;
      }
    }
    // Hub admins cannot reassign an order to a sub hub outside their scope.
    if (req.scope && !req.scope.isMaster && update.subHubId !== undefined) {
      const targetSub = update.subHubId ? String(update.subHubId) : "";
      if (!targetSub || !req.scope.subHubIds.includes(targetSub)) {
        res.status(403).json({ error: "Forbidden", message: "You cannot reassign this order to a sub hub outside your scope." });
        return;
      }
    }

    // Guard: out_for_delivery / delivered require an assigned delivery partner
    // (only applies to delivery-type orders, not takeaway).
    if (status !== undefined && (status === "out_for_delivery" || status === "delivered")) {
      const effectiveDeliveryType = update.deliveryType ?? prev.deliveryType ?? "delivery";
      if (effectiveDeliveryType !== "takeaway") {
        const effectiveAssignee =
          update.assignedDeliveryPersonId !== undefined
            ? update.assignedDeliveryPersonId
            : prev.assignedDeliveryPersonId;
        if (!effectiveAssignee) {
          res.status(400).json({
            error: "DeliveryPartnerRequired",
            message: "Assign a delivery partner before marking the order as Out for Delivery or Delivered.",
          });
          return;
        }
      }
    }

    // If the order is being moved OUT of "delivered" back to an earlier
    // active status (e.g. pending / confirmed / out_for_delivery), the
    // previously recorded payment is no longer relevant — clear it so the
    // next "delivered" transition prompts for fresh payment info.
    let clearPayments = false;
    if (
      status !== undefined &&
      prev.status === "delivered" &&
      status !== "delivered" &&
      status !== "cancelled" &&
      !Array.isArray(payments) // don't override an explicit payments update
    ) {
      clearPayments = true;
      update.payments = [];
      update.paidAmount = 0;
      update.paymentMode = "";
      const totalForDue = Number((update.total ?? prev.total)) || 0;
      // If the order total is zero (fully discounted), keep it paid; otherwise revert to unpaid.
      if (totalForDue === 0) {
        update.paymentStatus = "paid";
        update.dueAmount = 0;
      } else {
        update.paymentStatus = "unpaid";
        update.dueAmount = totalForDue;
      }
    }

    const resolvedPaymentStatus = String(update.paymentStatus ?? prev.paymentStatus ?? "").trim().toLowerCase();
    const resolvedTotal = Number(update.total ?? prev.total) || 0;
    const resolvedPaidAmount = Math.max(0, Number(update.paidAmount ?? prev.paidAmount) || 0);
    const resolvedDueAmount = Number(update.dueAmount ?? prev.dueAmount ?? Math.max(0, resolvedTotal - resolvedPaidAmount));
    if (
      isFtwOrder(prev) &&
      resolvedPaymentStatus === "unpaid" &&
      resolvedTotal > 0 &&
      resolvedPaidAmount >= resolvedTotal &&
      resolvedDueAmount <= 0
    ) {
      update.paymentStatus = "paid";
      update.paidAmount = resolvedPaidAmount;
      update.dueAmount = 0;
    }
    // Final guard: if the resolved paymentStatus is "paid", dueAmount must be 0.
    const finalPaymentStatus = update.paymentStatus ?? String(prev.paymentStatus ?? "");
    if (finalPaymentStatus === "paid") {
      update.dueAmount = 0;
    }

    const result = await conn.db.collection(COLLECTION).findOneAndUpdate(
      { _id: oid, isDeleted: { $ne: true } },
      { $set: update },
      { returnDocument: "after" }
    );
    if (!result) { res.status(404).json({ error: "NotFound", message: "Order not found" }); return; }

    // Sync inventory if status transitioned between active/cancelled.
    try {
      const wasDeducted = (prev as any).inventoryDeducted === true;
      const nowDeducted = await applyOrderInventoryOnUpdate(
        prev as any,
        result as any,
        wasDeducted,
      );
      if (wasDeducted !== nowDeducted) {
        await conn.db.collection(COLLECTION).updateOne(
          { _id: oid },
          { $set: { inventoryDeducted: nowDeducted } }
        );
        (result as any).inventoryDeducted = nowDeducted;
      }
    } catch (e) {
      req.log.error({ err: e }, "Failed to sync inventory on order update");
    }

    // Handle explicit walletAdjustment: positive = credit to customer wallet, negative = debit.
    // This is used when the collected amount differs from the outstanding amount at delivery.
    if (walletAdjustment !== undefined && (result as any).customerId) {
      const adj = Number(walletAdjustment) || 0;
      if (adj !== 0) {
        try {
          const cCol = await getCustomersCollection();
          await pushWalletTx(cCol, String((result as any).customerId), adj,
            adj > 0 ? "Extra amount credited — delivery payment difference" : "Order payment adjustment",
            { orderId: String((result as any).orderId || ""), orderRef: String(oid) }
          );
          req.log.info({ customerId: (result as any).customerId, walletAdjustment: adj }, "Wallet adjusted from delivery payment difference");
        } catch (e) {
          req.log.error({ err: e }, "Failed to apply walletAdjustment");
        }
      }
    }

    // Handle wallet payment entries: when "wallet" mode payments change, apply the inverse delta to
    // customer wallet balance. walletDelta represents change in wallet *used*:
    //   positive delta (more wallet used)  → deduct from balance  → $inc: -walletDelta
    //   negative delta (less wallet used)  → refund to balance    → $inc: -walletDelta (becomes positive)
    if (Array.isArray(payments) && (result as any).customerId) {
      try {
        const prevWalletTotal = ((prev as any).payments ?? [])
          .filter((p: any) => p.mode === "wallet")
          .reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
        const newWalletTotal = ((result as any).payments ?? [])
          .filter((p: any) => p.mode === "wallet")
          .reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
        const walletDelta = newWalletTotal - prevWalletTotal;
        if (walletDelta !== 0) {
          const cCol = await getCustomersCollection();
          await pushWalletTx(cCol, String((result as any).customerId), -walletDelta,
            walletDelta > 0 ? "Order edited — additional wallet deducted" : "Order edited — wallet refunded",
            { orderId: String((result as any).orderId || ""), orderRef: String(oid) }
          );
          req.log.info({ customerId: (result as any).customerId, walletUsedDelta: walletDelta, balanceDelta: -walletDelta }, "Wallet balance updated from order payment change");
        }
      } catch (e) {
        req.log.error({ err: e }, "Failed to update wallet from delivery payment");
      }
    }

    // Handle wallet refund/re-deduction based on status-only transitions.
    // These cases are separate from explicit payment-array updates handled above.
    if (status !== undefined && String(status) !== String(prev.status ?? "") && (result as any).customerId) {
      const prevStatus = String(prev.status ?? "");
      const newStatus = String(status);
      const wasNotCancelled = prevStatus !== "cancelled";
      const isNowCancelled = newStatus === "cancelled";
      const wasCancelled = prevStatus === "cancelled";
      try {
        // Case 1: Order just cancelled — refund any wallet payments back to the customer.
        // Only fires when payments array is not explicitly provided (that case is handled above).
        if (isNowCancelled && wasNotCancelled && !Array.isArray(payments)) {
          const walletToRefund = ((prev as any).payments ?? [])
            .filter((p: any) => p.mode === "wallet")
            .reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
          if (walletToRefund > 0) {
            const cCol = await getCustomersCollection();
            await pushWalletTx(cCol, String((result as any).customerId), walletToRefund,
              "Order cancelled — wallet refunded",
              { orderId: String((result as any).orderId || ""), orderRef: String(oid) }
            );
            req.log.info({ customerId: (result as any).customerId, refunded: walletToRefund }, "Wallet refunded on order cancellation");
          }
        }

        // Case 2: Order un-cancelled (moved from cancelled → active) — re-deduct wallet payments.
        // Only fires when payments array is not explicitly provided.
        if (wasCancelled && !isNowCancelled && !Array.isArray(payments)) {
          const walletToDeduct = ((result as any).payments ?? [])
            .filter((p: any) => p.mode === "wallet")
            .reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
          if (walletToDeduct > 0) {
            const cCol = await getCustomersCollection();
            await pushWalletTx(cCol, String((result as any).customerId), -walletToDeduct,
              "Order re-activated — wallet re-deducted",
              { orderId: String((result as any).orderId || ""), orderRef: String(oid) }
            );
            req.log.info({ customerId: (result as any).customerId, deducted: walletToDeduct }, "Wallet re-deducted on order re-activation from cancelled");
          }
        }

        // Case 3: Order moved OUT of "delivered" (payments cleared) — refund any wallet used.
        // clearPayments wipes the payments array so we look at prev.payments for the amount.
        if (clearPayments && !isNowCancelled && !Array.isArray(payments)) {
          const walletToRefund = ((prev as any).payments ?? [])
            .filter((p: any) => p.mode === "wallet")
            .reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
          if (walletToRefund > 0) {
            const cCol = await getCustomersCollection();
            await pushWalletTx(cCol, String((result as any).customerId), walletToRefund,
              "Order payments cleared — wallet refunded",
              { orderId: String((result as any).orderId || ""), orderRef: String(oid) }
            );
            req.log.info({ customerId: (result as any).customerId, refunded: walletToRefund }, "Wallet refunded when order moved out of delivered status");
          }
        }
      } catch (e) {
        req.log.error({ err: e }, "Failed to update wallet on order status transition");
      }
    }

    // Sync customer's activeCoupons / usedCoupons when order status changes.
    if (status !== undefined && status !== prev.status && (result as any).customerId) {
      const orderCouponsOnUpdate = extractOrderCoupons(prev);
      await syncCustomerCouponsOnStatusChange(
        await getCustomersCollection(),
        String((result as any).customerId),
        String(oid),
        orderCouponsOnUpdate,
        String(prev.status ?? ""),
        String(status),
        String((result as any).subHubId ?? ""),
        req.log,
      );
    }

    // If the payments list was touched, re-sync this order's banking payments.
    if (Array.isArray(payments) || clearPayments) {
      try {
        await syncOrderBankPayments({
          orderId: String((result as any)._id),
          customerName: (result as any).customerName,
          payments: (result as any).payments || [],
          orderRef: `#${String((result as any)._id).slice(-6).toUpperCase()}`,
        });
      } catch (e) {
        req.log.error({ err: e }, "Failed to sync order payments to banking");
      }
    }

    let borzoResult: any;
    const orderAfterUpdate = result as any;
    const borzoOrderIsEligible =
      status === "confirmed" &&
      orderAfterUpdate.deliveryType !== "takeaway" &&
      isBorzoOrder(orderAfterUpdate);
    const shouldAttemptBorzo =
      borzoOrderIsEligible &&
      (
        String(prev.status ?? "") !== "confirmed" ||
        String(prev.borzoDispatch?.status ?? "") === "failed"
      );

    if (shouldAttemptBorzo) {
      const sourceOrderId = String(orderAfterUpdate.orderId ?? "").trim().replace(/^#+/, "");
      const attemptedAt = new Date();
      try {
        // Claim the one allowed submission atomically so simultaneous admin
        // confirmations cannot create duplicate Borzo orders.
        const claim = await conn.db!.collection(COLLECTION).updateOne(
          {
            _id: oid,
            status: "confirmed",
            "borzoDispatch.status": { $nin: ["sending", "sent", "unknown"] },
          },
          {
            $set: {
              borzoDispatch: {
                status: "sending",
                sourceOrderId,
                attemptedAt,
              },
            },
          },
        );

        if (claim.modifiedCount > 0) {
          req.log.info({ orderId: sourceOrderId, environment: "test" }, "Submitting confirmed FishTokri order to Borzo test API");
          borzoResult = await createBorzoOrder(orderAfterUpdate);
          const dispatchStatus = borzoResult.success
            ? "sent"
            : borzoResult.error?.outcomeMayBeUnknown
              ? "unknown"
              : "failed";
          const persistedDispatch = {
            status: dispatchStatus,
            sourceOrderId,
            borzoOrderId: borzoResult.borzoOrderId,
            borzoOrderStatus: borzoResult.borzoOrderStatus,
            environment: "test",
            attemptedAt,
            completedAt: new Date(),
            requestMethod: borzoResult.requestMethod,
            requestUrl: borzoResult.requestUrl,
            authentication: borzoResult.authentication,
            httpStatus: borzoResult.httpStatus,
            requestPayload: borzoResult.requestPayload,
            responseBody: borzoResult.responseBody,
            warnings: borzoResult.warnings,
            error: borzoResult.error,
            errorMessage: borzoResult.error?.message,
            serverRequestId: req.id,
          };
          try {
            await conn.db!.collection(COLLECTION).updateOne(
              { _id: oid, "borzoDispatch.status": "sending" },
              { $set: { borzoDispatch: persistedDispatch } },
            );
            orderAfterUpdate.borzoDispatch = persistedDispatch;
          } catch (persistError) {
            // Keep the claim in "sending" if MongoDB cannot persist the result.
            // This blocks a later confirmation from unknowingly creating a duplicate.
            req.log.error(
              { err: persistError, orderId: sourceOrderId, borzoOrderId: borzoResult.borzoOrderId },
              "Could not persist Borzo submission result; duplicate protection remains active",
            );
            orderAfterUpdate.borzoDispatch = { status: "sending", sourceOrderId, attemptedAt, environment: "test" };
          }

          if (borzoResult.success) {
            req.log.info(
              {
                orderId: sourceOrderId,
                borzoOrderId: borzoResult.borzoOrderId,
                borzoOrderStatus: borzoResult.borzoOrderStatus,
                httpStatus: borzoResult.httpStatus,
              },
              "Borzo test API accepted the order",
            );
          } else {
            req.log.error(
              { orderId: sourceOrderId, borzoStatus: dispatchStatus, httpStatus: borzoResult.httpStatus, error: borzoResult.error },
              "Borzo test API order submission failed",
            );
          }
        } else {
          const current = await conn.db!.collection(COLLECTION).findOne(
            { _id: oid },
            { projection: { borzoDispatch: 1 } },
          );
          const priorDispatch = current?.borzoDispatch ?? {};
          const alreadySent = priorDispatch.status === "sent";
          borzoResult = {
            success: alreadySent,
            status: alreadySent ? "already_sent" : priorDispatch.status === "unknown" ? "unknown" : "in_progress",
            borzoOrderId: priorDispatch.borzoOrderId,
            borzoOrderStatus: priorDispatch.borzoOrderStatus,
            message: alreadySent
              ? "This order was already submitted to Borzo test; no duplicate was created."
              : priorDispatch.status === "unknown"
                ? "The previous Borzo test result is uncertain. Check the Borzo test cabinet before retrying to avoid a duplicate."
                : "A Borzo submission is already in progress; no second request was sent.",
          };
        }
      } catch (borzoError: any) {
        req.log.error({ err: borzoError, orderId: sourceOrderId }, "Borzo integration failed while confirming order");
        borzoResult = {
          success: false,
          status: "failed",
          error: { message: borzoError?.message || "Borzo integration failed unexpectedly." },
        };
        try {
          const failedDispatch = {
            status: "failed",
            sourceOrderId,
            environment: "test",
            attemptedAt,
            completedAt: new Date(),
            errorMessage: borzoResult.error.message,
          };
          await conn.db!.collection(COLLECTION).updateOne(
            { _id: oid },
            { $set: { borzoDispatch: failedDispatch } },
          );
          orderAfterUpdate.borzoDispatch = failedDispatch;
        } catch (persistError) {
          req.log.error({ err: persistError, orderId: sourceOrderId }, "Could not persist Borzo failure state");
        }
      }
    }

    if (borzoResult) borzoResult.serverRequestId = req.id;
    res.json({ order: result, ...(borzoResult ? { borzo: borzoResult } : {}) });

    // --- WhatsApp notifications (fire-and-forget, never blocks the response) ---
    if (status !== undefined && String(status) !== String(prev.status ?? "")) {
      const newStatus = String(status);
      const orderDoc = result as any;
      (async () => {
        try {
          if (newStatus === "confirmed") {
            await sendOrderConfirmed(orderDoc, req.log);
          } else if (newStatus === "out_for_delivery") {
            // Look up the delivery person's phone from hub_users.
            let dpPhone = "";
            if (orderDoc.assignedDeliveryPersonId) {
              try {
                const dp = await HubUser.findById(
                  orderDoc.assignedDeliveryPersonId,
                  { phone: 1 }
                ).lean();
                dpPhone = String((dp as any)?.phone ?? "").trim();
              } catch (e) {
                req.log.warn({ err: e }, "[WhatsApp] Could not fetch delivery person phone");
              }
            }

            // Note: WhatsApp out-for-delivery notifications no longer include a
            // Razorpay payment link (removed per product decision — same template
            // is used for both COD and UPI orders now), so the payment link is
            // no longer auto-generated here.

            await sendOutForDelivery(orderDoc, dpPhone, req.log);
          } else if (newStatus === "cancelled") {
            // Merge the cancellationReason from the update body (may not be on result yet).
            const cancelDoc = {
              ...orderDoc,
              cancellationReason:
                (cancellationReason ?? orderDoc.cancellationReason ?? "").toString().trim(),
            };
            await sendOrderCancelled(cancelDoc, req.log);
          }
        } catch (e) {
          req.log.error({ err: e }, "[WhatsApp] Notification error");
        }
      })();
    }

    // Re-send out-for-delivery WhatsApp when the delivery person is changed
    // on an order that is already "out_for_delivery" (e.g. express order where
    // the admin swaps Porter for an in-house person after the initial notification).
    {
      const prevAssigned = String(prev.assignedDeliveryPersonId ?? "");
      const newAssigned = String(update.assignedDeliveryPersonId ?? prevAssigned);
      const currentStatus = String((result as any).status ?? "");
      const deliveryPersonChanged =
        assignedDeliveryPersonId !== undefined && newAssigned !== prevAssigned;
      const assignedRealPerson = !!newAssigned && newAssigned !== "porter_delivery";
      const orderIsOfd = currentStatus === "out_for_delivery";
      // Don't double-fire when status ALSO changed to out_for_delivery in this same request
      const statusJustBecameOfd =
        status !== undefined &&
        String(status) === "out_for_delivery" &&
        String(prev.status ?? "") !== "out_for_delivery";

      if (deliveryPersonChanged && assignedRealPerson && orderIsOfd && !statusJustBecameOfd) {
        const orderDoc = result as any;
        (async () => {
          try {
            let dpPhone = "";
            try {
              const dp = await HubUser.findById(newAssigned, { phone: 1 }).lean();
              dpPhone = String((dp as any)?.phone ?? "").trim();
            } catch (e) {
              req.log.warn({ err: e }, "[WhatsApp] Could not fetch delivery person phone for re-notification");
            }
            console.log(
              `[WhatsApp] Re-firing out_for_delivery for order ${orderDoc.orderId} — ` +
              `delivery person changed from ${prevAssigned} to ${newAssigned}`
            );
            await sendOutForDelivery(orderDoc, dpPhone, req.log);
          } catch (e) {
            req.log.error({ err: e }, "[WhatsApp] Re-notification error on delivery person change");
          }
        })();
      }
    }

    // Sync timeslot order counts to MongoDB after any status change on a slot order.
    if (TIMESLOT_FEATURE_ENABLED && (result as any).scheduleType === "slot" && (result as any).timeslotId && (result as any).subHubName) {
      syncTimeslotOrderCounts(String((result as any).timeslotId), String((result as any).subHubName), req.log);
    }
  } catch (err) {
    req.log.error({ err }, "Failed to update order");
    res.status(500).json({ error: "InternalError", message: "Failed to update order" });
  }
});

// DELETE /api/orders/:id — delete an order
router.delete("/:id", async (req: ScopedRequest, res) => {
  try {
    const oid = toId(req.params.id);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid order ID" }); return; }
    const conn = await getOrdersDb();
    req.log.info({ id: req.params.id, oid: oid.toHexString() }, "Attempting to delete order");
    const existing = await conn.db.collection(COLLECTION).findOne({ _id: oid });
    if (!existing || !isOrderInScope(req.scope, existing, req)) {
      res.status(404).json({ error: "NotFound", message: "Order not found" }); return;
    }
    // Soft-delete: mark as deleted so it can be restored later.
    // The order stays in the DB; inventory/wallet/coupons are released exactly
    // as they were before (same side-effects as hard-delete).
    const result = await conn.db.collection(COLLECTION).updateOne(
      { _id: oid },
      { $set: { isDeleted: true, deletedAt: new Date(), inventoryDeducted: false } }
    );
    req.log.info({ modifiedCount: result.modifiedCount }, "Soft-delete result");
    if (result.modifiedCount === 0) { res.status(404).json({ error: "NotFound", message: "Order not found" }); return; }

    // Restore inventory for any deducted items.
    try {
      await applyOrderInventoryOnDelete(existing as any, (existing as any).inventoryDeducted === true);
    } catch (e) {
      req.log.error({ err: e }, "Failed to restore inventory on order delete");
    }

    try {
      await syncOrderBankPayments({ orderId: req.params.id, payments: [] });
    } catch (e) {
      req.log.error({ err: e }, "Failed to remove order payments from banking");
    }

    // Refund wallet if the deleted order had wallet payments and was NOT already cancelled.
    // Cancelled orders already had their wallet refunded at the time of cancellation.
    if ((existing as any).customerId && (existing as any).status !== "cancelled") {
      try {
        const walletToRefund = ((existing as any).payments ?? [])
          .filter((p: any) => p.mode === "wallet")
          .reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
        if (walletToRefund > 0) {
          const cCol = await getCustomersCollection();
          await pushWalletTx(cCol, String((existing as any).customerId), walletToRefund,
            "Order deleted — wallet refunded",
            { orderId: String((existing as any).orderId || ""), orderRef: req.params.id }
          );
          req.log.info({ customerId: (existing as any).customerId, refunded: walletToRefund }, "Wallet refunded on order delete");
        }
      } catch (e) {
        req.log.error({ err: e }, "Failed to refund wallet on order delete");
      }
    }

    // Release coupon locks when an order is deleted.
    // Decrement usedCount in activeCoupons and ALWAYS remove from usedCoupons —
    // physical deletion wipes the order entirely, so no coupon history should remain.
    if ((existing as any).customerId) {
      try {
        const deletedCoupons = extractOrderCoupons(existing);
        const cCol = await getCustomersCollection();
        const orderId = req.params.id;
        const custOid = new mongoose.Types.ObjectId(String((existing as any).customerId));

        // Decrement activeCoupons (safe no-op if the entry was already moved out on delivery)
        for (const c of deletedCoupons) {
          await decrementActiveCoupon(cCol, String((existing as any).customerId), c.couponId, orderId, req.log);
        }

        // Remove from usedCoupons — applies to delivered orders where the coupon was finalised
        await cCol.updateOne(
          { _id: custOid },
          { $pull: { usedCoupons: { orderId } } as any }
        );

        req.log.info({ customerId: (existing as any).customerId, orderId }, "Coupon lifecycle: activeCoupons decremented + usedCoupons cleared on order delete");
      } catch (e) {
        req.log.error({ err: e }, "Failed to clean up coupon on order delete");
      }
    }

    // Remove the deleted order's stored ref from the customer's orders array.
    // Without this, the customer detail page still shows the order as "active"
    // because enrichCustomers falls back to the stale ref in customer.orders.
    if ((existing as any).customerId) {
      try {
        const cCol = await getCustomersCollection();
        const orderId = req.params.id;
        await cCol.updateOne(
          { _id: new mongoose.Types.ObjectId(String((existing as any).customerId)) },
          { $pull: { orders: { $or: [{ _id: oid }, { id: orderId }, { orderId }] } } as any }
        );
        req.log.info({ customerId: (existing as any).customerId, orderId }, "Removed order ref from customer.orders on delete");
      } catch (e) {
        req.log.error({ err: e }, "Failed to remove order ref from customer on delete");
      }
    }

    res.json({ success: true });

    // Sync timeslot order counts to MongoDB after deleting a slot order.
    if (TIMESLOT_FEATURE_ENABLED && (existing as any).scheduleType === "slot" && (existing as any).timeslotId && (existing as any).subHubName) {
      syncTimeslotOrderCounts(String((existing as any).timeslotId), String((existing as any).subHubName), req.log);
    }
  } catch (err) {
    req.log.error({ err }, "Failed to delete order");
    res.status(500).json({ error: "InternalError", message: "Failed to delete order" });
  }
});

// DELETE /api/orders/:id/permanent — permanently destroy a soft-deleted order
router.delete("/:id/permanent", async (req: ScopedRequest, res) => {
  try {
    const oid = toId(req.params.id);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid order ID" }); return; }
    const conn = await getOrdersDb();
    const existing = await conn.db.collection(COLLECTION).findOne({ _id: oid, isDeleted: true });
    if (!existing || !isOrderInScope(req.scope, existing, req)) {
      res.status(404).json({ error: "NotFound", message: "Order not found or not in deleted state" }); return;
    }
    await conn.db.collection(COLLECTION).deleteOne({ _id: oid });
    req.log.info({ id: req.params.id }, "Order permanently deleted");
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to permanently delete order");
    res.status(500).json({ error: "InternalError", message: "Failed to permanently delete order" });
  }
});

// POST /api/orders/:id/restore — restore a soft-deleted order
// Re-deducts inventory, re-applies wallet charge, re-applies coupon locks.
router.post("/:id/restore", async (req: ScopedRequest, res) => {
  try {
    const oid = toId(req.params.id);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid order ID" }); return; }
    const conn = await getOrdersDb();
    const existing = await conn.db.collection(COLLECTION).findOne({ _id: oid, isDeleted: true });
    if (!existing || !isOrderInScope(req.scope, existing, req)) {
      res.status(404).json({ error: "NotFound", message: "Order not found or not in deleted state" }); return;
    }
    const failedFtwPayment =
      isFtwPaymentOnHold(existing) &&
      String(existing.paymentStatus ?? "").trim().toLowerCase() === "failed";
    const expiredFtwPayment = isFtwOrder(existing) &&
      String(existing.paymentStatus ?? "").trim().toLowerCase() === "pending" &&
      !!(await conn.db.collection(COLLECTION).findOne(
        {
          _id: oid,
          paymentExpiresAt: { $type: "date" },
          $expr: { $lte: ["$paymentExpiresAt", "$$NOW"] },
        },
        { projection: { _id: 1 } },
      ));
    if (failedFtwPayment || expiredFtwPayment) {
      res.status(409).json({
        error: "FtwPaymentExpired",
        message: "A failed or expired FTW payment order cannot be restored.",
      });
      return;
    }

    // Atomically claim the restore: the filter requires isDeleted: true, so if two
    // requests race (e.g. a double-click) only the first one's update matches —
    // the second gets null back and is rejected instead of re-deducting inventory.
    const claimed = await conn.db.collection(COLLECTION).findOneAndUpdate(
      {
        _id: oid,
        isDeleted: true,
        $nor: [
          {
            orderId: { $regex: "^#*FTW", $options: "i" },
            paymentStatus: { $regex: "^failed$", $options: "i" },
          },
          {
            orderId: { $regex: "^#*FTW", $options: "i" },
            paymentStatus: { $regex: "^pending$", $options: "i" },
            paymentExpiresAt: { $type: "date" },
            $expr: { $lte: ["$paymentExpiresAt", "$$NOW"] },
          },
        ],
      },
      { $set: { isDeleted: false, inventoryDeducted: true }, $unset: { deletedAt: "" } },
      { returnDocument: "before" }
    );
    if (!claimed) {
      res.status(409).json({ error: "AlreadyRestored", message: "Order was already restored" });
      return;
    }

    // Re-deduct inventory. If this fails we must roll back isDeleted so the
    // order doesn't appear in normal tabs with no inventory deducted.
    try {
      await applyOrderInventoryOnCreate(existing as any, "order_restored");
    } catch (e) {
      // Full rollback: return order to deleted state so it doesn't appear in
      // normal tabs with inconsistent inventory.
      await conn.db.collection(COLLECTION).updateOne(
        { _id: oid },
        { $set: { isDeleted: true, inventoryDeducted: false, deletedAt: (existing as any).deletedAt ?? new Date() } }
      );
      req.log.error({ err: e }, "Failed to re-deduct inventory on order restore — rolling back");
      const isStockError = (e as any)?.name === "InsufficientStockError";
      res.status(isStockError ? 400 : 500).json({
        error: isStockError ? "InsufficientStock" : "InventoryError",
        message: isStockError
          ? `Could not restore order: ${(e as Error).message}. No changes were made.`
          : "Could not restore order: insufficient stock. No changes were made.",
      });
      return;
    }

    // Re-sync banking payments.
    try {
      await syncOrderBankPayments({ orderId: req.params.id, payments: (existing as any).payments ?? [] });
    } catch (e) {
      req.log.error({ err: e }, "Failed to re-sync banking on order restore");
    }

    // Re-deduct wallet (only if the original order was not cancelled — cancelled
    // orders already had their wallet refunded at cancellation time, and the soft-
    // delete did not refund again for them).
    if ((existing as any).customerId && (existing as any).status !== "cancelled") {
      try {
        const walletToDeduct = ((existing as any).payments ?? [])
          .filter((p: any) => p.mode === "wallet")
          .reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
        if (walletToDeduct > 0) {
          const cCol = await getCustomersCollection();
          await pushWalletTx(cCol, String((existing as any).customerId), -walletToDeduct,
            "Order restored — wallet re-deducted",
            { orderId: String((existing as any).orderId || ""), orderRef: req.params.id }
          );
          req.log.info({ customerId: (existing as any).customerId, deducted: walletToDeduct }, "Wallet re-deducted on order restore");
        }
      } catch (e) {
        req.log.error({ err: e }, "Failed to re-deduct wallet on order restore");
      }
    }

    // Re-apply coupon state according to the order's status.
    //
    // Symmetry with the delete path (which always decrements activeCoupons
    // and always pulls from usedCoupons):
    //   - active status  → the coupon was in activeCoupons → re-upsert activeCoupons
    //   - delivered      → coupon was moved to usedCoupons at delivery, then
    //                       activeCoupons.decrement was a no-op → only restore usedCoupons
    //   - cancelled      → coupon was already released at cancel time, delete's
    //                       decrement was a no-op → no restoration needed
    if ((existing as any).customerId) {
      try {
        const restoredCoupons = extractOrderCoupons(existing);
        const orderStatus: string = (existing as any).status ?? "";
        const cCol = await getCustomersCollection();
        const orderId = req.params.id;
        const custOid = new mongoose.Types.ObjectId(String((existing as any).customerId));
        const ACTIVE_STATUSES_SET = new Set(["pending", "confirmed", "out_for_delivery", "takeaway"]);

        if (ACTIVE_STATUSES_SET.has(orderStatus)) {
          // Active order: restore activeCoupons count (exactly reverses the decrement on delete).
          for (const c of restoredCoupons) {
            await upsertActiveCoupon(
              cCol,
              String((existing as any).customerId),
              c,
              orderId,
              String((existing as any).subHubId ?? ""),
              req.log,
            );
          }
        } else if (orderStatus === "delivered") {
          // Delivered order: restore only usedCoupons (activeCoupons decrement on delete
          // was a no-op since it was already cleared at delivery time).
          for (const c of restoredCoupons) {
            await cCol.updateOne(
              { _id: custOid },
              {
                $addToSet: {
                  usedCoupons: {
                    couponId: c.couponId,
                    couponCode: c.couponCode,
                    orderId,
                    usedAt: (existing as any).updatedAt ?? new Date(),
                  },
                },
              } as any
            );
          }
        }
        // cancelled: no coupon restore needed — coupons were already released at cancellation.

        req.log.info(
          { customerId: (existing as any).customerId, orderId, orderStatus },
          "Coupon lifecycle: coupons re-applied on order restore"
        );
      } catch (e) {
        req.log.error({ err: e }, "Failed to re-apply coupons on order restore");
      }
    }

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to restore order");
    res.status(500).json({ error: "InternalError", message: "Failed to restore order" });
  }
});

export default router;
