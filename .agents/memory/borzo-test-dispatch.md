---
name: Borzo test dispatch
description: Provider, credentials, and retry-safety rules for FishTokri order dispatch.
---

Use Borzo's India test API for confirmed FTS/FTW delivery orders. The documented create-order authentication is the API token in `X-DV-Auth-Token`; the docs do not specify a Client ID field, so do not invent one. Keep production disabled unless the user explicitly asks to switch.

If a request times out, returns a server error, or otherwise has an uncertain outcome, do not automatically retry. Check the Borzo test dashboard first to avoid duplicate orders.

**Why:** The user replaced Pidge with Borzo and authorized the test environment; the API documentation distinguishes test and production endpoints and documents token-header authentication.

**How to apply:** Keep dispatch limited to eligible delivery orders on confirmation, keep the token server-side, and verify uncertain submissions in Borzo test before retrying.
