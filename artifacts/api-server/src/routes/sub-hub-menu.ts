import { Router, type IRouter } from "express";
import mongoose from "mongoose";
import { SubHub } from "../db/models/sub-hub.js";
import { getSubHubDbConnection } from "../db/sub-hub-connections.js";
import { requireAuth } from "../middlewares/auth.js";
import { loadScope, type ScopedRequest } from "../middlewares/scope.js";
import { TIMESLOT_FEATURE_ENABLED } from "../lib/feature-flags.js";
import { ensureCityAreasInitialized } from "../services/city-areas.mjs";
import {
  formatBulkPortionRangeLabel,
  formatBulkPortionWeightLabel,
  normalizeBulkPortionOptions,
} from "./inventory-batch-order.mjs";

const router: IRouter = Router({ mergeParams: true });
router.use(requireAuth as any);
router.use(loadScope as any);

// Keep legacy timeslot handlers in place, but make the API unavailable until
// scheduling is explicitly re-enabled in the feature flags.
const requireTimeslotsEnabled = (_req: any, res: any, next: any) => {
  if (!TIMESLOT_FEATURE_ENABLED) {
    res.status(404).json({ error: "NotFound", message: "Time-slot scheduling is currently disabled" });
    return;
  }
  next();
};

async function getSubHubDb(subHubId: string, res: any, req?: ScopedRequest) {
  const sub = await SubHub.findById(subHubId);
  if (!sub) {
    res.status(404).json({ error: "NotFound", message: "Sub hub not found" });
    return null;
  }
  // Enforce hub scope: non-master users may only access sub hubs in their scope
  // (either directly assigned or under one of their assigned super hubs).
  if (req && req.scope && !req.scope.isMaster) {
    const subId = String(sub._id);
    const subSuperId = sub.superHubId ? String(sub.superHubId) : "";
    const inSubScope = req.scope.subHubIds.includes(subId);
    const inSuperScope = subSuperId && req.scope.superHubIds.includes(subSuperId);
    if (!inSubScope && !inSuperScope) {
      res.status(404).json({ error: "NotFound", message: "Sub hub not found" });
      return null;
    }
  }
  if (!sub.dbName) {
    res.status(400).json({ error: "NoDB", message: "This sub hub has no database linked. Edit the sub hub and set a database name." });
    return null;
  }
  const conn = await getSubHubDbConnection(sub.dbName);
  return { sub, conn };
}

function toId(id: string) {
  try { return new mongoose.Types.ObjectId(id); } catch { return null; }
}

function normalizeIdList(values: any) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => {
      const raw = typeof value === "string" ? value : value?.$oid ? value.$oid : value?._id ? String(value._id) : "";
      return toId(raw);
    })
    .filter(Boolean);
}

function normalizeCuttingMethodNames(values: any): string[] | null {
  if (!Array.isArray(values)) return null;
  const names = values
    .map((value: any) => String(value ?? "").trim())
    .filter(Boolean);
  if (names.some((name: string) => name.length > 80)) return null;
  return Array.from(new Map(names.map((name: string) => [name.toLocaleLowerCase("en-IN"), name])).values());
}

async function validateProductCuttingMethods(db: any, values: any): Promise<{ names?: string[]; error?: string }> {
  const names = normalizeCuttingMethodNames(values);
  if (!names) return { error: "Cutting methods must be an array of names (maximum 80 characters each)." };
  if (names.length === 0) return { names: [] };
  const nameKeys = names.map((name) => name.toLocaleLowerCase("en-IN"));
  const methods = await db.collection("cutting_methods")
    .find({ nameKey: { $in: nameKeys } })
    .project({ name: 1, nameKey: 1 })
    .toArray();
  const canonicalNames = new Map(methods.map((method: any) => [String(method.nameKey), String(method.name)]));
  if (nameKeys.some((key) => !canonicalNames.has(key))) {
    return { error: "Choose cutting methods from this sub-hub's saved method list." };
  }
  return { names: Array.from(new Set(nameKeys.map((key) => canonicalNames.get(key)!))) };
}

const PRODUCT_PREORDER_DAY_NUMBERS = [0, 1, 2, 3, 4, 5, 6];
const PRODUCT_PREORDER_AVAILABILITY_TYPES = new Set(["all", "weekdays", "date_range", "date_range_and_weekdays"]);

function normalizePreorderAvailability(raw: any): { value: any; error?: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { value: { type: "all", weekdays: [...PRODUCT_PREORDER_DAY_NUMBERS], startDate: "", endDate: "" } };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { value: null, error: "Invalid preorder availability" };
  }

  const type = String(raw.type ?? "all");
  if (!PRODUCT_PREORDER_AVAILABILITY_TYPES.has(type)) {
    return { value: null, error: "Invalid preorder availability type" };
  }

  const weekdays = Array.from(new Set(
    (Array.isArray(raw.weekdays) ? raw.weekdays : [])
      .map((day: any) => Number(day))
      .filter((day: number) => Number.isInteger(day) && day >= 0 && day <= 6),
  )).sort((a, b) => a - b);
  const rawTimeslots = raw.timeslotIdsByWeekday;
  const timeslotIdsByWeekday: Record<string, string[]> = {};
  if (rawTimeslots !== undefined && (typeof rawTimeslots !== "object" || Array.isArray(rawTimeslots) || rawTimeslots === null)) {
    return { value: null, error: "Invalid preorder timeslot rules" };
  }
  if (rawTimeslots && typeof rawTimeslots === "object") {
    for (const [dayKey, ids] of Object.entries(rawTimeslots)) {
      const day = Number(dayKey);
      if (!Number.isInteger(day) || day < 0 || day > 6 || !Array.isArray(ids)) {
        return { value: null, error: "Invalid preorder timeslot rules" };
      }
      const normalizedIds = Array.from(new Set(ids
        .map((id: any) => String(id ?? "").trim())
        .filter(Boolean)));
      timeslotIdsByWeekday[String(day)] = normalizedIds;
    }
  }

  if ((type === "weekdays" || type === "date_range_and_weekdays") && weekdays.length === 0) {
    return { value: null, error: "Select at least one preorder weekday" };
  }

  const startDate = String(raw.startDate ?? "");
  const endDate = String(raw.endDate ?? "");
  const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date);
  if ((type === "date_range" || type === "date_range_and_weekdays") &&
      (!validDate(startDate) || !validDate(endDate) || startDate > endDate)) {
    return { value: null, error: "Preorder date range must have valid dates with the start date on or before the end date" };
  }

  return {
    value: {
      type,
      weekdays: type === "weekdays" || type === "date_range_and_weekdays" ? weekdays : [...PRODUCT_PREORDER_DAY_NUMBERS],
      startDate: type === "date_range" || type === "date_range_and_weekdays" ? startDate : "",
      endDate: type === "date_range" || type === "date_range_and_weekdays" ? endDate : "",
      ...(Object.keys(timeslotIdsByWeekday).length > 0 ? { timeslotIdsByWeekday } : {}),
    },
  };
}

// ─── STATS ────────────────────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const db = ctx.conn.db;
    await ensureCityAreasInitialized(db);
    const [products, categories, coupons, combos, carousels, cityAreas, sections, timeslots] = await Promise.all([
      db.collection("products").countDocuments({ isDailyWholeFish: { $ne: true } }),
      db.collection("categories").countDocuments(),
      db.collection("coupons").countDocuments(),
      db.collection("combos").countDocuments(),
      db.collection("carousels").countDocuments(),
      db.collection("city_areas").countDocuments(),
      db.collection("sections").countDocuments(),
      db.collection("timeslots").countDocuments(),
    ]);
    res.json({ stats: { products, categories, coupons, combos, carousels, cityAreas, sections, timeslots, dbName: ctx.sub.dbName } });
  } catch (err) {
    req.log.error({ err }, "Failed to get sub hub menu stats");
    res.status(500).json({ error: "InternalError", message: "Failed to get stats" });
  }
});

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────
router.get("/cutting-methods", async (req, res) => {
  try {
    const ctx = await getSubHubDb(String((req.params as any).id), res, req as ScopedRequest);
    if (!ctx) return;
    const methods = await ctx.conn.db!.collection("cutting_methods").find({})
      .sort({ nameKey: 1, name: 1 }).toArray();
    res.json({ methods });
  } catch (err) {
    req.log.error({ err }, "Failed to get cutting methods");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch cutting methods" });
  }
});

router.post("/cutting-methods", async (req, res) => {
  try {
    const ctx = await getSubHubDb(String((req.params as any).id), res, req as ScopedRequest);
    if (!ctx) return;
    const name = String(req.body?.name ?? "").trim();
    if (!name || name.length > 80) {
      res.status(400).json({ error: "ValidationError", message: "Enter a cutting method name up to 80 characters." });
      return;
    }
    const methods = ctx.conn.db!.collection("cutting_methods");
    const nameKey = name.toLocaleLowerCase("en-IN");
    if (await methods.findOne({ nameKey })) {
      res.status(409).json({ error: "Duplicate", message: "This cutting method already exists." });
      return;
    }
    const doc = { name, nameKey, createdAt: new Date(), updatedAt: new Date() };
    const result = await methods.insertOne(doc);
    res.status(201).json({ method: { ...doc, _id: result.insertedId } });
  } catch (err) {
    req.log.error({ err }, "Failed to create cutting method");
    res.status(500).json({ error: "InternalError", message: "Failed to create cutting method" });
  }
});

router.put("/cutting-methods/:methodId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(String((req.params as any).id), res, req as ScopedRequest);
    if (!ctx) return;
    const methodId = toId(req.params.methodId);
    const name = String(req.body?.name ?? "").trim();
    if (!methodId) {
      res.status(400).json({ error: "InvalidId", message: "Invalid cutting method ID." });
      return;
    }
    if (!name || name.length > 80) {
      res.status(400).json({ error: "ValidationError", message: "Enter a cutting method name up to 80 characters." });
      return;
    }
    const methods = ctx.conn.db!.collection("cutting_methods");
    const existing = await methods.findOne({ _id: methodId });
    if (!existing) {
      res.status(404).json({ error: "NotFound", message: "Cutting method not found." });
      return;
    }
    const nameKey = name.toLocaleLowerCase("en-IN");
    const duplicate = await methods.findOne({ nameKey, _id: { $ne: methodId } });
    if (duplicate) {
      res.status(409).json({ error: "Duplicate", message: "This cutting method already exists." });
      return;
    }
    await methods.updateOne({ _id: methodId }, { $set: { name, nameKey, updatedAt: new Date() } });
    if (String(existing.name) !== name) {
      await ctx.conn.db!.collection("products").updateMany(
        { cuttingMethods: String(existing.name) },
        { $set: { "cuttingMethods.$[method]": name, updatedAt: new Date() } },
        { arrayFilters: [{ method: String(existing.name) }] },
      );
    }
    res.json({ method: { ...existing, name, nameKey, updatedAt: new Date() } });
  } catch (err) {
    req.log.error({ err }, "Failed to update cutting method");
    res.status(500).json({ error: "InternalError", message: "Failed to update cutting method" });
  }
});

