import { Router, type IRouter } from "express";
import mongoose from "mongoose";
import { SubHub } from "../db/models/sub-hub.js";
import { SuperHub } from "../db/models/super-hub.js";
import { getSubHubDbConnection } from "../db/sub-hub-connections.js";
import { requireAuth } from "../middlewares/auth.js";
import { loadScope, type ScopedRequest } from "../middlewares/scope.js";
import { logger } from "../lib/logger.js";
import { getInventoryUpdateAction } from "./inventory-update-policy.mjs";
import {
  getOutstandingDeductionMovements,
  inventoryQuantityForOrder,
  planBatchConsumption,
  restoreBatchAllocations,
  sortBatchesByExpiry,
  type BatchAllocation,
} from "./inventory-batch-order.mjs";

const router: IRouter = Router();
router.use(requireAuth as any);
router.use(loadScope as any);

const MOVEMENTS_COLLECTION = "inventory_movements";
const ADJUSTMENTS_COLLECTION = "inventory_adjustments";

// ── Process-level mutex: prevents concurrent product-stock mutations from
// overlapping reads (two simultaneous orders deducting the same product each
// read the same stale qty and both write back qty-5 instead of qty-10).
let _deductionBusy = false;
async function withDeductionLock<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  while (_deductionBusy) {
    if (Date.now() - start > 10_000) throw new Error("deduction lock timeout after 10s");
    await new Promise((r) => setTimeout(r, 50));
  }
  _deductionBusy = true;
  try { return await fn(); }
  finally { _deductionBusy = false; }
}

/**
 * Thrown when a stock deduction is blocked because available inventory is
 * less than the requested quantity. Caught in the order-creation route to
 * return a 409 and cancel the just-inserted order document.
 */
export class InsufficientStockError extends Error {
  constructor(
    public readonly productName: string,
    public readonly available: number,
    public readonly requested: number,
  ) {
    super(`Insufficient stock for "${productName}": requested ${requested}, available ${available}`);
    this.name = "InsufficientStockError";
  }
}

function toId(id: string) {
  try { return new mongoose.Types.ObjectId(id); } catch { return null; }
}

/**
 * Returns true if the request user is allowed to access the given sub hub.
 * Master admins always have access; non-master users must have the sub hub
 * in their resolved scope.
 */
function userCanAccessSubHub(req: ScopedRequest, subHubId: string): boolean {
  const scope = req.scope;
  if (!scope || scope.isMaster) return true;
  return scope.subHubIds.includes(String(subHubId));
}

async function getCtx(subHubId: string, res: any, req?: ScopedRequest) {
  if (req && !userCanAccessSubHub(req, subHubId)) {
    res.status(403).json({ error: "Forbidden", message: "You do not have access to this sub hub" });
    return null;
  }
  const sub = await SubHub.findById(subHubId);
  if (!sub) { res.status(404).json({ error: "NotFound", message: "Sub hub not found" }); return null; }
  if (!sub.dbName) { res.status(400).json({ error: "NoDB", message: "Sub hub has no database linked" }); return null; }
  const conn = await getSubHubDbConnection(sub.dbName);
  return { sub, conn };
}

// ─── BATCH HELPERS ────────────────────────────────────────────────────────────
type Batch = {
  _id?: any;
  batchNumber?: string;
  quantity: number;
  fishWeightKg?: number | null;
  fishPrice?: number | null;
  fishPricePerKg?: number | null;
  shelfLifeDays?: number | null;
  receivedDate?: Date | null;
  expiryDate?: Date | null;
  notes?: string;
  createdAt?: Date;
};

function toDate(v: any): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function normalizeBatch(b: any): Batch {
  const received = toDate(b?.receivedDate) ?? new Date();
  const shelf = b?.shelfLifeDays != null && b.shelfLifeDays !== "" ? Number(b.shelfLifeDays) : null;
  const fishWeightInput = b?.fishWeightKg != null && b.fishWeightKg !== "" ? Number(b.fishWeightKg) : NaN;
  const fishPriceInput = b?.fishPrice != null && b.fishPrice !== "" ? Number(b.fishPrice) : NaN;
  const fishPricePerKgInput = b?.fishPricePerKg != null && b.fishPricePerKg !== "" ? Number(b.fishPricePerKg) : NaN;
  const fishWeightValue = Number.isFinite(fishWeightInput) ? Math.round(fishWeightInput * 1000) / 1000 : NaN;
  const fishPriceValue = Number.isFinite(fishPriceInput) ? Math.round(fishPriceInput * 100) / 100 : NaN;
  const fishPricePerKgValue = Number.isFinite(fishPricePerKgInput) ? Math.round(fishPricePerKgInput * 100) / 100 : NaN;
  let expiry = toDate(b?.expiryDate);
  if (!expiry && shelf != null && Number.isFinite(shelf)) {
    expiry = new Date(received.getTime() + shelf * 24 * 60 * 60 * 1000);
  }
  return {
    _id: b?._id ?? new mongoose.Types.ObjectId(),
    batchNumber: b?.batchNumber ? String(b.batchNumber).trim() : "",
    quantity: Math.max(0, Number(b?.quantity) || 0),
    ...(Number.isFinite(fishWeightValue) && fishWeightValue > 0 ? { fishWeightKg: fishWeightValue } : {}),
    ...(Number.isFinite(fishPriceValue) && fishPriceValue >= 0 ? { fishPrice: fishPriceValue } : {}),
    ...(Number.isFinite(fishPricePerKgValue) && fishPricePerKgValue > 0 ? { fishPricePerKg: fishPricePerKgValue } : {}),
    shelfLifeDays: shelf != null && Number.isFinite(shelf) ? shelf : null,
    receivedDate: received,
    expiryDate: expiry,
    notes: b?.notes ? String(b.notes).trim() : "",
    createdAt: b?.createdAt ? new Date(b.createdAt) : new Date(),
  };
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeBulkPortionWeights(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((weight) => Math.round(Number(weight) * 1000) / 1000)
    .filter((weight) => Number.isFinite(weight) && weight > 0))]
    .sort((a, b) => a - b);
}

function resolvedFishInventoryMode(product: any): "standard" | "whole_fish" | "bulk_portions" {
  if (product?.fishInventoryMode === "bulk_portions") return "bulk_portions";
  if (product?.fishInventoryMode === "whole_fish" || product?.wholeFishInventory === true) return "whole_fish";
  return "standard";
}

function batchesTotal(batches: Batch[] | undefined | null): number {
  if (!Array.isArray(batches)) return 0;
  return batches.reduce((s, b) => s + (Number(b?.quantity) || 0), 0);
}

function batchSnapshot(batch: Batch) {
  return {
    batchNumber: batch.batchNumber || "",
    fishWeightKg: batch.fishWeightKg ?? null,
    fishPrice: batch.fishPrice ?? null,
    fishPricePerKg: batch.fishPricePerKg ?? null,
    shelfLifeDays: batch.shelfLifeDays ?? null,
    receivedDate: batch.receivedDate ?? null,
    expiryDate: batch.expiryDate ?? null,
    notes: batch.notes ?? "",
    createdAt: batch.createdAt,
  };
}

function availableBatchesTotal(batches: Batch[] | undefined | null, now: Date = new Date()): number {
  if (!Array.isArray(batches)) return 0;
  const nowMs = now.getTime();
  return batches.reduce((total, batch) => {
    if (batch.expiryDate && new Date(batch.expiryDate).getTime() < nowMs) return total;
    return total + (Number(batch.quantity) || 0);
  }, 0);
}

/**
 * Consume `qty` units from batches by earliest expiry first,
 * skipping any batches that have already expired.
 * Expired batches are preserved unchanged in the returned list so
 * admins can still see and remove them manually.
 * If non-expired batches are insufficient, `remaining` will be > 0.
 */
function consumeBatches(
  batches: Batch[],
  qty: number,
  now: Date = new Date(),
  preferredBatchId?: unknown,
): { batches: Batch[]; remaining: number; allocations: BatchAllocation[] } {
  const nowMs = now.getTime();

  // Split into expired (untouched) and active (eligible for deduction)
  const expired = batches.filter((b) => b.expiryDate && new Date(b.expiryDate).getTime() < nowMs);
  const active  = batches.filter((b) => !b.expiryDate || new Date(b.expiryDate).getTime() >= nowMs);

  const plan = planBatchConsumption(active, qty, preferredBatchId);
  const allocations: BatchAllocation[] = plan.allocations.map((allocation) => {
    const sourceBatch = active.find((batch) => String(batch._id) === String(allocation.batchId));
    if (!sourceBatch) throw new Error(`Batch ${String(allocation.batchId)} disappeared while planning a deduction`);
    sourceBatch.quantity -= allocation.quantity;
    return { ...allocation, batchSnapshot: batchSnapshot(sourceBatch) };
  });
  const sorted = sortBatchesByExpiry(active);

  // Keep ALL batches — including emptied ones (quantity=0) so they appear in
  // the "Completed Batches" tab in the admin UI.  Expired batches are always kept.
  const result = [...expired, ...sorted];
  return { batches: result, remaining: plan.remaining, allocations };
}

/**
 * Sync a product document so `quantity` matches the sum of its batches,
 * keeps batches normalized and persisted.
 */
async function persistBatches(
  productsCol: any,
  productId: any,
  batches: Batch[],
  extra: Record<string, any> = {},
  combosCol?: any,
) {
  const normalized = batches.map((b) => normalizeBatch(b));
  // quantity = only non-expired stock (expired batches are kept for admin visibility but not available for sale)
  const nowMs = Date.now();
  const total = batchesTotal(normalized.filter((b) => !b.expiryDate || new Date(b.expiryDate).getTime() >= nowMs));
  const result = await productsCol.updateOne(
    { _id: productId },
    { $set: { batches: normalized, quantity: total, updatedAt: new Date(), ...extra } }
  );
  if (result.matchedCount === 0) {
    logger.warn({ productId: String(productId), total }, "persistBatches: updateOne matched 0 documents — product not found by _id");
  } else if (result.modifiedCount === 0) {
    logger.warn({ productId: String(productId), total }, "persistBatches: updateOne matched but modified 0 documents — data unchanged");
  } else {
    logger.info({ productId: String(productId), newTotal: total, batchCount: normalized.length }, "persistBatches: stock updated successfully");
  }

  // Sync combo isActive based on whether this product's stock is available.
  // productId may be stored as a string or ObjectId inside combo.includes — match both.
  if (combosCol) {
    const pidStr = String(productId);
    const pidOid = toId(pidStr);
    const pidFilter = pidOid
      ? { "includes.productId": { $in: [pidStr, pidOid] } }
      : { "includes.productId": pidStr };

    if (total === 0) {
      // Stock is 0 (all batches consumed or expired) → deactivate every combo containing this product.
      const deactivated = await combosCol.updateMany(
        { ...pidFilter, isActive: true },
        { $set: { isActive: false, updatedAt: new Date() } },
      );
      if (deactivated.modifiedCount > 0) {
        logger.info(
          { productId: pidStr, combosDeactivated: deactivated.modifiedCount },
          "persistBatches: stock reached 0 — deactivated combos containing this product",
        );
      }
    } else if (total > 0) {
      // Product now has available stock — re-activate any inactive combo that includes
      // this product, but only when ALL of its other constituent products also have stock.
      const inactiveCombos = await combosCol.find(
        { ...pidFilter, isActive: false },
      ).toArray();

      const toReactivate: any[] = [];
      for (const combo of inactiveCombos) {
        const includes: any[] = Array.isArray(combo.includes) ? combo.includes : [];
        let allHaveStock = true;
        for (const inc of includes) {
          if (String(inc.productId) === pidStr) continue; // already confirmed > 0
          const other = await productsCol.findOne({ _id: toId(String(inc.productId)) }, { projection: { quantity: 1 } });
          if (!other || (Number(other.quantity) || 0) <= 0) { allHaveStock = false; break; }
        }
        if (allHaveStock) toReactivate.push(combo._id);
      }

      if (toReactivate.length > 0) {
        await combosCol.updateMany(
          { _id: { $in: toReactivate } },
          { $set: { isActive: true, updatedAt: new Date() } },
        );
        logger.info(
          { productId: pidStr, combosReactivated: toReactivate.length },
          "persistBatches: product stock restored — reactivated combos containing this product",
        );
      }
    }
  }

  return { batches: normalized, quantity: total };
}

