let googleMapsPromise: Promise<typeof google> | null = null;

type GoogleMapsWindow = Window & {
  __fishtokriGoogleMapsReady?: () => void;
};

export function loadGoogleMaps(): Promise<typeof google> {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim();
  if (!apiKey) {
    return Promise.reject(
      new Error("Google Maps is not configured. Add VITE_GOOGLE_MAPS_API_KEY to Replit Secrets."),
    );
  }

  if (googleMapsPromise) return googleMapsPromise;

  googleMapsPromise = new Promise<typeof google>((resolve, reject) => {
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

  googleMapsPromise = googleMapsPromise.catch((error: unknown) => {
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