router.delete("/cutting-methods/:methodId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(String((req.params as any).id), res, req as ScopedRequest);
    if (!ctx) return;
    const methodId = toId(req.params.methodId);
    if (!methodId) {
      res.status(400).json({ error: "InvalidId", message: "Invalid cutting method ID." });
      return;
    }
    const methods = ctx.conn.db!.collection("cutting_methods");
    const existing = await methods.findOne({ _id: methodId });
    if (!existing) {
      res.status(404).json({ error: "NotFound", message: "Cutting method not found." });
      return;
    }
    await methods.deleteOne({ _id: methodId });
    await ctx.conn.db!.collection("products").updateMany(
      { cuttingMethods: String(existing.name) },
      { $pull: { cuttingMethods: String(existing.name) }, $set: { updatedAt: new Date() } } as any,
    );
    res.json({ message: "Cutting method deleted", methodId: String(methodId) });
  } catch (err) {
    req.log.error({ err }, "Failed to delete cutting method");
    res.status(500).json({ error: "InternalError", message: "Failed to delete cutting method" });
  }
});

router.get("/products", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const search = String(req.query.search || "");
    const query: any = search ? { name: { $regex: search, $options: "i" } } : {};
    const productsCollection = ctx.conn.db!.collection("products");
    const [productDocs, fishRoots] = await Promise.all([
      productsCollection.find({ ...query, isDailyWholeFish: { $ne: true } }).sort({ sortOrder: 1, name: 1 }).toArray(),
      productsCollection.find({
        $or: [
          { wholeFishInventory: true },
          { fishInventoryMode: { $in: ["whole_fish", "bulk_portions"] } },
        ],
      }).project({ _id: 1 }).toArray(),
    ]);
    const fishRootIds = new Set(fishRoots.map((product: any) => String(product._id)));
    const products = productDocs.filter((product: any) =>
      !product.variantGroupId ||
      !fishRootIds.has(String(product.variantGroupId)) ||
      String(product._id) === String(product.variantGroupId)
    );
    const groupIds = [...new Set(products.map((product: any) => String(product.variantGroupId ?? "")).filter(Boolean))];
    const rootIds = groupIds.map((groupId) => toId(groupId)).filter((id) => id !== null) as any[];
    const roots = rootIds.length
      ? await productsCollection.find({ _id: { $in: rootIds } }).project({ unit: 1 }).toArray()
      : [];
    const groupUnits = new Map(roots.map((root: any) => [String(root._id), root.unit || "per pack"]));
    // Derive quantity from non-expired batches only — expired stock is not available for sale.
    const nowMs = Date.now();
    const productsWithQty = products.map((p: any) => {
      const batches: any[] = Array.isArray(p.batches) ? p.batches : [];
      const fishInventoryMode = p.fishInventoryMode === "bulk_portions"
        ? "bulk_portions"
        : p.fishInventoryMode === "whole_fish" || p.wholeFishInventory === true
          ? "whole_fish"
          : "standard";
      const isWholeFish = fishInventoryMode === "whole_fish";
      const isBulkFish = fishInventoryMode === "bulk_portions";
      const availableBatchTotal = batches
        .filter((b: any) => !b?.expiryDate || new Date(b.expiryDate).getTime() >= nowMs)
        .reduce((s: number, b: any) => s + (Math.max(0, Number(b?.quantity) || 0)), 0);
      const fishBatches = isWholeFish
        ? batches
          .filter((batch: any) =>
            Number(batch?.quantity) > 0 &&
            Number(batch?.fishWeightKg) > 0 &&
            Number.isFinite(Number(batch?.fishPrice)) &&
            Number(batch?.fishPrice) > 0 &&
            (!batch?.expiryDate || new Date(batch.expiryDate).getTime() >= nowMs)
          )
          .map((batch: any) => ({
            batchId: String(batch._id ?? ""),
            batchNumber: String(batch.batchNumber ?? ""),
            weightKg: Number(batch.fishWeightKg),
            price: Math.round(Number(batch.fishPrice)),
            quantity: Number(batch.quantity) || 0,
            expiryDate: batch.expiryDate ?? null,
          }))
        : undefined;
      const unpricedFishCount = isWholeFish
        ? batches
          .filter((batch: any) =>
            Number(batch?.quantity) > 0 &&
            (!batch?.expiryDate || new Date(batch.expiryDate).getTime() >= nowMs) &&
            (!(Number(batch?.fishWeightKg) > 0) ||
              !Number.isFinite(Number(batch?.fishPrice)) ||
              !(Number(batch?.fishPrice) > 0))
          )
          .reduce((sum: number, batch: any) => sum + (Number(batch?.quantity) || 0), 0)
        : 0;
      const total = isWholeFish
        ? (fishBatches ?? []).reduce((sum: number, batch: any) => sum + batch.quantity, 0)
        : batches.length > 0 ? availableBatchTotal : Math.max(0, Number(p.quantity) || 0);
      const bulkPortionOptions = normalizeBulkPortionOptions(
        p.bulkPortionOptions,
        p.bulkPortionWeightsKg,
      );
      const bulkPortionWeightsKg = bulkPortionOptions.map((option) => option.weightKg);
      const fishPricePerKg = Number(p.fishPricePerKg) > 0
        ? Number(p.fishPricePerKg)
        : Number(p.price) > 0 ? Number(p.price) : 0;
      const bulkSaleOptions = isBulkFish
        ? bulkPortionOptions.map((option) => {
            const weightKg = option.weightKg;
            const wholePacksAvailable = Math.floor((total + 1e-9) / weightKg);
            return {
              weightKg,
              ...(option.minWeightKg != null && option.maxWeightKg != null ? {
                minWeightKg: option.minWeightKg,
                maxWeightKg: option.maxWeightKg,
              } : {}),
              weightLabel: formatBulkPortionRangeLabel(option),
              averageWeightLabel: formatBulkPortionWeightLabel(weightKg),
              price: Math.round(weightKg * fishPricePerKg),
              availableQuantity: wholePacksAvailable,
            };
          })
        : undefined;
      const hasVariantLabel = fishInventoryMode === "standard" &&
        Boolean(p.variantGroupId || p.netWeight || p.variantLabel || p.weight || p.grossWeight);
      const category = String(p.category ?? "").trim() ||
        (fishInventoryMode !== "standard" ? String(p.name ?? "").trim() : "");
      return {
        ...p,
        category,
        unit: isBulkFish
          ? "kg"
          : isWholeFish
            ? "per fish"
          : p.variantGroupId ? groupUnits.get(String(p.variantGroupId)) ?? p.unit : p.unit,
        price: fishInventoryMode !== "standard" && fishPricePerKg > 0
          ? fishPricePerKg
          : Number(p.price) || 0,
        ...(hasVariantLabel ? { variantLabel: getVariantLabel(p) } : {}),
        quantity: total,
        wholeFishInventory: isWholeFish,
        fishInventoryMode,
        fishPricePerKg: fishPricePerKg > 0 ? fishPricePerKg : null,
        ...(isBulkFish ? {
          bulkPortionWeightsKg,
          bulkPortionOptions,
          bulkSaleOptions,
        } : {}),
        ...(isWholeFish ? {
          fishBatches: fishBatches ?? [],
          unpricedFishCount,
        } : {}),
      };
    });
    res.json({ products: productsWithQty, total: productsWithQty.length });
  } catch (err) {
    req.log.error({ err }, "Failed to get products");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch products" });
  }
});

function getVariantLabel(product: any): string {
  return String(
    product?.netWeight ||
    product?.variantLabel ||
    product?.weight ||
    product?.grossWeight ||
    "Standard",
  ).trim();
}

router.get("/products/:productId/variants", async (req, res) => {
  try {
    const ctx = await getSubHubDb(String((req.params as any).id), res, req as ScopedRequest);
    if (!ctx) return;
    const productId = toId(req.params.productId);
    if (!productId) { res.status(400).json({ error: "InvalidId", message: "Invalid product ID" }); return; }
    const db = ctx.conn.db!;
    const products = db.collection("products");
    const product = await products.findOne({ _id: productId });
    if (!product) { res.status(404).json({ error: "NotFound", message: "Product not found" }); return; }

    const groupId = String(product.variantGroupId || product._id);
    const rootId = product.variantGroupId ? toId(groupId) : product._id;
    const root = rootId
      ? await products.findOne({ _id: rootId }, { projection: { unit: 1, wholeFishInventory: 1, fishInventoryMode: 1 } })
      : null;
    const globalUnit = root?.unit || product.unit || "per pack";
    const variants = root?.wholeFishInventory || root?.fishInventoryMode === "whole_fish" || root?.fishInventoryMode === "bulk_portions"
      ? [root]
      : product.variantGroupId
      ? await products.find({ variantGroupId: groupId }).sort({ createdAt: 1, _id: 1 }).toArray()
      : [product];
    const withQuantity = variants.map((variant: any) => {
      const batches = Array.isArray(variant.batches) ? variant.batches : [];
      const quantity = batches.length > 0
        ? batches.reduce((total: number, batch: any) => total + Math.max(0, Number(batch?.quantity) || 0), 0)
        : Math.max(0, Number(variant.quantity) || 0);
      const hasVariantLabel = variant.wholeFishInventory !== true && Boolean(
        variant.variantGroupId || variant.netWeight || variant.variantLabel || variant.weight || variant.grossWeight,
      );
      return {
        ...variant,
        unit: globalUnit,
        ...(hasVariantLabel ? { variantLabel: getVariantLabel(variant) } : { variantLabel: "" }),
        quantity,
      };
    });

    res.json({ groupId: product.variantGroupId ? groupId : null, variants: withQuantity });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch product variants");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch product variants" });
  }
});

