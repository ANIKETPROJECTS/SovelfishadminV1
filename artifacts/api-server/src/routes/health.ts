import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/runtime-config", (_req, res) => {
  // Google Maps JavaScript keys are browser keys by design. Restrict this key
  // in Google Cloud by allowed website referrers and enabled APIs.
  const googleMapsApiKey =
    process.env.VITE_GOOGLE_MAPS_API_KEY?.trim() ||
    process.env.GOOGLE_MAPS_API_KEY?.trim() ||
    "";
  const googleMapsMapId =
    process.env.VITE_GOOGLE_MAP_ID?.trim() ||
    process.env.GOOGLE_MAP_ID?.trim() ||
    "";

  res.set("Cache-Control", "no-store").json({ googleMapsApiKey, googleMapsMapId });
});

export default router;
