const TEST_API_URL = "https://robotapitest-in.borzodelivery.com/api/business/1.8";
const REQUEST_TIMEOUT_MS = 15_000;

function asText(value) {
  return String(value ?? "").trim();
}

function normalizeIndianPhone(value) {
  const digits = asText(value).replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 14 && digits.startsWith("0091")) return digits.slice(2);
  return digits;
}

function extractPincode(order, detail) {
  const candidates = [
    detail?.pincode,
    detail?.zipCode,
    detail?.zip,
    order?.deliveryPincode,
    order?.pincode,
    order?.address,
  ];
  for (const candidate of candidates) {
    const match = asText(candidate).match(/\b\d{6}\b/);
    if (match) return match[0];
  }
  return "";
}

function cashToCollect(order) {
  const paymentStatus = asText(order?.paymentStatus).toLowerCase();
  if (paymentStatus === "paid" || paymentStatus === "completed") return 0;

  const total = Math.max(0, Number(order?.total) || 0);
  const paid = Math.max(0, Number(order?.paidAmount) || 0);
  const dueValue = order?.dueAmount;
  const due = Math.max(
    0,
    dueValue !== undefined && dueValue !== null && dueValue !== "" && Number.isFinite(Number(dueValue))
      ? Number(dueValue)
      : total - paid,
  );
  const primaryMode = asText(order?.paymentMode).toLowerCase();
  const modes = (Array.isArray(order?.payments) ? order.payments : [])
    .map((payment) => asText(payment?.mode).toLowerCase())
    .filter(Boolean);
  const hasCashMode = primaryMode === "cash" || primaryMode === "cod" ||
    modes.some((mode) => mode === "cash" || mode === "cod");
  const hasNonCashMode = [primaryMode, ...modes].some((mode) =>
    ["upi", "card", "online", "wallet"].includes(mode),
  );

  if (hasCashMode) return due;
  if (hasNonCashMode) return 0;
  return due;
}

function declaredGoodsAmount(order) {
  const subtotal = Number(order?.subtotal);
  if (Number.isFinite(subtotal) && subtotal > 0) return subtotal;

  return (Array.isArray(order?.items) ? order.items : []).reduce((sum, item) => {
    const price = Number(item?.price);
    const quantity = Number(item?.quantity);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
      return sum;
    }
    return sum + price * quantity;
  }, 0);
}

function formatAddress(parts) {
  const result = [];
  const seen = new Set();
  for (const value of parts) {
    const text = asText(value);
    if (!text) continue;
    const normalized = text.toLowerCase().replace(/[,\s]+/g, " ").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(text);
  }
  return result.join(", ");
}

function mergeAddressParts(parts) {
  const result = [];
  const seen = [];
  for (const value of parts) {
    const text = asText(value);
    const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!normalized) continue;
    const coveredByShorterPart = seen.findIndex((existing) => normalized.includes(existing));
    if (coveredByShorterPart >= 0) {
      result[coveredByShorterPart] = text;
      seen[coveredByShorterPart] = normalized;
      continue;
    }
    if (seen.some((existing) => existing.includes(normalized))) continue;
    result.push(text);
    seen.push(normalized);
  }
  return result.join(", ");
}

function itemWeightKg(item) {
  const candidates = [item?.bulkWeightKg, item?.fishWeightKg, item?.weightKg];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const label = asText(item?.weight ?? item?.variantLabel);
  const match = label.match(/(\d+(?:\.\d+)?)\s*(kg|g)\b/i);
  if (!match) return 0;
  const weight = Number(match[1]);
  return match[2].toLowerCase() === "g" ? weight / 1000 : weight;
}

function sanitizeResponseBody(value) {
  if (Array.isArray(value)) return value.map(sanitizeResponseBody);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /token|password|authorization|secret/i.test(key)
        ? "[REDACTED]"
        : sanitizeResponseBody(entry),
    ]),
  );
}

function summarizeParameterErrors(value, path = "") {
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === "string")) {
      return value.map((entry) => `${path}: ${entry}`);
    }
    return value.flatMap((entry, index) =>
      entry === null || entry === undefined
        ? []
        : summarizeParameterErrors(entry, `${path}[${index}]`),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      summarizeParameterErrors(entry, path ? `${path}.${key}` : key),
    );
  }
  return path ? [`${path}: ${String(value)}`] : [];
}

