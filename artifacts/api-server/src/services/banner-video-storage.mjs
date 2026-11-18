import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export const BANNER_VIDEO_DIRECTORY_SETTING_ID = "banner-video-directory";

export const BANNER_VIDEO_EXTENSIONS = new Set([
  ".3gp",
  ".avi",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".ogv",
  ".webm",
]);

const SAFE_FILENAME_PATTERN = /^[\p{L}\p{N} ._()-]+$/u;

export function normalizeVideoDirectory(rawDirectory) {
  if (typeof rawDirectory !== "string") {
    throw new Error("Enter an absolute directory path on the VPS.");
  }

  const value = rawDirectory.trim();
  if (!value || value.includes("\0") || !path.isAbsolute(value)) {
    throw new Error("Enter an absolute directory path on the VPS.");
  }
  if (value.split(path.sep).includes("..")) {
    throw new Error("Directory paths cannot contain '..' path segments.");
  }

  const directory = path.resolve(value);
  if (directory === path.parse(directory).root) {
    throw new Error("The filesystem root cannot be used as a video directory.");
  }
  return directory;
}

export function validateVideoFilename(rawName) {
  if (typeof rawName !== "string" || !rawName || rawName.length > 180) {
    throw new Error("Invalid video filename.");
  }
  if (
    rawName !== path.basename(rawName) ||
    rawName.startsWith(".") ||
    rawName.includes("\0") ||
    !SAFE_FILENAME_PATTERN.test(rawName)
  ) {
    throw new Error("Video filenames can only contain letters, numbers, spaces, dots, underscores, parentheses, and hyphens.");
  }

  const extension = path.extname(rawName).toLowerCase();
  if (!BANNER_VIDEO_EXTENSIONS.has(extension)) {
    throw new Error("Only supported video files can be managed here.");
  }
  return rawName;
}

export function sanitizeUploadedVideoFilename(rawName) {
  if (typeof rawName !== "string") {
    throw new Error("The uploaded file has no valid filename.");
  }

  const basename = path.basename(rawName.replace(/\\/g, "/"));
  const originalExtension = path.extname(basename);
  const extension = originalExtension.toLowerCase();
  if (!BANNER_VIDEO_EXTENSIONS.has(extension)) {
    throw new Error("Use a supported video file such as MP4, MOV, or WebM.");
  }

  const stem = path.basename(basename, originalExtension)
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} ._()-]/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 150);
  const filename = `${stem || "video"}${extension}`;
  return validateVideoFilename(filename);
}

export async function ensureVideoDirectory(rawDirectory) {
  const directory = normalizeVideoDirectory(rawDirectory);
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) {
    throw new Error("The configured path is not a directory.");
  }
  await fs.access(directory, constants.R_OK | constants.W_OK);
  return directory;
}

export async function resolveManagedVideoFile(rawDirectory, rawFilename) {
  const directory = normalizeVideoDirectory(rawDirectory);
  const filename = validateVideoFilename(rawFilename);
  const candidate = path.join(directory, filename);
  if (path.dirname(candidate) !== directory) {
    throw new Error("Invalid video filename.");
  }

  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Video file not found.");
  }
  return { path: candidate, stat, filename };
}

export async function listVideoFiles(rawDirectory) {
  const directory = normalizeVideoDirectory(rawDirectory);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const filename = validateVideoFilename(entry.name);
      const filePath = path.join(directory, filename);
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      files.push({
        name: filename,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      // Ignore non-video files and names that are not safe to manage.
    }
  }

  return files.sort((a, b) => a.name.localeCompare(b.name, "en"));
}

export async function countVideoFiles(rawDirectory) {
  const directory = normalizeVideoDirectory(rawDirectory);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries.reduce((count, entry) => {
    if (!entry.isFile()) return count;
    try {
      validateVideoFilename(entry.name);
      return count + 1;
    } catch {
      return count;
    }
  }, 0);
}
