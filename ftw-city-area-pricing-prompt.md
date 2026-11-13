# Prompt: Add Area/City product pricing to the FTW storefront

Copy the prompt below into the FTW storefront application's coding agent.

---

## Prompt to give the storefront application

Implement the same Area/City pricing behavior used by the FishTokri Admin app in the FTW customer storefront. The city/area charge is added to **each catalog product unit price**. Delivery remains free: postal codes must not add a delivery fee.

### Inspect before changing anything

1. Trace the FTW address form, saved-address flow, catalog pricing, cart, checkout/payment calculation, trusted order-creation backend, and MongoDB order model.
2. Keep the existing FTW order ID generation, payment lifecycle, next-day scheduling behavior, order source, and admin-compatible MongoDB order structure. Do not create a second order or send a Borzo request from storefront checkout.
3. The city/area list is maintained per sub-hub in MongoDB, in the `city_areas` collection. Use the applicable sub-hub's active list as the source of truth; do not hardcode a separate list in the storefront.
4. The existing Admin endpoints `GET /api/sub-hubs/:id/menu/city-areas` and `GET /api/sub-hubs/city-area-options` require Admin authentication. Do not call these from customer-facing browser code unless the customer is legitimately authorized. Reuse a safe public catalog/service-area endpoint if one exists; otherwise add a minimal public read endpoint that returns only active city/area names and charges for the applicable sub-hub. Keep add/edit/delete endpoints Admin-only.
5. Never connect to MongoDB from browser code or expose a MongoDB URI, credentials, or Admin token. Read and write through the FTW trusted backend using its existing server-side database connection.

### Customer address and Area/City selection

- For delivery, require the customer to select an Area/City from the active list for the applicable sub-hub. Do not accept arbitrary typed city names as valid selections.
- Show the selected area's configured charge clearly near the address/checkout summary, for example, “Area charge: ₹100 per product.”
- When a customer chooses a saved address, recognize its `cityArea` value first. For legacy addresses, use `area` or `city` only when that value matches an active configured option. If it is missing or no longer active, ask the customer to select a valid Area/City before checkout.
- Save the selected value consistently on the address using `cityArea`, `area`, and `city` where required by the existing FTW/Admin address format. Keep the pincode as address data only; it must not determine the price or delivery fee.
- Preserve optional latitude/longitude and other existing address details when editing or saving an address.
- Refresh the available options when the applicable sub-hub changes. Show loading, empty, and error states; do not silently substitute a city or a zero charge when the list cannot be loaded.

### Product prices, cart, and checkout

- For each catalog product, calculate the displayed unit price as:

  `base product price + selected Area/City charge`

- Apply the charge per unit, not once per cart line or once per order. Example: a ₹200 product with a ₹100 city charge displays at ₹300 each; quantity 2 contributes ₹600.
- Keep product cards, product details, cart lines, subtotal, coupon/discount calculations, checkout total, and the payment-provider amount consistent with the adjusted unit prices.
- Do not add the Area/City charge as a separate delivery fee. The delivery fee must be ₹0 regardless of pincode. Use the existing FTW field that represents its delivery fee (currently `slotCharge` in the project convention) as appropriate; inspect its actual use before changing it so unrelated charges are not overwritten.
- Recalculate the charge and final order total on the trusted server from the current active Area/City configuration. Treat browser prices and totals as display values only. Ensure the payment amount is based on the same server-calculated total; if the configured charge changed during checkout, refresh/recalculate or stop checkout with a clear message.
- Preserve the existing coupon, tax, wallet, and payment rules, applying them to the adjusted product subtotal according to the current FTW behavior.

### Order persistence and compatibility

Create the order through the existing trusted FTW backend flow and keep its existing FTW order ID exactly as generated. On the same order document that Admin reads, persist the selected Area/City, its charge, the address snapshot, adjusted item prices, and a zero pincode-based delivery fee.

The exact field names must match the current FTW order model and Admin consumers. Use this as the semantic shape, adapting only to the existing schema:

```json
{
  "orderId": "<existing FTW order ID; do not change its format>",
  "deliveryType": "delivery",
  "cityArea": "Thane",
  "cityAreaCharge": 100,
  "deliveryArea": "Thane",
  "deliveryAddressDetail": {
    "area": "Thane",
    "cityArea": "Thane",
    "city": "Thane",
    "pincode": "400606",
    "latitude": 19.123,
    "longitude": 72.987
  },
  "items": [
    {
      "productId": "<existing product ID>",
      "name": "Example product",
      "basePrice": 200,
      "price": 300,
      "cityArea": "Thane",
      "cityAreaCharge": 100,
      "quantity": 2
    }
  ],
  "deliveryCharge": 0
}
```

- Keep all existing required FTW fields, status values, payment records, timestamps, and order-ID behavior; do not copy this example as a replacement schema.
- Store the adjusted unit price in the order item so Admin displays the charged price, while retaining `basePrice` and `cityAreaCharge` for transparency.
- The backend must reject delivery orders with no active selected Area/City, or with a city/area that is not active for the applicable sub-hub.
- Preserve FTW payment pending/completed/failed behavior and the existing `deliveryDate` / `nextDayOrder` rules. A payment callback or retry must not remove or alter the saved Area/City, item pricing, address coordinates, or delivery date.

### Verification required

1. A delivery address cannot proceed without selecting an active Area/City.
2. A valid saved address preselects its active Area/City; an unavailable legacy value requires a new selection.
3. Switching Area/City updates all catalog unit prices, cart lines, and totals. A ₹200 product with a ₹100 charge costs ₹300 per unit; two units cost ₹600 before discounts.
4. A zero-charge area adds ₹0. Changing only the pincode never changes product prices or delivery fees.
5. The customer sees a ₹0 delivery fee, and the order saved in MongoDB records the correct selected city, charge, address, and adjusted item prices.
6. The backend independently validates the Area/City and recomputes item prices and payment total from MongoDB configuration.
7. The order still uses the existing FTW ID, appears correctly in Admin, preserves map coordinates when present, and follows existing payment and next-day behavior.
8. Test in a non-production environment with test payments. Do not create a real delivery or Borzo dispatch while testing.