router.post("/products/:productId/variants", async (req, res) => {
  try {
    const ctx = await getSubHubDb(String((req.params as any).id), res, req as ScopedRequest);
    if (!ctx) return;
    const productId = toId(req.params.productId);
    if (!productId) { res.status(400).json({ error: "InvalidId", message: "Invalid product ID" }); return; }

    const db = ctx.conn.db!;
    const products = db.collection("products");
    const base = await products.findOne({ _id: productId });
    if (!base) { res.status(404).json({ error: "NotFound", message: "Product not found" }); return; }
    const rootId = toId(String(base.variantGroupId || base._id));
    const groupRoot = rootId
      ? await products.findOne({ _id: rootId }, { projection: { wholeFishInventory: 1, fishInventoryMode: 1 } })
      : null;
    if (
      base.wholeFishInventory === true ||
      base.fishInventoryMode === "whole_fish" ||
      base.fishInventoryMode === "bulk_portions" ||
      groupRoot?.wholeFishInventory === true ||
      groupRoot?.fishInventoryMode === "whole_fish" ||
      groupRoot?.fishInventoryMode === "bulk_portions"
    ) {
      res.status(409).json({
        error: "WholeFishBatchInventory",
        message: "This fish is managed as one batch per fish. Do not create weight sub-products.",
      });
      return;
    }

    const netWeight = String(req.body.netWeight ?? "").trim();
    const variantLabel = netWeight;
    const price = Number(req.body.price);
    if (!netWeight) { res.status(400).json({ error: "ValidationError", message: "Net weight is required" }); return; }
    if (!Number.isFinite(price) || price < 0) { res.status(400).json({ error: "ValidationError", message: "Enter a valid variant price" }); return; }

    const groupId = String(base.variantGroupId || base._id);
    const existingVariants = base.variantGroupId
      ? await products.find({ variantGroupId: groupId }).toArray()
      : [base];
    if (existingVariants.some((variant: any) => getVariantLabel(variant).toLowerCase() === variantLabel.toLowerCase())) {
      res.status(409).json({ error: "DuplicateVariant", message: "A variant with this weight or label already exists" });
      return;
    }

    const now = new Date();
    const baseVariantLabel = getVariantLabel(base);
    if (!base.variantGroupId) {
      await products.updateOne(
        { _id: productId },
        { $set: { variantGroupId: groupId, variantLabel: baseVariantLabel, updatedAt: now } },
      );
    }

    const originalPrice = Number(req.body.originalPrice);
    const variant: any = {
      name: base.name,
      description: base.description ?? "",
      category: base.category ?? "",
      subCategory: base.subCategory ?? "",
      shortCode: base.shortCode ?? "",
      price,
      originalPrice: Number.isFinite(originalPrice) && originalPrice >= price ? originalPrice : price,
      discountPct: Number.isFinite(originalPrice) && originalPrice > price
        ? Math.round(((originalPrice - price) / originalPrice) * 100)
        : 0,
      unit: base.unit || "per pack",
      weight: netWeight,
      grossWeight: req.body.grossWeight ?? "",
      netWeight: req.body.netWeight ?? "",
      pieces: req.body.pieces ?? "",
      serves: req.body.serves ?? "",
      quantity: 0,
      batches: [],
      status: "available",
      isArchived: false,
      imageUrl: base.imageUrl ?? "",
      limitedStockNote: base.limitedStockNote ?? "",
      lowStockThreshold: Number(base.lowStockThreshold) || 0,
      preorderMode: base.preorderMode ?? "normal",
      preorderAvailability: base.preorderAvailability ?? { type: "all", weekdays: [0, 1, 2, 3, 4, 5, 6], startDate: "", endDate: "" },
      cuttingMethods: Array.isArray(base.cuttingMethods) ? base.cuttingMethods : [],
      recipes: Array.isArray(base.recipes) ? base.recipes : [],
      sectionId: Array.isArray(base.sectionId) ? base.sectionId : [],
      couponIds: Array.isArray(base.couponIds) ? base.couponIds : [],
      variantGroupId: groupId,
      variantLabel,
      createdAt: now,
      updatedAt: now,
    };
    const result = await products.insertOne(variant);

    const couponObjectIds = (Array.isArray(base.couponIds) ? base.couponIds : [])
      .map((couponId: any) => toId(String(couponId?.$oid ?? couponId?._id ?? couponId)))
      .filter((id: any) => id !== null) as any[];
    if (couponObjectIds.length > 0) {
      await db.collection("coupons").updateMany(
        { _id: { $in: couponObjectIds } },
        { $addToSet: { applicableProducts: String(result.insertedId) } },
      );
    }

    res.status(201).json({ variant: { ...variant, _id: result.insertedId }, groupId });
  } catch (err) {
    req.log.error({ err }, "Failed to create product variant");
    res.status(500).json({ error: "InternalError", message: "Failed to create product variant" });
  }
});

router.put("/products/:productId/variants/:variantId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(String((req.params as any).id), res, req as ScopedRequest);
    if (!ctx) return;
    const productId = toId(req.params.productId);
    const variantId = toId(req.params.variantId);
    if (!productId || !variantId) { res.status(400).json({ error: "InvalidId", message: "Invalid product or variant ID" }); return; }

    const products = ctx.conn.db!.collection("products");
    const base = await products.findOne({ _id: productId });
    const variant = await products.findOne({ _id: variantId });
    if (!base || !variant) { res.status(404).json({ error: "NotFound", message: "Product variant not found" }); return; }
    const groupId = base.variantGroupId ? String(base.variantGroupId) : "";
    const belongsToGroup = groupId
      ? String(variant.variantGroupId ?? "") === groupId
      : String(variant._id) === String(base._id);
    if (!belongsToGroup) { res.status(404).json({ error: "NotFound", message: "Product variant not found" }); return; }

    const update: any = { updatedAt: new Date() };
    if (req.body.variantLabel !== undefined) {
      const label = String(req.body.variantLabel).trim();
      if (!label) { res.status(400).json({ error: "ValidationError", message: "Variant weight or label is required" }); return; }
      const siblings = groupId
        ? await products.find({ variantGroupId: groupId, _id: { $ne: variantId } }).toArray()
        : [];
      if (siblings.some((sibling: any) => getVariantLabel(sibling).toLowerCase() === label.toLowerCase())) {
        res.status(409).json({ error: "DuplicateVariant", message: "A variant with this weight or label already exists" });
        return;
      }
      update.variantLabel = label;
    }
    if (req.body.netWeight !== undefined) {
      const netWeight = String(req.body.netWeight ?? "").trim();
      const label = netWeight || String(variant.variantLabel ?? "Standard").trim();
      const siblings = groupId
        ? await products.find({ variantGroupId: groupId, _id: { $ne: variantId } }).toArray()
        : [];
      if (netWeight && siblings.some((sibling: any) => getVariantLabel(sibling).toLowerCase() === label.toLowerCase())) {
        res.status(409).json({ error: "DuplicateVariant", message: "A variant with this net weight already exists" });
        return;
      }
      update.netWeight = netWeight;
      update.weight = netWeight;
      update.variantLabel = label;
    }
    if (req.body.price !== undefined) {
      const price = Number(req.body.price);
      if (!Number.isFinite(price) || price < 0) { res.status(400).json({ error: "ValidationError", message: "Enter a valid variant price" }); return; }
      update.price = price;
    }
    if (req.body.originalPrice !== undefined) {
      const originalPrice = Number(req.body.originalPrice);
      if (!Number.isFinite(originalPrice) || originalPrice < 0) { res.status(400).json({ error: "ValidationError", message: "Enter a valid original price" }); return; }
      update.originalPrice = originalPrice;
      const effectivePrice = Number(req.body.price ?? variant.price) || 0;
      update.discountPct = originalPrice > effectivePrice
        ? Math.round(((originalPrice - effectivePrice) / originalPrice) * 100)
        : 0;
    } else if (req.body.price !== undefined) {
      const originalPrice = Number(variant.originalPrice) || 0;
      update.discountPct = originalPrice > Number(update.price)
        ? Math.round(((originalPrice - Number(update.price)) / originalPrice) * 100)
        : 0;
    }
    for (const field of ["grossWeight", "pieces", "serves"] as const) {
      if (req.body[field] !== undefined) update[field] = req.body[field];
    }
    if (req.body.isArchived !== undefined) update.isArchived = req.body.isArchived === true;

    const updated = await products.findOneAndUpdate(
      { _id: variantId },
      { $set: update },
      { returnDocument: "after" },
    );
    if (!updated) { res.status(404).json({ error: "NotFound", message: "Product variant not found" }); return; }
    res.json({ variant: updated });
  } catch (err) {
    req.log.error({ err }, "Failed to update product variant");
    res.status(500).json({ error: "InternalError", message: "Failed to update product variant" });
  }
});

router.delete("/products/:productId/variants/:variantId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(String((req.params as any).id), res, req as ScopedRequest);
    if (!ctx) return;
    const productId = toId(req.params.productId);
    const variantId = toId(req.params.variantId);
    if (!productId || !variantId) {
      res.status(400).json({ error: "InvalidId", message: "Invalid product or variant ID" });
      return;
    }

    const products = ctx.conn.db!.collection("products");
    const base = await products.findOne({ _id: productId });
    const variant = await products.findOne({ _id: variantId });
    if (!base || !variant) {
      res.status(404).json({ error: "NotFound", message: "Product variant not found" });
      return;
    }

    const groupId = base.variantGroupId ? String(base.variantGroupId) : "";
    const belongsToGroup = groupId
      ? String(variant.variantGroupId ?? "") === groupId
      : String(variant._id) === String(base._id);
    if (!belongsToGroup) {
      res.status(404).json({ error: "NotFound", message: "Product variant not found" });
      return;
    }

    const variantCount = groupId
      ? await products.countDocuments({ variantGroupId: groupId })
      : 1;
    if (variantCount <= 1) {
      res.status(409).json({
        error: "LastVariant",
        message: "At least one product variant must remain.",
      });
      return;
    }

    const batchCount = Array.isArray(variant.batches) ? variant.batches.length : 0;
    const result = await products.deleteOne({ _id: variantId });
    if (result.deletedCount !== 1) {
      res.status(404).json({ error: "NotFound", message: "Product variant not found" });
      return;
    }

    res.json({
      message: "Variant permanently deleted",
      variantId: String(variantId),
      batchesDeleted: batchCount,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to permanently delete product variant");
    res.status(500).json({ error: "InternalError", message: "Failed to delete product variant" });
  }
});

router.post("/products", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const {
      name, description, category, subCategory, shortCode,
      price, originalPrice, discountPct, unit, weight, grossWeight, netWeight, pieces, serves, quantity,
      status, isArchived, imageUrl, limitedStockNote, lowStockThreshold,
      recipes, sectionId, couponIds, preorderMode,
      preorderAvailability, cuttingMethods,
    } = req.body;
    if (!name) { res.status(400).json({ error: "ValidationError", message: "Name is required" }); return; }
    const validPreorderModes = new Set(["normal", "preorder_only"]);
    const normalizedPreorderMode = validPreorderModes.has(String(preorderMode)) ? String(preorderMode) : "normal";
    const availabilityResult = normalizePreorderAvailability(preorderAvailability);
    if (availabilityResult.error) {
      res.status(400).json({ error: "ValidationError", message: availabilityResult.error });
      return;
    }
    const cuttingMethodsResult = await validateProductCuttingMethods(ctx.conn.db!, cuttingMethods ?? []);
    if (cuttingMethodsResult.error) {
      res.status(400).json({ error: "ValidationError", message: cuttingMethodsResult.error });
      return;
    }
    const p = Number(price) || 0;
    const op = Number(originalPrice) || p;
    const doc = {
      name,
      description: description ?? "",
      category: category ?? "",
      subCategory: subCategory ?? "",
      shortCode: shortCode ?? "",
      price: p,
      originalPrice: op,
      discountPct: Number(discountPct) || (op > p ? Math.round(((op - p) / op) * 100) : 0),
      unit: unit ?? "per pack",
      weight: weight ?? "",
      grossWeight: grossWeight ?? "",
      netWeight: netWeight ?? "",
      variantLabel: String(netWeight ?? "").trim(),
      pieces: pieces ?? "",
      serves: serves ?? "",
      quantity: Number(quantity) || 0,
      status: status ?? "available",
      isArchived: isArchived === true,
      imageUrl: imageUrl ?? "",
      limitedStockNote: limitedStockNote ?? "",
      lowStockThreshold: lowStockThreshold != null ? Number(lowStockThreshold) : 0,
      preorderMode: normalizedPreorderMode,
      preorderAvailability: availabilityResult.value,
      cuttingMethods: cuttingMethodsResult.names,
      recipes: Array.isArray(recipes) ? recipes : [],
      sectionId: normalizeIdList(sectionId),
      couponIds: normalizeIdList(couponIds),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await ctx.conn.db.collection("products").insertOne(doc);
    res.status(201).json({ product: { ...doc, _id: result.insertedId } });
  } catch (err) {
    req.log.error({ err }, "Failed to create product");
    res.status(500).json({ error: "InternalError", message: "Failed to create product" });
  }
});

