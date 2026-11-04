# Product Catalog and Inventory Data Guide

This document describes how products, sellable variants, fish sale options, and inventory batches are represented in FishTokri, and how another application can read the same data.

## Recommended integration: use the API

The POS loads its product catalog from:

```http
GET /api/sub-hubs/{subHubId}/menu/products
Authorization: Bearer <authorized-session-token>
```

The response is shaped like:

```json
{
  "products": [
    {
      "_id": "PRODUCT_OBJECT_ID",
      "name": "Example Fish",
      "category": "Example Fish",
      "price": 750,
      "unit": "kg",
      "quantity": 20,
      "fishInventoryMode": "bulk_portions"
    }
  ],
  "total": 1
}
```

The POS uses this endpoint because it returns sale-oriented values, including available quantity and calculated bulk-fish sale options. The API requires an authenticated session, and the account must have access to the requested sub-hub. Requests without a valid token receive `401`; requests outside the account's sub-hub scope are denied.

For inventory screens that need the full batch list, use:

```http
GET /api/inventory/products?subHubId={subHubId}
Authorization: Bearer <authorized-session-token>
```

That response includes batches and inventory-management fields. The POS itself requests the menu endpoint above; it does not use the inventory endpoint to construct its sale cards.

Product variants can also be fetched as a group:

```http
GET /api/sub-hubs/{subHubId}/menu/products/{productId}/variants
Authorization: Bearer <authorized-session-token>
```

The response is `{ "groupId": "...", "variants": [...] }`. For standard products, it returns the records in that variant group. For fish products, it returns the single fish root record because fish pack sizes are not separate product variants.

### Authentication and database safety

- The API expects a FishTokri JWT in the `Authorization: Bearer ...` header. The existing POS obtains this through the app's sign-in flow.
- Keep session tokens and any database credentials on a trusted server. Do not put them in browser code, mobile bundles, source control, or API responses.
- Sharing `MONGODB_URI` does **not** mean every sub-hub's products are in the URI's default database. Each sub-hub has a `dbName`, and the API connects to that specific database when serving menu or inventory requests.
- If directly reading MongoDB from a server is unavoidable, first resolve the target sub-hub's `dbName` from the central hub metadata, then read that sub-hub database's `products` collection. Do not guess the database name or read/write a guessed default database. The API is preferred because it handles this routing, access scope, and sale-availability calculations.
- For a separate application that needs unattended server-to-server access, use an appropriately restricted server-side identity or add a dedicated service-auth mechanism. Do not reuse a master-admin password or expose the MongoDB URI.

## Product document: common fields

Products are documents in the `products` collection of a sub-hub database. Mongo `_id` values are ObjectIds in storage and are represented as strings in JSON responses. The product API returns stored fields plus some derived fields; the exact set varies by product type.

Common fields include:

| Field | Meaning |
| --- | --- |
| `_id` | Stable product ID. Use this ID when referring to the product in a cart/order. |
| `name` | Product name. |
| `description` | Product details shown in the menu. |
| `category`, `subCategory` | Menu grouping. |
| `shortCode` | Optional short product code. |
| `price` | Standard product price; for fish inventory modes, the menu response uses the fish selling rate per kg when one is configured. |
| `originalPrice`, `discountPct` | Optional display/discount values. |
| `unit` | Selling unit, such as `kg`, `per pack`, or `per fish`. Variant groups share the root product's unit. Fish menu responses derive their unit from the stock mode. |
| `quantity` | Stored/legacy quantity or an API-derived available quantity. Prefer the menu endpoint's value for sale display. |
| `status` | Product availability status; commonly `available`. |
| `isArchived` | Archived products must not be offered for new POS sales. The current POS filters out records where this is `true`. |
| `imageUrl` | Product image URL, if set. |
| `weight`, `grossWeight`, `netWeight`, `pieces`, `serves` | Optional package/portion metadata. |
| `batches` | Embedded stock batches, when batch tracking is used. |
| `createdAt`, `updatedAt` | Record timestamps. |

Other optional catalog fields include `limitedStockNote`, `lowStockThreshold`, `recipes`, `sectionId`, `couponIds`, `preorderMode`, and `preorderAvailability`. `preorderMode` currently has the supported values `normal` and `preorder_only`. They are not needed to identify the product, price, variant, or stock batch.

## Standard products and weight variants

For ordinary products sold in multiple sizes, each size is its **own product document**. The records are connected with `variantGroupId`.

