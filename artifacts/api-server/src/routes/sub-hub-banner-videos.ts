import { Router, type IRouter } from "express";
import multer from "multer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SubHub } from "../db/models/sub-hub.js";
import { getSubHubDbConnection } from "../db/sub-hub-connections.js";
import { requireAuth } from "../middlewares/auth.js";
import { loadScope, type ScopedRequest } from "../middlewares/scope.js";
import {
  BANNER_VIDEO_DIRECTORY_SETTING_ID,
  BANNER_VIDEO_EXTENSIONS,
  ensureVideoDirectory,
  listVideoFiles,
  normalizeVideoDirectory,
  resolveManagedVideoFile,
  sanitizeUploadedVideoFilename,
  validateVideoFilename,
} from "../services/banner-video-storage.mjs";

const router: IRouter = Router({ mergeParams: true });
router.use(requireAuth as any);
router.use(loadScope as any);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, os.tmpdir()),
    filename: (_req, _file, callback) => callback(null, `banner-video-${randomUUID()}.upload`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith("video/") && BANNER_VIDEO_EXTENSIONS.has(extension)) {
      callback(null, true);
      return;
    }
    callback(new Error("Upload a supported video file (MP4, MOV, WebM, or another supported video format)."));
  },
});

async function getSubHubVideoContext(req: ScopedRequest, res: any) {
  const subHub = await SubHub.findById(String(req.params.id));
  if (!subHub) {
    res.status(404).json({ error: "NotFound", message: "Sub hub not found" });
    return null;
  }

  const scope = req.scope;
  if (scope && !scope.isMaster) {
    const subHubId = String(subHub._id);
    const superHubId = subHub.superHubId ? String(subHub.superHubId) : "";
    if (!scope.subHubIds.includes(subHubId) && !(superHubId && scope.superHubIds.includes(superHubId))) {
      res.status(404).json({ error: "NotFound", message: "Sub hub not found" });
      return null;
    }
  }

  if (!subHub.dbName) {
    res.status(400).json({ error: "NoDB", message: "This sub hub has no database linked." });
    return null;
  }
  const connection = await getSubHubDbConnection(subHub.dbName);
  return { db: connection.db!, subHub };
}

async function getConfiguredDirectory(db: any): Promise<string> {
  const setting = await db.collection("menu_settings").findOne({ _id: BANNER_VIDEO_DIRECTORY_SETTING_ID });
  return typeof setting?.directory === "string" ? setting.directory : "";
}

function requireMasterAdmin(req: ScopedRequest, res: any): boolean {
  if (req.admin?.role !== "master_admin") {
    res.status(403).json({ error: "Forbidden", message: "Only a Master Admin can change the VPS video directory." });
    return false;
  }
  return true;
}

function handleMulterUpload(req: any, res: any, next: any) {
  upload.single("video")(req, res, (error: any) => {
    if (error) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      res.status(status).json({ error: "UploadError", message: error.message || "Video upload failed." });
      return;
    }
    next();
  });
}

async function moveUploadIntoDirectory(sourcePath: string, targetPath: string, replace: boolean) {
  const directory = path.dirname(targetPath);
  const stagingPath = path.join(directory, `.banner-video-${randomUUID()}.tmp`);
  try {
    try {
      await fs.rename(sourcePath, stagingPath);
    } catch (error: any) {
      if (error?.code !== "EXDEV") throw error;
      await fs.copyFile(sourcePath, stagingPath);
      await fs.unlink(sourcePath);
    }

    if (!replace) {
      try {
        await fs.link(stagingPath, targetPath);
        await fs.unlink(stagingPath);
      } catch (error: any) {
        if (error?.code === "EEXIST") {
          throw Object.assign(new Error("A video with this filename already exists. Use Replace to overwrite it."), { code: "EEXIST" });
        }
        throw error;
      }
    } else {
      await fs.rename(stagingPath, targetPath);
    }
  } finally {
    await fs.unlink(stagingPath).catch(() => undefined);
    await fs.unlink(sourcePath).catch(() => undefined);
  }
}

router.get("/", async (req: ScopedRequest, res) => {
  try {
    const ctx = await getSubHubVideoContext(req, res);
    if (!ctx) return;
    const directory = await getConfiguredDirectory(ctx.db);
    const files = directory ? await listVideoFiles(directory) : [];
    res.json({ directory, files, total: files.length });
  } catch (err: any) {
    req.log.error({ err }, "Failed to list banner videos");
    res.status(500).json({ error: "StorageError", message: err.message || "Could not read the configured video directory." });
  }
});

router.put("/directory", async (req: ScopedRequest, res) => {
  if (!requireMasterAdmin(req, res)) return;
  try {
    const ctx = await getSubHubVideoContext(req, res);
    if (!ctx) return;
    const rawDirectory = String(req.body?.directory ?? "").trim();
    const settings = ctx.db.collection("menu_settings");

    if (!rawDirectory) {
      await settings.deleteOne({ _id: BANNER_VIDEO_DIRECTORY_SETTING_ID as any });
      res.json({ directory: "", files: [], total: 0 });
      return;
    }

    const directory = normalizeVideoDirectory(rawDirectory);
    await ensureVideoDirectory(directory);
    await settings.updateOne(
      { _id: BANNER_VIDEO_DIRECTORY_SETTING_ID as any },
      { $set: { directory, updatedAt: new Date(), updatedBy: req.admin?.adminId ?? "" } },
      { upsert: true },
    );
    const files = await listVideoFiles(directory);
    res.json({ directory, files, total: files.length });
  } catch (err: any) {
    req.log.error({ err }, "Failed to save banner video directory");
    res.status(400).json({ error: "DirectoryError", message: err.message || "Could not use this directory. Check the path and VPS permissions." });
  }
});