router.put("/products/:productId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const db = ctx.conn.db!;
    const oid = toId(req.params.productId);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid product ID" }); return; }
    const {
      name, description, category, subCategory, shortCode,
      price, originalPrice, discountPct, unit, weight, grossWeight, netWeight, pieces, serves, quantity,
      status, isArchived, imageUrl, limitedStockNote, lowStockThreshold,
      recipes, sectionId, couponIds, preorderMode,
      preorderAvailability, cuttingMethods,
    } = req.body;
    const update: any = { updatedAt: new Date() };
    if (name !== undefined) update.name = name;
    if (description !== undefined) update.description = description;
    if (category !== undefined) update.category = category;
    if (subCategory !== undefined) update.subCategory = subCategory;
    if (shortCode !== undefined) update.shortCode = shortCode;
    if (price !== undefined) update.price = Number(price) || 0;
    if (originalPrice !== undefined) update.originalPrice = Number(originalPrice) || 0;
    if (discountPct !== undefined) update.discountPct = Number(discountPct) || 0;
    if (unit !== undefined) update.unit = unit;
    if (weight !== undefined) update.weight = weight;
    if (grossWeight !== undefined) update.grossWeight = grossWeight;
    if (netWeight !== undefined) update.netWeight = netWeight;
    if (pieces !== undefined) update.pieces = pieces;
    if (serves !== undefined) update.serves = serves;
    if (quantity !== undefined) update.quantity = Number(quantity) || 0;
    if (status !== undefined) update.status = status;
    if (isArchived !== undefined) update.isArchived = isArchived === true;
    if (imageUrl !== undefined) update.imageUrl = imageUrl;
    if (limitedStockNote !== undefined) update.limitedStockNote = limitedStockNote;
    if (lowStockThreshold !== undefined) update.lowStockThreshold = Number(lowStockThreshold) || 0;
    if (preorderMode !== undefined) {
      const validPreorderModes = new Set(["normal", "preorder_only"]);
      if (!validPreorderModes.has(String(preorderMode))) {
        res.status(400).json({ error: "ValidationError", message: "Invalid preorder mode" });
        return;
      }
      update.preorderMode = String(preorderMode);
    }
    if (preorderAvailability !== undefined) {
      const availabilityResult = normalizePreorderAvailability(preorderAvailability);
      if (availabilityResult.error) {
        res.status(400).json({ error: "ValidationError", message: availabilityResult.error });
        return;
      }
      update.preorderAvailability = availabilityResult.value;
    }
    if (cuttingMethods !== undefined) {
      const cuttingMethodsResult = await validateProductCuttingMethods(db, cuttingMethods);
      if (cuttingMethodsResult.error) {
        res.status(400).json({ error: "ValidationError", message: cuttingMethodsResult.error });
        return;
      }
      update.cuttingMethods = cuttingMethodsResult.names;
    }
    if (recipes !== undefined) update.recipes = Array.isArray(recipes) ? recipes : [];
    if (sectionId !== undefined) update.sectionId = normalizeIdList(sectionId);
    if (couponIds !== undefined) update.couponIds = normalizeIdList(couponIds);
    const existing = await db.collection("products").findOne({ _id: oid });
    if (!existing) { res.status(404).json({ error: "NotFound", message: "Product not found" }); return; }
    if (existing.variantGroupId) {
      const sharedFields = [
        "name", "description", "category", "subCategory", "shortCode",
        "imageUrl", "preorderMode", "preorderAvailability", "recipes", "unit", "cuttingMethods",
      ];
      const sharedUpdate: Record<string, unknown> = { updatedAt: update.updatedAt };
      for (const field of sharedFields) {
        if (update[field] !== undefined) sharedUpdate[field] = update[field];
      }
      if (Object.keys(sharedUpdate).length > 1) {
        await db.collection("products").updateMany(
          { variantGroupId: String(existing.variantGroupId) },
          { $set: sharedUpdate },
        );
      }
    }
    const result = await db.collection("products").findOneAndUpdate({ _id: oid }, { $set: update }, { returnDocument: "after" });
    if (!result) { res.status(404).json({ error: "NotFound", message: "Product not found" }); return; }
    if (couponIds !== undefined) {
      const oldCouponIds: string[] = (existing.couponIds ?? []).map((c: any) => String(c));
      const newCouponIds: string[] = (Array.isArray(couponIds) ? couponIds : []).map((c: any) => String(c));
      const removedCouponIds = oldCouponIds.filter((id) => !newCouponIds.includes(id)).map((id) => toId(id)).filter(Boolean);
      const addedCouponIds = newCouponIds.filter((id) => !oldCouponIds.includes(id)).map((id) => toId(id)).filter(Boolean);
      const productIdStr = String(oid);
      if (removedCouponIds.length > 0) {
        await db.collection("coupons").updateMany(
          { _id: { $in: removedCouponIds } },
          { $pull: { applicableProducts: productIdStr } }
        );
      }
      if (addedCouponIds.length > 0) {
        await db.collection("coupons").updateMany(
          { _id: { $in: addedCouponIds } },
          { $addToSet: { applicableProducts: productIdStr } }
        );
      }
    }
    res.json({ product: result });
  } catch (err) {
    req.log.error({ err }, "Failed to update product");
    res.status(500).json({ error: "InternalError", message: "Failed to update product" });
  }
});

router.delete("/products/:productId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const oid = toId(req.params.productId);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid product ID" }); return; }
    const products = ctx.conn.db.collection("products");
    const existing = await products.findOne({ _id: oid });
    if (!existing) { res.status(404).json({ error: "NotFound", message: "Product not found" }); return; }
    if (existing.variantGroupId) {
      await products.updateOne(
        { _id: oid },
        { $set: { isArchived: true, updatedAt: new Date() } },
      );
      res.json({ message: "Variant archived" });
      return;
    }
    await products.deleteOne({ _id: oid });
    res.json({ message: "Product deleted" });
  } catch (err) {
    req.log.error({ err }, "Failed to delete product");
    res.status(500).json({ error: "InternalError", message: "Failed to delete product" });
  }
});

// ─── PRODUCTS BULK UPSERT ─────────────────────────────────────────────────────
router.post("/products/bulk-upsert", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const rows: any[] = Array.isArray(req.body.products) ? req.body.products : [];
    if (rows.length === 0) { res.status(400).json({ error: "ValidationError", message: "No products provided" }); return; }

    const created: number[] = [];
    const updated: number[] = [];
    const errors: string[] = [];

    for (const row of rows) {
      try {
        const p = Number(row.price) || 0;
        const op = Number(row.originalPrice ?? row.mrp) || p;
        const fields = {
          name: row.name ?? "",
          description: row.description ?? "",
          category: row.category ?? "",
          subCategory: row.subCategory ?? "",
          price: p,
          originalPrice: op,
          discountPct: Number(row.discountPct ?? row.discount_pct) || (op > p ? Math.round(((op - p) / op) * 100) : 0),
          unit: row.unit ?? "per pack",
          weight: row.weight ?? "",
          grossWeight: row.grossWeight ?? "",
          netWeight: row.netWeight ?? "",
          variantLabel: String(row.netWeight ?? "").trim(),
          pieces: row.pieces ?? "",
          serves: row.serves ?? "",
          quantity: Number(row.quantity ?? row.stock) || 0,
          status: row.status ?? "available",
          isArchived: String(row.isArchived ?? row.archived ?? "").toLowerCase() === "yes" || row.isArchived === true,
          preorderMode: ["normal", "preorder_only"].includes(String(row.preorderMode))
            ? String(row.preorderMode)
            : "normal",
          preorderAvailability: undefined as any,
          imageUrl: row.imageUrl ?? "",
          limitedStockNote: row.limitedStockNote ?? "",
          updatedAt: new Date(),
        };
        if (!fields.name) { errors.push(`Row skipped: missing name`); continue; }

        const rawAvailability = row.preorderAvailability ?? {
          type: row.preorderAvailabilityType ?? "all",
          weekdays: row.preorderWeekdays,
          startDate: row.preorderStartDate ?? "",
          endDate: row.preorderEndDate ?? "",
        };
        const availabilityResult = normalizePreorderAvailability(rawAvailability);
        if (availabilityResult.error) {
          errors.push(`${fields.name}: ${availabilityResult.error}`);
          continue;
        }
        fields.preorderAvailability = availabilityResult.value;

        const oid = row._id ? toId(String(row._id)) : null;
        if (oid) {
          await ctx.conn.db.collection("products").updateOne({ _id: oid }, { $set: fields });
          updated.push(1);
        } else {
          await ctx.conn.db.collection("products").insertOne({ ...fields, cuttingMethods: [], createdAt: new Date() });
          created.push(1);
        }
      } catch (rowErr: any) {
        errors.push(rowErr.message);
      }
    }

    res.json({ created: created.length, updated: updated.length, errors });
  } catch (err) {
    req.log.error({ err }, "Failed to bulk upsert products");
    res.status(500).json({ error: "InternalError", message: "Failed to process bulk upsert" });
  }
});

// ─── CATEGORIES ───────────────────────────────────────────────────────────────
router.get("/categories", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const categories = await ctx.conn.db.collection("categories").find({}).sort({ sortOrder: 1, name: 1 }).toArray();
    res.json({ categories, total: categories.length });
  } catch (err) {
    req.log.error({ err }, "Failed to get categories");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch categories" });
  }
});

router.post("/categories", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const { name, imageUrl, isActive, sortOrder, subCategories } = req.body;
    if (!name) { res.status(400).json({ error: "ValidationError", message: "Name is required" }); return; }
    const doc = {
      name,
      imageUrl: imageUrl ?? "",
      isActive: isActive !== false,
      sortOrder: Number(sortOrder) || 0,
      subCategories: Array.isArray(subCategories) ? subCategories : [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await ctx.conn.db.collection("categories").insertOne(doc);
    res.status(201).json({ category: { ...doc, _id: result.insertedId } });
  } catch (err) {
    req.log.error({ err }, "Failed to create category");
    res.status(500).json({ error: "InternalError", message: "Failed to create category" });
  }
});

router.put("/categories/reorder", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: "ValidationError", message: "items array required" }); return; }
    const ops = items.map(({ id, sortOrder }: { id: string; sortOrder: number }) => {
      const oid = toId(id);
      if (!oid) return null;
      return { updateOne: { filter: { _id: oid }, update: { $set: { sortOrder: Number(sortOrder), updatedAt: new Date() } } } };
    }).filter(Boolean);
    if (ops.length > 0) await ctx.conn.db.collection("categories").bulkWrite(ops as any);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to reorder categories");
    res.status(500).json({ error: "InternalError", message: "Failed to reorder categories" });
  }
});

router.put("/categories/:catId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const oid = toId(req.params.catId);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid category ID" }); return; }
    const { name, imageUrl, isActive, sortOrder, subCategories } = req.body;
    const update: any = { updatedAt: new Date() };
    if (name !== undefined) update.name = name;
    if (imageUrl !== undefined) update.imageUrl = imageUrl;
    if (isActive !== undefined) update.isActive = isActive;
    if (sortOrder !== undefined) update.sortOrder = Number(sortOrder) || 0;
    if (subCategories !== undefined) update.subCategories = subCategories;
    const result = await ctx.conn.db.collection("categories").findOneAndUpdate({ _id: oid }, { $set: update }, { returnDocument: "after" });
    if (!result) { res.status(404).json({ error: "NotFound", message: "Category not found" }); return; }
    res.json({ category: result });
  } catch (err) {
    req.log.error({ err }, "Failed to update category");
    res.status(500).json({ error: "InternalError", message: "Failed to update category" });
  }
});

router.delete("/categories/:catId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const oid = toId(req.params.catId);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid category ID" }); return; }
    await ctx.conn.db.collection("categories").deleteOne({ _id: oid });
    res.json({ message: "Category deleted" });
  } catch (err) {
    req.log.error({ err }, "Failed to delete category");
    res.status(500).json({ error: "InternalError", message: "Failed to delete category" });
  }
});

