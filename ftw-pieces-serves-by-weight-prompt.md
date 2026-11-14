# Prompt: Show Pieces and Serves for the selected weight in FTW

Copy the prompt below into the Replit Agent that runs the FTW storefront.

---

## Prompt to give the FTW application

Update the FTW storefront so **Pieces** and **Serves** always come from the selected weight, fish batch, or sale-pack option—not from the parent product's legacy values when a more specific value exists.

### Inspect before changing anything

1. Trace the FTW product catalog API, product detail page, weight/variant selector, cart, checkout, trusted order-creation path, and how each product is scoped to a Sub Hub.
2. FishTokri Admin now stores:
   - **Individual fish:** `pieces` and `serves` on each `products[].batches[]` entry. The customer-facing menu should expose available entries as `fishBatches[]`, with `batchId`, `weightKg`, `price`, `quantity`, `pieces`, and `serves`.
   - **Bulk by kg:** `pieces` and `serves` on each `bulkPortionOptions[]` entry. The menu should expose these on the matching `bulkSaleOptions[]` entries, alongside `weightKg`, optional `minWeightKg`/`maxWeightKg`, `price`, `weightLabel`, and `availableQuantity`.
   - **Standard weight variants:** each variant is a separate product record. If it has no batch/pack metadata, read `pieces` and `serves` from the selected variant record, not from its parent product.
3. The current Admin product APIs are authenticated. Do not call an Admin-only route from customer browser code. Reuse the FTW public catalog endpoint if it already provides these fields; otherwise update the trusted FTW backend to read them from the shared MongoDB and return only the required catalog data.
4. Never connect to MongoDB from browser code or expose a MongoDB URI, Admin token, or other credentials. Preserve the FTW application's existing order ID, checkout, payment, city/area pricing, next-day scheduling, and database behavior.

### Product detail page

- Keep the existing **Choose weight** experience.
- After a weight/variant is selected, show the matching values near the product name/details:
  - `Pieces: <selected option's pieces>`
  - `Serves: <selected option's serves>`
- Update both values immediately whenever the customer changes the selected weight or option. Never keep values from the previously selected weight.
- For standard variants, use the selected variant product's own values.
- For bulk-by-kg fish, use the exact selected `bulkSaleOptions[]` entry. For a configured range, use the same option the customer selected; do not choose another option by approximate text or guess its values from the average weight.
- For individual fish, use the selected fish batch's values. Keep the selected `batchId` attached to the choice and order item. If multiple fish have the same weight but different Pieces/Serves values, keep them distinguishable or group them only when their weight and both values match.
- If a selected option has no Pieces or Serves value, hide that value or show a neutral “Not specified” state. Do not fall back to the parent product's old Pieces/Serves fields for `whole_fish` or `bulk_portions` inventory.
- Do not require a Pieces/Serves value for checkout; both are optional descriptive details.

### Cart and order summary

- Carry the selected weight/variant or exact batch/pack option and its Pieces/Serves values into the cart line.
- Show the matching Pieces/Serves under each cart item. Changing the selected weight or batch must refresh these values and any existing stock/price data together.
- If lines are combined, combine only items with the same product/variant or batch/pack option and the same selected Pieces/Serves metadata. Do not overwrite details from one option with another.
- Preserve these values when the page reloads, the customer edits the cart, and checkout resumes.

### Trusted order persistence

- On the existing FTW order-creation path, snapshot the selected values on the matching item:

  ```json
  {
    "productId": "<existing selected product or variant ID>",
    "inventoryBatchId": "<selected fish batch ID, for individual fish>",
    "batchNumber": "<existing batch number, when applicable>",
    "bulkWeightKg": 1,
    "quantity": 1,
    "pieces": "4–5 pieces",
    "serves": "Serves 2"
  }
  ```

- This is a semantic example, not a replacement order schema. Keep all existing FTW item fields and IDs. For bulk portions, keep the existing pack weight/count fields; do not add `inventoryBatchId` unless the current FTW flow already uses one.
- The trusted backend must resolve the selected product, batch, or pack option from current database data and save its authoritative Pieces/Serves values. Do not trust arbitrary values sent by the browser.
- Store the values on the same order item/document that Admin reads, so they remain a snapshot if the inventory metadata changes later. Payment callbacks, retries, order edits, and refreshes must not erase them.
- Do not create a separate database collection or order record for Pieces/Serves. Do not change product price, stock deduction, delivery fee, payment amount, order status, or delivery scheduling as part of this work.

### Verification required

1. For two standard weight variants with different values, selecting each weight immediately shows that variant's Pieces/Serves.
2. For a bulk fish product, each sale-pack option shows its own values; selecting another pack changes both values to that pack's metadata.
3. For individual fish, selecting a fish batch shows that batch's values and retains its exact batch ID through checkout.
4. Missing values do not show stale or parent-product details, and do not block checkout.
5. Cart lines, page reloads, and checkout preserve the matching values for each selected weight/option.
6. Inspect a test order in the shared MongoDB and confirm the order item stores the correct Pieces/Serves snapshot and existing weight/batch fields.
7. Changing a product's or batch's Pieces/Serves after order creation does not change the saved historical order item.
8. Verify in a non-production/test-payment flow. Do not place a real delivery or Borzo dispatch while testing.
