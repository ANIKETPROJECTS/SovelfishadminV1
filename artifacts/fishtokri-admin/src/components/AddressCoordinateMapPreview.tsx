import { useEffect, useRef } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";

type AddressCoordinateMapPreviewProps = {
  latitude: number;
  longitude: number;
};

export function AddressCoordinateMapPreview({
  latitude,
  longitude,
}: AddressCoordinateMapPreviewProps) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!mapElementRef.current) return;

    const point: L.LatLngExpression = [latitude, longitude];
    const map = L.map(mapElementRef.current, {
      center: point,
      zoom: 16,
      scrollWheelZoom: true,
      zoomControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    }).addTo(map);

    L.circleMarker(point, {
      radius: 8,
      color: "#ffffff",
      weight: 3,
      fillColor: "#1769d2",
      fillOpacity: 1,
    }).addTo(map);

    const invalidateTimer = window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      window.clearTimeout(invalidateTimer);
      map.remove();
    };
  }, [latitude, longitude]);

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-gray-200">
      <div
        ref={mapElementRef}
        className="h-48 w-full"
        role="img"
        aria-label={`Map showing the saved delivery pin at ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`}
      />
    </div>
  );
}