// ─── COUPONS ──────────────────────────────────────────────────────────────────
router.get("/coupons", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const coupons = await ctx.conn.db.collection("coupons").find({}).sort({ createdAt: -1 }).toArray();
    res.json({ coupons, total: coupons.length });
  } catch (err) {
    req.log.error({ err }, "Failed to get coupons");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch coupons" });
  }
});

router.post("/coupons", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const { code, title, description, type, discountValue, minOrderAmount, maxUsage, isFirstTimeOnly, applicableCategories, applicableProducts, applicableCustomers, isActive, visibleOnWebsite, expiresAt } = req.body;
    if (!code) { res.status(400).json({ error: "ValidationError", message: "Code is required" }); return; }
    const existing = await ctx.conn.db.collection("coupons").findOne({ code: { $regex: `^${code}$`, $options: "i" } });
    if (existing) { res.status(400).json({ error: "DuplicateCoupon", message: "Coupon code already exists" }); return; }
    const activeFlag = isActive !== false;
    const doc: any = {
      code: code.toUpperCase(),
      title: title ?? "",
      description: description ?? "",
      type: type ?? "percentage",
      discountValue: Number(discountValue) || 0,
      minOrderAmount: Number(minOrderAmount) || 0,
      isFirstTimeOnly: isFirstTimeOnly === true,
      applicableCategories: Array.isArray(applicableCategories) ? applicableCategories : [],
      applicableProducts: Array.isArray(applicableProducts) ? applicableProducts : [],
      applicableCustomers: Array.isArray(applicableCustomers) ? applicableCustomers : [],
      isActive: activeFlag,
      visibleOnWebsite: activeFlag ? (visibleOnWebsite !== false) : false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (maxUsage) doc.maxUsage = Number(maxUsage);
    if (expiresAt) doc.expiresAt = new Date(expiresAt);
    const result = await ctx.conn.db.collection("coupons").insertOne(doc);
    const couponOid = result.insertedId;
    if (doc.applicableProducts.length > 0) {
      const productOids = doc.applicableProducts.map((p: any) => toId(typeof p === "string" ? p : String(p))).filter(Boolean);
      await ctx.conn.db.collection("products").updateMany(
        { _id: { $in: productOids } },
        { $addToSet: { couponIds: couponOid } }
      );
    }
    res.status(201).json({ coupon: { ...doc, _id: couponOid } });
  } catch (err) {
    req.log.error({ err }, "Failed to create coupon");
    res.status(500).json({ error: "InternalError", message: "Failed to create coupon" });
  }
});

router.put("/coupons/:couponId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const oid = toId(req.params.couponId);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid coupon ID" }); return; }
    const { code, title, description, type, discountValue, minOrderAmount, maxUsage, isFirstTimeOnly, applicableCategories, applicableProducts, applicableCustomers, isActive, visibleOnWebsite, expiresAt } = req.body;
    const update: any = { updatedAt: new Date() };
    if (code !== undefined) update.code = code.toUpperCase();
    if (title !== undefined) update.title = title;
    if (description !== undefined) update.description = description;
    if (type !== undefined) update.type = type;
    if (discountValue !== undefined) update.discountValue = Number(discountValue) || 0;
    if (minOrderAmount !== undefined) update.minOrderAmount = Number(minOrderAmount) || 0;
    if (maxUsage !== undefined) update.maxUsage = maxUsage ? Number(maxUsage) : null;
    if (isFirstTimeOnly !== undefined) update.isFirstTimeOnly = isFirstTimeOnly;
    if (applicableCategories !== undefined) update.applicableCategories = Array.isArray(applicableCategories) ? applicableCategories : [];
    if (applicableProducts !== undefined) update.applicableProducts = Array.isArray(applicableProducts) ? applicableProducts : [];
    if (applicableCustomers !== undefined) update.applicableCustomers = Array.isArray(applicableCustomers) ? applicableCustomers : [];
    if (isActive !== undefined) {
      update.isActive = isActive;
      // When deactivating, force visibleOnWebsite off too
      if (!isActive) update.visibleOnWebsite = false;
    }
    if (visibleOnWebsite !== undefined) {
      // visibleOnWebsite can only be true when the coupon is active
      const currentlyActive = isActive !== undefined ? isActive : true;
      update.visibleOnWebsite = currentlyActive ? visibleOnWebsite : false;
    }
    if (expiresAt !== undefined) update.expiresAt = expiresAt ? new Date(expiresAt) : null;
    const existing = await ctx.conn.db.collection("coupons").findOne({ _id: oid });
    if (!existing) { res.status(404).json({ error: "NotFound", message: "Coupon not found" }); return; }
    const result = await ctx.conn.db.collection("coupons").findOneAndUpdate({ _id: oid }, { $set: update }, { returnDocument: "after" });
    if (!result) { res.status(404).json({ error: "NotFound", message: "Coupon not found" }); return; }
    if (applicableProducts !== undefined) {
      const oldIds: string[] = (existing.applicableProducts ?? []).map((p: any) => String(p));
      const newIds: string[] = (Array.isArray(applicableProducts) ? applicableProducts : []).map((p: any) => String(p));
      const removedIds = oldIds.filter((id) => !newIds.includes(id)).map((id) => toId(id)).filter(Boolean);
      const addedIds = newIds.filter((id) => !oldIds.includes(id)).map((id) => toId(id)).filter(Boolean);
      if (removedIds.length > 0) {
        await ctx.conn.db.collection("products").updateMany(
          { _id: { $in: removedIds } },
          { $pull: { couponIds: oid } }
        );
      }
      if (addedIds.length > 0) {
        await ctx.conn.db.collection("products").updateMany(
          { _id: { $in: addedIds } },
          { $addToSet: { couponIds: oid } }
        );
      }
    }
    res.json({ coupon: result });
  } catch (err) {
    req.log.error({ err }, "Failed to update coupon");
    res.status(500).json({ error: "InternalError", message: "Failed to update coupon" });
  }
});

router.delete("/coupons/:couponId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const oid = toId(req.params.couponId);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid coupon ID" }); return; }
    const existing = await ctx.conn.db.collection("coupons").findOne({ _id: oid });
    if (existing) {
      const productOids = (existing.applicableProducts ?? []).map((p: any) => toId(String(p))).filter(Boolean);
      if (productOids.length > 0) {
        await ctx.conn.db.collection("products").updateMany(
          { _id: { $in: productOids } },
          { $pull: { couponIds: oid } }
        );
      }
    }
    await ctx.conn.db.collection("coupons").deleteOne({ _id: oid });
    res.json({ message: "Coupon deleted" });
  } catch (err) {
    req.log.error({ err }, "Failed to delete coupon");
    res.status(500).json({ error: "InternalError", message: "Failed to delete coupon" });
  }
});

// ─── COMBOS ───────────────────────────────────────────────────────────────────
router.get("/combos", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const combosCol = ctx.conn.db.collection("combos");
    const productsCol = ctx.conn.db.collection("products");
    const combos = await combosCol.find({}).sort({ sortOrder: 1, name: 1 }).toArray();

    // Sync each combo's isActive against current product stock.
    // A combo must be inactive if ANY of its constituent products has quantity <= 0.
    // Do not automatically activate combos again: an inactive combo may have
    // been disabled manually, and the list refresh must preserve that choice.
    const toDeactivate: any[] = [];

    for (const combo of combos) {
      const includes: any[] = Array.isArray(combo.includes) ? combo.includes : [];
      if (includes.length === 0) continue;

      // Collect all productIds (support both string and ObjectId storage)
      const productIds = includes.map((inc: any) => {
        const id = inc.productId;
        const oid = toId(String(id));
        return oid;
      }).filter(Boolean);

      if (productIds.length === 0) continue;

      const products = await productsCol
        .find({ _id: { $in: productIds } }, { projection: { quantity: 1 } })
        .toArray();

      const anyOutOfStock = products.some((p: any) => (Number(p.quantity) || 0) <= 0)
        || products.length < productIds.length; // some products missing entirely

      if (anyOutOfStock && combo.isActive) {
        toDeactivate.push(combo._id);
        combo.isActive = false;
      }
    }

    // Persist the synced statuses in bulk
    const now = new Date();
    if (toDeactivate.length > 0) {
      await combosCol.updateMany(
        { _id: { $in: toDeactivate } },
        { $set: { isActive: false, updatedAt: now } },
      );
    }
    res.json({ combos, total: combos.length });
  } catch (err) {
    req.log.error({ err }, "Failed to get combos");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch combos" });
  }
});

router.post("/combos", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const { name, description, fullDescription, serves, weight, imageUrl, discountedPrice, originalPrice, discount, includes, tags, nutrition, isActive, sortOrder, sectionId } = req.body;
    if (!name) { res.status(400).json({ error: "ValidationError", message: "Name is required" }); return; }
    const dp = Number(discountedPrice) || 0;
    const op = Number(originalPrice) || 0;
    const doc = {
      name,
      description: description ?? "",
      fullDescription: fullDescription ?? "",
      serves: serves ?? "",
      weight: weight ?? "",
      imageUrl: imageUrl ?? "",
      discountedPrice: dp,
      originalPrice: op,
      discount: Number(discount) || (op > dp && dp > 0 ? Math.round(((op - dp) / op) * 100) : 0),
      includes: Array.isArray(includes) ? includes : [],
      tags: Array.isArray(tags) ? tags : [],
      nutrition: Array.isArray(nutrition) ? nutrition : [],
      isActive: isActive !== false,
      sortOrder: Number(sortOrder) || 0,
      sectionId: normalizeIdList(sectionId),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await ctx.conn.db.collection("combos").insertOne(doc);
    res.status(201).json({ combo: { ...doc, _id: result.insertedId } });
  } catch (err) {
    req.log.error({ err }, "Failed to create combo");
    res.status(500).json({ error: "InternalError", message: "Failed to create combo" });
  }
});

router.put("/combos/reorder", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: "ValidationError", message: "items array required" }); return; }
    const ops = items.map(({ id, sortOrder }: { id: string; sortOrder: number }) => {
      const oid = toId(id);
      if (!oid) return null;
      return { updateOne: { filter: { _id: oid }, update: { $set: { sortOrder: Number(sortOrder), updatedAt: new Date() } } } };
    }).filter(Boolean);
    if (ops.length > 0) await ctx.conn.db.collection("combos").bulkWrite(ops as any);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to reorder combos");
    res.status(500).json({ error: "InternalError", message: "Failed to reorder combos" });
  }
});

