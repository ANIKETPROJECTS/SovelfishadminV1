---
name: Borzo test dispatch
description: Provider, credentials, and retry-safety rules for FishTokri order dispatch.
---

Use Borzo's India test API for confirmed FTS/FTW delivery orders. The documented create-order authentication is the API token in `X-DV-Auth-Token`; the docs do not specify a Client ID field, so do not invent one. Keep production disabled unless the user explicitly asks to switch.

For COD, Borzo requires both `is_cod_cash_voucher_required: true` and `taking_amount` on the delivery point. Sending `taking_amount` without the voucher flag returns `points[1].taking_amount: not_allowed`.

The configured Borzo test account currently returns `cod_agreement_required` when the COD voucher flag is set. The request fields are then valid, but the account's COD agreement must be enabled before COD orders can be accepted.

If a request times out, returns a server error, or otherwise has an uncertain outcome, do not automatically retry. Check the Borzo test dashboard first to avoid duplicate orders.

**Why:** The user replaced Pidge with Borzo and authorized the test environment; Borzo validates COD fields only when the voucher flag is enabled and this account separately requires a COD agreement.

**How to apply:** Keep dispatch limited to eligible delivery orders on confirmation, keep the token server-side, include both COD fields together, and don't repeatedly retry COD after `cod_agreement_required`; have Borzo enable the agreement first.