// ─── ANALYTICS SUMMARY (across sub-hubs in the user's scope) ─────────────────
router.get("/analytics/summary", async (req: ScopedRequest, res) => {
  try {
    const scope = req.scope;
    const subFilter: any = {};
    if (scope && !scope.isMaster) {
      const ids = scope.subHubIds.map((id) => {
        try { return new mongoose.Types.ObjectId(id); } catch { return null; }
      }).filter(Boolean) as mongoose.Types.ObjectId[];
      if (ids.length === 0) {
        res.json({
          overview: {
            totalSubHubs: 0, trackedSubHubs: 0, totalProducts: 0, activeProducts: 0,
            outOfStockCount: 0, lowStockCount: 0, expiringSoonCount: 0, expiredCount: 0,
            totalStockValue: 0, totalQuantity: 0, categoryCount: 0,
            movementsTotal: 0, movements30d: 0, adjustmentsTotal: 0, adjustments30d: 0,
          },
          lowStock: [], expiringBatches: [], recentMovements: [], subHubBreakdown: [],
        });
        return;
      }
      subFilter._id = { $in: ids };
    }
    const subs = await SubHub.find(subFilter).lean();
    let totalProducts = 0;
    let activeProducts = 0;
    let outOfStockCount = 0;
    let lowStockCount = 0;
    let expiringSoonCount = 0;
    let expiredCount = 0;
    let totalStockValue = 0;
    let totalQuantity = 0;
    let movements30d = 0;
    let movementsTotal = 0;
    let adjustments30d = 0;
    let adjustmentsTotal = 0;
    let categories = new Set<string>();

    type LowItem = { id: string; name: string; variantLabel?: string; quantity: number; unit: string; category: string; subHubName: string; subHubId: string };
    type ExpiringItem = { id: string; name: string; quantity: number; unit: string; expiryDate: string; subHubName: string; subHubId: string; daysLeft: number };
    type SubSummary = { id: string; name: string; products: number; outOfStock: number; lowStock: number; stockValue: number };
    type RecentMove = any;
    const lowItems: LowItem[] = [];
    const expiringItems: ExpiringItem[] = [];
    const subSummaries: SubSummary[] = [];
    const recent: RecentMove[] = [];

    const now = new Date();
    const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const soonCutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    for (const sub of subs) {
      if (!sub.dbName) continue;
      const conn = await getSubHubDbConnection(sub.dbName);
      const productsCol = conn.db.collection("products");
      const movementsCol = conn.db.collection(MOVEMENTS_COLLECTION);
      const adjustmentsCol = conn.db.collection(ADJUSTMENTS_COLLECTION);

      const products = await productsCol.find({}).toArray();
      let subStockValue = 0;
      let subOut = 0;
      let subLow = 0;
      for (const p of products) {
        const batches: Batch[] = Array.isArray(p.batches) ? p.batches : [];
        const qty = batches.length > 0 ? batchesTotal(batches) : (Number(p.quantity) || 0);
        const price = Number(p.price) || 0;
        totalProducts += 1;
        totalQuantity += qty;
        totalStockValue += qty * price;
        subStockValue += qty * price;
        if ((p.status ?? "available") === "available") activeProducts += 1;
        if (p.category) categories.add(String(p.category));
        if (qty <= 0) { outOfStockCount += 1; subOut += 1; }
        else if (qty < 5) {
          lowStockCount += 1;
          subLow += 1;
          lowItems.push({
            id: String(p._id),
            name: p.name ?? "",
            variantLabel: inventoryVariantLabel(p),
            quantity: qty,
            unit: p.unit ?? "",
            category: p.category ?? "",
            subHubName: sub.name ?? "",
            subHubId: String(sub._id),
          });
        }
        for (const b of batches) {
          if (!b.expiryDate || (Number(b.quantity) || 0) <= 0) continue;
          const exp = new Date(b.expiryDate);
          if (isNaN(exp.getTime())) continue;
          const daysLeft = Math.ceil((exp.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
          if (exp.getTime() < now.getTime()) {
            expiredCount += 1;
            expiringItems.push({
              id: String(p._id), name: p.name ?? "", quantity: Number(b.quantity) || 0, unit: p.unit ?? "",
              expiryDate: exp.toISOString(), subHubName: sub.name ?? "", subHubId: String(sub._id), daysLeft,
            });
          } else if (exp.getTime() <= soonCutoff.getTime()) {
            expiringSoonCount += 1;
            expiringItems.push({
              id: String(p._id), name: p.name ?? "", quantity: Number(b.quantity) || 0, unit: p.unit ?? "",
              expiryDate: exp.toISOString(), subHubName: sub.name ?? "", subHubId: String(sub._id), daysLeft,
            });
          }
        }
      }
      subSummaries.push({
        id: String(sub._id),
        name: sub.name ?? "",
        products: products.length,
        outOfStock: subOut,
        lowStock: subLow,
        stockValue: subStockValue,
      });

      const [moveTotal, moveRecent, adjTotal, adjRecent, recentDocs] = await Promise.all([
        movementsCol.countDocuments({}),
        movementsCol.countDocuments({ createdAt: { $gte: since30 } }),
        adjustmentsCol.countDocuments({}),
        adjustmentsCol.countDocuments({ createdAt: { $gte: since30 } }),
        movementsCol.find({}).sort({ createdAt: -1 }).limit(8).toArray(),
      ]);
      movementsTotal += moveTotal;
      movements30d += moveRecent;
      adjustmentsTotal += adjTotal;
      adjustments30d += adjRecent;
      for (const m of recentDocs) {
        recent.push({ ...m, subHubName: sub.name ?? "", subHubId: String(sub._id) });
      }
    }

    lowItems.sort((a, b) => a.quantity - b.quantity);
    expiringItems.sort((a, b) => a.daysLeft - b.daysLeft);
    recent.sort((a, b) => +new Date(b.createdAt ?? 0) - +new Date(a.createdAt ?? 0));
    subSummaries.sort((a, b) => b.stockValue - a.stockValue);

    res.json({
      overview: {
        totalSubHubs: subs.length,
        trackedSubHubs: subs.filter((s) => s.dbName).length,
        totalProducts,
        activeProducts,
        outOfStockCount,
        lowStockCount,
        expiringSoonCount,
        expiredCount,
        totalStockValue,
        totalQuantity,
        categoryCount: categories.size,
        movementsTotal,
        movements30d,
        adjustmentsTotal,
        adjustments30d,
      },
      lowStock: lowItems.slice(0, 10),
      expiringBatches: expiringItems.slice(0, 12),
      recentMovements: recent.slice(0, 10),
      subHubBreakdown: subSummaries.slice(0, 8),
    });
  } catch (err) {
    res.status(500).json({ error: "InternalError", message: "Failed to fetch inventory analytics" });
  }
});

function inventoryProductDisplayName(product: any): string {
  const name = String(product?.name ?? "");
  if (resolvedFishInventoryMode(product) !== "standard") return name;
  const label = product?.variantGroupId || product?.variantLabel ? inventoryVariantLabel(product) : "";
  return label ? `${name} (${label})` : name;
}

function inventoryVariantLabel(product: any): string {
  return String(product?.netWeight || product?.variantLabel || product?.weight || product?.grossWeight || "").trim();
}

// ─── PRODUCT LIST (for selected sub-hub) ──────────────────────────────────────
router.get("/products", async (req, res) => {
  try {
    const subHubId = String(req.query.subHubId || "");
    if (!subHubId) { res.status(400).json({ error: "ValidationError", message: "subHubId is required" }); return; }
    const ctx = await getCtx(subHubId, res, req as ScopedRequest);
    if (!ctx) return;
    const search = String(req.query.search || "");
    const query: any = search ? { name: { $regex: search, $options: "i" } } : {};
    const productsCollection = ctx.conn.db!.collection("products");
    const products = await productsCollection.find({ ...query, isDailyWholeFish: { $ne: true } }).sort({ category: 1, name: 1 }).toArray();
    const groupIds = [...new Set(products.map((product: any) => String(product.variantGroupId ?? "")).filter(Boolean))];
    const rootIds = groupIds.map((groupId) => toId(groupId)).filter((id) => id !== null) as any[];
    const roots = rootIds.length
      ? await productsCollection.find({ _id: { $in: rootIds } }).project({ unit: 1 }).toArray()
      : [];
    const groupUnits = new Map(roots.map((root: any) => [String(root._id), root.unit || "per pack"]));
    res.json({
      products: products.map((p: any) => {
        const batches: Batch[] = Array.isArray(p.batches) ? p.batches : [];
        const qty = batches.length > 0 ? batchesTotal(batches) : (Number(p.quantity) || 0);
        const fishInventoryMode = resolvedFishInventoryMode(p);
        return {
          id: String(p._id),
          name: p.name,
          variantGroupId: p.variantGroupId ? String(p.variantGroupId) : undefined,
          variantLabel: fishInventoryMode === "standard" && (p.variantGroupId || p.netWeight || p.variantLabel || p.weight || p.grossWeight)
            ? inventoryVariantLabel(p)
            : "",
          shortCode: p.shortCode ?? "",
          category: String(p.category ?? "").trim() ||
            (fishInventoryMode !== "standard" ? String(p.name ?? "").trim() : ""),
          subCategory: p.subCategory ?? "",
          unit: fishInventoryMode === "bulk_portions" ? "kg"
            : fishInventoryMode === "whole_fish" ? "per piece"
            : p.variantGroupId ? groupUnits.get(String(p.variantGroupId)) ?? p.unit ?? "" : p.unit ?? "",
          price: fishInventoryMode !== "standard" && Number(p.fishPricePerKg) > 0
            ? Number(p.fishPricePerKg)
            : Number(p.price) || 0,
          quantity: qty,
          wholeFishInventory: fishInventoryMode === "whole_fish",
          fishInventoryMode,
          fishPricePerKg: Number(p.fishPricePerKg) > 0 ? Number(p.fishPricePerKg) : null,
          bulkPortionWeightsKg: normalizeBulkPortionWeights(p.bulkPortionWeightsKg),
          status: p.status ?? "available",
          imageUrl: p.imageUrl ?? "",
          isDailyWholeFish: p.isDailyWholeFish === true,
          dailyFishSourceProductId: p.dailyFishSourceProductId ? String(p.dailyFishSourceProductId) : undefined,
          dailyFishDate: p.dailyFishDate ?? undefined,
          batches: sortBatchesByExpiry(batches).map((b) => ({
            id: String(b._id ?? ""),
            batchNumber: b.batchNumber ?? "",
            quantity: Number(b.quantity) || 0,
            fishWeightKg: b.fishWeightKg != null ? Number(b.fishWeightKg) : null,
            fishPrice: b.fishPrice != null ? Number(b.fishPrice) : null,
            fishPricePerKg: b.fishPricePerKg != null ? Number(b.fishPricePerKg) : null,
            shelfLifeDays: b.shelfLifeDays ?? null,
            receivedDate: b.receivedDate ? new Date(b.receivedDate).toISOString() : null,
            expiryDate: b.expiryDate ? new Date(b.expiryDate).toISOString() : null,
            notes: b.notes ?? "",
            createdAt: b.createdAt ? new Date(b.createdAt).toISOString() : null,
          })),
        };
      }),
      total: products.length,
      subHub: { id: String(ctx.sub._id), name: ctx.sub.name, dbName: ctx.sub.dbName },
    });
  } catch (err) {
    req.log.error({ err }, "Failed to list inventory products");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch products" });
  }
});

// ─── MOVEMENT HISTORY ─────────────────────────────────────────────────────────
router.get("/movements", async (req, res) => {
  try {
    const subHubId = String(req.query.subHubId || "");
    if (!subHubId) { res.status(400).json({ error: "ValidationError", message: "subHubId is required" }); return; }
    const ctx = await getCtx(subHubId, res, req as ScopedRequest);
    if (!ctx) return;
    const productId = String(req.query.productId || "");
    const orderId = String(req.query.orderId || "");
    const type = String(req.query.type || "");
    const search = String(req.query.search || "").trim();
    const fromValue = String(req.query.from || "");
    const toValue = String(req.query.to || "");
    const fromDate = fromValue ? new Date(fromValue) : null;
    const toDate = toValue ? new Date(toValue) : null;
    if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) {
      res.status(400).json({ error: "ValidationError", message: "Invalid movement date range" });
      return;
    }
    if (fromDate && toDate && fromDate > toDate) {
      res.status(400).json({ error: "ValidationError", message: "Start date must be before end date" });
      return;
    }
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 100));
    const sortBy = String(req.query.sortBy || "newest");
    const movementSorts: Record<string, any> = {
      newest: { createdAt: -1, _id: -1 },
      oldest: { createdAt: 1, _id: 1 },
      product_asc: { productName: 1, createdAt: -1, _id: -1 },
      decrease: { change: 1, createdAt: -1, _id: -1 },
      increase: { change: -1, createdAt: -1, _id: -1 },
    };
    const filter: any = {};
    if (productId) filter.productId = productId;
    if (orderId) filter.orderId = orderId;
    if (type) filter.type = type;
    if (fromDate || toDate) {
      filter.createdAt = {
        ...(fromDate ? { $gte: fromDate } : {}),
        ...(toDate ? { $lt: toDate } : {}),
      };
    }
    if (search) {
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchRegex = { $regex: escapedSearch, $options: "i" };
      const movementSearchClauses: any[] = [
        { productName: searchRegex },
        { orderRef: searchRegex },
        { orderId: searchRegex },
        { reason: searchRegex },
        { subReason: searchRegex },
        { batchNumbers: searchRegex },
      ];
      const searchWords = search.split(/\s+/).filter(Boolean);
      const orderSearchClauses = searchWords.map((word) => {
        const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const wordRegex = { $regex: escapedWord, $options: "i" };
        const fields: any[] = [
          { orderId: wordRegex },
          { orderNumber: wordRegex },
          { customerName: wordRegex },
          { phone: wordRegex },
          { customerPhone: wordRegex },
          { email: wordRegex },
          { customerEmail: wordRegex },
          { customerId: wordRegex },
          { userId: wordRegex },
          { "customer.phone": wordRegex },
          { "customer.email": wordRegex },
          { "customer.name": wordRegex },
          { "customer.id": wordRegex },
          { "customer._id": wordRegex },
        ];
        const phoneDigits = word.replace(/\D/g, "");
        if (phoneDigits.length >= 3) {
          const formattedPhoneRegex = {
            $regex: phoneDigits.split("").join("\\D*"),
            $options: "i",
          };
          fields.push(
            { phone: formattedPhoneRegex },
            { customerPhone: formattedPhoneRegex },
            { "customer.phone": formattedPhoneRegex },
          );
        }
        return { $or: fields };
      });
      const ordersConn = await getSubHubDbConnection("orders");
      const matchingOrders = await ordersConn.db.collection("orders")
        .find({ $and: orderSearchClauses }, { projection: { _id: 1 } })
        .limit(10000)
        .toArray();
      if (matchingOrders.length > 0) {
        movementSearchClauses.push({
          orderId: { $in: matchingOrders.map((order: any) => String(order._id)) },
        });
      }
      filter.$or = movementSearchClauses;
    }
    const rows = await ctx.conn.db
      .collection(MOVEMENTS_COLLECTION)
      .find(filter)
      .sort(movementSorts[sortBy] ?? movementSorts.newest)
      .limit(limit)
      .toArray();

    // Enrich order-linked movements with customer name from the orders collection
    const orderIds = [...new Set(
      rows
        .filter((r: any) => r.orderId)
        .map((r: any) => {
          try { return new mongoose.Types.ObjectId(r.orderId); } catch { return null; }
        })
        .filter(Boolean)
    )];
    let customerMap: Map<string, string> = new Map();
    if (orderIds.length > 0) {
      try {
        const ordersConn = await getSubHubDbConnection("orders");
        const orderDocs = await ordersConn.db
          .collection("orders")
          .find({ _id: { $in: orderIds } }, { projection: { _id: 1, customerName: 1, orderId: 1 } })
          .toArray();
        for (const o of orderDocs) {
          customerMap.set(String(o._id), JSON.stringify({ customerName: o.customerName ?? "", invoiceId: o.orderId ?? "" }));
        }
      } catch (e) {
        logger.warn({ err: e }, "movements: failed to enrich customer names — returning without");
      }
    }

    const enriched = rows.map((r: any) => {
      if (!r.orderId) return r;
      const raw = customerMap.get(String(r.orderId));
      if (!raw) return r;
      try {
        const { customerName, invoiceId } = JSON.parse(raw);
        return { ...r, customerName: customerName || undefined, invoiceId: invoiceId || undefined };
      } catch {
        return { ...r, customerName: raw || undefined };
      }
    });

    res.json({ movements: enriched, total: enriched.length });
  } catch (err) {
    req.log.error({ err }, "Failed to list inventory movements");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch movements" });
  }
});