router.put("/combos/:comboId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const oid = toId(req.params.comboId);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid combo ID" }); return; }
    const { name, description, fullDescription, serves, weight, imageUrl, discountedPrice, originalPrice, discount, includes, tags, nutrition, isActive, sortOrder, sectionId } = req.body;
    const update: any = { updatedAt: new Date() };
    if (name !== undefined) update.name = name;
    if (description !== undefined) update.description = description;
    if (fullDescription !== undefined) update.fullDescription = fullDescription;
    if (serves !== undefined) update.serves = serves;
    if (weight !== undefined) update.weight = weight;
    if (imageUrl !== undefined) update.imageUrl = String(imageUrl ?? "");
    if (discountedPrice !== undefined) update.discountedPrice = Number(discountedPrice) || 0;
    if (originalPrice !== undefined) update.originalPrice = Number(originalPrice) || 0;
    if (discount !== undefined) update.discount = Number(discount) || 0;
    if (includes !== undefined) update.includes = Array.isArray(includes) ? includes : [];
    if (tags !== undefined) update.tags = tags;
    if (nutrition !== undefined) update.nutrition = nutrition;
    if (isActive !== undefined) update.isActive = isActive;
    if (sortOrder !== undefined) update.sortOrder = Number(sortOrder) || 0;
    if (sectionId !== undefined) update.sectionId = normalizeIdList(sectionId);
    const result = await ctx.conn.db.collection("combos").findOneAndUpdate({ _id: oid }, { $set: update }, { returnDocument: "after" });
    if (!result) { res.status(404).json({ error: "NotFound", message: "Combo not found" }); return; }
    res.json({ combo: result });
  } catch (err) {
    req.log.error({ err }, "Failed to update combo");
    res.status(500).json({ error: "InternalError", message: "Failed to update combo" });
  }
});

router.delete("/combos/:comboId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const oid = toId(req.params.comboId);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid combo ID" }); return; }
    await ctx.conn.db.collection("combos").deleteOne({ _id: oid });
    res.json({ message: "Combo deleted" });
  } catch (err) {
    req.log.error({ err }, "Failed to delete combo");
    res.status(500).json({ error: "InternalError", message: "Failed to delete combo" });
  }
});

// ─── CAROUSELS ────────────────────────────────────────────────────────────────
router.get("/carousels", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const carousels = await ctx.conn.db.collection("carousels").find({}).sort({ order: 1 }).toArray();
    res.json({ carousels, total: carousels.length });
  } catch (err) {
    req.log.error({ err }, "Failed to get carousels");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch carousels" });
  }
});

router.post("/carousels", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const { imageUrl, title, linkUrl, order, isActive } = req.body;
    if (!imageUrl) { res.status(400).json({ error: "ValidationError", message: "Image URL is required" }); return; }
    const doc = {
      imageUrl,
      title: title ?? null,
      linkUrl: linkUrl ?? null,
      order: Number(order) || 0,
      isActive: isActive !== false,
    };
    const result = await ctx.conn.db.collection("carousels").insertOne(doc);
    res.status(201).json({ carousel: { ...doc, _id: result.insertedId } });
  } catch (err) {
    req.log.error({ err }, "Failed to create carousel");
    res.status(500).json({ error: "InternalError", message: "Failed to create carousel" });
  }
});

router.put("/carousels/reorder", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: "ValidationError", message: "items array required" }); return; }
    const ops = items.map(({ id, order }: { id: string; order: number }) => {
      const oid = toId(id);
      if (!oid) return null;
      return { updateOne: { filter: { _id: oid }, update: { $set: { order: Number(order) } } } };
    }).filter(Boolean);
    if (ops.length > 0) await ctx.conn.db.collection("carousels").bulkWrite(ops as any);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to reorder carousels");
    res.status(500).json({ error: "InternalError", message: "Failed to reorder carousels" });
  }
});

router.put("/carousels/:carouselId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const oid = toId(req.params.carouselId);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid carousel ID" }); return; }
    const { imageUrl, title, linkUrl, order, isActive } = req.body;
    const update: any = {};
    if (imageUrl !== undefined) update.imageUrl = imageUrl;
    if (title !== undefined) update.title = title || null;
    if (linkUrl !== undefined) update.linkUrl = linkUrl || null;
    if (order !== undefined) update.order = Number(order) || 0;
    if (isActive !== undefined) update.isActive = isActive;
    const result = await ctx.conn.db.collection("carousels").findOneAndUpdate({ _id: oid }, { $set: update }, { returnDocument: "after" });
    if (!result) { res.status(404).json({ error: "NotFound", message: "Carousel not found" }); return; }
    res.json({ carousel: result });
  } catch (err) {
    req.log.error({ err }, "Failed to update carousel");
    res.status(500).json({ error: "InternalError", message: "Failed to update carousel" });
  }
});

router.delete("/carousels/:carouselId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const oid = toId(req.params.carouselId);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid carousel ID" }); return; }
    await ctx.conn.db.collection("carousels").deleteOne({ _id: oid });
    res.json({ message: "Carousel deleted" });
  } catch (err) {
    req.log.error({ err }, "Failed to delete carousel");
    res.status(500).json({ error: "InternalError", message: "Failed to delete carousel" });
  }
});

// ─── SECTIONS ─────────────────────────────────────────────────────────────────
router.get("/sections", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const sections = await ctx.conn.db.collection("sections").find({}).sort({ sortOrder: 1 }).toArray();
    res.json({ sections, total: sections.length });
  } catch (err) {
    req.log.error({ err }, "Failed to get sections");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch sections" });
  }
});

router.post("/sections", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const { title, type, sortOrder, isActive } = req.body;
    if (!title) { res.status(400).json({ error: "ValidationError", message: "Title is required" }); return; }
    const doc = {
      title,
      type: type ?? "products",
      sortOrder: Number(sortOrder) || 0,
      isActive: isActive !== false,
    };
    const result = await ctx.conn.db.collection("sections").insertOne(doc);
    res.status(201).json({ section: { ...doc, _id: result.insertedId } });
  } catch (err) {
    req.log.error({ err }, "Failed to create section");
    res.status(500).json({ error: "InternalError", message: "Failed to create section" });
  }
});

router.put("/sections/reorder", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: "ValidationError", message: "items array required" }); return; }
    const ops = items.map(({ id, sortOrder }: { id: string; sortOrder: number }) => {
      const oid = toId(id);
      if (!oid) return null;
      return { updateOne: { filter: { _id: oid }, update: { $set: { sortOrder: Number(sortOrder) } } } };
    }).filter(Boolean);
    if (ops.length > 0) await ctx.conn.db.collection("sections").bulkWrite(ops as any);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to reorder sections");
    res.status(500).json({ error: "InternalError", message: "Failed to reorder sections" });
  }
});

router.put("/sections/:sectionId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const oid = toId(req.params.sectionId);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid section ID" }); return; }
    const { title, type, sortOrder, isActive } = req.body;
    const update: any = {};
    if (title !== undefined) update.title = title;
    if (type !== undefined) update.type = type;
    if (sortOrder !== undefined) update.sortOrder = Number(sortOrder) || 0;
    if (isActive !== undefined) update.isActive = isActive;
    const result = await ctx.conn.db.collection("sections").findOneAndUpdate({ _id: oid }, { $set: update }, { returnDocument: "after" });
    if (!result) { res.status(404).json({ error: "NotFound", message: "Section not found" }); return; }
    res.json({ section: result });
  } catch (err) {
    req.log.error({ err }, "Failed to update section");
    res.status(500).json({ error: "InternalError", message: "Failed to update section" });
  }
});

router.put("/sections/:sectionId/items", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const sectionOid = toId(req.params.sectionId);
    if (!sectionOid) { res.status(400).json({ error: "InvalidId", message: "Invalid section ID" }); return; }
    const { type, itemIds } = req.body;
    const col = type === "combos" ? "combos" : "products";
    const newOids = Array.isArray(itemIds) ? itemIds.map((id: any) => toId(String(id))).filter(Boolean) : [];
    await ctx.conn.db.collection(col).updateMany({ sectionId: sectionOid }, { $pull: { sectionId: sectionOid } } as any);
    if (newOids.length > 0) {
      await ctx.conn.db.collection(col).updateMany({ _id: { $in: newOids } }, { $addToSet: { sectionId: sectionOid } });
    }
    res.json({ ok: true, assigned: newOids.length });
  } catch (err) {
    req.log.error({ err }, "Failed to assign section items");
    res.status(500).json({ error: "InternalError", message: "Failed to assign section items" });
  }
});

router.delete("/sections/:sectionId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const oid = toId(req.params.sectionId);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid section ID" }); return; }
    await ctx.conn.db.collection("sections").deleteOne({ _id: oid });
    res.json({ message: "Section deleted" });
  } catch (err) {
    req.log.error({ err }, "Failed to delete section");
    res.status(500).json({ error: "InternalError", message: "Failed to delete section" });
  }
});

// ─── CITY / AREA SERVICE ZONES ────────────────────────────────────────────────
router.get("/city-areas", async (req, res) => {
  try {
    const ctx = await getSubHubDb(String((req.params as any).id ?? ""), res, req as ScopedRequest);
    if (!ctx) return;
    await ensureCityAreasInitialized(ctx.conn.db!);
    const cityAreas = await ctx.conn.db!.collection("city_areas")
      .find({ isActive: { $ne: false } })
      .sort({ name: 1 })
      .toArray();
    res.json({ cityAreas, total: cityAreas.length });
  } catch (err) {
    req.log.error({ err }, "Failed to get city/area service zones");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch city/area service zones" });
  }
});

router.put("/city-areas", async (req, res) => {
  try {
    const ctx = await getSubHubDb(String((req.params as any).id ?? ""), res, req as ScopedRequest);
    if (!ctx) return;
    await ensureCityAreasInitialized(ctx.conn.db!);
    if (!Array.isArray(req.body?.cityAreas)) {
      res.status(400).json({ error: "ValidationError", message: "City/area entries must be an array" });
      return;
    }

    const seen = new Set<string>();
    const cityAreas: Array<{ name: string; nameKey: string; charge: number }> = [];
    for (const item of req.body.cityAreas) {
      const name = String(item?.name ?? "").trim();
      const charge = Number(item?.charge);
      const nameKey = name.toLocaleLowerCase("en-IN");
      if (!name) {
        res.status(400).json({ error: "ValidationError", message: "Every city/area must have a name" });
        return;
      }
      if (!Number.isFinite(charge) || charge < 0) {
        res.status(400).json({ error: "ValidationError", message: `Charge for ${name} must be a non-negative number` });
        return;
      }
      if (seen.has(nameKey)) {
        res.status(400).json({ error: "Duplicate", message: `${name} appears more than once` });
        return;
      }
      seen.add(nameKey);
      cityAreas.push({ name, nameKey, charge });
    }

    const collection = ctx.conn.db!.collection("city_areas");
    const now = new Date();
    if (cityAreas.length > 0) {
      await collection.bulkWrite(cityAreas.map((entry) => ({
        updateOne: {
          filter: { nameKey: entry.nameKey },
          update: {
            $set: { ...entry, isActive: true, updatedAt: now },
            $setOnInsert: { createdAt: now },
          },
          upsert: true,
        },
      })), { ordered: true });
      await collection.deleteMany({ nameKey: { $nin: cityAreas.map((entry) => entry.nameKey) } });
    } else {
      await collection.deleteMany({});
    }

    const saved = await collection.find({ isActive: { $ne: false } }).sort({ name: 1 }).toArray();
    res.json({ cityAreas: saved, total: saved.length });
  } catch (err) {
    req.log.error({ err }, "Failed to save city/area service zones");
    res.status(500).json({ error: "InternalError", message: "Failed to save city/area service zones" });
  }
});

// ─── PINCODES ─────────────────────────────────────────────────────────────────
router.get("/pincodes", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const pincodes = await ctx.conn.db.collection("pincodes").find({}).sort({ pincode: 1 }).toArray();
    res.json({ pincodes, total: pincodes.length });
  } catch (err) {
    req.log.error({ err }, "Failed to get pincodes");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch pincodes" });
  }
});

