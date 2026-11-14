export type MapLinkCoordinates = {
  latitude: number;
  longitude: number;
};

function isValidCoordinatePair(latitude: unknown, longitude: unknown): boolean {
  if (latitude === null || latitude === undefined || String(latitude).trim() === "" ||
    longitude === null || longitude === undefined || String(longitude).trim() === "") return false;
  const lat = Number(latitude);
  const lng = Number(longitude);
  return Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

function parseCoordinatePair(value: string | null | undefined): MapLinkCoordinates | null {
  if (!value) return null;
  const parts = value.trim().split(/[,\s/]+/);
  if (parts.length < 2 || !parts[0].trim() || !parts[1].trim()) return null;
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  return isValidCoordinatePair(latitude, longitude) ? { latitude, longitude } : null;
}

export function parseMapLinkCoordinates(value: string): MapLinkCoordinates | null {
  const input = value.trim();
  if (!input) return null;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }

  const osmLatitude = url.searchParams.get("mlat");
  const osmLongitude = url.searchParams.get("mlon");
  const osmCoordinates = parseCoordinatePair(
    osmLatitude != null && osmLongitude != null ? `${osmLatitude},${osmLongitude}` : null,
  );
  if (osmCoordinates) return osmCoordinates;

  let decoded = input;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    // Keep the original URL if it contains an incomplete escape sequence.
  }

  const googleLatitude = decoded.match(/!3d(-?(?:\d+(?:\.\d*)?|\.\d+))/i)?.[1];
  const googleLongitude = decoded.match(/!4d(-?(?:\d+(?:\.\d*)?|\.\d+))/i)?.[1];
  const googlePlaceCoordinates = parseCoordinatePair(
    googleLatitude != null && googleLongitude != null
      ? `${googleLatitude},${googleLongitude}`
      : null,
  );
  if (googlePlaceCoordinates) return googlePlaceCoordinates;

  const mapCenter = decoded.match(/@(-?(?:\d+(?:\.\d*)?|\.\d+)),\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/);
  const centerCoordinates = parseCoordinatePair(
    mapCenter ? `${mapCenter[1]},${mapCenter[2]}` : null,
  );
  if (centerCoordinates) return centerCoordinates;

  const hashMap = url.hash.match(/(?:^|[#&])map=\d+(?:\.\d+)?\/(-?(?:\d+(?:\.\d*)?|\.\d+))\/(-?(?:\d+(?:\.\d*)?|\.\d+))/);
  const hashCoordinates = parseCoordinatePair(
    hashMap ? `${hashMap[1]},${hashMap[2]}` : null,
  );
  if (hashCoordinates) return hashCoordinates;

  for (const key of ["q", "ll", "center"]) {
    const coordinates = parseCoordinatePair(url.searchParams.get(key));
    if (coordinates) return coordinates;
  }

  return null;
}
