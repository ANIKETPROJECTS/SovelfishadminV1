import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

type LocationSearchResult = {
  place_id: string;
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
};

type CachedResult = {
  expiresAt: number;
  results: LocationSearchResult[];
};

type CachedReverseResult = {
  expiresAt: number;
  postcode: string | null;
};

const router: IRouter = Router();
router.use(requireAuth as any);

const resultCache = new Map<string, CachedResult>();
const reverseResultCache = new Map<string, CachedReverseResult>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const MIN_REQUEST_INTERVAL_MS = 600;
const MIN_REVERSE_REQUEST_INTERVAL_MS = 1000;
const LOCATION_SEARCH_BASE_URL =
  process.env.LOCATION_SEARCH_BASE_URL || "https://photon.komoot.io/api/";
let lastPhotonRequestAt = 0;
let requestQueue: Promise<unknown> = Promise.resolve();
let lastReverseRequestAt = 0;
let reverseRequestQueue: Promise<unknown> = Promise.resolve();

function getCachedResults(key: string): LocationSearchResult[] | null {
  const cached = resultCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    resultCache.delete(key);
    return null;
  }
  return cached.results;
}

async function searchPhoton(query: string): Promise<LocationSearchResult[]> {
  const cacheKey = query.toLocaleLowerCase("en-IN");
  const cached = getCachedResults(cacheKey);
  if (cached) return cached;

  const job = requestQueue.then(async () => {
    // Another identical search may have populated the cache while this request
    // waited behind the shared per-process rate limiter.
    const queuedCache = getCachedResults(cacheKey);
    if (queuedCache) return queuedCache;

    const waitMs = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - lastPhotonRequestAt));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastPhotonRequestAt = Date.now();

    const url = new URL(LOCATION_SEARCH_BASE_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("lang", "en");
    url.searchParams.set("limit", "5");
    url.searchParams.set("lat", "19.2183");
    url.searchParams.set("lon", "72.9781");

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "FreshStockXchangeAdmin/1.0 (customer location picker)",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = new Error(`Photon returned HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }

    const body: unknown = await response.json();
    const features = (body as any)?.type === "FeatureCollection" && Array.isArray((body as any).features)
      ? (body as any).features
      : [];
    const results = features.flatMap((feature: any) => {
      const coordinates = feature?.geometry?.coordinates;
      const properties = feature?.properties;
      const longitude = Number(coordinates?.[0]);
      const latitude = Number(coordinates?.[1]);
      if (!properties || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return [];

      const displayParts = [
        properties.name,
        properties.street,
        properties.locality,
        properties.district,
        properties.city,
        properties.state,
        properties.postcode,
        properties.country,
      ].filter((part, index, parts) =>
        typeof part === "string" && part.trim() &&
        parts.findIndex((candidate) => typeof candidate === "string" &&
          candidate.trim().toLowerCase() === part.trim().toLowerCase()) === index,
      );
      const displayName = displayParts.join(", ");
      if (!displayName) return [];

      return [{
        place_id: `${properties.osm_type ?? "osm"}-${properties.osm_id ?? `${latitude},${longitude}`}`,
        display_name: displayName,
        lat: String(latitude),
        lon: String(longitude),
        ...(typeof properties.type === "string" ? { type: properties.type } : {}),
      }];
    });

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

async function reverseGeocodeNominatim(latitude: number, longitude: number): Promise<string | null> {
  const cacheKey = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
  const cached = reverseResultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.postcode;
  if (cached) reverseResultCache.delete(cacheKey);

  const job = reverseRequestQueue.then(async () => {
    const queuedCache = reverseResultCache.get(cacheKey);
    if (queuedCache && queuedCache.expiresAt > Date.now()) return queuedCache.postcode;

    const waitMs = Math.max(
      0,
      MIN_REVERSE_REQUEST_INTERVAL_MS - (Date.now() - lastReverseRequestAt),
    );
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastReverseRequestAt = Date.now();

    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(latitude));
    url.searchParams.set("lon", String(longitude));
    url.searchParams.set("zoom", "18");
    url.searchParams.set("addressdetails", "1");

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "FreshStockXchangeAdmin/1.0 (customer map pin postal-code lookup)",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = new Error(`Nominatim returned HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }

    const body = await response.json() as { address?: { postcode?: unknown } };
    const rawPostcode = typeof body?.address?.postcode === "string"
      ? body.address.postcode.trim()
      : "";
    const postcode = rawPostcode || null;
    reverseResultCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, postcode });
    if (reverseResultCache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = reverseResultCache.keys().next().value;
      if (oldestKey) reverseResultCache.delete(oldestKey);
    }
    return postcode;
  });

  reverseRequestQueue = job.then(() => undefined, () => undefined);
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
    res.json({ results: await searchPhoton(query) });
  } catch (error: any) {
    const status = Number(error?.status);
    logger.warn({ status: Number.isFinite(status) ? status : undefined }, "Photon location search failed");
    if (status === 429) {
      res.status(429).json({ message: "Location search is busy. Wait a moment and try again." });
      return;
    }
    res.status(503).json({ message: "Location search is temporarily unavailable. You can still place a pin on the map." });
  }
});

router.get("/reverse", async (req, res) => {
  const latitude = Number(req.query.lat);
  const longitude = Number(req.query.lon);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    res.status(400).json({ message: "Valid latitude and longitude are required." });
    return;
  }

  try {
    res.json({ postcode: await reverseGeocodeNominatim(latitude, longitude) });
  } catch (error: any) {
    const status = Number(error?.status);
    logger.warn(
      { status: Number.isFinite(status) ? status : undefined },
      "Nominatim reverse geocoding failed",
    );
    res.status(503).json({
      message: "Postal-code lookup is temporarily unavailable. Enter the pincode manually.",
    });
  }
});

export default router;
