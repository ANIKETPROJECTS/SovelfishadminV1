# Prompt: Add optional OpenStreetMap pins to storefront customer addresses

Copy the prompt below into the frontend application's coding agent.

---

## Prompt to give the frontend application

Implement optional exact map pins for customer addresses in the Fresh Stock Xchange storefront. Do not change the existing FTW order-ID generation, order numbering, payment lifecycle, checkout behavior, or order endpoint.

### Before coding

Inspect the frontend application's current customer profile/address APIs and its current FTW checkout/order-creation path. Use the existing trusted backend for customer and order writes; do not connect to MongoDB from browser code or expose database credentials. Preserve all existing fields and behavior, adding only the optional coordinates described below.

### Address form and OpenStreetMap

1. Add an optional button labeled **Map** to both add-address and edit-address forms. The map pin must never be required to save an address or place an order.
2. Open a map picker using Leaflet and OpenStreetMap tiles, with visible OpenStreetMap attribution. Let the customer search for a public place/address, choose a result, or tap/click the map to place or move a pin. Include clear-pin and cancel/save-pin actions.
3. Searching should show results as the customer types, with a short debounce and a visible result list above the map. Search only public location text. Never send the customer's name, phone, apartment/flat number, or other private profile data to a geocoder.
4. Store the selected pin inside that address object as numeric `latitude` and `longitude`. Do not geocode an address automatically and present the result as an exact customer pin; only coordinates explicitly selected or confirmed by the customer count as a pin.
5. Keep coordinates optional. With no pin, omit both `latitude` and `longitude` from the saved address. If a pin is cleared, remove both fields rather than keeping stale values.
6. When an address is selected or edited, recognize an existing pin only if **both** coordinates are present, finite numbers, and in range (`latitude` −90…90; `longitude` −180…180). If valid, initialize the map at that point and show its marker. If neither is present, show the normal unpinned map. If only one or an invalid value is present, do not invent the missing coordinate; treat it as unpinned and let the customer choose a new valid pin.
7. Save coordinates with the exact address being edited. Do not copy a pin to another saved address just because its text looks similar.

### Customer address persistence

Persist the address and its coordinates together in the customer's `addresses` array through the existing customer-profile API. The current admin API's compatible address object uses these fields:

```json
{
  "label": "Home",
  "type": "house",
  "name": "Customer or recipient name",
  "phone": "10-digit phone",
  "houseNo": "Flat or house number",
  "building": "Building or society",
  "street": "Street",
  "addressLine2": "",
  "area": "Locality",
  "landmark": "",
  "city": "Thane",
  "state": "Maharashtra",
  "pincode": "400606",
  "instructions": "",
  "isDefault": true,
  "latitude": 19.123456,
  "longitude": 72.123456
}
```

The coordinate fields above are illustrative. Include them only when the customer has explicitly saved a valid pin; send both or neither. The current API validates this pair and stores it as numbers. Keep all other existing address fields intact when updating an address array; do not replace the array with only the edited address.

When returning saved addresses to the frontend, preserve `latitude` and `longitude`. To tell whether a selected address already has a pin, inspect that selected address object and validate its coordinate pair as above—do not compare address text or infer coordinates from a different address.

### FTW order

Keep the current storefront FTW creation path and its generated order ID exactly as it is. Continue using the existing `#FTW...` order ID and current sequencing. Do not generate a new ID in the map component, rename FTW to FTS, or send FTW orders through an admin-only order-creation path that generates an FTS ID.

At checkout, take a snapshot of the selected delivery address. Continue sending the existing human-readable `address` and `deliveryArea` fields, and put the structured selected address—including the optional coordinates—inside `deliveryAddressDetail`. The order should retain its current customer, item, totals, payment, source, status, and schedule fields. The relevant structure is:

```json
{
  "orderId": "<the existing FTW-generated ID>",
  "customerId": "<existing customer ID>",
  "customerName": "Customer name",
  "phone": "Customer phone",
  "email": "Customer email, if present",
  "deliveryType": "delivery",
  "address": "Full human-readable delivery address",
  "deliveryArea": "Locality",
  "deliveryAddressDetail": {
    "label": "Home",
    "type": "house",
    "name": "Recipient name",
    "phone": "Recipient phone",
    "houseNo": "Flat or house number",
    "building": "Building or society",
    "street": "Street",
    "addressLine2": "",
    "area": "Locality",
    "landmark": "",
    "city": "Thane",
    "state": "Maharashtra",
    "pincode": "400606",
    "instructions": "",
    "latitude": 19.123456,
    "longitude": 72.123456
  },
  "items": [
    {
      "productId": "<product ID>",
      "name": "Product name",
      "price": 520,
      "quantity": 1,
      "unit": "pack",
      "bulkWeightKg": 1
    }
  ],
  "subtotal": 520,
  "discount": 0,
  "deliveryCharge": 0,
  "total": 520
}
```

This is a shape example, not a replacement for the current FTW payload. Keep the frontend's existing required totals, payment fields, status, schedule fields, and any other established fields. If the selected address has no valid pin, omit both coordinate keys from `deliveryAddressDetail` but still send the normal address text and structured address. Do not send `0,0`, null-island coordinates, or coordinates from a previous selection.

The current API and delivery integration read the recipient coordinates from `deliveryAddressDetail.latitude` and `deliveryAddressDetail.longitude`. Keep the coordinates there as well as in the customer's saved address. Do not put them only at the top level of the order or only in the customer profile.

### Save/order sequencing

- If the customer saves a new or edited address to their profile, persist the whole updated `addresses` array first and use the returned/current address object.
- When checkout proceeds, copy the chosen address into `deliveryAddressDetail` as an order-time snapshot. Do not mutate an older order if the customer later changes their saved address.
- If the customer does not choose **Save to profile**, the checkout address can still include its pin in that order's `deliveryAddressDetail`; do not silently add it to the profile without consent.
- Keep map state scoped to the selected address and clear it when changing to a different unpinned address.
- Show a clear loading state and useful error when address/profile saving fails; do not report success before the backend confirms it.

### Verify before finishing

1. A customer can save an address without opening the map.
2. A customer can set a pin and save; reopening that same address shows the marker and saved coordinates.
3. An existing address with a valid coordinate pair opens centered on that saved point.
4. An address without coordinates remains unpinned and still works for checkout.
5. A checkout using a pinned address sends numeric coordinates in `deliveryAddressDetail`; an unpinned checkout omits both.
6. Editing one address preserves other addresses and does not transfer coordinates between them.
7. FTW order IDs and all existing FTW payment/order behavior remain unchanged.

---

## Contract notes from the current application

- Customer records store saved addresses in a `customers` database collection, with address objects in `addresses`.
- The current address sanitizer keeps the standard address fields listed above and accepts numeric `latitude` and `longitude` only as a valid pair.
- The order snapshot field is `deliveryAddressDetail`. Keep the top-level `address` string for compatibility and normal delivery-address validation.
- The current admin `POST /api/orders` route generates `#FTS...` IDs. The storefront must preserve its separate existing `#FTW...` generation path.
