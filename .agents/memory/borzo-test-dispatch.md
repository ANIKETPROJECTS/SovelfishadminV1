---
name: Borzo test dispatch
description: Provider, credentials, and retry-safety rules for FishTokri order dispatch.
---

Use Borzo's India test API for confirmed FTS/FTW delivery orders. The documented create-order authentication is the API token in `X-DV-Auth-Token`; the docs do not specify a Client ID field, so do not invent one. Keep production disabled unless the user explicitly asks to switch.

For COD, Borzo requires both `is_cod_cash_voucher_required: true` and `taking_amount` on the delivery point. Sending `taking_amount` without the voucher flag returns `points[1].taking_amount: not_allowed`.

The configured Borzo test account currently returns `cod_agreement_required` when the COD voucher flag is set. The request fields are then valid, but the account's COD agreement must be enabled before COD orders can be accepted.

Borzo production may return HTTP 400 with `errors: ["insufficient_balance"]` when the account cannot fund a delivery. This is a definitive rejection; no Borzo order was created. Add funds before retrying.

**Why:** A production confirmation was rejected with this provider error after authentication succeeded.

**How to apply:** Treat it as an account-balance issue, not a payload or auth problem. Do not retry until the Borzo production account has sufficient funds.

Do not send Borzo's `insurance_amount` field on individual or batch orders. The user wants no insured/declared parcel value because it can add to the delivery fee.

The recipient stop must use the customer delivery address snapshot on the order, never the configured pickup address or a newly changed profile default. Preserve both full-string addresses and structured/legacy address fields.

Customer map coordinates are optional. If both are valid, send `latitude` and `longitude` on the same Borzo point as the required written address; omit incomplete or invalid coordinate pairs.

Nominatim's public endpoint must never be used for autocomplete. For map suggestions, use the OSM-based Photon provider through the server proxy with debouncing, caching, and a reasonable request rate; public Photon has fair-use limits and no availability guarantee. Search only public places/areas, block private flat details and contact data, display provider attribution, and keep the provider endpoint configurable.

For a grouped route, batch 2–98 fully paid delivery orders only when they share the same sub-hub, delivery date, and schedule window. Send one shared pickup and one distinct destination stop per order, retaining each source order ID at its stop. Keep COD out of batches until the account's COD agreement is enabled.

If a request times out, returns a server error, or otherwise has an uncertain outcome, do not automatically retry. Check the Borzo test dashboard first to avoid duplicate orders.

**Why:** The user replaced Pidge with Borzo, authorized the test environment, then asked to omit declared parcel value because insurance increases delivery fees. They also require the recipient to receive the actual customer address. Borzo's point schema keeps the address required while allowing optional coordinates. OpenStreetMap's public Nominatim policy forbids autocomplete and asks apps not to submit personal data; Photon supports search-as-you-type but its shared public instance is fair-use only. A single Borzo route needs one shared pickup and aligned delivery timing; this account separately requires a COD agreement.

**How to apply:** Keep dispatch limited to eligible delivery orders on confirmation, keep the token server-side, omit `insurance_amount`, use the order-time address snapshot without substituting pickup/default customer data, send a complete valid coordinate pair only alongside the written address, include both COD fields together, and don't repeatedly retry COD after `cod_agreement_required`; have Borzo enable the agreement first. For batches, enforce payment, hub, date, schedule, and stop-count constraints on the server, and treat uncertain outcomes as non-retryable until checked. For map search, use debounced Photon suggestions through a server proxy with caching, keep the provider switchable, and never implement autocomplete against public Nominatim.
