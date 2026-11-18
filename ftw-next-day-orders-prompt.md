# Prompt: Add next-day delivery scheduling to the FTW storefront

Copy the prompt below into the Replit Agent that runs the FTW storefront.

---

## Prompt to give the FTW application

Add next-day delivery scheduling to the customer-facing FTW storefront, matching the rules used by FishTokri Admin. Before the cutoff, customers may choose delivery today or tomorrow. From 5:00 PM India time onward, delivery orders must automatically be scheduled for tomorrow. Display the selected delivery date clearly.

### Inspect before changing anything

1. Trace the storefront's delivery selection, cart, checkout, trusted order-creation API, payment callback/retry flow, and how orders are written to the database shared with FishTokri Admin.
2. Admin recognizes next-day delivery using `nextDayOrder: true` and `deliveryDate` as an ISO calendar date (`YYYY-MM-DD`). Its Next Day Orders view shows tomorrow's date. After midnight Asia/Kolkata, that delivery date becomes today and the order naturally appears under Current Orders; do not add a copy, migration, or midnight job.
3. Preserve the existing FTW order ID, source, payment lifecycle, customer/address snapshots, items, prices, discounts, delivery fees, and database architecture. Do not route customer orders through an Admin-only endpoint or access MongoDB from browser code.
4. Next-day scheduling is separate from preorder. Preorders use their own future date and must never be converted into next-day orders.

### Customer-facing delivery choice

- Add a clear **Next day delivery** toggle or choice to the existing delivery/checkout flow.
- Before 5:00 PM Asia/Kolkata, let the customer choose same-day delivery or tomorrow. Default to the storefront's existing same-day behavior unless the existing business flow specifies otherwise.
- When the customer enables next-day delivery, immediately show the expected date (tomorrow in India time) and keep it visible in the cart and checkout summary.
- Starting at 5:00 PM Asia/Kolkata and through 11:59 PM, automatically enable next-day delivery, show tomorrow's date, and prevent the customer from turning it off for a delivery order. Explain that orders placed after the cutoff are delivered the next day.
- If checkout stays open across 5:00 PM or midnight, recalculate the toggle state and date when the cutoff passes, when the page becomes active again, and immediately before submission. Never submit a stale date.
- At midnight Asia/Kolkata, new orders use the new current date and are not automatically marked next-day unless they are submitted after that day's 5:00 PM cutoff. Existing orders scheduled for that date remain unchanged.
- Apply the choice to delivery only. Takeaway must clear/disable next-day scheduling and use the existing pickup behavior.
- Use `Asia/Kolkata` for all cutoff and date calculations. Do not use the visitor's local timezone or the VPS timezone.

### Cart rules

- Keep the chosen delivery date and `nextDayOrder` state attached to the cart/checkout session so refreshes and sign-in do not revert the selection.
- Show the date on each relevant cart/checkout summary and in the final order confirmation.
- If cart contents or delivery type change, re-evaluate next-day eligibility. Do not silently remove items, change the delivery method, or alter prices.
- Preserve all existing availability, stock, city/area, delivery address, and pricing validation.

### Trusted order creation and Admin compatibility

The server—not the browser clock or UI toggle—must be the source of truth. Apply the 5:00 PM cutoff in the trusted FTW order-creation path as well. A stale or modified client must not create a same-day delivery after the cutoff.

For a normal delivery scheduled for tomorrow, save semantic fields equivalent to:

```json
{
  "orderId": "#FTW<existing-generated-id>",
  "orderType": "normal",
  "deliveryType": "delivery",
  "nextDayOrder": true,
  "deliveryDate": "<tomorrow in Asia/Kolkata, YYYY-MM-DD>",
  "status": "pending"
}
```

- This example is not a replacement order schema. Keep every existing required field and the current FTW ID generation unchanged.
- A customer-selected next-day order before the cutoff must also be saved with `nextDayOrder: true` and tomorrow's date.
- After the cutoff, the server must set `nextDayOrder: true` and tomorrow's date for ordinary delivery orders, even if the client omitted or sent a false value.
- For same-day delivery before the cutoff, save today's India date and `nextDayOrder: false` or omit the flag.
- Do not mark takeaway as next-day. Do not set `nextDayOrder` on preorders; preserve their own `orderType: "preorder"` and selected `deliveryDate`.
- Persist these fields on the same order document/collection Admin reads, so tomorrow's order appears in Admin **Next Day Orders**. After midnight, its date-based placement should move it to **Current Orders** automatically.
- Keep payment pending/completed/failed behavior as it is today. Payment callbacks, retries, and order refreshes must not erase or rewrite the saved date or `nextDayOrder` value.
- Do not confirm, dispatch, or send the order to Borzo from the storefront. Preserve Admin's server-side restrictions against accepting or dispatching a future next-day order before its delivery date.

### Verification required

1. At 4:59 PM IST, a delivery can remain same-day, and selecting Next day saves tomorrow's date with `nextDayOrder: true`.
2. At 5:00 PM IST and 11:59 PM IST, ordinary delivery automatically shows and saves tomorrow's date with `nextDayOrder: true`.
3. At midnight IST, a new delivery uses the new current date and is not automatically marked next-day.
4. Takeaway never offers or submits next-day delivery.
5. Preorders retain their own selected date and never receive `nextDayOrder: true`.
6. Verify a delivery checkout left open over the cutoff refreshes its displayed and submitted date correctly.
7. Confirm the saved order appears in Admin **Next Day Orders** before midnight and under **Current Orders** after the delivery date begins, without copying or modifying the order.
8. Confirm payment callbacks/retries preserve the FTW ID, payment lifecycle, `deliveryDate`, and `nextDayOrder`.
9. Test with a non-production/test-payment flow. Do not create a real delivery or dispatch anything to Borzo.

### Completion summary

Report the checkout/cart flows changed, the build and tests run, whether the order appeared in Admin's correct tab, and any remaining backend/API work.