// Save the service-area list to the selected sub-hub database. The admin UI
// edits the list locally, so this endpoint reconciles additions, edits, and
// removals against the same collection used by GET /pincodes.
router.put("/pincodes", async (req, res) => {
  try {
    const ctx = await getSubHubDb(String((req.params as any).id ?? ""), res, req as ScopedRequest);
    if (!ctx) return;

    if (!Array.isArray(req.body?.pincodes)) {
      res.status(400).json({ error: "ValidationError", message: "Pincodes must be an array" });
      return;
    }

    const seen = new Set<string>();
    const pincodes: Array<{ pincode: string; charge: number; timeDelay: number }> = [];
    for (const item of req.body.pincodes) {
      const pincode = String(item?.pincode ?? "").trim();
      const charge = Number(item?.charge ?? 0);
      const timeDelay = Number(item?.timeDelay ?? 0);
      if (!pincode) {
        res.status(400).json({ error: "ValidationError", message: "Every pincode must have a value" });
        return;
      }
      if (seen.has(pincode)) {
        res.status(400).json({ error: "Duplicate", message: `Pincode ${pincode} appears more than once` });
        return;
      }
      if (!Number.isFinite(charge) || charge < 0 || !Number.isFinite(timeDelay) || timeDelay < 0) {
        res.status(400).json({ error: "ValidationError", message: "Charge and time delay must be valid non-negative numbers" });
        return;
      }
      seen.add(pincode);
      pincodes.push({ pincode, charge, timeDelay });
    }

    const db = ctx.conn.db;
    if (!db) throw new Error("Sub-hub database connection is unavailable");
    const collection = db.collection("pincodes");
    const now = new Date();
    const operations: any[] = pincodes.map((entry) => ({
      updateOne: {
        filter: { pincode: entry.pincode },
        update: {
          $set: { ...entry, updatedAt: now },
          $setOnInsert: { createdAt: now, area: "", city: "", isActive: true },
        },
        upsert: true,
      },
    }));
    if (pincodes.length > 0) {
      operations.push({ deleteMany: { filter: { pincode: { $nin: pincodes.map((entry) => entry.pincode) } } } });
      await collection.bulkWrite(operations, { ordered: true });
    } else {
      await collection.deleteMany({});
    }

    const saved = await collection.find({}).sort({ pincode: 1 }).toArray();
    res.json({ pincodes: saved, total: saved.length });
  } catch (err) {
    req.log.error({ err }, "Failed to save pincodes");
    res.status(500).json({ error: "InternalError", message: "Failed to save service areas" });
  }
});

router.post("/pincodes", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const { pincode, area, city, isActive } = req.body;
    if (!pincode) { res.status(400).json({ error: "ValidationError", message: "Pincode is required" }); return; }
    const existing = await ctx.conn.db.collection("pincodes").findOne({ pincode });
    if (existing) { res.status(400).json({ error: "Duplicate", message: "Pincode already exists" }); return; }
    const doc = {
      pincode: String(pincode),
      area: area ?? "",
      city: city ?? "",
      isActive: isActive !== false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await ctx.conn.db.collection("pincodes").insertOne(doc);
    res.status(201).json({ pincode: { ...doc, _id: result.insertedId } });
  } catch (err) {
    req.log.error({ err }, "Failed to create pincode");
    res.status(500).json({ error: "InternalError", message: "Failed to create pincode" });
  }
});

router.put("/pincodes/:pincodeId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const oid = toId(req.params.pincodeId);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid pincode ID" }); return; }
    const { pincode, area, city, isActive } = req.body;
    const update: any = { updatedAt: new Date() };
    if (pincode !== undefined) update.pincode = String(pincode);
    if (area !== undefined) update.area = area;
    if (city !== undefined) update.city = city;
    if (isActive !== undefined) update.isActive = isActive;
    const result = await ctx.conn.db.collection("pincodes").findOneAndUpdate({ _id: oid }, { $set: update }, { returnDocument: "after" });
    if (!result) { res.status(404).json({ error: "NotFound", message: "Pincode not found" }); return; }
    res.json({ pincode: result });
  } catch (err) {
    req.log.error({ err }, "Failed to update pincode");
    res.status(500).json({ error: "InternalError", message: "Failed to update pincode" });
  }
});

router.delete("/pincodes/:pincodeId", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const oid = toId(req.params.pincodeId);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid pincode ID" }); return; }
    await ctx.conn.db.collection("pincodes").deleteOne({ _id: oid });
    res.json({ message: "Pincode deleted" });
  } catch (err) {
    req.log.error({ err }, "Failed to delete pincode");
    res.status(500).json({ error: "InternalError", message: "Failed to delete pincode" });
  }
});

// ─── TIMESLOTS ─────────────────────────────────────────────────────────────────

/** Returns today's date in YYYY-MM-DD format using IST (UTC+5:30). */
function getTimeslotTodayISO(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Returns the current day of week in IST (0=Sunday … 6=Saturday). */
function getISTDayOfWeek(): number {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCDay();
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

/** Convert active day indices → full 7-element {day, status} array for DB storage */
function toDayStatusArray(activeNums: number[]): { day: string; status: "on" | "off" }[] {
  return DAY_NAMES.map((day, i) => ({ day, status: activeNums.includes(i) ? "on" : "off" }));
}

/** Convert {day, status}[] → active day index numbers for runtime checks */
function dayStatusToNumbers(arr: { day: string; status: string }[]): number[] {
  return arr
    .filter((item) => item.status === "on")
    .map((item) => DAY_NAMES.indexOf(item.day as any))
    .filter((n) => n >= 0)
    .sort((a, b) => a - b);
}

/** Normalise activeDays from DB — handles both legacy number[] and new {day,status}[] */
function normalizeActiveDays(raw: any[]): { numbers: number[]; objects: { day: string; status: "on" | "off" }[] } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { numbers: ALL_DAYS, objects: toDayStatusArray(ALL_DAYS) };
  }
  if (typeof raw[0] === "object" && raw[0] !== null && "day" in raw[0]) {
    // Already new format — respect stored values, including a legitimate all-off state.
    // Only fall back to ALL_DAYS for truly missing data (handled above).
    const numbers = dayStatusToNumbers(raw);
    return { numbers, objects: toDayStatusArray(numbers) };
  }
  // Legacy: array of numbers
  const numbers = (raw as any[]).map(Number).filter((d) => d >= 0 && d <= 6);
  const resolved = numbers.length > 0 ? numbers : ALL_DAYS;
  return { numbers: resolved, objects: toDayStatusArray(resolved) };
}

/** Returns tomorrow's date in YYYY-MM-DD format using IST (UTC+5:30). */
function getTimeslotTomorrowISO(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  ist.setUTCDate(ist.getUTCDate() + 1);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

router.get("/timeslots", requireTimeslotsEnabled, async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const requestedDate = typeof req.query.deliveryDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.deliveryDate)
      ? req.query.deliveryDate
      : "";
    const timeslots = await ctx.conn.db.collection("timeslots").find({}).sort({ sortOrder: 1, startTime: 1 }).toArray();

    if (timeslots.length > 0) {
      const todayISO = getTimeslotTodayISO();
      const tomorrowISO = getTimeslotTomorrowISO();
      const countDates = requestedDate ? [requestedDate] : [todayISO, tomorrowISO];
      const timeslotIdStrs = timeslots.map((t: any) => String(t._id));
      try {
        const ordersConn = await getSubHubDbConnection("orders");
        const countsAgg = await ordersConn.db.collection("orders").aggregate([
          {
            $match: {
              timeslotId: { $in: timeslotIdStrs },
              scheduleType: "slot",
              deliveryDate: { $in: countDates },
              status: { $ne: "cancelled" },
            },
          },
          {
            $group: {
              _id: { timeslotId: "$timeslotId", deliveryDate: "$deliveryDate" },
              count: { $sum: 1 },
            },
          },
        ]).toArray();

        const countMap = new Map<string, Record<string, number>>();
        for (const row of countsAgg as any[]) {
          const tid = String(row._id.timeslotId);
          const date = String(row._id.deliveryDate);
          if (!countMap.has(tid)) countMap.set(tid, {});
          const entry = countMap.get(tid)!;
          entry[date] = Number(row.count) || 0;
        }

        for (const slot of timeslots as any[]) {
          const counts = countMap.get(String(slot._id)) ?? {};
          slot.todaysOrderCount = counts[todayISO] ?? 0;
          slot.nextDayOrderCount = counts[tomorrowISO] ?? 0;
          if (requestedDate) slot.orderCountForDate = counts[requestedDate] ?? 0;
          delete slot.todaysOrderDate;
          delete slot.nextDayOrderDate;
        }

        // Persist computed counts back to MongoDB so the DB reflects reality.
        const bulkOps = (timeslots as any[]).map((slot) => ({
          updateOne: {
            filter: { _id: new mongoose.Types.ObjectId(slot._id) },
            update: {
              $set: {
                todaysOrderCount: slot.todaysOrderCount,
                nextDayOrderCount: slot.nextDayOrderCount,
              },
              $unset: { todaysOrderDate: "", nextDayOrderDate: "" },
            },
          },
        }));
        await ctx.conn.db.collection("timeslots").bulkWrite(bulkOps, { ordered: false });
      } catch (e) {
        req.log.warn({ err: e }, "Failed to compute timeslot order counts (non-fatal)");
        for (const slot of timeslots as any[]) {
          slot.todaysOrderCount = slot.todaysOrderCount ?? 0;
          slot.nextDayOrderCount = slot.nextDayOrderCount ?? 0;
          if (requestedDate) slot.orderCountForDate = slot.orderCountForDate ?? 0;
          delete slot.todaysOrderDate;
          delete slot.nextDayOrderDate;
        }
      }
    }

    // Compute effectiveIsActive: manualIsActive AND today's day is in activeDays.
    const todayDow = getISTDayOfWeek();
    const migrationOps: any[] = [];
    for (const slot of timeslots as any[]) {
      const raw = slot.activeDays;
      const isLegacy = !Array.isArray(raw) || raw.length === 0 || typeof raw[0] === "number";
      const { numbers, objects } = normalizeActiveDays(raw);
      const dayAllowed = numbers.includes(todayDow);
      slot.effectiveIsActive = (slot.isActive !== false) && dayAllowed;
      slot.activeDays = objects;
      // Migrate legacy number-array records to new {day, status} format
      if (isLegacy) {
        migrationOps.push({
          updateOne: { filter: { _id: new mongoose.Types.ObjectId(slot._id) }, update: { $set: { activeDays: objects } } },
        });
      }
    }
    if (migrationOps.length > 0) {
      ctx.conn.db.collection("timeslots").bulkWrite(migrationOps, { ordered: false }).catch(() => {});
    }

    res.json({ timeslots, total: timeslots.length });
  } catch (err) {
    req.log.error({ err }, "Failed to get timeslots");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch timeslots" });
  }
});

router.post("/timeslots", requireTimeslotsEnabled, async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const { label, startTime, endTime, isInstant, extraCharge, isActive, sortOrder, orderLimit, activeDays } = req.body;
    if (!startTime || !endTime) { res.status(400).json({ error: "ValidationError", message: "Start time and end time are required" }); return; }
    const resolvedLabel = label && String(label).trim() ? String(label).trim() : `${startTime} - ${endTime}`;
    const { numbers: resolvedDayNums } = normalizeActiveDays(Array.isArray(activeDays) ? activeDays : []);
    const doc = {
      label: resolvedLabel,
      startTime,
      endTime,
      isInstant: isInstant === true,
      extraCharge: Number(extraCharge) || 0,
      isActive: isActive !== false,
      sortOrder: Number(sortOrder) || 0,
      orderLimit: Number(orderLimit) || 0,
      activeDays: toDayStatusArray(resolvedDayNums),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await ctx.conn.db.collection("timeslots").insertOne(doc);
    res.status(201).json({ timeslot: { ...doc, _id: result.insertedId } });
  } catch (err) {
    req.log.error({ err }, "Failed to create timeslot");
    res.status(500).json({ error: "InternalError", message: "Failed to create timeslot" });
  }
});

