import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  deriveVideoThumbnailFilename,
  ensureVideoDirectory,
  listVideoFiles,
  normalizeVideoDirectory,
  resolveManagedVideoThumbnail,
  sanitizeUploadedVideoFilename,
  validateVideoThumbnailFilename,
  validateVideoFilename,
} from "../src/services/banner-video-storage.mjs";

test("banner video directories must be absolute and not filesystem root", () => {
  assert.throws(() => normalizeVideoDirectory("videos"), /absolute directory path/i);
  assert.throws(() => normalizeVideoDirectory("/"), /root cannot be used/i);
  assert.throws(() => normalizeVideoDirectory("/var/../etc/videos"), /cannot contain/i);
  assert.equal(normalizeVideoDirectory("/var/www/videos"), "/var/www/videos");
});

test("banner video filenames reject paths and unsupported extensions", () => {
  assert.throws(() => validateVideoFilename("../clip.mp4"), /filename/i);
  assert.throws(() => validateVideoFilename("script.sh"), /supported video/i);
  assert.equal(validateVideoFilename("Promo edit 01.mp4"), "Promo edit 01.mp4");
  assert.equal(sanitizeUploadedVideoFilename("../../Promo: edit 01.MP4"), "Promo_ edit 01.mp4");
});

test("video thumbnail names are paired to safe video stems and only accept JPG", () => {
  assert.equal(deriveVideoThumbnailFilename("fresh-catch-offer.mp4"), "fresh-catch-offer.jpg");
  assert.equal(validateVideoThumbnailFilename("Fresh Catch.jpg"), "Fresh Catch.jpg");
  assert.throws(() => validateVideoThumbnailFilename("../Fresh Catch.jpg"), /safe .jpg/i);
  assert.throws(() => validateVideoThumbnailFilename("Fresh Catch.png"), /safe .jpg/i);
});

test("video listing includes paired JPG thumbnail metadata and skips unrelated files and symlinks", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "banner-video-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await ensureVideoDirectory(directory);
  await fs.writeFile(path.join(directory, "promo.mp4"), "sample video bytes");
  await fs.writeFile(path.join(directory, "promo.jpg"), "thumbnail bytes");
  await fs.writeFile(path.join(directory, "linked-video.mp4"), "sample video bytes");
  await fs.symlink(path.join(directory, "promo.jpg"), path.join(directory, "linked-video.jpg"));
  await fs.writeFile(path.join(directory, "orphan.jpg"), "orphan image");
  await fs.writeFile(path.join(directory, "notes.txt"), "not a video");
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "nested", "hidden.mp4"), "nested video");
  await fs.symlink(path.join(directory, "promo.mp4"), path.join(directory, "linked.mp4"));

  const videos = await listVideoFiles(directory);
  assert.deepEqual(videos.map((video) => video.name), ["linked-video.mp4", "promo.mp4"]);
  assert.equal(videos[0].thumbnail, null);
  assert.equal(videos[1].thumbnail.name, "promo.jpg");
  assert.equal(videos[1].thumbnail.size, 15);
  assert.ok(videos[1].thumbnail.modifiedAt);
  assert.equal(videos[1].size, 18);
  assert.ok(videos[1].modifiedAt);

  const thumbnail = await resolveManagedVideoThumbnail(directory, "promo.mp4");
  assert.equal(thumbnail.filename, "promo.jpg");
  assert.equal(await resolveManagedVideoThumbnail(directory, "linked-video.mp4"), null);
});
