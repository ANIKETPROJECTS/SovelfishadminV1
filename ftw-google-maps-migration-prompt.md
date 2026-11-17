# Prompt: Replace the FTW storefront's OpenStreetMap picker with Google Maps

Please update the **FTW storefront application in this Replit** to replace the current OpenStreetMap-based delivery-pin picker with Google Maps.

The Google Maps API key is already stored in this Replit's Secrets, and the required Google services are enabled:

- Maps JavaScript API
- Places API (New)
- Geocoding API

## Important credential handling

- Find and use the existing Google Maps key from the Replit environment. For a Vite app, the expected variable is `VITE_GOOGLE_MAPS_API_KEY`; if this app uses a different framework or the existing secret has a different name, follow that project's convention and use the existing secret.
- Do not ask me to paste the key into chat, print it, commit it, put it in source code, or add it to a checked-in `.env` file.
- A browser Maps key is visible to visitors. Keep it protected by Google Cloud website/referrer restrictions and API restrictions; do not treat a frontend environment variable as a hidden credential.

## First inspect the existing storefront

Locate the current OpenStreetMap/Leaflet map, location search, marker state, and saved-address flows. The screenshot reference is the storefront's **“Set delivery pin”** dialog, currently showing OpenStreetMap tiles, search, “Use current location,” a pin, and a save action.

Trace every place that opens or displays a delivery pin, including:

- The customer profile's saved-address form and pin dialog
- Address editing and adding a new address
- Any checkout or delivery-address flow that reuses the map
- Any saved-pin preview

Follow the current app's framework, API, form, and styling conventions. Make the change in the existing storefront artifact; do not create a second app or bypass authentication.

## Required behavior

1. Replace the active OSM map tiles with an interactive Google Map using the existing restricted API key.
2. Replace active Photon/Nominatim search-as-you-type with Google Places Autocomplete (New), using session tokens and requesting place details only after the customer selects a suggestion. Limit results to India where the existing address flow is India-specific.
3. Keep the current search field, suggestions, “Use current location” action, pin placement, clear/cancel/save behavior, and responsive layout. Selecting a suggestion should center the map and place the marker there.
4. Let the customer set the pin by clicking the map and adjust it by dragging the marker. Keep coordinates synchronized with the form's existing latitude/longitude fields.
5. Use Google reverse geocoding after a pin is selected or moved to find the Indian six-digit postcode/pincode. Fill the existing pincode field only when a valid pincode is returned; if Google has none or the request fails, leave the address usable and allow manual pincode entry. Do not replace a newer pin's postcode with a late response from an earlier lookup.
6. Save and reload the selected coordinates using the storefront's existing address API and data format. Do not change address persistence, customer identity, area/city selection, pricing, delivery fees, or order behavior as part of this map-provider change.
7. Keep the existing map link/coordinate parsing behavior if the storefront currently supports it. Do not remove support for pasted OpenStreetMap links solely because the displayed map changes to Google.
8. Keep map attribution and Google branding visible and unobstructed. Search only for public places, streets, or localities; do not send customer names or private address details as autocomplete queries.

## Implementation and safety

- Load the Maps JavaScript API once and reuse it wherever the picker or saved-pin preview is rendered.
- Use Google's current Maps JavaScript API and Places Autocomplete Data API, rather than introducing a deprecated autocomplete API.
- Show a clear error if the key is missing, rejected, or a required API is unavailable. Do not silently fall back to OSM.
- Keep API calls scoped to the map, Places, and geocoding services needed for this feature.
- Remove Leaflet/OSM frontend dependencies only if a project-wide search confirms nothing else uses them. Do not remove shared backend endpoints until you confirm no other storefront client depends on them.
- Preserve existing customer authentication and authorization.

## Verify before finishing

- Run the storefront's build and relevant tests/type checks.
- Check the browser console for Google Maps authorization, billing, referrer, and API errors.
- Test adding an address, editing an address, selecting a search suggestion, clicking and dragging the pin, using current location, postcode autofill, saving, reopening, and cancelling.
- Test both a location with a returned six-digit pincode and one where no pincode is returned.
- Verify the saved map preview uses Google Maps and that the map remains usable on a narrow/mobile viewport.
- Do not claim the external Google integration passed unless you actually verify the map loads with this Replit's key. If the preview requires login and cannot be accessed, state that limitation and provide exact manual verification steps.

## Completion summary

When finished, report:

- Which storefront flows now use Google Maps
- Build/tests and browser verification results
- Any required Google Cloud referrer/API restriction adjustments
- Any remaining OSM dependencies or endpoints intentionally retained for other clients
