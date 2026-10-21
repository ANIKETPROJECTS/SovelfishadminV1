# Issue: Captured FTW payment was not finalized into an admin order

## Summary

A customer completed a Razorpay payment for an online checkout, but the corresponding FTW order did not appear in the Fresh Stock Xchange Admin Orders section. The database contains a matching record in `orders.pendingcheckouts`, but no corresponding finalized record in `orders.orders`.

The current evidence points to a failure between persisting the pending checkout and finalizing the paid order. The database evidence does not by itself identify whether the frontend success handler, payment verification/webhook, API request, or database insert failed.

## Confirmed incident details

- Affected customer: Vikas Kapoor.
- Razorpay order ID: `order_TiBOMix6pSHBxn`.
- Razorpay dashboard screenshot: payment created at about **2:01 PM IST** and captured at about **2:02 PM IST**, September 30, 2026.
- Matching pending checkout:
  - Collection: `orders.pendingcheckouts`
  - MongoDB `_id`: `6abcc88443847e8e14c4be7e`
  - `createdAt`: `2026-09-30T08:29:56.284Z` (**1:59:56 PM IST**)
- The pending checkout payload contains the matching customer, basket and total:
  - Khapri Pomfret, 400–500g, cut pieces + head and tail: quantity 2
  - Chicken Curry Cut, 500g: quantity 1
  - Subtotal: ₹2,275
  - Slot charge: ₹49
  - Total: ₹2,324
  - Delivery slot: 2:30–4:00 PM IST
- The pending payload says `paymentStatus: "paid"` and `paidAmount: 2324`, but its UPI payment `reference` is empty. The payment timestamp in that payload predates the captured time shown in Razorpay, so it is not evidence that capture was verified.
- The `pendingcheckouts` record has no captured payment ID, final FTW order ID, or finalization status.
- A lookup in `orders.orders` found no order with this Razorpay order ID or the screenshot’s payment reference.
- A later manual order, `#FTS2026093068`, was created at **5:20 PM IST** for the same basket and ₹2,324 total. Its source is `admin_manual`. The two inventory deduction history entries are linked to this FTS order and timestamped at its creation time. They are not evidence of an FTW order.

## Why the order was missing in Admin

The Admin Orders API reads the `orders` collection. A document left only in `pendingcheckouts` is not returned to the Orders page, so the pending checkout would remain invisible even though Razorpay shows a captured payment.

## Investigation and fix required in the storefront

Trace the complete checkout lifecycle using `order_TiBOMix6pSHBxn` as the correlation ID:

1. Find where the frontend creates the Razorpay order and persists the pending checkout.
2. Trace the Razorpay success callback and server-side payment verification. Confirm whether the callback fired, what endpoint it called, the response status/body, and whether signature/payment verification passed.
3. Trace any Razorpay webhook handling and server logs for the order ID and payment capture time. Check for timeouts, rejected requests, validation errors, duplicate handling, or MongoDB insert errors.
4. Find the code path that should turn a pending checkout into a finalized order. Confirm why it did not create an FTW document in `orders.orders`.
5. Ensure finalization uses server-verified payment state. Do not mark an order paid from an unverified client payload or set `paidAt` before Razorpay confirms capture.
6. Finalization must be durable and idempotent, keyed by Razorpay order/payment ID. A repeated browser callback or webhook must not create duplicate orders or duplicate inventory changes.
7. Do not rely only on a browser redirect/callback to finalize the order: a customer can close the tab or lose connectivity after payment. Provide a server-side webhook/reconciliation path and a safe retry/recovery path for pending checkouts with captured payments.
8. Keep pending checkouts recoverable and record an explicit finalization state or link to the created FTW order. Log failures with the Razorpay order ID so they can be found without exposing payment secrets.
9. Never connect directly to MongoDB from browser code or ship database credentials to the frontend. Use a trusted backend endpoint/webhook to verify payment and write the order.

## Expected result

After a successful, server-verified capture:

- Exactly one FTW order is created in `orders.orders`.
- The generated order ID starts with `FTW`.
- The order contains the verified payment reference/ID and correct paid amount/status.
- The order appears in the Admin Orders API/page without manual recreation.
- Inventory processing follows the agreed FTW inventory ownership flow and is idempotent; payment retries or duplicate callbacks must not double-deduct.
- Failed, abandoned, or unverified payments do not become paid orders or cause permanent inventory reduction. If inventory was reserved/deducted, the same durable lifecycle must restore it exactly once.

## Acceptance tests

- Successful payment and callback create one FTW order visible in Admin.
- Successful payment followed by closing the browser still results in an order through the webhook/reconciliation path.
- Duplicate success callbacks and duplicate webhooks do not create a second order or repeat inventory changes.
- Failed, abandoned, or merely authorized-but-not-captured payments do not become paid orders.
- A temporary API/network failure can be retried or reconciled without losing a captured payment.
- The created order’s payment and inventory history can be traced back to its Razorpay order/payment IDs.