- Each variant has its own `_id`, price, quantity, and batches.
- Variants in a group share the same `variantGroupId`; that ID points to the original/root product ID. Once a product has variants, the root record also has `variantGroupId` set to its own ID.
- The root record is retained as the first variant. Do not assume a root record is only a non-sellable parent.
- `netWeight` is the preferred variant label. Older records may use `variantLabel`, `weight`, or `grossWeight`.
- `variantLabel` may be derived by the API. Use `variantGroupId` to group records and each record's `_id` as its distinct sellable ID.
- The API returns standard variant records as individual products in the menu list. A client can group them for display, or display them as separate POS cards as the current POS does.

Example group:

```json
[
  {
    "_id": "ROOT_PRODUCT_ID",
    "name": "Basa",
    "variantGroupId": "ROOT_PRODUCT_ID",
    "netWeight": "500 g",
    "variantLabel": "500 g",
    "price": 500,
    "unit": "per pack",
    "batches": []
  },
  {
    "_id": "SECOND_VARIANT_ID",
    "name": "Basa",
    "variantGroupId": "ROOT_PRODUCT_ID",
    "netWeight": "1 kg",
    "variantLabel": "1 kg",
    "price": 1000,
    "unit": "per pack",
    "batches": []
  }
]
```

The values above are illustrative only; actual weights, units, prices, and IDs come from the sub-hub's data.

## Inventory batches

Stock is embedded in each product document as an array. A typical batch has this shape:

```json
{
  "_id": "BATCH_OBJECT_ID",
  "batchNumber": "LOT-EXAMPLE-001",
  "quantity": 12,
  "shelfLifeDays": 3,
  "receivedDate": "2026-11-04T00:00:00.000Z",
  "expiryDate": "2026-11-07T00:00:00.000Z",
  "notes": "",
  "createdAt": "2026-11-04T00:00:00.000Z"
}
```

`quantity` is in the product's inventory unit. For a normal packaged product it is the number of packs/items; for bulk-portion fish it is kilograms; for whole fish it is a fish count (normally one per batch).

### Which quantity should a selling app use?

- Use `quantity` returned by `/menu/products` to decide whether stock is available for a sale. That endpoint excludes expired batch quantity from the sale-facing total and falls back to the stored product quantity for legacy products without batches.
- Do not add `product.quantity` to `batches[].quantity`; when batches are present, quantity is represented by the batches.
- Expired and zero-quantity batches may still be present for inventory/history purposes. Their presence does not make them sellable.
- Batch deductions use eligible batches ordered by earliest expiry. If an order is cancelled, the API restores the deduction to the original batch allocation.
- Do not implement stock deductions or restorations by writing Mongo documents from the other app. Fetching can be read-only; any order/stock mutations should go through an authorized API flow so batch allocations remain consistent.

## Fish products: one catalog product, two stock modes

Fish species remain a single product record. Fish sell-size options are not ordinary `variantGroupId` sub-products. The root product uses `fishInventoryMode`:

| `fishInventoryMode` | Inventory meaning |
| --- | --- |
| `standard` | Normal product/batch behavior. Missing mode is treated as `standard`. |
| `whole_fish` | Each fish is a separate batch with its own weight and total price. Legacy `wholeFishInventory: true` also means `whole_fish`. |
| `bulk_portions` | Shared stock is measured in kg and sold as configured exact-weight or ranged packs. |

Fish-specific fields include:

| Field | Meaning |
| --- | --- |
| `fishInventoryMode` | Fish stock mode. |
| `wholeFishInventory` | Legacy/compatibility boolean for whole-fish mode. |
| `fishPricePerKg` | Customer selling rate per kg used to calculate fish prices. |
| `bulkPortionOptions` | Bulk portion definitions; may contain exact weights or ranges. |
| `bulkPortionWeightsKg` | Legacy exact-weight list, retained for compatibility with older records. |
| `fishBatches` | Derived menu response list of eligible, individually priced whole fish. |
| `bulkSaleOptions` | Derived menu response list with customer-facing labels, prices, and available pack counts for bulk fish. |
| `unpricedFishCount` | Derived count of available whole-fish inventory missing valid weight/price details. |

Fish categories default to the fish product's name when no category is set.

### Whole-fish batches

Each whole fish is one batch, generally with `quantity: 1` and these extra batch fields:

