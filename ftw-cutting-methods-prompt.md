# Prompt: Add product cutting choices to the FTW storefront

Copy the prompt below into the Replit Agent that runs the FTW storefront.

---

## Prompt to give the FTW application

Add optional cutting-method choices to the FTW product page, cart, and order submission. Customers should choose methods from the list already configured for that product in FishTokri Admin. They may select no method, one method, or multiple methods.

### Inspect before changing anything

1. Trace the existing product detail page, weight/variant selection, add-to-cart flow, cart editing, checkout, order creation, payment callbacks, and the applicable sub-hub/database selection.
2. FishTokri Admin already saves each product's allowed methods in its `cuttingMethods` string array. Reuse that product data; do not create a second method catalog, hardcode method names, or change the Admin method-management feature.
3. The Admin order API stores selections on each order item as `cuttingMethods: string[]` and validates the names against the selected product's current saved methods. Keep FTW orders compatible with this shape so Admin can display the choices.
4. If the FTW app cannot safely read `cuttingMethods` through its existing public product/catalog service, add only the minimum safe server-side read needed. Do not expose Admin credentials or call Admin-authenticated catalog-management routes from customer browser code.
5. Never connect to MongoDB from browser code or expose a MongoDB URI. Use the FTW application's trusted backend and preserve its existing database and order-writing architecture.

### Product page and weight selection

- Follow the existing product-page design and interaction: after the customer selects a weight/variant, show that selected product's available methods in a clearly labeled section such as **Choose cutting method (optional)**.
- Render the methods as independent checkboxes, not single-select radio buttons. Selecting none, one, or multiple methods must work.
- Use only the methods from the selected product/weight's `cuttingMethods` array. If the array is empty or missing, do not show an empty selector and keep the existing product page behavior.
- Do not preselect any method.
- Keep selections associated with the chosen product/weight. If a customer changes products or selects a variant with different available methods, clear selections that are no longer valid. Do not submit stale method names.
- Do not change product prices, weight prices, stock handling, or quantity behavior because of cutting selections.

### Cart behavior

- Save the selected method names with the cart line as a `cuttingMethods` array.
- Show the selected method names under the product/weight in the cart and order summary. If none were selected, either omit the line or clearly show that no cutting was selected.
- Let the customer edit the selection in the cart using the same optional multi-select behavior.
- Treat the method selection as part of a cart line's identity. Do not merge lines with different method selections into one line and lose either selection. Quantity changes on a line apply to that line's selected methods.
- Preserve the selected product/weight, quantity, price, and methods through cart refreshes and the existing checkout flow.

### Order creation and persistence

- Include the selection on the matching order item when submitting checkout:

  ```json
  {
    "productId": "<existing selected product or weight-variant ID>",
    "name": "<existing item name>",
    "price": "<existing unit price>",
    "quantity": 1,
    "cuttingMethods": ["Curry cut", "Remove scales"]
  }
  ```

- The example is semantic only. Adapt to the current FTW order schema and keep all existing required item and order fields.
- When no method is selected, send an empty array or omit `cuttingMethods`; do not invent a default.
- Validate selections on the trusted server against the allowed methods on the selected product in the applicable sub-hub. Do not trust method names supplied by the browser. Reject invalid or stale choices with a clear checkout error rather than silently saving them.
- Persist the validated array on each item in the same order document and collection that Admin reads. Do not create a second order, collection, or method record.
- Preserve the existing FTW order ID, order source, city/area pricing, free delivery fee, next-day scheduling, inventory/weight fields, discounts, payment lifecycle, and payment callback behavior. Callbacks and retries must not erase or overwrite `cuttingMethods`.
- Do not confirm or dispatch the order to Borzo as part of this change.

### Verification required

1. A product without configured cutting methods still works as before and has no empty selector.
2. For a product with methods, choosing none, one, or multiple methods works for each weight/variant.
3. Changing the selected weight or product cannot leave invalid method choices in the cart or submitted order.
4. The cart shows the saved choices, allows editing them, and keeps different method selections on separate lines.
5. After checkout, inspect the order document and confirm each item has the correct `cuttingMethods` array.
6. Confirm the order appears in Admin with its cutting selections visible in the order list/details, and that editing/payment callbacks do not erase them.
7. A tampered or stale method name is rejected by the trusted backend.
8. Test with a non-production order/payment flow. Do not place a real delivery or Borzo dispatch while testing.