export function buildBorzoOrderPayload(order, env = process.env) {
  const detail = order?.deliveryAddressDetail && typeof order.deliveryAddressDetail === "object"
    ? order.deliveryAddressDetail
    : {};
  const orderId = asText(order?.orderId).replace(/^#+/, "") || asText(order?._id);
  const receiverName = asText(detail.name || detail.contactName || order?.customerName);
  const receiverPhone = normalizeIndianPhone(detail.phone || order?.phone);
  const receiverPincode = extractPincode(order, detail);
  const fullAddressCandidates = [
    order?.address,
    typeof order?.deliveryAddressDetail === "string" ? order.deliveryAddressDetail : "",
    detail.address,
    detail.fullAddress,
    detail.line1,
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .sort((a, b) => b.trim().length - a.trim().length);
  const structuredAddress = [
    detail.houseNo || detail.flatNo || detail.house || detail.apartment,
    detail.building || detail.buildingName || detail.society,
    detail.street || detail.streetName || detail.road || detail.addressLine1,
    detail.addressLine2,
    detail.area || detail.locality || detail.neighbourhood,
    detail.landmark,
  ].map(asText).filter(Boolean);
  const receiverCity = asText(detail.city || order?.deliveryCity);
  const receiverState = asText(detail.state || order?.deliveryState);
  const receiverAddressBase = mergeAddressParts([
    ...fullAddressCandidates,
    ...structuredAddress,
    order?.deliveryArea,
  ]);
  const receiverAddress = mergeAddressParts([
    receiverAddressBase,
    receiverCity,
    receiverState,
    receiverPincode,
  ]);

  const pickupAddressBase = asText(env.BORZO_PICKUP_ADDRESS) ||
    formatAddress([env.BORZO_PICKUP_ADDRESS_LINE_1, env.BORZO_PICKUP_ADDRESS_LINE_2]);
  const pickupAddress = pickupAddressBase
    ? formatAddress([
        pickupAddressBase,
        env.BORZO_PICKUP_CITY,
        env.BORZO_PICKUP_STATE,
        env.BORZO_PICKUP_PINCODE,
        env.BORZO_PICKUP_COUNTRY || "India",
      ])
    : "";
  const pickupName = asText(env.BORZO_PICKUP_NAME);
  const pickupPhone = normalizeIndianPhone(env.BORZO_PICKUP_MOBILE);
  const pickupNote = asText(env.BORZO_PICKUP_INSTRUCTIONS);

  const items = (Array.isArray(order?.items) ? order.items : [])
    .filter((item) => asText(item?.name))
    .map((item) => ({
      name: asText(item.name),
      quantity: Math.max(1, Number(item.quantity) || 1),
      weightKg: itemWeightKg(item),
    }));
  const matter = [
    `Fresh Stock Xchange order ${orderId}`,
    ...items.map((item) => `${item.name} × ${item.quantity}`),
  ].join("; ").slice(0, 5000);
  const totalWeightKg = items.reduce((sum, item) => sum + item.weightKg * item.quantity, 0);
  const goodsAmount = declaredGoodsAmount(order);
  const takingAmount = cashToCollect(order);

  const payload = {
    type: "standard",
    matter,
    total_weight_kg: Math.ceil(totalWeightKg),
    ...(goodsAmount > 0 ? { insurance_amount: goodsAmount.toFixed(2) } : {}),
    is_client_notification_enabled: false,
    is_contact_person_notification_enabled: false,
    points: [
      {
        address: pickupAddress,
        contact_person: {
          name: pickupName || null,
          phone: pickupPhone,
        },
        ...(pickupNote ? { note: pickupNote } : {}),
      },
      {
        address: receiverAddress,
        contact_person: {
          name: receiverName || null,
          phone: receiverPhone,
        },
        client_order_id: orderId.slice(0, 32),
        ...(takingAmount > 0
          ? {
              is_cod_cash_voucher_required: true,
              taking_amount: takingAmount.toFixed(2),
            }
          : {}),
      },
    ],
  };

  const missingFields = [];
  if (!asText(env.BORZO_API_TOKEN)) missingFields.push("Borzo test API token secret");
  if (!pickupAddress) missingFields.push("pickup address");
  if (!pickupName) missingFields.push("pickup contact name");
  if (!/^\d{12}$/.test(pickupPhone)) missingFields.push("valid Indian pickup phone");
  if (!orderId) missingFields.push("source order ID");
  if (!matter || items.length === 0) missingFields.push("at least one order item");
  if (!receiverAddress) missingFields.push("customer delivery address");
  if (!receiverName) missingFields.push("customer name");
  if (!/^\d{12}$/.test(receiverPhone)) missingFields.push("valid Indian customer phone");

  return {
    payload,
    missingFields,
    warnings: [
      ...(goodsAmount > 0
        ? [`Declared goods value sent to Borzo: ₹${goodsAmount.toFixed(2)}; Borzo may apply an insurance fee.`]
        : []),
      ...(totalWeightKg > 0 && totalWeightKg < 1
        ? ["Borzo total_weight_kg is an integer, so this order weight is rounded up to 1 kg."]
        : []),
    ],
  };
}

async function requestJson(url, body, token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DV-Auth-Token": token,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 4000) };
    }
    return { ok: response.ok, status: response.status, body: parsed };
  } finally {
    clearTimeout(timeout);
  }
}

