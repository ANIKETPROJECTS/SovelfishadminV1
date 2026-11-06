---
name: Borzo test dispatch
description: Provider, credentials, and retry-safety rules for FishTokri order dispatch.
---

Use Borzo's India test API for confirmed FTS/FTW delivery orders. The documented create-order authentication is the API token in `X-DV-Auth-Token`; the docs do not specify a Client ID field, so do not invent one. Keep production disabled unless the user explicitly asks to switch.

For COD, Borzo requires both `is_cod_cash_voucher_required: true` and `taking_amount` on the delivery point. Sending `taking_amount` without the voucher flag returns `points[1].taking_amount: not_allowed`.

The configured Borzo test account currently returns `cod_agreement_required` when the COD voucher flag is set. The request fields are then valid, but the account's COD agreement must be enabled before COD orders can be accepted.

Send the merchandise subtotal as Borzo's `insurance_amount` (a two-decimal money string), falling back to the sum of item prices when the subtotal is absent. This is the declared/insured goods value, not Borzo's delivery price, and may incur insurance fees.

The recipient stop must use the customer delivery address snapshot on the order, never the configured pickup address or a newly changed profile default. Preserve both full-string addresses and structured/legacy address fields.

Customer map coordinates are optional. If both are valid, send `latitude` and `longitude` on the same Borzo point as the required written address; omit incomplete or invalid coordinate pairs.

For a grouped route, batch 2–98 fully paid delivery orders only when they share the same sub-hub, delivery date, and schedule window. Send one shared pickup and one distinct destination stop per order, retaining each source order ID at its stop. Keep COD out of batches until the account's COD agreement is enabled.

If a request times out, returns a server error, or otherwise has an uncertain outcome, do not automatically retry. Check the Borzo test dashboard first to avoid duplicate orders.

**Why:** The user replaced Pidge with Borzo, authorized the test environment, chose to declare goods value, and explicitly required the recipient to receive the actual customer address. Borzo's point schema keeps the address required while allowing optional coordinates. A single Borzo route needs one shared pickup and aligned delivery timing; this account separately requires a COD agreement.

**How to apply:** Keep dispatch limited to eligible delivery orders on confirmation, keep the token server-side, declare goods separately from delivery charges, use the order-time address snapshot without substituting pickup/default customer data, send a complete valid coordinate pair only alongside the written address, include both COD fields together, and don't repeatedly retry COD after `cod_agreement_required`; have Borzo enable the agreement first. For batches, enforce payment, hub, date, schedule, and stop-count constraints on the server, and treat uncertain outcomes as non-retryable until checked.
