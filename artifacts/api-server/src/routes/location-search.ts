import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

type LocationSearchResult = {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
};

type CachedResult = {
  expiresAt: number;
  results: LocationSearchResult[];
};

const router: IRouter = Router();
router.use(requireAuth as any);

const resultCache = new Map<string, CachedResult>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const MIN_REQUEST_INTERVAL_MS = 1100;
const LOCATION_SEARCH_BASE_URL =
  process.env.LOCATION_SEARCH_BASE_URL || "https://nominatim.openstreetmap.org/search";
let lastNominatimRequestAt = 0;
let requestQueue: Promise<unknown> = Promise.resolve();

function getCachedResults(key: string): LocationSearchResult[] | null {
  const cached = resultCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    resultCache.delete(key);
    return null;
  }
  return cached.results;
}

async function searchNominatim(query: string): Promise<LocationSearchResult[]> {
  const cacheKey = query.toLocaleLowerCase("en-IN");
  const cached = getCachedResults(cacheKey);
  if (cached) return cached;

  const job = requestQueue.then(async () => {
    // Another identical search may have populated the cache while this request
    // waited behind the shared per-process rate limiter.
    const queuedCache = getCachedResults(cacheKey);
    if (queuedCache) return queuedCache;

    const waitMs = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - lastNominatimRequestAt));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastNominatimRequestAt = Date.now();

    const url = new URL(LOCATION_SEARCH_BASE_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "5");
    url.searchParams.set("countrycodes", "in");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", "en-IN,en");

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "FreshStockXchangeAdmin/1.0 (customer location picker)",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = new Error(`Nominatim returned HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }

    const body: unknown = await response.json();
    const results = Array.isArray(body)
      ? body.filter((item: any) =>
        item &&
        Number.isFinite(Number(item.place_id)) &&
        typeof item.display_name === "string" &&
        Number.isFinite(Number(item.lat)) &&
        Number.isFinite(Number(item.lon)) &&
        Number(item.lat) >= -90 && Number(item.lat) <= 90 &&
        Number(item.lon) >= -180 && Number(item.lon) <= 180,
      ).map((item: any) => ({
        place_id: Number(item.place_id),
        display_name: item.display_name,
        lat: String(item.lat),
        lon: String(item.lon),
        ...(typeof item.type === "string" ? { type: item.type } : {}),
      }))
      : [];

    resultCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, results });
    if (resultCache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = resultCache.keys().next().value;
      if (oldestKey) resultCache.delete(oldestKey);
    }
    return results;
  });

  requestQueue = job.then(() => undefined, () => undefined);
  return job;
}

router.get("/", async (req, res) => {
  const rawQuery = req.query.q;
  const query = typeof rawQuery === "string" ? rawQuery.trim().replace(/\s+/g, " ") : "";
  if (query.length < 3 || query.length > 120) {
    res.status(400).json({ message: "Enter a place or area between 3 and 120 characters." });
    return;
  }
  if (/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/.test(query) || /(?:\+?\d[\d\s().-]{8,}\d)/.test(query)) {
    res.status(400).json({ message: "Search for a public place or area, not an email or phone number." });
    return;
  }
  if (/\b(flat|apartment|apt|wing|floor|room|unit|house\s*(?:no|number)|door\s*(?:no|number))\b/i.test(query)) {
    res.status(400).json({ message: "Search a nearby public place, street, or area, then fine-tune the pin on the map. Do not search private flat details." });
    return;
  }

  try {
    res.json({ results: await searchNominatim(query) });
  } catch (error: any) {
    const status = Number(error?.status);
    logger.warn({ status: Number.isFinite(status) ? status : undefined }, "OpenStreetMap location search failed");
    if (status === 429) {
      res.status(429).json({ message: "Location search is busy. Wait a moment and try again." });
      return;
    }
    res.status(503).json({ message: "Location search is temporarily unavailable. You can still place a pin on the map." });
  }
});

export default router;
