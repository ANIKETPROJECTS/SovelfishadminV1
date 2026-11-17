let googleMapsPromise: Promise<typeof google> | null = null;

type GoogleMapsWindow = Window & {
  __fishtokriGoogleMapsReady?: () => void;
};

export function loadGoogleMaps(): Promise<typeof google> {
  if (googleMapsPromise) return googleMapsPromise;

  googleMapsPromise = (async () => {
    let runtimeApiKey = "";
    try {
      const response = await fetch("/api/runtime-config", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (response.ok) {
        const config = (await response.json()) as { googleMapsApiKey?: unknown };
        if (typeof config.googleMapsApiKey === "string") {
          runtimeApiKey = config.googleMapsApiKey.trim();
        }
      }
    } catch {
      // Local Vite development can still use its build-time environment value.
    }

    const apiKey = runtimeApiKey || import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        "Google Maps is not configured. Set VITE_GOOGLE_MAPS_API_KEY or GOOGLE_MAPS_API_KEY in the server .env, then restart the API server.",
      );
    }

    return new Promise<typeof google>((resolve, reject) => {
      const targetWindow = window as GoogleMapsWindow;
      const script = document.createElement("script");

      targetWindow.__fishtokriGoogleMapsReady = () => {
        delete targetWindow.__fishtokriGoogleMapsReady;
        resolve(window.google);
      };

      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async&callback=__fishtokriGoogleMapsReady`;
      script.async = true;
      script.defer = true;
      script.onerror = () => {
        delete targetWindow.__fishtokriGoogleMapsReady;
        script.remove();
        reject(new Error("Google Maps could not load. Check the API key, enabled APIs, and website restrictions."));
      };
      document.head.appendChild(script);
    });
  })().catch((error: unknown) => {
    googleMapsPromise = null;
    throw error;
  });

  return googleMapsPromise;
}

export async function loadGoogleMapsLibraries() {
  const mapsApi = await loadGoogleMaps();
  const [maps, places, geocoding] = await Promise.all([
    mapsApi.maps.importLibrary("maps") as Promise<google.maps.MapsLibrary>,
    mapsApi.maps.importLibrary("places") as Promise<google.maps.PlacesLibrary>,
    mapsApi.maps.importLibrary("geocoding") as Promise<google.maps.GeocodingLibrary>,
  ]);

  return { mapsApi, maps, places, geocoding };
}