```json
{
  "_id": "FISH_BATCH_ID",
  "batchNumber": "FISH-LOT-001",
  "quantity": 1,
  "fishWeightKg": 0.85,
  "fishPrice": 638,
  "fishPricePerKg": 750,
  "expiryDate": "2026-11-06T00:00:00.000Z"
}
```

The displayed fish price is the total per fish: `round(fishWeightKg × fishPricePerKg)`. The menu endpoint exposes valid available fish in `fishBatches`, including `batchId`, `weightKg`, `price`, `quantity`, and `expiryDate`. A selling client must retain the selected `batchId` when constructing a cart/order item; the same fish species can have multiple fish batches with different weights and prices.

### Bulk portions and weight ranges

Bulk stock is held in ordinary batches with kg quantities. Sale options are stored on the fish product:

```json
{
  "fishInventoryMode": "bulk_portions",
  "fishPricePerKg": 1000,
  "bulkPortionOptions": [
    { "weightKg": 0.5 },
    { "weightKg": 0.525, "minWeightKg": 0.5, "maxWeightKg": 0.55 }
  ]
}
```

- An exact option has `weightKg` only.
- A ranged option has `minWeightKg` and `maxWeightKg`. `weightKg` is the midpoint, rounded to the nearest gram.
- The range above represents 500–550 g and has an effective average weight of 525 g.
- The menu response includes `bulkSaleOptions`. Each option has `weightKg`, optional min/max values, `weightLabel`, `averageWeightLabel`, `price`, and `availableQuantity`.
- Calculated price is `round(weightKg × fishPricePerKg)` in whole rupees. In the example, 0.525 kg at ₹1,000/kg displays as ₹525.
- The sale-facing available pack count is calculated from eligible kg stock divided by the effective weight. For a ranged option, the midpoint is the weight used for displayed price, estimated pack availability, and stock deduction.
- When a pack is sold, the stock deduction is pack count multiplied by the option's effective `weightKg`. Keep the selected option/range and effective weight with the order line; do not recalculate from an independently chosen value.
- Older products may only have `bulkPortionWeightsKg`. The API normalizes those values into exact-weight sale options.

## Example menu response: bulk-portion fish

This abbreviated example shows the fields a customer-facing client should use:

```json
{
  "_id": "FISH_PRODUCT_ID",
  "name": "Example Fish",
  "category": "Example Fish",
  "price": 1000,
  "unit": "kg",
  "quantity": 10,
  "fishInventoryMode": "bulk_portions",
  "wholeFishInventory": false,
  "fishPricePerKg": 1000,
  "bulkPortionOptions": [
    { "weightKg": 0.525, "minWeightKg": 0.5, "maxWeightKg": 0.55 }
  ],
  "bulkSaleOptions": [
    {
      "weightKg": 0.525,
      "minWeightKg": 0.5,
      "maxWeightKg": 0.55,
      "weightLabel": "500 g–550 g",
      "averageWeightLabel": "525 g",
      "price": 525,
      "availableQuantity": 19
    }
  ]
}
```

The example is illustrative. The production response may contain additional stored product fields and the raw `batches` array.

## Suggested client behavior

1. Authenticate to the FishTokri API on a trusted server and retain the token securely.
2. Resolve the chosen sub-hub and request `/api/sub-hubs/{subHubId}/menu/products`.
3. Exclude `isArchived: true` products. Use the menu response's `quantity` and fish-specific sale fields for the sale UI.
4. For standard size variants, use each product `_id` as a distinct sellable item and `variantGroupId` to identify siblings.
5. For whole-fish mode, present the `fishBatches` entries and preserve the selected `batchId`.
6. For bulk-fish mode, present `bulkSaleOptions` and preserve the selected option's exact/range bounds and effective `weightKg`.
7. Treat inventory as read-only in the customer-facing app. Create or update orders through an authorized API flow, not direct Mongo writes.

## Source of truth in this project

The behavior documented here is implemented in:

- POS catalog loading: `artifacts/fishtokri-admin/src/pages/orders.tsx`
- Menu product API and derived sale data: `artifacts/api-server/src/routes/sub-hub-menu.ts`
- Inventory product/batch API: `artifacts/api-server/src/routes/inventory.ts`
- Bulk range normalization, midpoint, and stock quantity helpers: `artifacts/api-server/src/routes/inventory-batch-order.mjs`
- Per-sub-hub database selection: `artifacts/api-server/src/db/sub-hub-connections.ts`