router.post("/files", handleMulterUpload, async (req: ScopedRequest, res) => {
  const tempPath = req.file?.path;
  try {
    const ctx = await getSubHubVideoContext(req, res);
    if (!ctx) return;
    if (!req.file) {
      res.status(400).json({ error: "ValidationError", message: "Choose a video file to upload." });
      return;
    }

    const directory = await getConfiguredDirectory(ctx.db);
    if (!directory) {
      res.status(409).json({ error: "DirectoryNotConfigured", message: "Set this sub-hub's VPS video directory before uploading." });
      return;
    }
    const actualDirectory = await ensureVideoDirectory(directory);
    const filename = sanitizeUploadedVideoFilename(req.file.originalname);
    const targetPath = path.join(actualDirectory, filename);
    await moveUploadIntoDirectory(req.file.path, targetPath, false);
    res.status(201).json({ file: { name: filename }, files: await listVideoFiles(actualDirectory) });
  } catch (err: any) {
    req.log.error({ err }, "Failed to upload banner video");
    const status = err?.code === "EEXIST" ? 409 : err?.message?.includes("supported video") ? 400 : 500;
    res.status(status).json({ error: "UploadError", message: err.message || "Failed to save this video." });
  } finally {
    if (tempPath) await fs.unlink(tempPath).catch(() => undefined);
  }
});

router.put("/files/:filename", async (req: ScopedRequest, res) => {
  try {
    const ctx = await getSubHubVideoContext(req, res);
    if (!ctx) return;
    const directory = await getConfiguredDirectory(ctx.db);
    if (!directory) {
      res.status(409).json({ error: "DirectoryNotConfigured", message: "Set this sub-hub's VPS video directory first." });
      return;
    }

    const oldFilename = validateVideoFilename(req.params.filename);
    const newFilename = validateVideoFilename(String(req.body?.newFilename ?? "").trim());
    if (path.extname(oldFilename).toLowerCase() !== path.extname(newFilename).toLowerCase()) {
      res.status(400).json({ error: "ValidationError", message: "Renaming a video must keep its current file extension." });
      return;
    }

    const actualDirectory = normalizeVideoDirectory(directory);
    const source = await resolveManagedVideoFile(actualDirectory, oldFilename);
    const targetPath = path.join(actualDirectory, newFilename);
    if (source.path !== targetPath) {
      try {
        await fs.access(targetPath);
        res.status(409).json({ error: "Duplicate", message: "A video with that filename already exists." });
        return;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      await fs.rename(source.path, targetPath);
    }
    res.json({ file: { name: newFilename }, files: await listVideoFiles(actualDirectory) });
  } catch (err: any) {
    req.log.error({ err }, "Failed to rename banner video");
    res.status(400).json({ error: "FileError", message: err.message || "Could not rename this video." });
  }
});

router.put("/files/:filename/replace", handleMulterUpload, async (req: ScopedRequest, res) => {
  const tempPath = req.file?.path;
  try {
    const ctx = await getSubHubVideoContext(req, res);
    if (!ctx) return;
    if (!req.file) {
      res.status(400).json({ error: "ValidationError", message: "Choose a replacement video." });
      return;
    }

    const directory = await getConfiguredDirectory(ctx.db);
    if (!directory) {
      res.status(409).json({ error: "DirectoryNotConfigured", message: "Set this sub-hub's VPS video directory first." });
      return;
    }
    const filename = validateVideoFilename(req.params.filename);
    const uploadedName = sanitizeUploadedVideoFilename(req.file.originalname);
    if (path.extname(uploadedName).toLowerCase() !== path.extname(filename).toLowerCase()) {
      res.status(400).json({ error: "ValidationError", message: "The replacement must use the same video file extension." });
      return;
    }

    const actualDirectory = normalizeVideoDirectory(directory);
    const target = await resolveManagedVideoFile(actualDirectory, filename);
    await moveUploadIntoDirectory(req.file.path, target.path, true);
    res.json({ file: { name: filename }, files: await listVideoFiles(actualDirectory) });
  } catch (err: any) {
    req.log.error({ err }, "Failed to replace banner video");
    res.status(400).json({ error: "ReplaceError", message: err.message || "Could not replace this video." });
  } finally {
    if (tempPath) await fs.unlink(tempPath).catch(() => undefined);
  }
});

router.delete("/files/:filename", async (req: ScopedRequest, res) => {
  try {
    const ctx = await getSubHubVideoContext(req, res);
    if (!ctx) return;
    const directory = await getConfiguredDirectory(ctx.db);
    if (!directory) {
      res.status(409).json({ error: "DirectoryNotConfigured", message: "Set this sub-hub's VPS video directory first." });
      return;
    }
    const file = await resolveManagedVideoFile(directory, String(req.params.filename));
    await fs.unlink(file.path);
    res.json({ deleted: file.filename, files: await listVideoFiles(directory) });
  } catch (err: any) {
    req.log.error({ err }, "Failed to delete banner video");
    res.status(400).json({ error: "FileError", message: err.message || "Could not delete this video." });
  }
});

export default router;