// ─── ADJUSTMENTS ──────────────────────────────────────────────────────────────
router.get("/adjustments", async (req, res) => {
  try {
    const subHubId = String(req.query.subHubId || "");
    if (!subHubId) { res.status(400).json({ error: "ValidationError", message: "subHubId is required" }); return; }
    const ctx = await getCtx(subHubId, res, req as ScopedRequest);
    if (!ctx) return;
    const rows = await ctx.conn.db
      .collection(ADJUSTMENTS_COLLECTION)
      .find({})
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    res.json({ adjustments: rows, total: rows.length });
  } catch (err) {
    req.log.error({ err }, "Failed to list inventory adjustments");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch adjustments" });
  }
});

router.post("/adjustments", async (req, res) => {
  try {
    const { subHubId, superHubId, date, reason, notes, items } = req.body ?? {};
    if (!subHubId) { res.status(400).json({ error: "ValidationError", message: "subHubId is required" }); return; }
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "ValidationError", message: "At least one item is required" }); return;
    }
    if (!reason || !String(reason).trim()) {
      res.status(400).json({ error: "ValidationError", message: "Reason is required" }); return;
    }
    const ctx = await getCtx(subHubId, res, req as ScopedRequest);
    if (!ctx) return;

    const superHub = superHubId ? await SuperHub.findById(superHubId) : null;
    const products = ctx.conn.db.collection("products");
    const movements = ctx.conn.db.collection(MOVEMENTS_COLLECTION);

    const adjustmentItems: any[] = [];
    const movementDocs: any[] = [];
    const now = new Date();
    const productIds = [...new Set(items.map((it: any) => toId(String(it?.productId || ""))).filter(Boolean))];
    const productDocs = productIds.length ? await products.find({ _id: { $in: productIds } }).toArray() : [];
    const productsById = new Map(productDocs.map((product: any) => [String(product._id), product]));

    // Validate every fish batch before writing any product so a malformed row
    // cannot leave a partially applied stock adjustment.
    for (const it of items) {
      const productId = toId(String(it?.productId || ""));
      if (!productId) continue;
      const existing = productsById.get(String(productId));
      const mode = String(it.mode || (it.addQuantity != null ? "add" : it.removeQuantity != null ? "remove" : "set"));
      const hasFishDetails = it.fishWeightKg !== undefined || it.fishPrice !== undefined || it.fishPricePerKg !== undefined;
      const requestedFishMode = it.fishInventoryMode != null
        ? String(it.fishInventoryMode)
        : resolvedFishInventoryMode(existing);
      if (it.fishInventoryMode != null && !["standard", "whole_fish", "bulk_portions"].includes(requestedFishMode)) {
        res.status(400).json({ error: "ValidationError", message: "Invalid fish inventory mode" });
        return;
      }
      if (requestedFishMode === "whole_fish" || requestedFishMode === "bulk_portions") {
        const rate = Number(it.fishPricePerKg ?? existing?.fishPricePerKg ?? existing?.price);
        if (!Number.isFinite(rate) || rate <= 0) {
          res.status(400).json({
            error: "ValidationError",
            message: `${String(existing?.name ?? "This product")} needs a customer selling price per kilogram`,
          });
          return;
        }
        if (requestedFishMode === "bulk_portions") {
          const weights = normalizeBulkPortionWeights(it.bulkPortionWeightsKg ?? existing?.bulkPortionWeightsKg);
          if (weights.length === 0) {
            res.status(400).json({
              error: "ValidationError",
              message: "Bulk fish needs at least one positive portion weight",
            });
            return;
          }
        }
      }
      if (existing && it.fishInventoryMode != null &&
        resolvedFishInventoryMode(existing) !== requestedFishMode &&
        batchesTotal(Array.isArray(existing.batches) ? existing.batches.map((batch: any) => normalizeBatch(batch)) : []) > 0) {
        res.status(409).json({
          error: "FishInventoryModeHasStock",
          message: "Sell or remove the current stock before changing this product's inventory mode",
        });
        return;
      }
      if (hasFishDetails) {
        if (existing?.variantGroupId && String(existing.variantGroupId) !== String(existing._id)) {
          res.status(400).json({
            error: "ValidationError",
            message: "Whole-fish stock must be added to the main product, not a weight sub-product",
          });
          return;
        }
        const weightKg = Math.round(Number(it.fishWeightKg) * 1000) / 1000;
        const rate = Number(it.fishPricePerKg);
        const fishPrice = Number.isFinite(rate) && rate > 0
          ? roundMoney(weightKg * rate)
          : roundMoney(Number(it.fishPrice));
        if (mode !== "add" || Number(it.addQuantity) !== 1 ||
          !Number.isFinite(weightKg) || weightKg <= 0 ||
          !Number.isFinite(fishPrice) || fishPrice <= 0) {
          res.status(400).json({
            error: "ValidationError",
            message: "Each whole-fish batch must be one fish with a positive weight and total price",
          });
          return;
        }
      }
      if (requestedFishMode === "whole_fish" && mode === "add" && !hasFishDetails) {
        res.status(400).json({
          error: "ValidationError",
          message: `${String(existing?.name ?? "This fish")} needs a weight and total price for each new fish batch`,
        });
        return;
      }
      if (requestedFishMode === "whole_fish" && mode === "add_existing") {
        res.status(400).json({
          error: "ValidationError",
          message: "Add each incoming fish as a new batch instead of increasing an existing fish batch",
        });
        return;
      }
      if (requestedFishMode === "whole_fish" && mode === "set") {
        res.status(400).json({
          error: "ValidationError",
          message: "Whole-fish stock must be adjusted one fish batch at a time",
        });
        return;
      }
    }

    for (const it of items) {
      const pid = toId(String(it.productId || ""));
      if (!pid) continue;
      const existing = await products.findOne({ _id: pid });
      if (!existing) continue;

      const currentBatches: Batch[] = Array.isArray(existing.batches) ? existing.batches.map((b: any) => normalizeBatch(b)) : [];
      const before = batchesTotal(currentBatches) || (Number(existing.quantity) || 0);

      const mode = String(it.mode || (it.addQuantity != null ? "add" : it.removeQuantity != null ? "remove" : "set"));
      const fishInventoryMode = it.fishInventoryMode != null
        ? String(it.fishInventoryMode)
        : resolvedFishInventoryMode(existing);
      const fishPricePerKgInput = Number(it.fishPricePerKg ?? existing.fishPricePerKg ?? existing.price);
      const fishPricePerKg = Number.isFinite(fishPricePerKgInput) && fishPricePerKgInput > 0
        ? roundMoney(fishPricePerKgInput)
        : null;
      const inventoryUnit = fishInventoryMode === "bulk_portions"
        ? "kg"
        : fishInventoryMode === "whole_fish"
          ? "per piece"
          : existing.unit ?? "";
      const bulkPortionWeightsKg = normalizeBulkPortionWeights(
        it.bulkPortionWeightsKg ?? existing.bulkPortionWeightsKg,
      );
      const fishConfigPatch: Record<string, any> = it.fishInventoryMode == null ? {} :
        fishInventoryMode === "whole_fish"
          ? {
              fishInventoryMode,
              wholeFishInventory: true,
              bulkPortionWeightsKg: [],
              fishPricePerKg,
            }
          : fishInventoryMode === "bulk_portions"
            ? {
                fishInventoryMode,
                wholeFishInventory: false,
                bulkPortionWeightsKg,
                fishPricePerKg,
              }
            : {
                fishInventoryMode: "standard",
                wholeFishInventory: false,
                bulkPortionWeightsKg: [],
                fishPricePerKg: null,
              };

      let newBatches = [...currentBatches];
      let delta = 0;
      let appliedBatch: Batch | null = null;

      if (mode === "configure") {
        if (fishInventoryMode === "whole_fish" && fishPricePerKg != null && it.repriceExistingFish === true) {
          newBatches = currentBatches.map((batch) => {
            const weight = Number(batch.fishWeightKg);
            if (!Number.isFinite(weight) || weight <= 0) return batch;
            return {
              ...batch,
              fishPricePerKg,
              fishPrice: roundMoney(weight * fishPricePerKg),
            };
          });
        }
        const persisted = await persistBatches(
          products,
          pid,
          newBatches,
          fishConfigPatch,
          ctx.conn.db.collection("combos"),
        );
        adjustmentItems.push({
          productId: String(pid),
          productName: inventoryProductDisplayName({ ...existing, ...fishConfigPatch }),
          unit: inventoryUnit,
          quantityBefore: before,
          newQuantity: persisted.quantity,
          quantityAdjusted: 0,
          mode: "configure",
        });
        movementDocs.push({
          type: "adjustment",
          productId: String(pid),
          productName: inventoryProductDisplayName({ ...existing, ...fishConfigPatch }),
          unit: inventoryUnit,
          change: 0,
          balance: persisted.quantity,
          reason: String(reason).trim(),
          notes: notes ? String(notes).trim() : "",
          createdAt: now,
        });
        continue;
      } else if (mode === "add") {
        const addQty = Math.max(0, Number(it.addQuantity) || 0);
        if (addQty <= 0) continue;
        const fishWeightKg = Number(it.fishWeightKg);
        const submittedFishPrice = Number(it.fishPrice);
        const fishPrice = fishInventoryMode === "whole_fish" && Number.isFinite(fishWeightKg) && fishPricePerKg != null
          ? roundMoney(fishWeightKg * fishPricePerKg)
          : submittedFishPrice;
        const batch = normalizeBatch({
          batchNumber: it.batchNumber,
          quantity: addQty,
          shelfLifeDays: it.shelfLifeDays,
          expiryDate: it.expiryDate,
          receivedDate: it.receivedDate ?? now,
          notes: it.notes,
          fishWeightKg: it.fishWeightKg,
          fishPrice: Number.isFinite(fishPrice) ? fishPrice : undefined,
          fishPricePerKg: fishInventoryMode === "whole_fish" ? fishPricePerKg : undefined,
          createdAt: now,
        });
        newBatches.push(batch);
        delta = addQty;
        appliedBatch = batch;
      } else if (mode === "add_existing") {
        const addQty = Math.max(0, Number(it.addQuantity) || 0);
        if (addQty <= 0) continue;
        if (!it.batchId) continue;
        const targetIdx = currentBatches.findIndex((b) => String(b._id) === String(it.batchId));
        if (targetIdx < 0) continue;
        newBatches = currentBatches.map((b, i) => i === targetIdx ? { ...b, quantity: b.quantity + addQty } : b);
        delta = addQty;
        appliedBatch = newBatches[targetIdx];
      } else if (mode === "remove") {
        const rmQty = Math.max(0, Number(it.removeQuantity) || 0);
        if (rmQty <= 0) continue;

        // If a specific batchId is provided, reduce from that batch first then earliest-expiry order for the remainder
        if (it.batchId) {
          const targetIdx = currentBatches.findIndex((b) => String(b._id) === String(it.batchId));
          if (targetIdx >= 0) {
            appliedBatch = currentBatches[targetIdx]; // capture before modification
            const working = currentBatches.map((b) => ({ ...b }));
            const target = working[targetIdx];
            const take = Math.min(target.quantity, rmQty);
            target.quantity -= take;
            const remaining = rmQty - take;
            if (remaining > 0) {
              // Consume from the rest in earliest-expiry order
              const others = working.filter((_, i) => i !== targetIdx);
              const consumed = consumeBatches(others, remaining);
              newBatches = [working[targetIdx], ...consumed.batches];
              delta = -(rmQty - consumed.remaining);
            } else {
              newBatches = working;
              delta = -take;
            }
          } else {
            // batchId not found — fall back to earliest-expiry order
            const consumed = consumeBatches(currentBatches, rmQty);
            newBatches = consumed.batches;
            delta = -(rmQty - consumed.remaining);
            // Capture first earliest-expiry batch for movement tracking
            if (!appliedBatch && currentBatches.length > 0) appliedBatch = currentBatches[0];
          }
        } else {
          const consumed = consumeBatches(currentBatches, rmQty);
          newBatches = consumed.batches;
          delta = -(rmQty - consumed.remaining);
          // Capture first earliest-expiry batch for movement tracking
          if (!appliedBatch && currentBatches.length > 0) appliedBatch = currentBatches[0];
        }
        if (delta === 0) continue;
      } else {
        // legacy "set" mode (no batch info) — keep behaviour for backward compat
        const newQty = Number(it.newQuantity);
        if (!Number.isFinite(newQty)) continue;
        delta = newQty - before;
        if (delta === 0 && !it.force) {
          adjustmentItems.push({
            productId: String(pid), productName: inventoryProductDisplayName(existing), unit: existing.unit ?? "",
            quantityBefore: before, newQuantity: newQty, quantityAdjusted: 0, mode: "set",
          });
          continue;
        }
        if (delta > 0) {
          // treat as new batch with optional shelf life
          const batch = normalizeBatch({
            quantity: delta,
            shelfLifeDays: it.shelfLifeDays,
            expiryDate: it.expiryDate,
            receivedDate: now,
            createdAt: now,
          });
          newBatches.push(batch);
          appliedBatch = batch;
        } else {
          const consumed = consumeBatches(currentBatches, -delta);
          newBatches = consumed.batches;
          if (consumed.remaining > 0 && currentBatches.length === 0) {
            // legacy product without batches: just set total directly
            newBatches = [];
          }
        }
      }

      const fishBatchAdded = it.fishWeightKg !== undefined || it.fishPrice !== undefined;
      if (fishInventoryMode === "whole_fish" && fishPricePerKg != null && it.repriceExistingFish === true) {
        newBatches = newBatches.map((batch) => {
          const weight = Number(batch.fishWeightKg);
          if (!Number.isFinite(weight) || weight <= 0) return batch;
          return {
            ...batch,
            fishPricePerKg,
            fishPrice: roundMoney(weight * fishPricePerKg),
          };
        });
      }
      const persisted = await persistBatches(
        products,
        pid,
        newBatches,
        it.fishInventoryMode != null
          ? fishConfigPatch
          : fishBatchAdded || existing.wholeFishInventory === true
            ? { wholeFishInventory: true, fishInventoryMode: "whole_fish", unit: "per piece" }
            : {},
        ctx.conn.db.collection("combos"),
      );

      adjustmentItems.push({
        productId: String(pid),
        productName: inventoryProductDisplayName(existing),
        unit: inventoryUnit,
        quantityBefore: before,
        newQuantity: persisted.quantity,
        quantityAdjusted: delta,
        mode,
        batch: appliedBatch ? {
          batchNumber: appliedBatch.batchNumber,
          quantity: appliedBatch.quantity,
          fishWeightKg: appliedBatch.fishWeightKg ?? null,
          fishPrice: appliedBatch.fishPrice ?? null,
          shelfLifeDays: appliedBatch.shelfLifeDays,
          expiryDate: appliedBatch.expiryDate,
        } : undefined,
      });
      movementDocs.push({
        type: "adjustment",
        productId: String(pid),
        productName: inventoryProductDisplayName(existing),
        unit: inventoryUnit,
        change: delta,
        balance: persisted.quantity,
        reason: String(reason).trim(),
        notes: notes ? String(notes).trim() : "",
        batchNumber: appliedBatch?.batchNumber || undefined,
        batchObjectId: appliedBatch?._id ? String(appliedBatch._id) : undefined,
        fishWeightKg: appliedBatch?.fishWeightKg ?? undefined,
        fishPrice: appliedBatch?.fishPrice ?? undefined,
        expiryDate: appliedBatch?.expiryDate || undefined,
        receivedDate: appliedBatch?.receivedDate || undefined,
        createdAt: now,
      });
    }

    if (adjustmentItems.length === 0) {
      res.status(400).json({ error: "ValidationError", message: "No valid items to adjust" }); return;
    }

    if (movementDocs.length > 0) await movements.insertMany(movementDocs);

    const adjustmentDoc = {
      date: date ? new Date(date) : now,
      reason: String(reason).trim(),
      notes: notes ? String(notes).trim() : "",
      subHubId: String(ctx.sub._id),
      subHubName: ctx.sub.name,
      superHubId: superHub ? String(superHub._id) : "",
      superHubName: superHub?.name ?? "",
      items: adjustmentItems,
      createdAt: now,
    };
    const result = await ctx.conn.db.collection(ADJUSTMENTS_COLLECTION).insertOne(adjustmentDoc);
    res.status(201).json({ adjustment: { ...adjustmentDoc, _id: result.insertedId } });
  } catch (err) {
    req.log.error({ err }, "Failed to create inventory adjustment");
    res.status(500).json({ error: "InternalError", message: "Failed to save adjustment" });
  }
});

