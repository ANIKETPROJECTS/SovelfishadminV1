import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureVideoDirectory,
  listVideoFiles,
  normalizeVideoDirectory,
  sanitizeUploadedVideoFilename,
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

test("video listing includes supported files but skips other files and symlinks", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "banner-video-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await ensureVideoDirectory(directory);
  await fs.writeFile(path.join(directory, "promo.mp4"), "sample video bytes");
  await fs.writeFile(path.join(directory, "notes.txt"), "not a video");
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "nested", "hidden.mp4"), "nested video");
  await fs.symlink(path.join(directory, "promo.mp4"), path.join(directory, "linked.mp4"));

  const videos = await listVideoFiles(directory);
  assert.deepEqual(videos.map((video) => video.name), ["promo.mp4"]);
  assert.equal(videos[0].size, 18);
  assert.ok(videos[0].modifiedAt);
});
