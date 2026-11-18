export const BANNER_VIDEO_DIRECTORY_SETTING_ID: string;
export const BANNER_VIDEO_EXTENSIONS: Set<string>;

export function normalizeVideoDirectory(rawDirectory: unknown): string;
export function validateVideoFilename(rawName: unknown): string;
export function sanitizeUploadedVideoFilename(rawName: unknown): string;
export function deriveVideoThumbnailFilename(rawVideoFilename: unknown): string;
export function validateVideoThumbnailFilename(rawName: unknown): string;
export function ensureVideoDirectory(rawDirectory: string): Promise<string>;
export function resolveManagedVideoFile(
  rawDirectory: string,
  rawFilename: string,
): Promise<{ path: string; stat: any; filename: string }>;
export function resolveManagedVideoThumbnail(
  rawDirectory: string,
  rawVideoFilename: string,
): Promise<{ path: string; stat: any; filename: string } | null>;
export function listVideoFiles(
  rawDirectory: string,
): Promise<Array<{
  name: string;
  size: number;
  modifiedAt: string;
  thumbnail: { name: string; size: number; modifiedAt: string } | null;
}>>;
export function countVideoFiles(rawDirectory: string): Promise<number>;