// ─── PER-PRODUCT BATCH ENDPOINTS ──────────────────────────────────────────────
router.get("/products/:productId/batches", async (req, res) => {
  try {
    const subHubId = String(req.query.subHubId || "");
    if (!subHubId) { res.status(400).json({ error: "ValidationError", message: "subHubId is required" }); return; }
    const ctx = await getCtx(subHubId, res, req as ScopedRequest);
    if (!ctx) return;
    const pid = toId(req.params.productId);
    if (!pid) { res.status(400).json({ error: "InvalidId", message: "Invalid product id" }); return; }
    const product = await ctx.conn.db.collection("products").findOne({ _id: pid });
    if (!product) { res.status(404).json({ error: "NotFound", message: "Product not found" }); return; }
    const batches: Batch[] = Array.isArray(product.batches) ? product.batches : [];
    res.json({
      productId: String(pid),
      name: product.name,
      unit: product.unit ?? "",
      quantity: batchesTotal(batches) || (Number(product.quantity) || 0),
      batches: sortBatchesByExpiry(batches),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch batches");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch batches" });
  }
});

router.delete("/products/:productId/batches/:batchId", async (req, res) => {
  try {
    const subHubId = String(req.query.subHubId || "");
    if (!subHubId) { res.status(400).json({ error: "ValidationError", message: "subHubId is required" }); return; }
    const ctx = await getCtx(subHubId, res, req as ScopedRequest);
    if (!ctx) return;
    const pid = toId(req.params.productId);
    if (!pid) { res.status(400).json({ error: "InvalidId", message: "Invalid product id" }); return; }
    const product = await ctx.conn.db.collection("products").findOne({ _id: pid });
    if (!product) { res.status(404).json({ error: "NotFound", message: "Product not found" }); return; }
    const batches: Batch[] = Array.isArray(product.batches) ? product.batches.map((b: any) => normalizeBatch(b)) : [];
    const remaining = batches.filter((b) => String(b._id) !== String(req.params.batchId));
    const persisted = await persistBatches(ctx.conn.db.collection("products"), pid, remaining, {}, ctx.conn.db.collection("combos"));
    res.json({ productId: String(pid), quantity: persisted.quantity, batches: persisted.batches });
  } catch (err) {
    req.log.error({ err }, "Failed to delete batch");
    res.status(500).json({ error: "InternalError", message: "Failed to delete batch" });
  }
});

