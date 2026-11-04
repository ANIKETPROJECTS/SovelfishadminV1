/**
 * WhatsApp notification service — Admark Verified WhatsApp API
 * Docs: https://verifiedwhatsapp.admarksolution.com
 *
 * Credentials are read from environment variables:
 *   WABA_API_KEY   — API key
 *   WABA_PHONE_ID  — WhatsApp Business phone number ID
 */
import { DIRECT_ORDER_ONLY } from "../lib/feature-flags.js";

const WABA_API_BASE = "https://verifiedwhatsapp.admarksolution.com";
const SEND_TIMEOUT_MS = 15_000; // 15 s per attempt
const MAX_RETRIES = 2; // 1 initial + 1 retry

// ---------------------------------------------------------------------------
// Deduplication guard
// Prevents the same WhatsApp notification from firing twice when two
// concurrent PUT requests race to MongoDB and both read prev.status before
// either write commits (classic TOCTOU double-fire).
// Key: "<orderId>:<templateName>"  Value: timestamp (ms) of last send.
// Any duplicate within DEDUP_TTL_MS is silently dropped.
// ---------------------------------------------------------------------------
const DEDUP_TTL_MS = 30_000; // 30 seconds
const recentlySent = new Map<string, number>();

function isDuplicate(orderId: string, templateName: string): boolean {
  const key = `${orderId}:${templateName}`;
  const last = recentlySent.get(key);
  const now = Date.now();
  if (last !== undefined && now - last < DEDUP_TTL_MS) {
    console.warn(
      `[WhatsApp] DEDUP — suppressing duplicate ${templateName} for order ${orderId} ` +
      `(last sent ${now - last}ms ago, TTL=${DEDUP_TTL_MS}ms)`
    );
    return true;
  }
  recentlySent.set(key, now);
  // Prune stale entries to avoid unbounded growth
  if (recentlySent.size > 500) {
    for (const [k, t] of recentlySent) {
      if (now - t > DEDUP_TTL_MS) recentlySent.delete(k);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise an Indian mobile number to the 91XXXXXXXXXX format the API
 * expects. Returns null for unrecognised formats (caller skips the send).
 * Handles:
 *   10 digits            → 91XXXXXXXXXX
 *   11 digits, leading 0 → 91XXXXXXXXXX  (e.g. 0XXXXXXXXXX)
 *   12 digits, starts 91 → unchanged
 */
function formatPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) return digits;
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return null;
}

/**
 * NOTE: U+2028 (LINE SEPARATOR) was tried here as a way to render a real
 * line break inside a WhatsApp template variable without tripping Meta's
 * "no literal \n" validator. In production it came through as a broken "�"
 * glyph on the customer's phone — the Admark/WhatsApp pipeline does not
 * preserve that codepoint. Do NOT reintroduce it. A true one-item-per-line
 * layout requires a template redesign with fixed line slots (see
 * docs/whatsapp-templates.md) — it is not achievable from a single
 * free-text variable.
 */

/**
 * Build the human-readable items block used inside the order-confirmed bill.
 * Each item is prefixed with its sequence number (1., 2., 3., …) and the
 * whole list is joined with " | " — the only separator that reliably
 * survives the WhatsApp/Admark pipeline. Per-unit labels like "(per piece)"
 * / "(per pack)" are intentionally omitted — not useful to the customer on
 * the confirmation message.
 *
 * Example:
 *   "1. Fish x2 - Rs.300 | 2. Prawns x1 - Rs.450"
 */
export function buildItemsText(
  items: Array<{ name: string; quantity: number; price: number; unit?: string }>
): string {
  if (!Array.isArray(items) || items.length === 0) return "-";
  return items
    .map((it, idx) => {
      const lineTotal = (Number(it.price) || 0) * (Number(it.quantity) || 1);
      return `${idx + 1}. ${it.name} x${it.quantity} - Rs.${lineTotal}`;
    })
    .join(" | ");
}

/**
 * NOT YET WIRED UP — for use once the new "fishtokri_order_confirmed_v2"
 * template (with 10 fixed item-line slots, one per hardcoded template line)
 * has been created in Admark and approved by Meta. See
 * docs/whatsapp-templates.md for the exact template body to submit.
 *
 * Splits an order's items into exactly `maxSlots` template-variable values,
 * one per item so each renders on its own hardcoded template line (true
 * line breaks, since they're static text in the approved template body —
 * not embedded inside a single free-text variable).
 *
 * Orders with more items than `maxSlots`: the first `maxSlots - 1` items get
 * their own line as usual, and ALL remaining items are packed into the last
 * slot together, joined with " | " (still numbered, so nothing is lost —
 * just not one-per-line beyond the cap). Unused trailing slots (when an
 * order has fewer items than `maxSlots`) get a single space (" ") — Meta
 * template variables cannot be an empty string.
 */
export function buildOrderConfirmedItemSlots(
  items: Array<{ name: string; quantity: number; price: number; unit?: string }>,
  maxSlots = 5
): string[] {
  const list = Array.isArray(items) ? items : [];
  const lines = list.map((it, idx) => {
    const lineTotal = (Number(it.price) || 0) * (Number(it.quantity) || 1);
    return `${idx + 1}. ${it.name} x${it.quantity} - Rs.${lineTotal}`;
  });

  const slots: string[] = new Array(maxSlots).fill(" ");
  if (lines.length <= maxSlots) {
    lines.forEach((line, i) => { slots[i] = line; });
  } else {
    const shown = lines.slice(0, maxSlots - 1);
    shown.forEach((line, i) => { slots[i] = line; });
    const overflow = lines.slice(maxSlots - 1);
    slots[maxSlots - 1] = overflow.join(" | ");
  }
  return slots;
}

/**
 * WhatsApp's Cloud API rejects template parameter values that contain a
 * literal newline (\n), a carriage return (\r), or a tab (\t), or 4+
 * consecutive spaces — the entire send fails with "(#100) Invalid
 * parameter" and the customer receives nothing. Call this on every value
 * right before it is placed into a template variable. This intentionally
 * does NOT touch WA_LINE_BREAK (U+2028), which is how we render intentional
 * line breaks inside a template variable.
 */
function sanitizeTemplateParam(value: unknown): string {
  const cleaned = String(value ?? "")
    .replace(/[\r\n\t]+/g, " | ")
    .replace(/ {2,}/g, " ")
    .trim();
  // Meta's Cloud API hard-rejects a template call if ANY parameter resolves
  // to an empty string — fails with "(#131008) Required parameter is
  // missing" for the WHOLE message, not just that slot. Placeholder values
  // for unused item slots (a single " ") must survive sanitization, so if
  // trimming collapsed the value to nothing, fall back to a single space.
  return cleaned.length > 0 ? cleaned : " ";
}

/** Formats a "YYYY-MM-DD" delivery date string as "03 Jul 2026". Leaves other formats untouched. */
function formatDeliveryDateLabel(d: string): string {
  const s = String(d ?? "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIdx = Number(m[2]) - 1;
  return `${m[3]} ${months[monthIdx] ?? m[2]} ${m[1]}`;
}

/**
 * Build a human-readable delivery-timing label so the order-confirmed
 * message always tells the customer *when* to expect delivery — for
 * scheduled slot orders, express (Porter) orders, and instant/ASAP orders
 * alike. Previously this only showed anything when timeslotLabel /
 * timeslotStart+End were set, so express/instant orders (and slot orders
 * missing those specific fields) silently showed no timing at all.
 */
function buildDeliveryTimingLabel(order: any): string {
  if (DIRECT_ORDER_ONLY) return "As soon as possible";
  const scheduleType = String(order?.scheduleType ?? "").trim().toLowerCase();
  const slotLabel =
    String(order?.timeslotLabel ?? "").trim() ||
    (order?.timeslotStart && order?.timeslotEnd ? `${order.timeslotStart} - ${order.timeslotEnd}` : "");
  const dateLabel = order?.deliveryDate ? formatDeliveryDateLabel(String(order.deliveryDate)) : "";

  if (order?.isExpress || scheduleType === "express") {
    return "Express Delivery (via Porter)";
  }
  if (scheduleType === "instant") {
    return "As soon as possible";
  }
  if (slotLabel && dateLabel) return `${dateLabel}, ${slotLabel}`;
  if (slotLabel) return slotLabel;
  if (dateLabel) return dateLabel;
  return "";
}

type Logger = {
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
  info: (obj: object, msg?: string) => void;
};

// ---------------------------------------------------------------------------
// Core send function — with timeout + retry
// ---------------------------------------------------------------------------

/**
 * Attempt a single HTTP call to the Admark API.
 * Throws on non-success so the caller can retry.
 */
async function attemptSend(
  templateName: string,
  formattedPhone: string,
  varsObj: Record<string, string>,
  apiKey: string,
  phoneId: string,
  attemptNum: number,
  log: Logger
): Promise<void> {
  const params = new URLSearchParams({
    "api-key": apiKey,
    templateName,
    phoneNumber: formattedPhone,
    phoneNumberId: phoneId,
    variables: JSON.stringify(varsObj),
  });

  const requestUrl = `${WABA_API_BASE}/api/send/bytemplate?${params.toString()}`;

  // Log full details (mask API key in the URL shown)
  const maskedUrl = requestUrl.replace(/(api-key=)[^&]+/, "$1***");
  console.log(
    `[WhatsApp][attempt ${attemptNum}] SEND → template=${templateName} phone=${formattedPhone}\n` +
    `  variables: ${JSON.stringify(varsObj)}\n` +
    `  url: ${maskedUrl}`
  );
  log.info(
    { templateName, phone: formattedPhone, variables: varsObj, attempt: attemptNum },
    `[WhatsApp] Sending template (attempt ${attemptNum})`
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  let httpStatus: number;
  let rawText: string;
  let data: any;
  try {
    const resp = await fetch(requestUrl, { signal: controller.signal });
    httpStatus = resp.status;
    rawText = await resp.text();
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { rawText };
    }
  } finally {
    clearTimeout(timer);
  }

  // Always log the full raw response so we can see exactly what Admark returns.
  console.log(
    `[WhatsApp][attempt ${attemptNum}] RESPONSE ← httpStatus=${httpStatus} body=${rawText}`
  );
  log.info(
    { templateName, phone: formattedPhone, httpStatus, response: data, attempt: attemptNum },
    "[WhatsApp] Admark raw response"
  );

  // Admark quirk: it can return success:true at the top level but still fail delivery.
  // The reliable check is: success:true AND sent >= 1 AND errors array is empty.
  const topSuccess = data?.success === true;
  const sentCount = Number(data?.sent ?? 0);
  const errorsArr: any[] = Array.isArray(data?.errors) ? data.errors : [];
  const actuallyDelivered = topSuccess && sentCount >= 1 && errorsArr.length === 0;

  if (!actuallyDelivered) {
    const errDetail = errorsArr.length > 0
      ? errorsArr.map((e: any) => e.error ?? JSON.stringify(e)).join("; ")
      : `success=${topSuccess} sent=${sentCount}`;
    const errMsg = `[WhatsApp] Delivery failed: ${errDetail} | httpStatus=${httpStatus} | body=${rawText}`;
    log.error({ templateName, phone: formattedPhone, httpStatus, response: data, attempt: attemptNum }, errMsg);
    console.error(errMsg);
    throw new Error(errMsg);
  }

  const msgId = data?.results?.[0]?.messageId ?? data?.messageId ?? "(none)";
  console.log(
    `[WhatsApp][attempt ${attemptNum}] SUCCESS → template=${templateName} phone=${formattedPhone} ` +
    `sent=${sentCount} msgId=${msgId}`
  );
  log.info(
    { templateName, phone: formattedPhone, sent: sentCount, msgId, response: data, attempt: attemptNum },
    "[WhatsApp] Message delivered via Admark"
  );
}

/**
 * Core send function.
 * Variables are passed as a URL-encoded JSON object (body1, body2, …)
 * so commas and newlines inside variable values are safe.
 * Retries up to MAX_RETRIES times on timeout or network error.
 *
 * @param extraVars  Additional Admark variable keys to merge in, e.g. { url1: "https://..." }
 *                   for templates that have a dynamic CTA button URL.
 */
async function sendTemplate(
  templateName: string,
  phone: string,
  bodyVars: string[],
  log?: Logger,
  extraVars?: Record<string, string>
): Promise<void> {
  const logger: Logger = log ?? {
    warn: (o, m) => console.warn(m, o),
    error: (o, m) => console.error(m, o),
    info: (o, m) => console.log(m, o),
  };

  const apiKey = process.env.WABA_API_KEY;
  const phoneId = process.env.WABA_PHONE_ID;

  if (!apiKey || !phoneId) {
    logger.warn({ templateName }, "[WhatsApp] WABA_API_KEY or WABA_PHONE_ID not set — skipping");
    console.warn(`[WhatsApp] WABA_API_KEY or WABA_PHONE_ID not set — skipping template=${templateName}`);
    return;
  }

  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) {
    logger.warn(
      { phone, templateName },
      "[WhatsApp] Unrecognised phone format — skipping"
    );
    console.warn(`[WhatsApp] Unrecognised phone format="${phone}" for template=${templateName} — skipping`);
    return;
  }

  // Build named variable object: { body1: "...", body2: "...", … }
  // Merge any extra vars (e.g. url1 for CTA button URLs) after the body vars.
  //
  // IMPORTANT: WhatsApp's Cloud API rejects template parameter values that
  // contain a newline (\n), a tab (\t), or 4+ consecutive spaces — the whole
  // send fails with "(#100) Invalid parameter". Any value we build (item
  // lists, addresses with an appended timing line, etc.) MUST be sanitized
  // before it goes into a template variable, or the message silently fails
  // to deliver even though our own code has no bug.
  const varsObj: Record<string, string> = {};
  bodyVars.forEach((v, i) => {
    varsObj[`body${i + 1}`] = sanitizeTemplateParam(v);
  });
  if (extraVars) {
    Object.assign(varsObj, extraVars);
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await attemptSend(templateName, formattedPhone, varsObj, apiKey, phoneId, attempt, logger);
      return; // success — stop
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        const delay = attempt * 2000; // 2 s, 4 s …
        console.warn(
          `[WhatsApp][attempt ${attempt}] FAILED for template=${templateName} phone=${formattedPhone} — retrying in ${delay}ms. Error: ${String(err)}`
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // All attempts failed
  logger.error(
    { err: lastErr, templateName, phone: formattedPhone },
    `[WhatsApp] All ${MAX_RETRIES} attempts failed`
  );
  console.error(
    `[WhatsApp] ALL ${MAX_RETRIES} ATTEMPTS FAILED → template=${templateName} phone=${formattedPhone}. Last error: ${String(lastErr)}`
  );
}

// ---------------------------------------------------------------------------
// Public send functions — one per template
// ---------------------------------------------------------------------------

/**
 * Fires when an order is accepted (status → confirmed).
 *
 * TWO templates are used depending on whether wallet balance was applied:
 *
 * A) fishtokri_confirmed_v2  — no wallet (14 vars):
 *   {{1}} name, {{2}} orderId,
 *   {{3}}-{{7}} five item-line slots,
 *   {{8}} subtotal, {{9}} discount, {{10}} delivery, {{11}} total,
 *   {{12}} paymentMode, {{13}} address, {{14}} delivery time.
 *
 * B) fishtokri_confirmed_wallet_v2 — wallet used (16 vars):
 *   {{1}}-{{11}} same as above,
 *   {{12}} walletUsed, {{13}} amountDue (cash/UPI left to pay),
 *   {{14}} paymentMode, {{15}} address, {{16}} delivery time.
 *
 * See docs/whatsapp-templates.md for the template bodies to submit to
 * Admark / Meta for approval.
 */
export async function sendOrderConfirmed(order: any, log?: Logger): Promise<void> {
  const phone = String(order.phone ?? "").trim();
  if (!phone) {
    (log ?? console).warn({ orderId: String(order._id) }, "[WhatsApp] Order has no phone — skipping order_confirmed");
    console.warn(`[WhatsApp] Order ${order._id} has no phone field — skipping order_confirmed`);
    return;
  }

  // Use the stored FTS order ID; fall back to short hex if missing.
  // Strip any leading '#' — the WhatsApp template text already has a '#' before {{2}},
  // so passing '#FTS...' would produce '##FTS...' in the delivered message.
  const orderId =
    (String(order.orderId ?? "").trim() ||
     `ORD-${String(order._id).slice(-6).toUpperCase()}`).replace(/^#+/, "");

  const itemSlots = buildOrderConfirmedItemSlots(order.items ?? [], 5);
  const subtotal = String(order.subtotal ?? 0);
  const discount = String(order.discount ?? 0);
  // slotCharge and deliveryCharge represent the same delivery fee. Prefer the
  // storefront slot charge and only use legacy fields when it is not present;
  // never add them together.
  const slotCharge = Number(order.slotCharge) || 0;
  const deliveryCharge = String(
    slotCharge > 0
      ? slotCharge
      : (Number(order.deliveryCharge) || Number(order.instantDeliveryCharge) || 0),
  );
  const total = String(order.total ?? 0);
  const rawMode = String(order.paymentMode ?? "").trim().toLowerCase();
  const paymentMode =
    rawMode === "cod" ? "Cash on Delivery" :
    rawMode === "upi" ? "UPI" :
    rawMode === "online" ? "Online" :
    rawMode || "Cash on Delivery";
  const address =
    String(order.address ?? order.deliveryArea ?? "").trim() || "—";
  const timingLabel = buildDeliveryTimingLabel(order) || "—";

  // Calculate wallet used — sum all payments entries with mode === "wallet".
  const payments: any[] = Array.isArray(order.payments) ? order.payments : [];
  const walletUsed = payments
    .filter((p: any) => String(p?.mode ?? "").toLowerCase() === "wallet")
    .reduce((s: number, p: any) => s + (Number(p?.amount) || 0), 0);

  console.log(
    `[WhatsApp] sendOrderConfirmed → orderId=${orderId} customer=${order.customerName} ` +
    `phone=${phone} timing="${timingLabel}" walletUsed=${walletUsed}`
  );

  if (walletUsed > 0) {
    // Compute the cash/UPI balance due after wallet deduction.
    const grandTotal = Number(order.total) || 0;
    const amountDue = Math.max(0, grandTotal - walletUsed);

    await sendTemplate(
      "fishtokri_confirmed_wallet_v2",
      phone,
      [
        String(order.customerName ?? "Customer"),
        orderId,
        ...itemSlots,            // {{3}}–{{7}}
        subtotal,                // {{8}}
        discount,                // {{9}}
        deliveryCharge,          // {{10}}
        total,                   // {{11}}
        String(walletUsed),      // {{12}} Wallet applied
        String(amountDue),       // {{13}} Amount due (cash/UPI)
        paymentMode,             // {{14}}
        address,                 // {{15}}
        timingLabel,             // {{16}}
      ],
      log
    );
  } else {
    await sendTemplate(
      "fishtokri_confirmed_v2",
      phone,
      [
        String(order.customerName ?? "Customer"),
        orderId,
        ...itemSlots,
        subtotal,
        discount,
        deliveryCharge,
        total,
        paymentMode,
        address,
        timingLabel,
      ],
      log
    );
  }
}

/**
 * Fires when an order goes out for delivery (status → out_for_delivery).
 *
 * Template: fishtokri_out_for_delivery_v3 (5 vars):
 *   {{1}} name, {{2}} orderId, {{3}} dp_name, {{4}} dp_phone, {{5}} delivery slot
 *
 * Used for ALL orders regardless of payment mode (COD or UPI).
 * Previous variants (v1 / v2 / cod_new) are retired.
 */
export async function sendOutForDelivery(
  order: any,
  deliveryPersonPhone: string,
  log?: Logger
): Promise<void> {
  const phone = String(order.phone ?? "").trim();
  if (!phone) {
    console.warn(`[WhatsApp] Order ${order._id} has no phone field — skipping out_for_delivery`);
    return;
  }

  const orderId =
    (String(order.orderId ?? "").trim() ||
     `ORD-${String(order._id).slice(-6).toUpperCase()}`).replace(/^#+/, "");

  const dpName =
    String(order.assignedDeliveryPersonName ?? "").trim() ||
    "Our delivery partner";
  const dpPhone = deliveryPersonPhone.trim() || "-";

  // Build "15 Jul 2026 | 10:00 AM – 12:00 PM" style slot label for {{5}}
  const scheduleType = String(order?.scheduleType ?? "").trim().toLowerCase();
  const dateLabel = order?.deliveryDate ? formatDeliveryDateLabel(String(order.deliveryDate)) : "";
  const slotLabel =
    String(order?.timeslotLabel ?? "").trim() ||
    (order?.timeslotStart && order?.timeslotEnd
      ? `${order.timeslotStart} – ${order.timeslotEnd}`
      : "");
  let deliverySlot: string;
  if (DIRECT_ORDER_ONLY) {
    deliverySlot = "As soon as possible";
  } else if (order?.isExpress || scheduleType === "express") {
    deliverySlot = "Express Delivery (via Porter)";
  } else if (scheduleType === "instant") {
    deliverySlot = "As soon as possible";
  } else if (dateLabel && slotLabel) {
    deliverySlot = `${dateLabel} | ${slotLabel}`;
  } else {
    deliverySlot = slotLabel || dateLabel || "As scheduled";
  }

  const templateName = "fishtokri_out_for_delivery_v7";

  console.log(
    `[WhatsApp] sendOutForDelivery → orderId=${orderId} customer=${order.customerName} ` +
    `phone=${phone} dp=${dpName} dpPhone=${dpPhone} slot="${deliverySlot}" template=${templateName}`
  );

  if (isDuplicate(orderId, templateName)) return;
  await sendTemplate(
    templateName,
    phone,
    [
      String(order.customerName ?? "Customer"),
      orderId,
      dpName,
      dpPhone,
      deliverySlot,
    ],
    log
  );
}

/**
 * Fires when an order is cancelled from the backend (status → cancelled).
 * Template: fishtokri_order_cancelled
 * Variables: {{1}} name, {{2}} orderId, {{3}} reason
 */
export async function sendOrderCancelled(order: any, log?: Logger): Promise<void> {
  const phone = String(order.phone ?? "").trim();
  if (!phone) {
    console.warn(`[WhatsApp] Order ${order._id} has no phone field — skipping order_cancelled`);
    return;
  }

  const orderId =
    (String(order.orderId ?? "").trim() ||
     `ORD-${String(order._id).slice(-6).toUpperCase()}`).replace(/^#+/, "");

  const reason =
    String(order.cancellationReason ?? "").trim() ||
    "As per operational requirements";

  console.log(
    `[WhatsApp] sendOrderCancelled → orderId=${orderId} customer=${order.customerName} phone=${phone} reason="${reason}"`
  );

  await sendTemplate(
    "fishtokri_order_cancelled",
    phone,
    [
      String(order.customerName ?? "Customer"),
      orderId,
      reason,
    ],
    log
  );
}
