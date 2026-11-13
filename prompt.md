# Prompt: Add automatic next-day scheduling to storefront orders

Copy the prompt below into the storefront application's coding agent.

---

## Prompt to give the storefront application

Implement automatic next-day scheduling for storefront delivery orders. There must be **no customer-facing toggle**. Use the same 5:00 PM India-time cutoff as the admin POS, and persist the order fields so the existing Admin Orders page places the FTW order in **Next Day Orders**.

### Inspect before changing anything

1. Trace the current storefront FTW checkout, order-creation endpoint, payment callback, and database connection.
2. Keep the existing FTW order-ID generation and checkout/payment flow. Do not route storefront orders through an admin-only endpoint if it changes the order ID, source, or payment behavior.
3. The storefront and Admin must write/read the same database, `orders` collection, and compatible order document. Use the existing trusted backend API for writes; never connect to MongoDB directly from browser code or expose a MongoDB URI.
4. The admin classifies orders by their persisted `deliveryDate`. Its Next Day Orders view selects tomorrow's date; after midnight, the same order's delivery date is today and it appears under Current Orders. Preserve the `nextDayOrder` flag as order metadata, but do not require a midnight database migration or cron job.

### Checkout behavior

- For ordinary **delivery** orders placed from **5:00 PM through 11:59 PM Asia/Kolkata**, automatically show a clear message such as **“Next day delivery”** with the expected date.
- Do not add a toggle or require the customer to select this option.
- Persist the delivery date as tomorrow in India time. Before 5:00 PM, keep the existing same-day behavior.
- At midnight Asia/Kolkata, new orders should use the new current date and must not be marked next-day. An existing order scheduled for that date naturally moves into Current Orders because Admin filters by date.
- If checkout remains open across 5:00 PM or midnight, refresh the displayed label/date when the boundary passes and when the page becomes active again. The order submitted must use the correct date, not a stale value from when checkout was opened.
- Apply this to delivery only. Preserve existing takeaway, preorder, or other explicitly scheduled flows; do not overwrite an already selected future date.
- Use `Asia/Kolkata` as the timezone. Do not rely on the browser's local timezone or the VPS's timezone.

### Backend and order persistence

The server must be the source of truth for the cutoff and stored delivery date. The UI message alone is not sufficient. Apply the same rule in the existing trusted FTW order-creation path so a modified or stale browser cannot create a same-day delivery after the cutoff.

For an eligible order, persist these fields on the **same order document** that Admin reads:

```json
{
  "orderId": "#FTW<existing-generated-id>",
  "deliveryType": "delivery",
  "nextDayOrder": true,
  "deliveryDate": "<tomorrow in YYYY-MM-DD format, calculated in Asia/Kolkata>",
  "status": "pending"
}
```

For orders before the cutoff, use the current India date for `deliveryDate` and set `nextDayOrder` to `false` or omit it. Keep the existing FTW ID format and generation sequence exactly as they are.

Do not:

- Create a second order document to represent next-day scheduling.
- Set the order to confirmed or dispatch it to Borzo from the storefront.
- Change the existing FTW payment lifecycle. Keep payment pending until confirmed by the current payment callback; preserve completed and failed behavior.
- Let payment callbacks or retries overwrite `nextDayOrder` or `deliveryDate`.
- Change customer details, address snapshots, optional customer coordinates, items, totals, coupons, delivery charges, payment records, or order source as part of this feature.

Admin uses `nextDayOrder: true` together with a future `deliveryDate` to prevent early acceptance/dispatch. Once the delivery date becomes today, its date-based Current Orders filter should show the order and normal staff acceptance rules apply. Confirm that the storefront backend writes `deliveryDate` as an ISO calendar-date string (`YYYY-MM-DD`), not a timestamp that can shift dates across timezones.

### Verification required

1. A delivery order submitted at 4:59 PM IST keeps today's date and is not marked next-day.
2. A delivery order submitted at 5:00 PM IST is labeled Next Day and is saved with tomorrow's `deliveryDate` and `nextDayOrder: true`.
3. An order submitted at 11:59 PM IST still uses tomorrow's date.
4. A new order submitted after midnight uses the new current date and is not marked next-day.
5. An order scheduled for tomorrow appears in Admin **Next Day Orders**; after midnight it appears in **Current Orders** without creating or copying the order.
6. The storefront continues generating the existing `#FTW...` ID and keeps its payment pending/completed/failed behavior unchanged.
7. A payment callback or retry cannot erase or change the next-day date.
8. Verify with test data or a non-production environment. Do not place a real Borzo delivery as part of testing.
