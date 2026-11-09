import { useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import { LoaderCircle, LocateFixed, MapPin, Search, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import "leaflet/dist/leaflet.css";

export type AddressCoordinates = {
  latitude: number;
  longitude: number;
};

type AddressCoordinatePickerProps = {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  onChange: (coordinates: AddressCoordinates | null) => void;
};

const DEFAULT_CENTER: [number, number] = [19.2183, 72.9781];

type LocationSearchResult = {
  place_id: string;
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
};

function isValidCoordinatePair(latitude: unknown, longitude: unknown): boolean {
  if (latitude === null || latitude === undefined || String(latitude).trim() === "" ||
    longitude === null || longitude === undefined || String(longitude).trim() === "") return false;
  const lat = Number(latitude);
  const lng = Number(longitude);
  return Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

export function AddressCoordinatePicker({
  latitude,
  longitude,
  onChange,
}: AddressCoordinatePickerProps) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const onChangeRef = useRef(onChange);
  const [locating, setLocating] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<LocationSearchResult[]>([]);
  const [locationError, setLocationError] = useState("");

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!mapElementRef.current) return;
    const hasCoordinates = isValidCoordinatePair(latitude, longitude);
    const center: [number, number] = hasCoordinates
      ? [Number(latitude), Number(longitude)]
      : DEFAULT_CENTER;
    const map = L.map(mapElementRef.current, {
      center,
      zoom: hasCoordinates ? 16 : 12,
      scrollWheelZoom: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    }).addTo(map);
    map.on("click", (event: L.LeafletMouseEvent) => {
      onChangeRef.current({
        latitude: Number(event.latlng.lat.toFixed(6)),
        longitude: Number(event.latlng.lng.toFixed(6)),
      });
    });
    mapRef.current = map;
    const invalidateTimer = window.setTimeout(() => map.invalidateSize(), 0);

    return () => {
      window.clearTimeout(invalidateTimer);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!isValidCoordinatePair(latitude, longitude)) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }

    const point = L.latLng(Number(latitude), Number(longitude));
    if (markerRef.current) {
      markerRef.current.setLatLng(point);
    } else {
      markerRef.current = L.circleMarker(point, {
        radius: 8,
        color: "#ffffff",
        weight: 3,
        fillColor: "#1769d2",
        fillOpacity: 1,
      }).addTo(map);
      map.setView(point, Math.max(map.getZoom(), 16));
    }
  }, [latitude, longitude]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length < 3) {
      setSearchResults([]);
      setSearching(false);
      setLocationError("");
      return;
    }

    const controller = new AbortController();
    setSearching(true);
    setSearchResults([]);
    setLocationError("");
    const timeout = window.setTimeout(async () => {
      try {
        const response = await apiFetch(
          `/api/location-search?q=${encodeURIComponent(query)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const results = Array.isArray(response?.results) ? response.results as LocationSearchResult[] : [];
        setSearchResults(results);
        if (results.length === 0) setLocationError("No places found. Try a nearby street, area, or public landmark.");
      } catch (error: any) {
        if (!controller.signal.aborted) {
          setLocationError(error?.message || "Location search failed. You can still place a pin on the map.");
        }
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 450);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [searchQuery]);

  const useCurrentLocation = () => {
    setLocationError("");
    if (!navigator.geolocation) {
      setLocationError("Location access is not available in this browser.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latitude = Number(position.coords.latitude.toFixed(6));
        const longitude = Number(position.coords.longitude.toFixed(6));
        mapRef.current?.flyTo([latitude, longitude], Math.max(mapRef.current.getZoom(), 16), { duration: 0.4 });
        onChangeRef.current({ latitude, longitude });
        setLocating(false);
      },
      (error) => {
        setLocationError(
          error.code === error.PERMISSION_DENIED
            ? "Allow location access in your browser, or click the map to place a pin."
            : "Could not read your current location. Click the map to place a pin.",
        );
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  };

  const chooseSearchResult = (result: LocationSearchResult) => {
    const latitude = Number(result.lat);
    const longitude = Number(result.lon);
    if (!isValidCoordinatePair(latitude, longitude)) {
      setLocationError("That search result did not include valid coordinates.");
      return;
    }
    mapRef.current?.flyTo([latitude, longitude], Math.max(mapRef.current.getZoom(), 16), { duration: 0.4 });
    onChangeRef.current({
      latitude: Number(latitude.toFixed(6)),
      longitude: Number(longitude.toFixed(6)),
    });
    setSearchResults([]);
    setSearchQuery("");
    setLocationError("");
  };

  const hasCoordinates = isValidCoordinatePair(latitude, longitude);

  return (
    <div className="space-y-2" data-testid="address-coordinate-picker">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs text-gray-600">
          <MapPin className="h-3.5 w-3.5 text-blue-700" />
          Click the map to set the exact delivery pin.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="button-use-current-location"
            onClick={useCurrentLocation}
            disabled={locating}
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <LocateFixed className="h-3.5 w-3.5" />
            {locating ? "Locating…" : "Use current location"}
          </button>
          {hasCoordinates && (
            <button
              type="button"
              data-testid="button-clear-location-pin"
              onClick={() => onChange(null)}
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-600 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear pin
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <input
            type="search"
            data-testid="input-address-location-search"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSearchResults([]);
            }}
            placeholder="Search for a street, area, or landmark"
            aria-label="Search map location"
            aria-autocomplete="list"
            aria-controls="address-location-search-results"
            aria-expanded={searchResults.length > 0}
            className="h-10 w-full rounded-md border border-gray-300 bg-white py-2 pl-9 pr-9 text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
          {searching && <LoaderCircle className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-blue-700" aria-label="Searching" />}
          {searchResults.length > 0 && (
            <div
              id="address-location-search-results"
              className="relative z-10 mt-1 max-h-52 w-full overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg"
              role="listbox"
              aria-label="Location search results"
            >
              {searchResults.map((result) => (
                <button
                  key={result.place_id}
                  type="button"
                  role="option"
                  aria-selected="false"
                  onClick={() => chooseSearchResult(result)}
                  className="flex w-full items-start gap-2 border-b border-gray-100 px-3 py-2.5 text-left last:border-b-0 hover:bg-blue-50"
                >
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-700" />
                  <span className="text-xs leading-4 text-gray-800">{result.display_name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <p className="text-[10px] leading-4 text-gray-500">
          Suggestions appear as you type. Search text is sent to Photon, an OpenStreetMap-based provider; use a public area or landmark, not customer names or private address details.
        </p>
        {locationError && <p className="text-xs text-amber-700" role="status">{locationError}</p>}
      </div>

      <div
        ref={mapElementRef}
        data-testid="map-openstreetmap"
        aria-label="OpenStreetMap location picker"
        className="h-[360px] w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
      />

      {hasCoordinates ? (
        <p className="text-xs font-medium text-blue-800" data-testid="text-saved-coordinates">
          Pinned coordinates: {Number(latitude).toFixed(6)}, {Number(longitude).toFixed(6)}
        </p>
      ) : (
        <p className="text-xs text-gray-500">No pin selected. The written address will still be used for delivery.</p>
      )}
      <p className="text-[10px] text-gray-500">Map data © OpenStreetMap contributors.</p>
    </div>
  );
}