router.put("/timeslots/reorder", requireTimeslotsEnabled, async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: "ValidationError", message: "items array required" }); return; }
    const ops = items.map(({ id, sortOrder }: { id: string; sortOrder: number }) => {
      const oid = toId(id);
      if (!oid) return null;
      return { updateOne: { filter: { _id: oid }, update: { $set: { sortOrder: Number(sortOrder), updatedAt: new Date() } } } };
    }).filter(Boolean);
    if (ops.length > 0) await ctx.conn.db.collection("timeslots").bulkWrite(ops as any);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to reorder timeslots");
    res.status(500).json({ error: "InternalError", message: "Failed to reorder timeslots" });
  }
});

router.put("/timeslots/:timeslotId", requireTimeslotsEnabled, async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const oid = toId(req.params.timeslotId);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid timeslot ID" }); return; }
    const { label, startTime, endTime, isInstant, extraCharge, isActive, sortOrder, orderLimit, activeDays } = req.body;
    const update: any = { updatedAt: new Date() };
    if (label !== undefined) update.label = label;
    if (startTime !== undefined) update.startTime = startTime;
    if (endTime !== undefined) update.endTime = endTime;
    if (isInstant !== undefined) update.isInstant = isInstant === true;
    if (extraCharge !== undefined) update.extraCharge = Number(extraCharge) || 0;
    if (isActive !== undefined) {
      update.isActive = isActive;
      // If admin manually changes isActive, clear the auto-limit flag
      update.limitedByOrders = false;
    }
    if (sortOrder !== undefined) update.sortOrder = Number(sortOrder) || 0;
    if (orderLimit !== undefined) update.orderLimit = Number(orderLimit) || 0;
    if (activeDays !== undefined) {
      const { numbers: dayNums } = normalizeActiveDays(Array.isArray(activeDays) ? activeDays : []);
      update.activeDays = toDayStatusArray(dayNums);
    }
    const result = await ctx.conn.db.collection("timeslots").findOneAndUpdate({ _id: oid }, { $set: update }, { returnDocument: "after" });
    if (!result) { res.status(404).json({ error: "NotFound", message: "Timeslot not found" }); return; }
    res.json({ timeslot: result });
  } catch (err) {
    req.log.error({ err }, "Failed to update timeslot");
    res.status(500).json({ error: "InternalError", message: "Failed to update timeslot" });
  }
});

router.delete("/timeslots/:timeslotId", requireTimeslotsEnabled, async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const oid = toId(req.params.timeslotId);
    if (!oid) { res.status(400).json({ error: "InvalidId", message: "Invalid timeslot ID" }); return; }
    await ctx.conn.db.collection("timeslots").deleteOne({ _id: oid });
    res.json({ message: "Timeslot deleted" });
  } catch (err) {
    req.log.error({ err }, "Failed to delete timeslot");
    res.status(500).json({ error: "InternalError", message: "Failed to delete timeslot" });
  }
});

// ─── BULK UPSERTS ─────────────────────────────────────────────────────────────

router.post("/categories/bulk-upsert", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const rows: any[] = Array.isArray(req.body.items) ? req.body.items : [];
    if (rows.length === 0) { res.status(400).json({ error: "ValidationError", message: "No items provided" }); return; }
    let created = 0, updated = 0; const errors: string[] = [];
    for (const row of rows) {
      try {
        const subCats = row.subCategories ? String(row.subCategories).split("|").map((s: string) => ({ name: s.trim() })).filter((s: any) => s.name) : undefined;
        const fields: any = { name: row.name ?? "", imageUrl: row.imageUrl ?? "", isActive: String(row.isActive ?? "yes").toLowerCase() !== "no", sortOrder: Number(row.sortOrder) || 0, updatedAt: new Date() };
        if (subCats !== undefined) fields.subCategories = subCats;
        if (!fields.name) { errors.push("Skipped: missing name"); continue; }
        const oid = row._id ? toId(String(row._id)) : null;
        if (oid) { await ctx.conn.db.collection("categories").updateOne({ _id: oid }, { $set: fields }); updated++; }
        else { await ctx.conn.db.collection("categories").insertOne({ ...fields, createdAt: new Date() }); created++; }
      } catch (e: any) { errors.push(e.message); }
    }
    res.json({ created, updated, errors });
  } catch (err) { req.log.error({ err }, "categories bulk-upsert failed"); res.status(500).json({ error: "InternalError", message: "Failed" }); }
});

router.post("/combos/bulk-upsert", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const rows: any[] = Array.isArray(req.body.items) ? req.body.items : [];
    if (rows.length === 0) { res.status(400).json({ error: "ValidationError", message: "No items provided" }); return; }
    let created = 0, updated = 0; const errors: string[] = [];
    for (const row of rows) {
      try {
        const dp = Number(row.discountedPrice ?? row.salePrice) || 0;
        const op = Number(row.originalPrice ?? row.mrp) || dp;
        const fields: any = {
          name: row.name ?? "", description: row.description ?? "", fullDescription: row.fullDescription ?? "",
          serves: row.serves ?? "", weight: row.weight ?? "",
          discountedPrice: dp, originalPrice: op,
          discount: Number(row.discount) || (op > dp && dp > 0 ? Math.round(((op - dp) / op) * 100) : 0),
          includes: row.includes ? String(row.includes).split("|").map((s: string) => s.trim()).filter(Boolean) : [],
          tags: row.tags ? String(row.tags).split("|").map((s: string) => s.trim()).filter(Boolean) : [],
          isActive: String(row.isActive ?? "yes").toLowerCase() !== "no",
          sortOrder: Number(row.sortOrder) || 0, updatedAt: new Date(),
        };
        if (!fields.name) { errors.push("Skipped: missing name"); continue; }
        const oid = row._id ? toId(String(row._id)) : null;
        if (oid) { await ctx.conn.db.collection("combos").updateOne({ _id: oid }, { $set: fields }); updated++; }
        else { await ctx.conn.db.collection("combos").insertOne({ ...fields, createdAt: new Date() }); created++; }
      } catch (e: any) { errors.push(e.message); }
    }
    res.json({ created, updated, errors });
  } catch (err) { req.log.error({ err }, "combos bulk-upsert failed"); res.status(500).json({ error: "InternalError", message: "Failed" }); }
});

router.post("/coupons/bulk-upsert", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const rows: any[] = Array.isArray(req.body.items) ? req.body.items : [];
    if (rows.length === 0) { res.status(400).json({ error: "ValidationError", message: "No items provided" }); return; }
    let created = 0, updated = 0; const errors: string[] = [];
    for (const row of rows) {
      try {
        const code = String(row.code ?? "").toUpperCase().trim();
        if (!code) { errors.push("Skipped: missing code"); continue; }
        const fields: any = {
          code, title: row.title ?? "", description: row.description ?? "",
          type: row.type === "flat" ? "flat" : "percentage",
          discountValue: Number(row.discountValue) || 0,
          minOrderAmount: Number(row.minOrderAmount) || 0,
          maxUsage: row.maxUsage ? Number(row.maxUsage) : null,
          isFirstTimeOnly: String(row.isFirstTimeOnly ?? "no").toLowerCase() === "yes",
          isActive: String(row.isActive ?? "yes").toLowerCase() !== "no",
          expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
          updatedAt: new Date(),
        };
        const oid = row._id ? toId(String(row._id)) : null;
        if (oid) { await ctx.conn.db.collection("coupons").updateOne({ _id: oid }, { $set: fields }); updated++; }
        else {
          const existing = await ctx.conn.db.collection("coupons").findOne({ code: { $regex: `^${code}$`, $options: "i" } });
          if (existing) { await ctx.conn.db.collection("coupons").updateOne({ _id: existing._id }, { $set: fields }); updated++; }
          else { await ctx.conn.db.collection("coupons").insertOne({ ...fields, applicableCategories: [], applicableProducts: [], createdAt: new Date() }); created++; }
        }
      } catch (e: any) { errors.push(e.message); }
    }
    res.json({ created, updated, errors });
  } catch (err) { req.log.error({ err }, "coupons bulk-upsert failed"); res.status(500).json({ error: "InternalError", message: "Failed" }); }
});

router.post("/sections/bulk-upsert", async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const rows: any[] = Array.isArray(req.body.items) ? req.body.items : [];
    if (rows.length === 0) { res.status(400).json({ error: "ValidationError", message: "No items provided" }); return; }
    let created = 0, updated = 0; const errors: string[] = [];
    for (const row of rows) {
      try {
        const fields: any = { title: row.title ?? "", type: row.type ?? "products", sortOrder: Number(row.sortOrder) || 0, isActive: String(row.isActive ?? "yes").toLowerCase() !== "no", updatedAt: new Date() };
        if (!fields.title) { errors.push("Skipped: missing title"); continue; }
        const oid = row._id ? toId(String(row._id)) : null;
        if (oid) { await ctx.conn.db.collection("sections").updateOne({ _id: oid }, { $set: fields }); updated++; }
        else { await ctx.conn.db.collection("sections").insertOne({ ...fields, createdAt: new Date() }); created++; }
      } catch (e: any) { errors.push(e.message); }
    }
    res.json({ created, updated, errors });
  } catch (err) { req.log.error({ err }, "sections bulk-upsert failed"); res.status(500).json({ error: "InternalError", message: "Failed" }); }
});

router.post("/timeslots/bulk-upsert", requireTimeslotsEnabled, async (req, res) => {
  try {
    const ctx = await getSubHubDb(req.params.id, res, req as ScopedRequest);
    if (!ctx) return;
    const rows: any[] = Array.isArray(req.body.items) ? req.body.items : [];
    if (rows.length === 0) { res.status(400).json({ error: "ValidationError", message: "No items provided" }); return; }
    let created = 0, updated = 0; const errors: string[] = [];
    for (const row of rows) {
      try {
        const fields: any = {
          label: row.label ?? "", startTime: row.startTime ?? "", endTime: row.endTime ?? "",
          isInstant: String(row.isInstant ?? "no").toLowerCase() === "yes",
          extraCharge: Number(row.extraCharge) || 0,
          isActive: String(row.isActive ?? "yes").toLowerCase() !== "no",
          sortOrder: Number(row.sortOrder) || 0,
          orderLimit: Number(row.orderLimit) || 0,
          updatedAt: new Date(),
        };
        if (!fields.label || !fields.startTime || !fields.endTime) { errors.push("Skipped: missing label/startTime/endTime"); continue; }
        const oid = row._id ? toId(String(row._id)) : null;
        if (oid) { await ctx.conn.db.collection("timeslots").updateOne({ _id: oid }, { $set: fields }); updated++; }
        else { await ctx.conn.db.collection("timeslots").insertOne({ ...fields, createdAt: new Date() }); created++; }
      } catch (e: any) { errors.push(e.message); }
    }
    res.json({ created, updated, errors });
  } catch (err) { req.log.error({ err }, "timeslots bulk-upsert failed"); res.status(500).json({ error: "InternalError", message: "Failed" }); }
});

export default router;