// PUT /api/inventory/products/:productId/batches — replace batches for a product
router.put("/products/:productId/batches", async (req, res) => {
  try {
    const subHubId = String(req.query.subHubId || "");
    if (!subHubId) { res.status(400).json({ error: "ValidationError", message: "subHubId is required" }); return; }
    const ctx = await getCtx(subHubId, res, req as ScopedRequest);
    if (!ctx) return;
    const pid = toId(req.params.productId);
    if (!pid) { res.status(400).json({ error: "InvalidId", message: "Invalid product id" }); return; }
    const product = await ctx.conn.db.collection("products").findOne({ _id: pid });
    if (!product) { res.status(404).json({ error: "NotFound", message: "Product not found" }); return; }
    const batches: Batch[] = Array.isArray(req.body.batches) ? req.body.batches : [];
    if (product.wholeFishInventory === true && batches.some((batch: any) =>
      ![0, 1].includes(Number(batch?.quantity)) ||
      !Number.isFinite(Number(batch?.fishWeightKg)) || Number(batch?.fishWeightKg) <= 0 ||
      !Number.isFinite(Number(batch?.fishPrice)) || Number(batch?.fishPrice) <= 0
    )) {
      res.status(400).json({
        error: "ValidationError",
        message: "Each fish batch must keep one fish maximum with a positive weight and total price",
      });
      return;
    }
    const persisted = await persistBatches(ctx.conn.db.collection("products"), pid, batches, {}, ctx.conn.db.collection("combos"));
    res.json({ productId: String(pid), quantity: persisted.quantity, batches: persisted.batches });
  } catch (err) {
    req.log.error({ err }, "Failed to update batches");
    res.status(500).json({ error: "InternalError", message: "Failed to update batches" });
  }
});

// POST /api/inventory/init-product-batches — one-time migration: add empty batch to products without any batch
router.post("/init-product-batches", async (req, res) => {
  try {
    const subHubId = String((req.body as any)?.subHubId || req.query.subHubId || "");
    if (!subHubId) { res.status(400).json({ error: "ValidationError", message: "subHubId is required" }); return; }
    const ctx = await getCtx(subHubId, res, req as ScopedRequest);
    if (!ctx) return;
    const productsCol = ctx.conn.db.collection("products");
    const allProducts = await productsCol.find({}).toArray();
    let initialized = 0;
    let skipped = 0;
    for (const p of allProducts) {
      const existingBatches: Batch[] = Array.isArray(p.batches) ? p.batches : [];
      if (existingBatches.length === 0) {
        const emptyBatch = normalizeBatch({ batchNumber: "BATCH-1", quantity: 0, receivedDate: new Date(), notes: "" });
        await persistBatches(productsCol, p._id, [emptyBatch]);
        initialized++;
      } else {
        skipped++;
      }
    }
    res.json({ message: `Done. Added initial batch to ${initialized} products; ${skipped} already had batches.`, initialized, skipped });
  } catch (err) {
    req.log.error({ err }, "Failed to init product batches");
    res.status(500).json({ error: "InternalError", message: "Failed to init batches" });
  }
});

// ─── ORDER SYNC HELPERS (used by orders.ts) ───────────────────────────────────
type OrderForSync = {
  _id: any;
  subHubId?: string;
  subHubName?: string;
  status?: string;
  createdAt?: Date | string;
  items?: Array<{ productId?: string; name?: string; quantity?: number; unit?: string; inventoryBatchId?: string }>;
};

const ACTIVE_STATUSES = new Set(["pending", "confirmed", "out_for_delivery", "delivered", "takeaway"]);
const ACTIVE_STATUS_REGEX = "^(pending|confirmed|out_for_delivery|delivered|takeaway)$";
const MAX_AUTO_DEDUCTION_BATCH_SIZE = 200;
const STATUS_TRANSITION_DEDUCTION_MAX_AGE_MS = 2 * 60 * 1000;
// Orders that existed before this process started are protected from automatic
// recovery. This lets new missed orders be retried regardless of createdAt age
// without backfilling existing order, inventory, or movement records.
let preexistingOrderIds: Set<string> | null = null;

export async function initializeInventoryDeductionBaseline(): Promise<void> {
  const conn = await getSubHubDbConnection("orders");
  const ordersDb = conn.db;
  if (!ordersDb) throw new Error("Orders database connection is unavailable");

  const existing = await ordersDb.collection("orders")
    .find({}, { projection: { _id: 1 } })
    .toArray();
  preexistingOrderIds = new Set(existing.map((order: any) => String(order._id)));
  logger.info(
    { protectedExistingOrderCount: preexistingOrderIds.size },
    "initializeInventoryDeductionBaseline: existing orders protected from fallback recovery"
  );
}

function isWithinStatusTransitionDeductionWindow(order: { createdAt?: Date | string }, now = Date.now()) {
  const createdAtMs = order.createdAt instanceof Date
    ? order.createdAt.getTime()
    : typeof order.createdAt === "string"
      ? Date.parse(order.createdAt)
      : Number.NaN;
  const ageMs = now - createdAtMs;
  return Number.isFinite(createdAtMs) && ageMs >= 0 && ageMs <= STATUS_TRANSITION_DEDUCTION_MAX_AGE_MS;
}

function orderShouldDeduct(order: OrderForSync) {
  if (!order || !order.subHubId) return false;
  const status = String(order.status ?? "").toLowerCase();
  return ACTIVE_STATUSES.has(status);
}

/** Expand raw order items so that any combo productId is replaced by its constituent products.
 * Quantities are aggregated per product so that two combos sharing a product get combined.
 * Each combo include may carry a `quantity` field specifying how many units of that product
 * are contained in one combo (defaults to 1). The final deduction is orderedQty × includeQty.
 *
 * Lookup strategy per item:
 *  1. If productId present → look up product by _id. Found? treat as normal product.
 *  2. If productId present but not a product → look up combo by _id. Found? expand its includes.
 *  3. If still not resolved (no productId, or ID lookup missed) → look up combo by name (case-insensitive).
 *  4. If name lookup finds a combo → expand its includes.
 *  5. If name lookup finds no combo → try to find a product by name and treat as direct product.
 */