export async function createBorzoOrder(order) {
  const { payload, missingFields, warnings } = buildBorzoOrderPayload(order);
  const token = asText(process.env.BORZO_API_TOKEN);
  const requestUrl = `${TEST_API_URL}/create-order`;
  if (missingFields.length > 0) {
    return {
      success: false,
      status: "failed",
      requestPayload: payload,
      requestMethod: "POST",
      requestUrl,
      authentication: { scheme: "X-DV-Auth-Token (value not logged)" },
      warnings,
      error: {
        message: `Borzo test request was not sent. Missing required values: ${missingFields.join(", ")}.`,
        missingFields,
      },
    };
  }

  let requestStarted = false;
  try {
    requestStarted = true;
    const response = await requestJson(requestUrl, payload, token);
    const responseBody = sanitizeResponseBody(response.body);
    const orderId = asText(response.body?.order?.order_id);
    const successful = response.ok && response.body?.is_successful === true && Boolean(orderId);
    if (!successful) {
      const outcomeMayBeUnknown = response.status === 408 ||
        response.status >= 500 ||
        (response.ok && response.body?.is_successful === true);
      const detail = Array.isArray(response.body?.errors)
        ? response.body.errors.join(", ")
        : "";
      const parameterDetails = summarizeParameterErrors(response.body?.parameter_errors);
      return {
        success: false,
        status: outcomeMayBeUnknown ? "unknown" : "failed",
        requestPayload: payload,
        requestMethod: "POST",
        requestUrl,
        authentication: { scheme: "X-DV-Auth-Token (value not logged)" },
        warnings,
        httpStatus: response.status,
        responseBody,
        error: {
          message: [
            detail ? `Borzo test API rejected the request (${detail}).` : "",
            ...parameterDetails,
          ].filter(Boolean).join(" ") ||
            `Borzo test API returned HTTP ${response.status} without a confirmed order ID.`,
          httpStatus: response.status,
          responseBody,
          outcomeMayBeUnknown,
        },
      };
    }

    return {
      success: true,
      status: "sent",
      requestPayload: payload,
      requestMethod: "POST",
      requestUrl,
      authentication: { scheme: "X-DV-Auth-Token (value not logged)" },
      warnings,
      httpStatus: response.status,
      responseBody,
      borzoOrderId: orderId,
      borzoOrderStatus: asText(response.body?.order?.status) || undefined,
    };
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    return {
      success: false,
      status: requestStarted ? "unknown" : "failed",
      requestPayload: payload,
      requestMethod: "POST",
      requestUrl,
      authentication: { scheme: "X-DV-Auth-Token (value not logged)" },
      warnings,
      error: {
        message: isTimeout
          ? "Borzo test request timed out; check the Borzo test cabinet before retrying."
          : (error?.message || "Borzo test request failed; check the Borzo test cabinet before retrying."),
        outcomeMayBeUnknown: requestStarted,
      },
    };
  }
}
