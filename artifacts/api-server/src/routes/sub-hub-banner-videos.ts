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
  deriveVideoThumbnailFilename,
  ensureVideoDirectory,
  listVideoFiles,
  normalizeVideoDirectory,
  resolveManagedVideoFile,
  resolveManagedVideoThumbnail,
  sanitizeUploadedVideoFilename,
  validateVideoFilename,
} from "../services/banner-video-storage.mjs";

const router: IRouter = Router({ mergeParams: true });
router.use(requireAuth as any);
router.use(loadScope as any);

function tempUploadStorage(prefix: string) {
  return multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, os.tmpdir()),
    filename: (_req, _file, callback) => callback(null, `${prefix}-${randomUUID()}.upload`),
  });
}

const upload = multer({
  storage: tempUploadStorage("banner-video"),
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

const thumbnailUpload = multer({
  storage: tempUploadStorage("banner-video-thumbnail"),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype === "image/jpeg" && path.extname(file.originalname).toLowerCase() === ".jpg") {
      callback(null, true);
      return;
    }
    callback(new Error("Upload a JPG image (.jpg) for the video thumbnail."));
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

function handleThumbnailUpload(req: any, res: any, next: any) {
  thumbnailUpload.single("thumbnail")(req, res, (error: any) => {
    if (error) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      res.status(status).json({ error: "UploadError", message: error.message || "Thumbnail upload failed." });
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
          throw Object.assign(new Error("A file with this filename already exists. Use Replace to overwrite it."), { code: "EEXIST" });
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

router.get("/files/:filename/thumbnail", async (req: ScopedRequest, res) => {
  try {
    const ctx = await getSubHubVideoContext(req, res);
    if (!ctx) return;
    const directory = await getConfiguredDirectory(ctx.db);
    if (!directory) {
      res.status(409).json({ error: "DirectoryNotConfigured", message: "Set this sub-hub's VPS video directory first." });
      return;
    }

    const video = await resolveManagedVideoFile(directory, String(req.params.filename));
    const thumbnail = await resolveManagedVideoThumbnail(directory, video.filename);
    if (!thumbnail) {
      res.status(404).json({ error: "NotFound", message: "This video does not have a JPG thumbnail." });
      return;
    }
    res.type("image/jpeg").sendFile(thumbnail.path);
  } catch (err: any) {
    req.log.error({ err }, "Failed to read banner video thumbnail");
    res.status(404).json({ error: "NotFound", message: err.message || "Could not read this thumbnail." });
  }
});

router.get("/files/:filename/stream", async (req: ScopedRequest, res) => {
  try {
    const ctx = await getSubHubVideoContext(req, res);
    if (!ctx) return;
    const directory = await getConfiguredDirectory(ctx.db);
    if (!directory) {
      res.status(409).json({ error: "DirectoryNotConfigured", message: "Set this sub-hub's VPS video directory first." });
      return;
    }

    const file = await resolveManagedVideoFile(directory, String(req.params.filename));
    res.type(path.extname(file.filename));
    res.set("Content-Disposition", `inline; filename="${file.filename}"`);
    res.set("Cache-Control", "private, no-store");
    res.sendFile(file.path);
  } catch (err: any) {
    req.log.error({ err }, "Failed to stream banner video");
    res.status(404).json({ error: "NotFound", message: err.message || "Could not read this video." });
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
    const sourceThumbnail = await resolveManagedVideoThumbnail(actualDirectory, oldFilename);
    const targetThumbnailPath = path.join(actualDirectory, deriveVideoThumbnailFilename(newFilename));
    if (source.path !== targetPath) {
      try {
        await fs.access(targetPath);
        res.status(409).json({ error: "Duplicate", message: "A video with that filename already exists." });
        return;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (sourceThumbnail && sourceThumbnail.path !== targetThumbnailPath) {
      try {
        await fs.access(targetThumbnailPath);
        res.status(409).json({ error: "Duplicate", message: "A JPG thumbnail with that filename already exists." });
        return;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }

    let videoMoved = false;
    let thumbnailMoved = false;
    try {
      if (source.path !== targetPath) {
        await fs.rename(source.path, targetPath);
        videoMoved = true;
      }
      if (sourceThumbnail && sourceThumbnail.path !== targetThumbnailPath) {
        await fs.rename(sourceThumbnail.path, targetThumbnailPath);
        thumbnailMoved = true;
      }
    } catch (error) {
      if (thumbnailMoved) {
        await fs.rename(targetThumbnailPath, sourceThumbnail!.path).catch(() => undefined);
      }
      if (videoMoved) {
        await fs.rename(targetPath, source.path).catch(() => undefined);
      }
      throw error;
    }
    res.json({ file: { name: newFilename }, files: await listVideoFiles(actualDirectory) });
  } catch (err: any) {
    req.log.error({ err }, "Failed to rename banner video");
    res.status(400).json({ error: "FileError", message: err.message || "Could not rename this video." });
  }
});

async function saveVideoThumbnail(req: ScopedRequest, res: any, replace: boolean) {
  const tempPath = req.file?.path;
  try {
    const ctx = await getSubHubVideoContext(req, res);
    if (!ctx) return;
    if (!req.file) {
      res.status(400).json({ error: "ValidationError", message: "Choose a JPG thumbnail to upload." });
      return;
    }

    const directory = await getConfiguredDirectory(ctx.db);
    if (!directory) {
      res.status(409).json({ error: "DirectoryNotConfigured", message: "Set this sub-hub's VPS video directory first." });
      return;
    }

    const actualDirectory = normalizeVideoDirectory(directory);
    const video = await resolveManagedVideoFile(actualDirectory, String(req.params.filename));
    const thumbnailFilename = deriveVideoThumbnailFilename(video.filename);
    const targetPath = path.join(actualDirectory, thumbnailFilename);
    const existingThumbnail = await resolveManagedVideoThumbnail(actualDirectory, video.filename);
    if (replace && !existingThumbnail) {
      res.status(404).json({ error: "NotFound", message: "Upload a thumbnail first before replacing it." });
      return;
    }
    if (!replace && existingThumbnail) {
      res.status(409).json({ error: "Duplicate", message: "This video already has a thumbnail. Use Replace to update it." });
      return;
    }

    await moveUploadIntoDirectory(req.file.path, targetPath, replace);
    res.json({
      thumbnail: { name: thumbnailFilename },
      files: await listVideoFiles(actualDirectory),
    });
  } catch (err: any) {
    req.log.error({ err }, "Failed to save banner video thumbnail");
    const status = err?.code === "EEXIST" ? 409 : err?.message?.includes("JPG") ? 400 : 500;
    res.status(status).json({ error: "ThumbnailError", message: err.message || "Could not save this thumbnail." });
  } finally {
    if (tempPath) await fs.unlink(tempPath).catch(() => undefined);
  }
}

router.post("/files/:filename/thumbnail", handleThumbnailUpload, (req: ScopedRequest, res) => {
  void saveVideoThumbnail(req, res, false);
});

router.put("/files/:filename/thumbnail", handleThumbnailUpload, (req: ScopedRequest, res) => {
  void saveVideoThumbnail(req, res, true);
});

router.delete("/files/:filename/thumbnail", async (req: ScopedRequest, res) => {
  try {
    const ctx = await getSubHubVideoContext(req, res);
    if (!ctx) return;
    const directory = await getConfiguredDirectory(ctx.db);
    if (!directory) {
      res.status(409).json({ error: "DirectoryNotConfigured", message: "Set this sub-hub's VPS video directory first." });
      return;
    }
    const video = await resolveManagedVideoFile(directory, String(req.params.filename));
    const thumbnail = await resolveManagedVideoThumbnail(directory, video.filename);
    if (!thumbnail) {
      res.status(404).json({ error: "NotFound", message: "This video does not have a JPG thumbnail." });
      return;
    }
    await fs.unlink(thumbnail.path);
    res.json({ deleted: thumbnail.filename, files: await listVideoFiles(directory) });
  } catch (err: any) {
    req.log.error({ err }, "Failed to delete banner video thumbnail");
    res.status(400).json({ error: "FileError", message: err.message || "Could not delete this thumbnail." });
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
    const thumbnail = await resolveManagedVideoThumbnail(directory, file.filename);
    if (thumbnail) await fs.unlink(thumbnail.path);
    await fs.unlink(file.path);
    res.json({ deleted: file.filename, thumbnailDeleted: thumbnail?.filename ?? null, files: await listVideoFiles(directory) });
  } catch (err: any) {
    req.log.error({ err }, "Failed to delete banner video");
    res.status(400).json({ error: "FileError", message: err.message || "Could not delete this video." });
  }
});

export default router;