async function expandOrderItems(
  productsCol: any,
  combosCol: any,
  rawItems: Array<{ productId?: string; name?: string; quantity?: number; unit?: string; inventoryBatchId?: string; bulkWeightKg?: number }>,
  validateBulkPortions = false,
): Promise<Array<{ productId: string; name: string; quantity: number; unit: string; inventoryBatchId?: string }>> {
  const aggregated = new Map<string, { productId: string; name: string; quantity: number; unit: string; inventoryBatchId?: string }>();

  /** Helper: expand a resolved combo document into aggregated constituent products */
  async function expandCombo(combo: any, qty: number) {
    if (!combo || !Array.isArray(combo.includes) || combo.includes.length === 0) return false;
    logger.info({ comboId: String(combo._id), comboName: combo.name, includeCount: combo.includes.length }, "expandOrderItems: expanding combo into constituent products");
    for (const inc of combo.includes) {
      if (!inc.productId) continue;
      const incPid = toId(String(inc.productId));
      if (!incPid) continue;
      const incProduct = await productsCol.findOne({ _id: incPid }, { projection: { name: 1, unit: 1 } });
      if (!incProduct) {
        logger.warn({ comboId: String(combo._id), includeProductId: String(inc.productId) }, "expandOrderItems: included product not found in sub-hub products — skipping");
        continue;
      }
      const key = String(incPid);
      const entry = aggregated.get(key);
      const qtyPerCombo = Math.max(1, Number(inc.quantity) || 1);
      const totalDeduct = qty * qtyPerCombo;
      if (entry) entry.quantity += totalDeduct;
      else aggregated.set(key, { productId: key, name: incProduct.name ?? inc.label ?? "", quantity: totalDeduct, unit: incProduct.unit ?? "" });
    }
    return true;
  }

  // Log the raw item keys so we can see exactly what field names the customer app sends
  if (rawItems.length > 0) {
    logger.info(
      { sampleItem: rawItems[0], allKeys: Object.keys(rawItems[0] as any), totalItems: rawItems.length },
      "expandOrderItems: raw item sample"
    );
  }

  for (const it of rawItems) {
    const qty = Math.max(0, Number(it.quantity) || 0);
    if (qty <= 0) continue;

    let resolved = false;

    // ── Path A: productId-based lookup (also accepts `id` field used by some customer apps) ──
    const rawId = (it as any).productId ?? (it as any).id ?? null;
    if (rawId) {
      const pid = toId(String(rawId));
      if (pid) {
        const productDoc = await productsCol.findOne(
          { _id: pid },
          { projection: { _id: 1, fishInventoryMode: 1, bulkPortionWeightsKg: 1, unit: 1 } },
        );
        if (productDoc) {
          const submittedBulkWeightKg = Number(it.bulkWeightKg);
          const hasBulkWeight = Number.isFinite(submittedBulkWeightKg) && submittedBulkWeightKg > 0;
          const isBulkFish = productDoc.fishInventoryMode === "bulk_portions";
          if (validateBulkPortions && isBulkFish) {
            const allowedWeights = normalizeBulkPortionWeights(productDoc.bulkPortionWeightsKg);
            if (!hasBulkWeight || !allowedWeights.some((weight) => Math.abs(weight - submittedBulkWeightKg) < 0.0005)) {
              throw new Error(`Select a valid portion size for ${String(it.name ?? "this bulk fish")}`);
            }
          }
          if (validateBulkPortions && hasBulkWeight && !isBulkFish) {
            throw new Error(`Bulk portion pricing is no longer enabled for ${String(it.name ?? "this product")}`);
          }
          const inventoryQuantity = inventoryQuantityForOrder(qty, hasBulkWeight ? submittedBulkWeightKg : undefined);
          const inventoryUnit = hasBulkWeight ? "kg" : it.unit ?? "";
          const inventoryBatchId = String(it.inventoryBatchId ?? "").trim() || undefined;
          const key = inventoryBatchId ? `${String(pid)}::batch:${inventoryBatchId}` : String(pid);
          const entry = aggregated.get(key);
          if (entry) entry.quantity += inventoryQuantity;
          else aggregated.set(key, {
            productId: String(pid),
            name: it.name ?? "",
            quantity: inventoryQuantity,
            unit: inventoryUnit,
            ...(inventoryBatchId ? { inventoryBatchId } : {}),
          });
          resolved = true;
        } else {
          // Not a product — try combo by _id
          const comboById = await combosCol.findOne({ _id: pid });
          if (comboById) {
            resolved = await expandCombo(comboById, qty);
            if (!resolved) {
              logger.warn({ productId: String(pid), comboName: comboById.name }, "expandOrderItems: combo found by id but has no includes — skipping");
              resolved = true; // don't attempt name fallback for an explicitly matched combo
            }
          }
        }
      }
    }

    // ── Path B: name-based combo lookup (fallback when no productId or ID miss) ──
    if (!resolved && it.name) {
      const nameTrimmed = String(it.name).trim();
      const comboByName = await combosCol.findOne({ name: { $regex: `^${nameTrimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
      if (comboByName) {
        resolved = await expandCombo(comboByName, qty);
        if (!resolved) {
          logger.warn({ itemName: nameTrimmed, comboId: String(comboByName._id) }, "expandOrderItems: combo found by name but has no includes — skipping");
          resolved = true;
        }
      }
    }

    // ── Path C: name-based product lookup (last resort) ─────────────────────
    if (!resolved && it.name) {
      const nameTrimmed = String(it.name).trim();
      const productByName = await productsCol.findOne({ name: { $regex: `^${nameTrimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
      if (productByName) {
        const key = String(productByName._id);
        const entry = aggregated.get(key);
        if (entry) entry.quantity += qty;
        else aggregated.set(key, { productId: key, name: productByName.name ?? nameTrimmed, quantity: qty, unit: productByName.unit ?? it.unit ?? "" });
        resolved = true;
        logger.info({ itemName: nameTrimmed, productId: key }, "expandOrderItems: resolved item to product by name");
      }
    }

    if (!resolved) {
      logger.warn({ productId: it.productId, itemName: it.name }, "expandOrderItems: item could not be resolved to any product or combo — skipping");
    }
  }

  return Array.from(aggregated.values());
}

async function restoreOrderDeductionsFromMovements(
  orderId: string,
  orderRef: string,
  products: any,
  combos: any,
  movements: any,
  subReason?: string,
): Promise<number> {
  const orderMovements = await movements
    .find({ orderId, type: { $in: ["order_deduct", "order_restore"] } })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();
  const deductions = orderMovements.filter((movement: any) => movement.type === "order_deduct");
  const restores = orderMovements.filter((movement: any) => movement.type === "order_restore");
  const outstanding = getOutstandingDeductionMovements(deductions, restores);
  if (outstanding.length === 0) {
    logger.info({ orderId }, "restoreOrderDeductions: no outstanding deduction movements");
    return 0;
  }

  const byProduct = new Map<string, any[]>();
  for (const movement of outstanding) {
    if (!movement.productId) continue;
    const productId = String(movement.productId);
    const group = byProduct.get(productId) ?? [];
    group.push(movement);
    byProduct.set(productId, group);
  }

  let restoredCount = 0;
  for (const [productId, sourceMovements] of byProduct) {
    const productObjectId = toId(productId);
    if (!productObjectId) {
      logger.warn({ orderId, productId }, "restoreOrderDeductions: invalid product ID in movement ledger");
      continue;
    }
    const product = await products.findOne({ _id: productObjectId });
    if (!product) {
      logger.warn({ orderId, productId }, "restoreOrderDeductions: product missing; leaving deduction outstanding");
      continue;
    }

    let newBatches: Batch[] = Array.isArray(product.batches)
      ? product.batches.map((batch: any) => normalizeBatch(batch))
      : [];
    const exactAllocations: BatchAllocation[] = [];
    const legacySources: any[] = [];
    const noBatchSources: Array<{ movement: any; quantity: number }> = [];
    const reversesMovementIds = sourceMovements.map((movement) => movement._id);

    for (const movement of sourceMovements) {
      if (Array.isArray(movement.batchAllocations)) {
        for (const allocation of movement.batchAllocations) {
          if ((Number(allocation.quantity) || 0) <= 0) continue;
          exactAllocations.push({
            ...allocation,
            deductionMovementId: movement._id,
          });
        }

        const legacyQuantity = Math.max(
          0,
          Number(movement.legacyQuantity) ||
            (movement.batchAllocations.length === 0 ? Math.abs(Number(movement.change) || 0) : 0),
        );
        if (legacyQuantity > 0) noBatchSources.push({ movement, quantity: legacyQuantity });
      } else {
        legacySources.push(movement);
      }
    }

    const exactResult = restoreBatchAllocations(newBatches, exactAllocations);
    if (exactResult.unmatchedAllocations.length > 0) {
      throw new Error(`Could not resolve source batches for order ${orderId}, product ${productId}`);
    }
    newBatches = exactResult.batches;
    const restoredAllocations: BatchAllocation[] = [...exactResult.restoredAllocations];
    let legacyQuantity = 0;

    for (const movement of legacySources) {
      const quantity = Math.abs(Number(movement.change) || 0);
      if (quantity <= 0) continue;
      const batchNumbers = String(movement.batchNumbers ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

      if (batchNumbers.length > 1) {
        logger.warn(
          { orderId, productId, batchNumbers, quantity },
          "restoreOrderDeductions: legacy movement lacks the exact split across source batches",
        );
      }

      const sourceBatchNumber = batchNumbers[0];
      if (sourceBatchNumber) {
        const existingBatch = newBatches.find((batch) => batch.batchNumber === sourceBatchNumber);
        if (existingBatch) {
          const legacyAllocation: BatchAllocation = {
            batchNumber: sourceBatchNumber,
            quantity,
            deductionMovementId: movement._id,
          };
          const restored = restoreBatchAllocations(newBatches, [legacyAllocation]);
          newBatches = restored.batches;
          restoredAllocations.push(...restored.restoredAllocations);
          continue;
        }

        const now = new Date();
        const recreatedId = new mongoose.Types.ObjectId();
        const recreatedSnapshot = {
          batchNumber: sourceBatchNumber,
          shelfLifeDays: null,
          receivedDate: now,
          expiryDate: toDate(movement.expiryDate),
          notes: "Restored from an older order movement without a saved batch ID",
          createdAt: now,
        };
        const legacyAllocation: BatchAllocation = {
          batchId: recreatedId,
          batchNumber: sourceBatchNumber,
          quantity,
          deductionMovementId: movement._id,
          batchSnapshot: recreatedSnapshot,
        };
        const restored = restoreBatchAllocations(newBatches, [legacyAllocation]);
        newBatches = restored.batches;
        restoredAllocations.push(...restored.restoredAllocations);
        continue;
      }

      if (newBatches.length > 0) {
        const recordedExpiry = toDate(movement.expiryDate)?.getTime();
        const target =
          (recordedExpiry != null
            ? newBatches.find((batch) => batch.expiryDate?.getTime() === recordedExpiry)
            : undefined) ?? sortBatchesByExpiry(newBatches)[0];
        const legacyAllocation: BatchAllocation = {
          batchId: target._id,
          batchNumber: target.batchNumber,
          quantity,
          deductionMovementId: movement._id,
          batchSnapshot: batchSnapshot(target),
        };
        const restored = restoreBatchAllocations(newBatches, [legacyAllocation]);
        newBatches = restored.batches;
        restoredAllocations.push(...restored.restoredAllocations);
      } else {
        noBatchSources.push({ movement, quantity });
      }
    }

    for (const { movement, quantity } of noBatchSources) {
      if (newBatches.length === 0) {
        legacyQuantity += quantity;
        continue;
      }

      logger.warn(
        { orderId, productId, quantity },
        "restoreOrderDeductions: legacy quantity had no source batch; assigning it to the earliest-expiring existing batch",
      );
      const target = sortBatchesByExpiry(newBatches)[0];
      const fallbackAllocation: BatchAllocation = {
        batchId: target._id,
        batchNumber: target.batchNumber,
        quantity,
        deductionMovementId: movement._id,
        batchSnapshot: batchSnapshot(target),
      };
      const restored = restoreBatchAllocations(newBatches, [fallbackAllocation]);
      newBatches = restored.batches;
      restoredAllocations.push(...restored.restoredAllocations);
    }

    const restoredBatchQuantity = restoredAllocations.reduce(
      (total, allocation) => total + (Number(allocation.quantity) || 0),
      0,
    );
    const totalRestored = restoredBatchQuantity + legacyQuantity;
    if (totalRestored <= 0) continue;

    let balance = 0;
    if (newBatches.length > 0) {
      const persisted = await persistBatches(products, productObjectId, newBatches, {}, combos);
      balance = persisted.quantity;
    } else {
      await products.updateOne(
        { _id: productObjectId },
        { $inc: { quantity: legacyQuantity }, $set: { updatedAt: new Date() } },
      );
      const after = await products.findOne(
        { _id: productObjectId },
        { projection: { quantity: 1 } },
      );
      balance = Number(after?.quantity) || 0;
    }

    const batchNumbers = [...new Set(
      restoredAllocations
        .map((allocation) => allocation.batchNumber ?? allocation.batchSnapshot?.batchNumber)
        .filter((value): value is string => Boolean(value)),
    )];
    const sourceExpiry = restoredAllocations
      .map((allocation) => allocation.batchSnapshot?.expiryDate)
      .find((value) => value != null);

    await movements.insertOne({
      type: "order_restore",
      productId,
      productName: inventoryProductDisplayName(product),
      unit: product.unit ?? "",
      change: totalRestored,
      balance,
      orderId,
      orderRef,
      ...(subReason ? { subReason } : {}),
      ...(batchNumbers.length > 0 ? { batchNumbers: batchNumbers.join(", ") } : {}),
      batchAllocations: restoredAllocations,
      ...(legacyQuantity > 0 ? { legacyQuantity } : {}),
      reversesMovementIds,
      ...(sourceExpiry ? { expiryDate: sourceExpiry } : {}),
      createdAt: new Date(),
    });
    restoredCount++;
    logger.info(
      { orderId, productId, restoredQuantity: totalRestored, batchNumbers },
      "restoreOrderDeductions: restored source batch allocations",
    );
  }

  return restoredCount;
}

async function applyDelta(order: OrderForSync, direction: "deduct" | "restore", subReason?: string): Promise<number> {
  if (!order.subHubId) {
    logger.warn({ orderId: String(order._id) }, "applyDelta: skipped — no subHubId on order");
    return 0;
  }

  // Resolve sub-hub: first try by ObjectId (handles both string and BSON ObjectId),
  // then fall back to name match (handles customer-app orders that store the hub name instead of ID).
  let sub = await SubHub.findById(order.subHubId).catch(() => null);
  if (!sub) {
    const nameStr = String(order.subHubId).trim();
    sub = await SubHub.findOne({ name: { $regex: `^${nameStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } }).catch(() => null);
  }
  if (!sub) {
    logger.warn({ orderId: String(order._id), subHubId: order.subHubId }, "applyDelta: skipped — subHub not found by id or name");
    return 0;
  }
  if (!sub.dbName) {
    logger.warn({ orderId: String(order._id), subHubId: order.subHubId }, "applyDelta: skipped — subHub has no dbName");
    return 0;
  }
  const conn = await getSubHubDbConnection(sub.dbName);
  const products = conn.db.collection("products");
  const combos = conn.db.collection("combos");
  const movements = conn.db.collection(MOVEMENTS_COLLECTION);
  const now = new Date();
  const orderId = String(order._id);
  const orderRef = `#${orderId.slice(-6).toUpperCase()}`;

  if (direction === "restore") {
    return restoreOrderDeductionsFromMovements(
      orderId,
      orderRef,
      products,
      combos,
      movements,
      subReason,
    );
  }

  // Expand combos into their constituent products before applying stock changes
  const items = await expandOrderItems(
    products,
    combos,
    Array.isArray(order.items) ? order.items : [],
    direction === "deduct",
  );
  if (items.length === 0) {
    logger.warn({ orderId, subHubId: order.subHubId, rawItemCount: (order.items ?? []).length }, "applyDelta: no items to process after expansion");
    return 0;
  }

  // ── Pre-flight stock check (deduct only) ────────────────────────────────────
  // This runs INSIDE withDeductionLock so only one request at a time reaches
  // this point. If two orders race for the last unit, the second request enters
  // the lock only after the first has already deducted — it then sees available=0
  // and throws InsufficientStockError before any mutation occurs.
  if (direction === "deduct") {
    const stockCheckNow = new Date();
    for (const it of items) {
      const pid = toId(it.productId);
      if (!pid || it.quantity <= 0) continue;
      const product = await products.findOne({ _id: pid });
      if (!product) continue; // missing product is a warning, not a stock block
      const currentBatches: Batch[] = Array.isArray(product.batches)
        ? product.batches.map((b: any) => normalizeBatch(b))
        : [];
      // Expired batches remain visible to admins but cannot satisfy an order.
      const selectedBatch = it.inventoryBatchId
        ? currentBatches.find((batch) => String(batch._id) === String(it.inventoryBatchId))
        : undefined;
      const selectedBatchExpired = Boolean(
        selectedBatch?.expiryDate && new Date(selectedBatch.expiryDate).getTime() < stockCheckNow.getTime(),
      );
      const available = it.inventoryBatchId
        ? selectedBatch && !selectedBatchExpired
          ? Math.max(0, Number(selectedBatch.quantity) || 0)
          : 0
        : currentBatches.length > 0
          ? availableBatchesTotal(currentBatches, stockCheckNow)
          : Math.max(0, Number(product.quantity) || 0);
      if (available < it.quantity) {
        logger.warn(
          { orderId, productId: String(pid), productName: inventoryProductDisplayName(product), available, requested: it.quantity },
          "applyDelta: pre-flight stock check FAILED — insufficient stock, rejecting order"
        );
        throw new InsufficientStockError(product.name ?? it.name ?? "Unknown product", available, it.quantity);
      }
    }
    logger.info({ orderId, itemCount: items.length }, "applyDelta: pre-flight stock check passed — all items have sufficient stock");
  }

  let deductedCount = 0;
  for (const it of items) {
    const pid = toId(it.productId);
    if (!pid) continue;
    const qty = it.quantity;
    if (qty <= 0) continue;

    const existing = await products.findOne({ _id: pid });
    if (!existing) {
      logger.warn({ orderId, productId: String(pid) }, "applyDelta: product not found in sub-hub DB — skipping");
      continue;
    }
    const currentBatches: Batch[] = Array.isArray(existing.batches) ? existing.batches.map((b: any) => normalizeBatch(b)) : [];
    logger.info({ orderId, direction, productId: String(pid), productName: inventoryProductDisplayName(existing), qty, batchCount: currentBatches.length, batchTotal: batchesTotal(currentBatches), storedQuantity: existing.quantity }, "applyDelta: processing item");

    let newBatches = currentBatches;
    let appliedExpiry: Date | null = null;
    let appliedBatchNumbers: string | undefined;
    let batchAllocations: BatchAllocation[] = [];
    if (direction === "deduct") {
      if (currentBatches.length > 0) {
        const now2 = new Date();
        const available = availableBatchesTotal(currentBatches, now2);
        const consumed = consumeBatches(currentBatches, qty, now2, it.inventoryBatchId);
        if (consumed.remaining > 0) {
          throw new InsufficientStockError(existing.name ?? it.name ?? "Unknown product", available, qty);
        }
        newBatches = consumed.batches;
        batchAllocations = consumed.allocations;
        logger.info({ orderId, productId: String(pid), batchesAfter: newBatches.length, totalAfter: batchesTotal(newBatches) }, "applyDelta: consumeBatches result");
        appliedExpiry = consumed.allocations[0]?.batchSnapshot?.expiryDate
          ? new Date(consumed.allocations[0].batchSnapshot.expiryDate)
          : null;
        const consumedNames = consumed.allocations
          .map((allocation) => allocation.batchNumber)
          .filter((name): name is string => Boolean(name));
        if (consumedNames.length > 0) appliedBatchNumbers = consumedNames.join(", ");
      } else {
        // legacy product with no batches — just decrement quantity
        await products.updateOne(
          { _id: pid },
          { $inc: { quantity: -qty }, $set: { updatedAt: now } }
        );
        const after = await products.findOne({ _id: pid }, { projection: { quantity: 1, name: 1, unit: 1, variantLabel: 1 } });
        await movements.insertOne({
          type: "order_deduct", productId: String(pid),
          productName: inventoryProductDisplayName(after) || it.name || "",
          unit: (after as any)?.unit ?? it.unit ?? "",
          change: -qty, balance: Number((after as any)?.quantity) || 0,
          orderId, orderRef, ...(subReason ? { subReason } : {}),
          batchAllocations: [], legacyQuantity: qty, createdAt: now,
        });
        deductedCount++;
        continue;
      }
    }

    const persisted = await persistBatches(products, pid, newBatches, {}, combos);
    logger.info(
      { orderId, direction, productId: String(pid), productName: inventoryProductDisplayName(existing), newStockTotal: persisted.quantity },
      "applyDelta: stock persisted ✓"
    );
    await movements.insertOne({
      type: "order_deduct",
      productId: String(pid),
      productName: inventoryProductDisplayName(existing) || it.name || "",
      unit: existing.unit ?? it.unit ?? "",
      change: -qty,
      balance: persisted.quantity,
      orderId,
      orderRef,
      ...(subReason ? { subReason } : {}),
      ...(appliedBatchNumbers ? { batchNumbers: appliedBatchNumbers } : {}),
      batchAllocations,
      expiryDate: appliedExpiry || undefined,
      createdAt: now,
    });
    deductedCount++;
  }
  logger.info({ orderId, direction, deductedCount }, "applyDelta: completed");
  return deductedCount;
}

/**
 * Atomically claims and deducts inventory for orders that arrived without
 * going through applyOrderInventoryOnCreate (e.g. customer-app-created orders
 * inserted directly into MongoDB). Uses findOneAndUpdate with an inventoryDeducted
 * condition to prevent double-deduction if multiple requests run concurrently.
 */
export async function autoDeductUndedcutedOrders(
  ordersDb: any,
  orders: Array<{ _id: any; status?: string; subHubId?: string; subHubName?: string; createdAt?: Date | string; items?: any[]; inventoryDeducted?: boolean; isDeleted?: boolean }>
): Promise<void> {
  if (preexistingOrderIds === null) {
    logger.warn("autoDeductUndedcutedOrders: baseline is not initialized — skipping");
    return;
  }

  // Log a sample of raw order structure so we can see what customer-app orders look like
  if (orders.length > 0) {
    const sample = orders[0] as any;
    logger.info(
      {
        totalOrders: orders.length,
        sampleOrderId: String(sample._id),
        sampleStatus: sample.status,
        sampleSubHubId: sample.subHubId,
        sampleSubHubName: sample.subHubName,
        sampleInventoryDeducted: sample.inventoryDeducted,
        sampleItemCount: Array.isArray(sample.items) ? sample.items.length : "N/A",
        sampleItemFields: Array.isArray(sample.items) && sample.items.length > 0
          ? Object.keys(sample.items[0])
          : [],
        sampleItem0: Array.isArray(sample.items) && sample.items.length > 0
          ? sample.items[0]
          : null,
        allOrderIds: orders.map((o) => String(o._id)),
        allStatuses: orders.map((o) => o.status),
        allDeductedFlags: orders.map((o) => (o as any).inventoryDeducted),
      },
      "autoDeductUndedcutedOrders: called"
    );
  } else {
    logger.info({ totalOrders: 0 }, "autoDeductUndedcutedOrders: called with empty list");
    return;
  }

  const candidates = orders.filter(
    (o) =>
      ACTIVE_STATUSES.has(String(o.status ?? "").toLowerCase()) &&
      o.inventoryDeducted !== true &&
      (o as any).isDeleted !== true &&
      !preexistingOrderIds!.has(String(o._id))
  );
  logger.info(
    { candidateCount: candidates.length, skippedCount: orders.length - candidates.length },
    "autoDeductUndedcutedOrders: candidate filter"
  );
  if (candidates.length === 0) return;

  for (const order of candidates) {
    try {
      // Atomically claim this order for deduction: only succeeds if inventoryDeducted is still not true
      const claimed = await ordersDb.collection("orders").findOneAndUpdate(
        {
          _id: order._id,
          inventoryDeducted: { $ne: true },
          isDeleted: { $ne: true },
          status: { $regex: ACTIVE_STATUS_REGEX, $options: "i" },
        },
        { $set: { inventoryDeducted: true } },
        { returnDocument: "before" }
      );
      if (!claimed) {
        logger.info({ orderId: String(order._id) }, "autoDeductUndedcutedOrders: already claimed — skipping");
        continue;
      }
      // Serialize stock mutations so two orders for the same product don't both
      // read stale qty and each write back qty-5 instead of the correct qty-10.
      const deducted = await withDeductionLock(() =>
        applyDelta(
          { _id: order._id, subHubId: order.subHubId, subHubName: order.subHubName, status: order.status, items: order.items },
          "deduct",
          "order_placed"
        )
      );
      if (deducted === 0) {
        logger.warn({ orderId: String(order._id) }, "autoDeductUndedcutedOrders: applyDelta returned 0 — reverting flag for retry");
        await ordersDb.collection("orders").updateOne(
          { _id: order._id },
          { $set: { inventoryDeducted: false } }
        );
      } else {
        logger.info({ orderId: String(order._id), deducted }, "autoDeductUndedcutedOrders: deduction successful ✓");
      }
    } catch (err) {
      logger.error({ err, orderId: String(order._id) }, "autoDeductUndedcutedOrders: failed to deduct inventory");
      try {
        await ordersDb.collection("orders").updateOne(
          { _id: order._id },
          { $set: { inventoryDeducted: false } }
        );
      } catch (e2) {
        logger.error({ err: e2, orderId: String(order._id) }, "autoDeductUndedcutedOrders: failed to revert inventoryDeducted flag");
      }
    }
  }
}

export async function applyOrderInventoryOnCreate(order: OrderForSync, subReason: string = "order_placed") {
  if (!orderShouldDeduct(order)) return false;
  const deducted = await withDeductionLock(() => applyDelta(order, "deduct", subReason));
  return deducted > 0;
}

/**
 * Background job: independently fetches all active orders missing inventory
 * deduction and processes them. Safe to call on a recurring interval without
 * an HTTP request context — it owns its own DB connection.
 */
export async function runInventoryBackgroundDeduction(): Promise<void> {
  try {
    if (preexistingOrderIds === null) {
      logger.warn("runInventoryBackgroundDeduction: baseline is not initialized — skipping");
      return;
    }
    const conn = await getSubHubDbConnection("orders");
    const ordersDb = conn.db;
    if (!ordersDb) throw new Error("Orders database connection is unavailable");
    // Status is filtered in MongoDB before selecting the 200-order batch, so
    // cancelled or otherwise inactive orders cannot consume its capacity.
    const cursor = ordersDb.collection("orders")
      .find({
        inventoryDeducted: { $ne: true },
        isDeleted: { $ne: true },
        status: { $regex: ACTIVE_STATUS_REGEX, $options: "i" },
      })
      .sort({ createdAt: 1 })
      .project({ _id: 1, subHubId: 1, subHubName: 1, status: 1, createdAt: 1, items: 1 });

    const candidates: any[] = [];
    let protectedExistingCount = 0;
    try {
      for await (const order of cursor) {
        if (preexistingOrderIds.has(String(order._id))) {
          protectedExistingCount++;
          continue;
        }
        candidates.push(order);
        if (candidates.length >= MAX_AUTO_DEDUCTION_BATCH_SIZE) break;
      }
    } finally {
      await cursor.close();
    }

    logger.info(
      { candidateCount: candidates.length, protectedExistingCount, batchLimit: MAX_AUTO_DEDUCTION_BATCH_SIZE },
      "runInventoryBackgroundDeduction: scan complete"
    );

    if (candidates.length === 0) return;
    logger.info({ count: candidates.length }, "runInventoryBackgroundDeduction: processing undeducted orders");
    await autoDeductUndedcutedOrders(ordersDb, candidates as any[]);
  } catch (err) {
    logger.error({ err }, "runInventoryBackgroundDeduction: failed");
  }
}

export async function applyOrderInventoryOnDelete(order: OrderForSync, wasDeducted: boolean) {
  if (!wasDeducted) return false;
  if (!order?.subHubId) return false;
  const restored = await withDeductionLock(() => applyDelta(order, "restore", "order_deleted"));
  return restored > 0;
}

function itemsSignature(items: any): string {
  if (!Array.isArray(items)) return "";
  return items
    .map((i: any) => `${i?.productId ?? ""}:${i?.inventoryBatchId ?? ""}:${Number(i?.quantity) || 0}`)
    .filter((s: string) => s !== ":0")
    .sort()
    .join("|");
}

export async function applyOrderInventoryOnUpdate(prev: OrderForSync, next: OrderForSync, wasDeducted: boolean) {
  const wantsDeducted = orderShouldDeduct(next);
  const wasActiveForInventory = orderShouldDeduct(prev);
  const isBaselineProtected =
    preexistingOrderIds === null || preexistingOrderIds.has(String(next._id));
  const action = getInventoryUpdateAction({
    baselineProtected: isBaselineProtected,
    wasDeducted,
    wasActive: wasActiveForInventory,
    wantsDeducted,
  });

  // Never backfill a baseline order or reconcile it just because it was edited.
  // A previously deducted order transitioning out of an active status is the
  // inverse of a recorded deduction, so it must still restore stock once.
  if (action === "skip") {
    logger.info(
      {
        orderId: String(next._id),
        baselineInitialized: preexistingOrderIds !== null,
        wasDeducted,
        wantsDeducted,
      },
      "applyOrderInventoryOnUpdate: skipped inventory sync for baseline order"
    );
    return wasDeducted;
  }

  if (action === "deduct") {
    if (!isWithinStatusTransitionDeductionWindow(next)) {
      logger.warn(
        { orderId: String(next._id), createdAt: next.createdAt ?? null },
        "applyOrderInventoryOnUpdate: skipped late first-time inventory deduction"
      );
      return false;
    }
    await withDeductionLock(() => applyDelta(next, "deduct", "order_placed"));
    return true;
  }
  if (action === "restore") {
    await withDeductionLock(() => applyDelta({ ...prev, _id: next._id }, "restore", "order_cancelled"));
    return false;
  }
  if (action === "reconcile") {
    const prevSig = `${prev?.subHubId ?? ""}::${itemsSignature((prev as any)?.items)}`;
    const nextSig = `${next?.subHubId ?? ""}::${itemsSignature((next as any)?.items)}`;
    if (prevSig !== nextSig) {
      await withDeductionLock(async () => {
        await applyDelta({ ...prev, _id: next._id }, "restore", "items_changed");
        await applyDelta(next, "deduct", "items_changed");
      });
    }
    return true;
  }
  return wasDeducted;
}

/**
 * POST /api/inventory/reset-deduction-flags
 * Admin-only debug endpoint. Resets inventoryDeducted=false for the given
 * order IDs (or all pending orders if no IDs given) so they get re-processed
 * by autoDeductUndedcutedOrders on the next poll or page load.
 * Body: { orderIds?: string[] }
 */
router.post("/reset-deduction-flags", async (req, res) => {
  try {
    const conn = await getSubHubDbConnection("orders");
    const { orderIds } = req.body as { orderIds?: string[] };

    let filter: any;
    if (Array.isArray(orderIds) && orderIds.length > 0) {
      const oids = orderIds.map((id) => {
        try { return new mongoose.Types.ObjectId(id); } catch { return null; }
      }).filter(Boolean);
      filter = { _id: { $in: oids } };
    } else {
      // Reset all active orders that aren't cancelled
      filter = { status: { $nin: ["cancelled"] }, inventoryDeducted: true };
    }

    const result = await conn.db.collection("orders").updateMany(
      filter,
      { $set: { inventoryDeducted: false } }
    );
    logger.info({ modifiedCount: result.modifiedCount, filter }, "reset-deduction-flags: flags reset");
    res.json({ message: `Reset inventoryDeducted flag on ${result.modifiedCount} order(s). They will be re-deducted on next poll.`, modifiedCount: result.modifiedCount });
  } catch (err: any) {
    logger.error({ err }, "reset-deduction-flags: failed");
    res.status(500).json({ error: "InternalError", message: err.message });
  }
});

/**
 * POST /api/inventory/migrate-unit-names
 * One-time migration: renames unit "per pack" → "pack" across all sub-hub product collections.
 */
router.post("/migrate-unit-names", async (_req, res) => {
  try {
    const subs = await SubHub.find({ dbName: { $exists: true, $ne: "" } }).lean();
    let totalUpdated = 0;
    const results: { subHub: string; updated: number }[] = [];
    for (const sub of subs) {
      if (!sub.dbName) continue;
      const conn = await getSubHubDbConnection(sub.dbName);
      const result = await conn.db.collection("products").updateMany(
        { unit: "per pack" },
        { $set: { unit: "pack" } }
      );
      totalUpdated += result.modifiedCount;
      if (result.modifiedCount > 0) {
        results.push({ subHub: sub.name ?? sub.dbName, updated: result.modifiedCount });
      }
    }
    logger.info({ totalUpdated, results }, "migrate-unit-names: complete");
    res.json({ message: `Renamed "per pack" → "pack" on ${totalUpdated} product(s).`, totalUpdated, results });
  } catch (err: any) {
    logger.error({ err }, "migrate-unit-names: failed");
    res.status(500).json({ error: "InternalError", message: err.message });
  }
});

export default router;
