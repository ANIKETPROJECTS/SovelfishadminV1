import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { loadGoogleMaps } from "@/lib/google-maps";

type AddressCoordinateMapPreviewProps = {
  latitude: number;
  longitude: number;
};

export function AddressCoordinateMapPreview({
  latitude,
  longitude,
}: AddressCoordinateMapPreviewProps) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!mapElementRef.current) return;
    let cancelled = false;
    let map: google.maps.Map | null = null;
    let marker: google.maps.Marker | null = null;

    const renderMap = async () => {
      try {
        const mapsApi = await loadGoogleMaps();
        const maps = await mapsApi.maps.importLibrary("maps") as google.maps.MapsLibrary;
        if (cancelled || !mapElementRef.current) return;

        const point = { lat: latitude, lng: longitude };
        map = new maps.Map(mapElementRef.current, {
          center: point,
          zoom: 16,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          clickableIcons: false,
          gestureHandling: "cooperative",
        });
        marker = new mapsApi.maps.Marker({
          map,
          position: point,
          title: "Saved delivery location",
        });
        setLoading(false);
      } catch (loadError) {
        if (!cancelled) {
          setLoading(false);
          setError(loadError instanceof Error ? loadError.message : "Google Maps could not be loaded.");
        }
      }
    };

    void renderMap();
    return () => {
      cancelled = true;
      marker?.setMap(null);
      if (map) mapsApiCleanup(map);
    };
  }, [latitude, longitude]);

  return (
    <div className="relative mt-3 overflow-hidden rounded-lg border border-gray-200">
      <div
        ref={mapElementRef}
        className="h-48 w-full bg-gray-100"
        role="img"
        aria-label={`Google map showing the saved delivery pin at ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`}
      />
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100 px-4 text-center text-xs text-amber-800">
          {error}
        </div>
      )}
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100 text-xs text-gray-500">
          <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
          Loading map…
        </div>
      )}
    </div>
  );
}

function mapsApiCleanup(map: google.maps.Map) {
  google.maps.event.clearInstanceListeners(map);
}
