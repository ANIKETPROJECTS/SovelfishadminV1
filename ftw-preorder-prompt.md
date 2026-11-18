# Prompt: Add a dedicated Preorder section to the FTW storefront

Copy the prompt below into the Replit Agent that runs the FTW storefront.

---

## Prompt to give the FTW application

Implement preorder shopping in the FTW customer website using the preorder product settings already maintained in FishTokri Admin. Add a separate customer-facing **Preorder** section where all eligible preorder-only products are listed. Preorder-only products must not appear in normal browsing, search, recommendations, or normal checkout.

### Inspect before changing anything

1. Trace the storefront's product/catalog API, home page and category navigation, product details, search, recommendations, cart, checkout, order creation, payment callbacks, and sub-hub selection.
2. The Admin product record uses:
   - `preorderMode: "normal" | "preorder_only"`
   - `preorderAvailability`, with `type` equal to `all`, `weekdays`, `date_range`, or `date_range_and_weekdays`; optional fields include `weekdays` (JavaScript weekday numbers, Sunday = 0), `startDate`, and `endDate`.
   - Existing products with no preorder mode should be treated as `"normal"`.
3. Use the existing shared product records and product IDs. Do not create a second preorder catalog or copy products into another collection.
4. The Admin order API supports preorder orders using `orderType: "preorder"` and requires a future `deliveryDate` in `YYYY-MM-DD` format, `deliveryType: "delivery"`, and only saved products marked `preorder_only`. Keep the storefront's existing trusted order-creation and database architecture compatible with these rules.
5. Do not connect to MongoDB from browser code, expose database credentials, or call an Admin-only endpoint from the customer browser. Reuse the storefront's safe catalog API; if it does not include preorder fields, add the minimum required server-side catalog read.

### Separate Preorder section

- Add a clearly visible **Preorder** entry in the storefront navigation and a dedicated page/section styled consistently with the existing site.
- The section must list products whose `preorderMode` is exactly `"preorder_only"` for the currently selected sub-hub. Include all such products in the section, even when their next available delivery date is later; indicate availability and let the customer select a valid date before adding the product to cart.
- Keep normal products in normal storefront browsing. Exclude preorder-only products from normal category listings, search results, recommendations, featured products, and other normal-order product entry points. Do not hide normal products from the normal storefront.
- Keep product availability/status, sub-hub, city/area, and stock rules in effect. Do not show inactive or otherwise unavailable products as orderable.
- A preorder product must not be added to a normal cart/order, and a normal product must not be added to a preorder order.

### Delivery date and product availability

- Require the customer to choose a delivery date strictly after today before adding preorder items to the cart. Use the storefront's existing timezone convention; the Admin/API currently interprets dates in India time.
- Apply the product's saved `preorderAvailability` when determining selectable dates:
  - `all`: any future date.
  - `weekdays`: only future dates whose JavaScript weekday number is in `weekdays`.
  - `date_range`: only future dates from `startDate` through `endDate`, inclusive.
  - `date_range_and_weekdays`: dates must be inside the inclusive range and match a configured weekday.
- Respect empty/missing values safely: missing availability settings should follow the Admin/API default behavior, not make an existing product disappear. If a rule is malformed, fail closed for date selection and show a useful message rather than offering an invalid date.
- On the product page, show the date picker and the product's available date information. Disable unavailable dates and explain when there is no eligible future date.
- When multiple preorder products are in the cart, require one shared delivery date that is valid for every preorder item. If the date changes or an item is removed, revalidate the remaining items and clearly explain any conflict. Do not silently change the date.
- Preorder checkout is delivery-only. Do not offer takeaway or mix preorder and normal items in a single order. Do not add a time-slot requirement as part of this change.

### Product page, cart, and checkout

- Keep the existing product page, weight/variant, pieces/serves, cutting-method, quantity, pricing, and stock behavior. Preorder status changes the order flow, not the product's price or chosen variant.
- Add to cart only after a valid future delivery date is selected. Keep the selected product/variant, exact batch or pack option where applicable, quantity, and preorder delivery date together.
- Display a clear **Preorder** label and the selected delivery date on product details, cart lines, cart summary, and checkout.
- Make the delivery date editable in cart/checkout. When changed, validate it against every preorder product in the cart.
- If the cart contains preorder items, prevent adding normal products and prevent switching to normal checkout until all preorder items are removed. Apply the inverse rule if normal items are already in the cart; explain what the customer needs to do instead of silently removing anything.
- Preserve the preorder type/date through refreshes, sign-in, checkout retries, and payment callbacks.

### Order creation and persistence

- On the existing trusted order-creation path, submit a preorder using the FTW app's existing schema and include semantic fields equivalent to:

  ```json
  {
    "orderType": "preorder",
    "deliveryType": "delivery",
    "deliveryDate": "YYYY-MM-DD",
    "items": [
      {
        "productId": "<saved preorder product ID>",
        "quantity": 1
      }
    ]
  }
  ```

- This is a semantic example, not a replacement schema. Preserve all existing required customer, address, sub-hub, selected weight/batch/pack, pieces/serves, cutting-method, pricing, discount, payment, and order fields.
- Validate on the trusted backend that the delivery date is a valid future date and every submitted product is saved as `preorder_only` and available on that date for the selected sub-hub. Do not trust a browser-supplied `orderType`, product name, price, or availability claim by itself.
- If the FTW order endpoint writes to the same orders collection read by Admin, persist `orderType: "preorder"` and the chosen `deliveryDate` on that order so Admin places it in its separate **Preorders** tab. If the existing endpoint does not support these fields, add only the minimal compatible server-side support; do not create a duplicate order or collection.
- Return clear validation errors for invalid dates, unavailable products, mixed order types, and unavailable delivery. Do not silently convert the order into a normal order.
- Preserve existing payment lifecycle, order identifiers, city/area pricing, delivery charges, inventory deduction, and callbacks. Do not trigger Borzo dispatch or change delivery integration as part of this feature.

### Verification required

1. The navigation opens a separate **Preorder** section and it lists preorder-only products for the selected sub-hub.
2. Preorder-only products do not appear in normal product listings, normal search, recommendations, or normal checkout.
3. Normal products remain available through the normal storefront and cannot be placed in a preorder order.
4. Test date selection for all four availability rules, including date-range boundaries, weekdays, today, and a future date outside the allowed schedule.
5. Test that a product with no future eligible date cannot be added.
6. Test cart refresh, changing the date, removing an item, and attempts to mix normal and preorder products.
7. Submit a test preorder and confirm the saved order has `orderType: "preorder"`, the correct future `deliveryDate`, and the existing correct item/variant details.
8. Confirm the order appears in Admin's **Preorders** tab and is not counted in normal Current or Next Day Orders.
9. Confirm retries/payment callbacks preserve the preorder type and delivery date.
10. Run the storefront build and relevant tests. Use a non-production/test-payment flow; do not place a real delivery or trigger Borzo.

### Completion summary

Report the storefront flows changed, the build/tests run, whether the preorder reached Admin's dedicated tab, and any backend/API changes still required.
