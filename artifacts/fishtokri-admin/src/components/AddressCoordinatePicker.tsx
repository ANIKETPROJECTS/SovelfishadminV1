import { useCallback, useEffect, useRef, useState } from "react";
import { Link2, LoaderCircle, LocateFixed, MapPin, Search, Trash2 } from "lucide-react";
import { parseMapLinkCoordinates } from "@/lib/map-link-coordinates";
import { loadGoogleMapsLibraries } from "@/lib/google-maps";

export type AddressCoordinates = {
  latitude: number;
  longitude: number;
};

type AddressCoordinatePickerProps = {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  onChange: (coordinates: AddressCoordinates | null) => void;
  onPincodeChange?: (pincode: string) => void;
  onPincodeLookupStateChange?: (busy: boolean) => void;
};

type LocationSearchResult = {
  id: string;
  label: string;
  prediction: google.maps.places.PlacePrediction;
};

const DEFAULT_CENTER = { lat: 19.2183, lng: 72.9781 };

function isValidCoordinatePair(latitude: unknown, longitude: unknown): boolean {
  if (
    latitude === null || latitude === undefined || String(latitude).trim() === "" ||
    longitude === null || longitude === undefined || String(longitude).trim() === ""
  ) return false;

  const lat = Number(latitude);
  const lng = Number(longitude);
  return Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

function normalizeCoordinates(latitude: number, longitude: number): AddressCoordinates {
  return {
    latitude: Number(latitude.toFixed(6)),
    longitude: Number(longitude.toFixed(6)),
  };
}

export function AddressCoordinatePicker({
  latitude,
  longitude,
  onChange,
  onPincodeChange,
  onPincodeLookupStateChange,
}: AddressCoordinatePickerProps) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const geocoderRef = useRef<google.maps.Geocoder | null>(null);
  const autocompleteSessionRef = useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  const postcodeLookupIdRef = useRef(0);
  const onChangeRef = useRef(onChange);
  const onPincodeChangeRef = useRef(onPincodeChange);
  const onPincodeLookupStateChangeRef = useRef(onPincodeLookupStateChange);
  const [mapReady, setMapReady] = useState(false);
  const [mapLoading, setMapLoading] = useState(true);
  const [locating, setLocating] = useState(false);
  const [searching, setSearching] = useState(false);
  const [lookingUpPostcode, setLookingUpPostcode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [mapLink, setMapLink] = useState("");
  const [pinStatusMessage, setPinStatusMessage] = useState("");
  const [searchResults, setSearchResults] = useState<LocationSearchResult[]>([]);
  const [locationError, setLocationError] = useState("");

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onPincodeChangeRef.current = onPincodeChange;
  }, [onPincodeChange]);

  useEffect(() => {
    onPincodeLookupStateChangeRef.current = onPincodeLookupStateChange;
  }, [onPincodeLookupStateChange]);

  const lookupPincode = useCallback(async (coordinates: AddressCoordinates) => {
    const lookupId = ++postcodeLookupIdRef.current;
    setLookingUpPostcode(true);
    onPincodeLookupStateChangeRef.current?.(true);
    setPinStatusMessage("Pin set. Looking up the pincode…");

    try {
      const { geocoding } = await loadGoogleMapsLibraries();
      if (lookupId !== postcodeLookupIdRef.current) return;
      geocoderRef.current ??= new geocoding.Geocoder();

      const response = await geocoderRef.current.geocode({
        location: { lat: coordinates.latitude, lng: coordinates.longitude },
      });
      if (lookupId !== postcodeLookupIdRef.current) return;

      const postcode = response.results
        .flatMap((result) => result.address_components)
        .find((component) => component.types.includes("postal_code"))
        ?.long_name.replace(/\D/g, "");

      if (postcode && /^\d{6}$/.test(postcode)) {
        onPincodeChangeRef.current?.(postcode);
        setPinStatusMessage(`Pin set. Pincode ${postcode} found.`);
      } else {
        setPinStatusMessage("Pin set. No 6-digit pincode was found here; enter it manually.");
      }
    } catch {
      if (lookupId === postcodeLookupIdRef.current) {
        setPinStatusMessage("Pin set. Pincode lookup failed; enter it manually.");
      }
    } finally {
      if (lookupId === postcodeLookupIdRef.current) {
        setLookingUpPostcode(false);
        onPincodeLookupStateChangeRef.current?.(false);
      }
    }
  }, []);

  const pinCoordinates = useCallback((coordinates: AddressCoordinates, lookupPincodeAfterPin = true) => {
    const position = { lat: coordinates.latitude, lng: coordinates.longitude };
    const map = mapRef.current;
    if (map) {
      map.panTo(position);
      map.setZoom(Math.max(map.getZoom() ?? 0, 16));
    }
    markerRef.current?.setPosition(position);
    markerRef.current?.setVisible(true);
    onChangeRef.current(coordinates);
    setLocationError("");

    if (lookupPincodeAfterPin) {
      void lookupPincode(coordinates);
    } else {
      setPinStatusMessage("");
    }
  }, [lookupPincode]);

  useEffect(() => {
    if (!mapElementRef.current) return;
    let cancelled = false;
    let map: google.maps.Map | null = null;
    let marker: google.maps.Marker | null = null;
    let clickListener: google.maps.MapsEventListener | null = null;
    let dragListener: google.maps.MapsEventListener | null = null;
    let mapInitTimer: number | undefined;

    const createMap = async () => {
      try {
        const { mapsApi, maps, geocoding } = await loadGoogleMapsLibraries();
        const mapElement = mapElementRef.current;
        if (cancelled || !mapElement?.isConnected) return;
        const mapBounds = mapElement.getBoundingClientRect();
        if (mapBounds.width === 0 || mapBounds.height === 0) {
          setMapLoading(false);
          setLocationError("The map area is not visible yet. Close and reopen the map, then try again.");
          return;
        }

        const hasCoordinates = isValidCoordinatePair(latitude, longitude);
        const initialCenter = hasCoordinates
          ? { lat: Number(latitude), lng: Number(longitude) }
          : DEFAULT_CENTER;

        map = new maps.Map(mapElement, {
          center: initialCenter,
          zoom: hasCoordinates ? 16 : 12,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          clickableIcons: false,
        });
        marker = new mapsApi.maps.Marker({
          map,
          position: initialCenter,
          draggable: true,
          visible: hasCoordinates,
          title: "Delivery location",
        });
        geocoderRef.current = new geocoding.Geocoder();
        mapRef.current = map;
        markerRef.current = marker;
        setMapReady(true);
        setMapLoading(false);

        clickListener = map.addListener("click", (event: google.maps.MapMouseEvent) => {
          if (!event.latLng) return;
          pinCoordinates(normalizeCoordinates(event.latLng.lat(), event.latLng.lng()));
        });
        dragListener = marker.addListener("dragend", () => {
          const point = marker?.getPosition();
          if (!point) return;
          pinCoordinates(normalizeCoordinates(point.lat(), point.lng()), false);
          void lookupPincode(normalizeCoordinates(point.lat(), point.lng()));
        });
      } catch (error) {
        if (cancelled) return;
        setMapLoading(false);
        setLocationError(error instanceof Error ? error.message : "Google Maps could not be loaded.");
      }
    };

    // The POS map is inside an animated Radix dialog. Let the opening
    // transition finish so Google Maps initializes against a connected,
    // measurable element.
    mapInitTimer = window.setTimeout(() => void createMap(), 250);

    return () => {
      cancelled = true;
      if (mapInitTimer !== undefined) window.clearTimeout(mapInitTimer);
      clickListener?.remove();
      dragListener?.remove();
      marker?.setMap(null);
      if (map) mapsCleanup(map);
      mapRef.current = null;
      markerRef.current = null;
      geocoderRef.current = null;
    };
  // The map is created once; the following effect syncs incoming coordinates.
  // Recreating the map whenever a pin is selected would interrupt clicks and drags.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker) return;

    if (!isValidCoordinatePair(latitude, longitude)) {
      marker.setVisible(false);
      return;
    }

    const point = { lat: Number(latitude), lng: Number(longitude) };
    marker.setPosition(point);
    marker.setVisible(true);
    map.setCenter(point);
    map.setZoom(Math.max(map.getZoom() ?? 0, 16));
  }, [latitude, longitude, mapReady]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length < 3) {
      setSearchResults([]);
      setSearching(false);
      setLocationError("");
      if (query.length === 0) autocompleteSessionRef.current = null;
      return;
    }

    let cancelled = false;
    setSearching(true);
    setSearchResults([]);
    setLocationError("");
    const timeout = window.setTimeout(async () => {
      try {
        const { places } = await loadGoogleMapsLibraries();
        if (cancelled) return;
        autocompleteSessionRef.current ??= new places.AutocompleteSessionToken();
        const response = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: query,
          includedRegionCodes: ["in"],
          sessionToken: autocompleteSessionRef.current,
        });
        if (cancelled) return;

        const results = response.suggestions.flatMap((suggestion) => {
          const prediction = suggestion.placePrediction;
          if (!prediction) return [];
          return [{
            id: prediction.placeId,
            label: prediction.text.toString(),
            prediction,
          }];
        });
        setSearchResults(results);
        if (results.length === 0) {
          setLocationError("No places found. Try a nearby street, area, or public landmark.");
        }
      } catch (error) {
        if (!cancelled) {
          setLocationError(error instanceof Error
            ? error.message
            : "Location search failed. You can still place a pin on the map.");
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
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
        pinCoordinates(normalizeCoordinates(position.coords.latitude, position.coords.longitude));
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

  const chooseSearchResult = async (result: LocationSearchResult) => {
    setSearching(true);
    setLocationError("");
    try {
      const place = result.prediction.toPlace();
      await place.fetchFields({ fields: ["location"] });
      const point = place.location?.toJSON();
      if (!point || !isValidCoordinatePair(point.lat, point.lng)) {
        setLocationError("That search result did not include valid coordinates.");
        return;
      }

      autocompleteSessionRef.current = null;
      const coordinates = normalizeCoordinates(point.lat, point.lng);
      setSearchResults([]);
      setSearchQuery("");
      pinCoordinates(coordinates);
    } catch {
      setLocationError("Could not load that place. Try another result or click the map.");
    } finally {
      setSearching(false);
    }
  };

  const pinFromMapLink = () => {
    const coordinates = parseMapLinkCoordinates(mapLink);
    if (!coordinates) {
      setPinStatusMessage("Could not find coordinates. Paste a full Google Maps or OpenStreetMap link that includes them.");
      return;
    }

    const roundedCoordinates = normalizeCoordinates(coordinates.latitude, coordinates.longitude);
    setSearchResults([]);
    setSearchQuery("");
    setPinStatusMessage("");
    pinCoordinates(roundedCoordinates);
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
              onClick={() => {
                postcodeLookupIdRef.current += 1;
                setLookingUpPostcode(false);
                onPincodeLookupStateChangeRef.current?.(false);
                markerRef.current?.setVisible(false);
                onChangeRef.current(null);
                setPinStatusMessage("");
              }}
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-600 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear pin
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="space-y-1.5">
          <label htmlFor="address-map-link" className="block text-xs font-semibold text-gray-700">
            Paste a Google Maps or OpenStreetMap link
          </label>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
              <input
                id="address-map-link"
                type="text"
                data-testid="input-address-map-link"
                value={mapLink}
                onChange={(event) => {
                  setMapLink(event.target.value);
                  setPinStatusMessage("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    pinFromMapLink();
                  }
                }}
                placeholder="Paste a link containing map coordinates"
                aria-label="Paste map link"
                autoComplete="off"
                className="h-10 w-full rounded-md border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </div>
            <button
              type="button"
              data-testid="button-pin-from-map-link"
              onClick={pinFromMapLink}
              disabled={!mapLink.trim() || lookingUpPostcode}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-blue-700 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {lookingUpPostcode
                ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                : <MapPin className="h-3.5 w-3.5" />}
              {lookingUpPostcode ? "Looking up…" : "Pin from link"}
            </button>
          </div>
          <p className="text-[10px] leading-4 text-gray-500">
            Exact coordinates are used when included. The pincode is filled automatically when Google provides one.
          </p>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <input
            type="search"
            data-testid="input-address-location-search"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSearchResults([]);
              if (!event.target.value.trim()) autocompleteSessionRef.current = null;
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
              className="absolute z-20 mt-1 max-h-52 w-full overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg"
              role="listbox"
              aria-label="Google Maps location search results"
            >
              {searchResults.map((result) => (
                <button
                  key={result.id}
                  type="button"
                  role="option"
                  aria-selected="false"
                  onClick={() => void chooseSearchResult(result)}
                  className="flex w-full items-start gap-2 border-b border-gray-100 px-3 py-2.5 text-left last:border-b-0 hover:bg-blue-50"
                >
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-700" />
                  <span className="text-xs leading-4 text-gray-800">{result.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <p className="text-[10px] leading-4 text-gray-500">
          Search suggestions are provided by Google Maps. Search for a street, area, or public landmark rather than a customer’s name.
        </p>
        {locationError && <p className="text-xs text-amber-700" role="status">{locationError}</p>}
      </div>

      <div className="relative">
        <div
          ref={mapElementRef}
          data-testid="map-google"
          aria-label="Google Maps delivery location picker"
          className="h-[360px] w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
        />
        {mapLoading && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-gray-100/90 text-sm text-gray-600">
            <LoaderCircle className="mr-2 h-4 w-4 animate-spin text-blue-700" />
            Loading Google Maps…
          </div>
        )}
      </div>

      {pinStatusMessage && <p className="text-xs text-blue-800" role="status">{pinStatusMessage}</p>}
      {hasCoordinates ? (
        <p className="text-xs font-medium text-blue-800" data-testid="text-saved-coordinates">
          Pinned coordinates: {Number(latitude).toFixed(6)}, {Number(longitude).toFixed(6)}
        </p>
      ) : (
        <p className="text-xs text-gray-500">No pin selected. The written address will still be used for delivery.</p>
      )}
      <p className="text-[10px] text-gray-500">
        {lookingUpPostcode ? "Looking up the pincode…" : mapReady ? "Map provided by Google Maps." : ""}
      </p>
    </div>
  );
}

function mapsCleanup(map: google.maps.Map) {
  google.maps.event.clearInstanceListeners(map);
}
