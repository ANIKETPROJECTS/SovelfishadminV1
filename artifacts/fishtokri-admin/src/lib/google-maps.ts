let googleMapsPromise: Promise<typeof google> | null = null;
let googleMapsConfigPromise: Promise<{ apiKey: string; mapId: string }> | null = null;

type GoogleMapsWindow = Window & {
  __fishtokriGoogleMapsReady?: () => void;
};

function loadGoogleMapsConfig(): Promise<{ apiKey: string; mapId: string }> {
  if (googleMapsConfigPromise) return googleMapsConfigPromise;

  googleMapsConfigPromise = (async () => {
    let runtimeApiKey = "";
    let runtimeMapId = "";
    try {
      const response = await fetch("/api/runtime-config", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (response.ok) {
        const config = (await response.json()) as {
          googleMapsApiKey?: unknown;
          googleMapsMapId?: unknown;
        };
        if (typeof config.googleMapsApiKey === "string") {
          runtimeApiKey = config.googleMapsApiKey.trim();
        }
        if (typeof config.googleMapsMapId === "string") {
          runtimeMapId = config.googleMapsMapId.trim();
        }
      }
    } catch {
      // Local Vite development can still use its build-time environment value.
    }

    return {
      apiKey: runtimeApiKey || import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim() || "",
      mapId: runtimeMapId || import.meta.env.VITE_GOOGLE_MAP_ID?.trim() || "",
    };
  })().catch((error: unknown) => {
    googleMapsConfigPromise = null;
    throw error;
  });

  return googleMapsConfigPromise;
}

export async function getGoogleMapsMapId(): Promise<string> {
  const { mapId } = await loadGoogleMapsConfig();
  const configuredMapId = mapId || (import.meta.env.DEV ? "DEMO_MAP_ID" : "");
  if (!configuredMapId) {
    throw new Error(
      "Google Maps Advanced Markers need a Map ID. Set GOOGLE_MAP_ID in the server .env.",
    );
  }
  return configuredMapId;
}

export function loadGoogleMaps(): Promise<typeof google> {
  if (googleMapsPromise) return googleMapsPromise;

  googleMapsPromise = (async () => {
    const { apiKey } = await loadGoogleMapsConfig();
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
  const [maps, places, geocoding, marker] = await Promise.all([
    mapsApi.maps.importLibrary("maps") as Promise<google.maps.MapsLibrary>,
    mapsApi.maps.importLibrary("places") as Promise<google.maps.PlacesLibrary>,
    mapsApi.maps.importLibrary("geocoding") as Promise<google.maps.GeocodingLibrary>,
    mapsApi.maps.importLibrary("marker") as Promise<google.maps.MarkerLibrary>,
  ]);

  return { mapsApi, maps, places, geocoding, marker };
}
