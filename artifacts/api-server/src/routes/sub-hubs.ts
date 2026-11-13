import { Router, type IRouter } from "express";
import { SubHub } from "../db/models/sub-hub.js";
import { SuperHub } from "../db/models/super-hub.js";
import { requireAuth } from "../middlewares/auth.js";
import {
  loadScope,
  toObjectIds,
  canAccessSubHub,
  rejectIfNotMaster,
  type ScopedRequest,
} from "../middlewares/scope.js";
import { dropSubHubDb } from "../db/sub-hub-connections.js";
import { getSubHubDbConnection } from "../db/sub-hub-connections.js";
import { ensureCityAreasInitialized } from "../services/city-areas.mjs";

const router: IRouter = Router();
router.use(requireAuth as any);
router.use(loadScope as any);

function subHubToJson(sub: any, superHubName: string) {
  return {
    id: String(sub._id),
    superHubId: String(sub.superHubId),
    superHubName,
    name: sub.name,
    location: sub.location,
    imageUrl: sub.imageUrl ?? "",
    pincodes: sub.pincodes,
    status: sub.status,
    dbName: sub.dbName ?? "",
    createdAt: sub.createdAt,
  };
}

router.get("/", async (req: ScopedRequest, res) => {
  try {
    const scope = req.scope!;
    const filter = scope.isMaster
      ? {}
      : { _id: { $in: toObjectIds(scope.subHubIds) } };

    const subs = await SubHub.find(filter).sort({ createdAt: 1 });
    const superHubIds = [...new Set(subs.map((s) => String(s.superHubId)))];
    const superHubs = await SuperHub.find({ _id: { $in: superHubIds } });
    const superHubMap: Record<string, string> = {};
    for (const sh of superHubs) superHubMap[String(sh._id)] = sh.name;
    res.json({ subHubs: subs.map((sub) => subHubToJson(sub, superHubMap[String(sub.superHubId)] ?? "")), total: subs.length });
  } catch (err) {
    req.log.error({ err }, "Failed to get all sub hubs");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch sub hubs" });
  }
});

router.get("/city-area-options", async (req: ScopedRequest, res) => {
  try {
    const scope = req.scope!;
    const filter: any = { status: "Active", dbName: { $ne: "" } };
    if (!scope.isMaster) filter._id = { $in: toObjectIds(scope.subHubIds) };
    const subs = await SubHub.find(filter).select("_id dbName").lean();
    const values = await Promise.all(subs.map(async (sub: any) => {
      try {
        const conn = await getSubHubDbConnection(String(sub.dbName));
        await ensureCityAreasInitialized(conn.db!);
        return await conn.db!.collection("city_areas")
          .find({ isActive: { $ne: false } })
          .project({ name: 1 })
          .toArray();
      } catch (err) {
        req.log.warn({ err, subHubId: String(sub._id) }, "Could not load city/area options for sub-hub");
        return [];
      }
    }));
    const cityAreas = [...new Set(values.flat().map((item: any) => String(item.name ?? "").trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "en-IN"));
    res.json({ cityAreas });
  } catch (err) {
    req.log.error({ err }, "Failed to load city/area options");
    res.status(500).json({ error: "InternalError", message: "Failed to load city/area options" });
  }
});

router.put("/:id", async (req: ScopedRequest, res) => {
  if (rejectIfNotMaster(req.scope, res)) return;
  try {
    const sub = await SubHub.findById(req.params.id);
    if (!sub) { res.status(404).json({ error: "NotFound", message: "Sub hub not found" }); return; }
    const { name, location, pincodes, status, imageUrl, dbName } = req.body;
    if (name !== undefined) sub.name = name;
    if (location !== undefined) sub.location = location;
    if (pincodes !== undefined) sub.pincodes = pincodes;
    if (status !== undefined) sub.status = status;
    if (imageUrl !== undefined) sub.imageUrl = imageUrl;
    if (dbName !== undefined) {
      const trimmed = String(dbName).trim();
      if (trimmed && trimmed !== sub.dbName) {
        const duplicate = await SubHub.findOne({ dbName: trimmed, _id: { $ne: sub._id } });
        if (duplicate) {
          res.status(400).json({ error: "DuplicateDb", message: `Database name "${trimmed}" is already in use by another sub hub.` });
          return;
        }
      }
      sub.dbName = trimmed;
    }
    await sub.save();
    const superHub = await SuperHub.findById(sub.superHubId);
    res.json({ subHub: subHubToJson(sub, superHub?.name ?? "") });
  } catch (err) {
    req.log.error({ err }, "Failed to update sub hub");
    res.status(500).json({ error: "InternalError", message: "Failed to update sub hub" });
  }
});

router.delete("/:id", async (req: ScopedRequest, res) => {
  if (rejectIfNotMaster(req.scope, res)) return;
  try {
    const sub = await SubHub.findById(req.params.id);
    if (!sub) { res.status(404).json({ error: "NotFound", message: "Sub hub not found" }); return; }
    await SubHub.findByIdAndDelete(req.params.id);
    if (sub.dbName) {
      await dropSubHubDb(sub.dbName);
    }
    res.json({ message: "Sub hub deleted successfully" });
  } catch (err) {
    req.log.error({ err }, "Failed to delete sub hub");
    res.status(500).json({ error: "InternalError", message: "Failed to delete sub hub" });
  }
});

router.patch("/:id/toggle-status", async (req: ScopedRequest, res) => {
  if (rejectIfNotMaster(req.scope, res)) return;
  try {
    const sub = await SubHub.findById(req.params.id);
    if (!sub) { res.status(404).json({ error: "NotFound", message: "Sub hub not found" }); return; }
    sub.status = sub.status === "Active" ? "Inactive" : "Active";
    await sub.save();
    const superHub = await SuperHub.findById(sub.superHubId);
    res.json({ subHub: subHubToJson(sub, superHub?.name ?? "") });
  } catch (err) {
    req.log.error({ err }, "Failed to toggle sub hub status");
    res.status(500).json({ error: "InternalError", message: "Failed to toggle status" });
  }
});

// Re-export so the sub-hub-menu router can also call canAccessSubHub
export { canAccessSubHub };
export default router;
