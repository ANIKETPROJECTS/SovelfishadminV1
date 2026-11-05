const LOGIN_PATH = "/v1.0/store/channel/vendor/login";
const CREATE_ORDER_PATH = "/v1.0/store/channel/vendor/order";
const REQUEST_TIMEOUT_MS = 15_000;

function asText(value) {
  return String(value ?? "").trim();
}

function normalizePhone(value) {
  const raw = asText(value);
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return raw.replace(/[()\s-]/g, "");
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
  const hasCashMode = primaryMode === "cash" || primaryMode === "cod" || modes.some((mode) => mode === "cash" || mode === "cod");
  const hasNonCashMode = [primaryMode, ...modes].some((mode) =>
    ["upi", "card", "online", "wallet"].includes(mode),
  );

  if (hasCashMode) return due;
  if (hasNonCashMode) return 0;
  // Orders without recorded payment details are treated as cash-on-delivery.
  return due;
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

export function buildPidgeOrderPayload(order, env = process.env) {
  const detail = order?.deliveryAddressDetail && typeof order.deliveryAddressDetail === "object"
    ? order.deliveryAddressDetail
    : {};
  const orderId = asText(order?.orderId).replace(/^#+/, "") || asText(order?._id);
  const isFtw = orderId.toUpperCase().startsWith("FTW");
  const receiverName = asText(detail.name || detail.contactName || order?.customerName);
  const receiverMobile = normalizePhone(detail.phone || order?.phone);
  const receiverAddressLine1 = [
    detail.building,
    detail.street,
  ].map(asText).filter(Boolean).join(", ") || asText(order?.address);
  const receiverAddressLine2 = [
    detail.area,
    detail.landmark,
  ].map(asText).filter(Boolean).join(", ") || asText(order?.deliveryArea);
  const receiverPincode = extractPincode(order, detail);
  const receiverCity = asText(detail.city || order?.deliveryCity) || "Thane";
  const receiverState = asText(detail.state || order?.deliveryState) || "Maharashtra";
  const receiverWarnings = [];
  if (!asText(detail.city || order?.deliveryCity)) receiverWarnings.push("Customer city was not saved; defaulted to Thane.");
  if (!asText(detail.state || order?.deliveryState)) receiverWarnings.push("Customer state was not saved; defaulted to Maharashtra.");

  const items = (Array.isArray(order?.items) ? order.items : [])
    .filter((item) => asText(item?.name))
    .map((item) => {
      const kg = Number(item?.bulkWeightKg ?? item?.fishWeightKg ?? 0);
      const product = {
        name: asText(item.name),
        price: Math.max(0, Number(item.price) || 0),
        quantity: Math.max(1, Number(item.quantity) || 1),
      };
      if (asText(item.productId)) product.sku = asText(item.productId);
      if (kg > 0) product.dimension = { dead_weight: Math.round(kg * 1000) };
      return product;
    });

  const pickupAddressLine1 = asText(env.PIDGE_PICKUP_ADDRESS_LINE_1);
  const pickupAddressLine2 = asText(env.PIDGE_PICKUP_ADDRESS_LINE_2);
  const pickupName = asText(env.PIDGE_PICKUP_NAME);
  const pickupMobile = normalizePhone(env.PIDGE_PICKUP_MOBILE);
  const supportName = asText(env.PIDGE_SUPPORT_NAME);
  const supportMobile = normalizePhone(env.PIDGE_SUPPORT_MOBILE);
  const payload = {
    channel: isFtw ? "FTW" : "FTS",
    sender_detail: {
      address: {
        address_line_1: pickupAddressLine1,
        ...(pickupAddressLine2 ? { address_line_2: pickupAddressLine2 } : {}),
        label: asText(env.PIDGE_PICKUP_LABEL) || "Fresh Stock Xchange",
        city: asText(env.PIDGE_PICKUP_CITY),
        state: asText(env.PIDGE_PICKUP_STATE),
        country: asText(env.PIDGE_PICKUP_COUNTRY) || "India",
        pincode: asText(env.PIDGE_PICKUP_PINCODE),
        ...(asText(env.PIDGE_PICKUP_LANDMARK) ? { landmark: asText(env.PIDGE_PICKUP_LANDMARK) } : {}),
        ...(asText(env.PIDGE_PICKUP_INSTRUCTIONS) ? { instructions_to_reach: asText(env.PIDGE_PICKUP_INSTRUCTIONS) } : {}),
      },
      name: pickupName,
      mobile: pickupMobile,
      ...(asText(env.PIDGE_PICKUP_EMAIL) ? { email: asText(env.PIDGE_PICKUP_EMAIL) } : {}),
    },
    poc_detail: {
      name: supportName,
      mobile: supportMobile,
      ...(asText(env.PIDGE_SUPPORT_EMAIL) ? { email: asText(env.PIDGE_SUPPORT_EMAIL) } : {}),
    },
    trips: [{
      receiver_detail: {
        address: {
          address_line_1: receiverAddressLine1,
          ...(receiverAddressLine2 ? { address_line_2: receiverAddressLine2 } : {}),
          label: asText(detail.label) || "Delivery",
          ...(asText(detail.landmark) ? { landmark: asText(detail.landmark) } : {}),
          city: receiverCity,
          state: receiverState,
          country: "India",
          pincode: receiverPincode,
          ...(asText(detail.instructionsToReach ?? detail.instructions_to_reach)
            ? { instructions_to_reach: asText(detail.instructionsToReach ?? detail.instructions_to_reach) }
            : {}),
        },
        name: receiverName,
        mobile: receiverMobile,
        ...(asText(order?.email || detail.email) ? { email: asText(order?.email || detail.email) } : {}),
      },
      packages: [{ label: `Fresh fish order ${orderId}`, quantity: 1 }],
      source_order_id: orderId,
      reference_id: orderId,
      cod_amount: cashToCollect(order),
      bill_amount: Math.max(0, Number(order?.total) || 0),
      products: items,
      order_category: "food",
      force_dispose: false,
    }],
  };

  const brandCode = asText(env.PIDGE_BRAND_CODE);
  const locationCode = asText(env.PIDGE_LOCATION_CODE);
  if (brandCode || locationCode) {
    payload.brand = {
      ...(brandCode ? { code: brandCode } : {}),
      ...(locationCode ? { location_code: locationCode } : {}),
      ...(asText(env.PIDGE_BRAND_NAME ?? order?.superHubName ?? order?.subHubName)
        ? { name: asText(env.PIDGE_BRAND_NAME ?? order?.superHubName ?? order?.subHubName) }
        : {}),
    };
  }

  const trip = payload.trips[0];
  const missingFields = [];
  if (!asText(env.PIDGE_PICKUP_ADDRESS_LINE_1)) missingFields.push("pickup address line 1");
  if (!asText(env.PIDGE_PICKUP_CITY)) missingFields.push("pickup city");
  if (!asText(env.PIDGE_PICKUP_STATE)) missingFields.push("pickup state");
  if (!/^\d{6}$/.test(asText(env.PIDGE_PICKUP_PINCODE))) missingFields.push("valid 6-digit pickup pincode");
  if (!pickupName) missingFields.push("pickup contact name");
  if (!pickupMobile) missingFields.push("pickup contact mobile");
  if (!supportName) missingFields.push("support contact name");
  if (!supportMobile) missingFields.push("support contact mobile");
  if (!orderId) missingFields.push("source order ID");
  if (!trip.receiver_detail.name) missingFields.push("customer name");
  if (!trip.receiver_detail.mobile) missingFields.push("customer mobile");
  if (!trip.receiver_detail.address.address_line_1) missingFields.push("customer address line 1");
  if (!trip.receiver_detail.address.city) missingFields.push("customer city");
  if (!trip.receiver_detail.address.state) missingFields.push("customer state");
  if (!/^\d{6}$/.test(receiverPincode)) missingFields.push("valid 6-digit customer pincode");
  if (items.length === 0) missingFields.push("at least one order item");

  return {
    payload,
    missingFields,
    warnings: receiverWarnings,
  };
}

async function requestJson(url, body, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
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
    return {
      ok: response.ok,
      status: response.status,
      body: parsed,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function joinUrl(base, path) {
  return `${asText(base).replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function login(baseUrl, username, password) {
  const response = await requestJson(joinUrl(baseUrl, LOGIN_PATH), { username, password });
  const token = asText(response.body?.data?.token);
  if (!response.ok || !token) {
    const error = new Error(asText(response.body?.message ?? response.body?.data?.message) || "Pidge login failed");
    error.httpStatus = response.status;
    error.responseBody = sanitizeResponseBody(response.body);
    throw error;
  }
  return {
    token: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    httpStatus: response.status,
  };
}

export async function createPidgeOrder(order) {
  const { payload, missingFields, warnings } = buildPidgeOrderPayload(order);
  const baseUrl = asText(process.env.PIDGE_PRODUCTION_API_BASE_URL);
  const username = asText(process.env.Pidge_Username);
  const password = asText(process.env.Pidge_Password);
  if (!baseUrl) missingFields.push("production API base URL secret");
  if (!username) missingFields.push("Pidge username secret");
  if (!password) missingFields.push("Pidge password secret");

  if (missingFields.length > 0) {
    return {
      success: false,
      status: "failed",
      requestPayload: payload,
      warnings,
      error: {
        message: `Pidge request was not sent. Missing required values: ${missingFields.join(", ")}.`,
        missingFields,
      },
      requestMethod: "POST",
      requestUrl: baseUrl ? joinUrl(baseUrl, CREATE_ORDER_PATH) : CREATE_ORDER_PATH,
    };
  }

  let createRequestStarted = false;
  const authenticationAttempts = [];
  const requestUrl = joinUrl(baseUrl, CREATE_ORDER_PATH);
  try {
    let authentication = await login(baseUrl, username, password);
    authenticationAttempts.push({ success: true, httpStatus: authentication.httpStatus });
    createRequestStarted = true;
    let response = await requestJson(
      requestUrl,
      payload,
      { Authorization: authentication.token },
    );
    if (response.status === 401) {
      authentication = await login(baseUrl, username, password);
      authenticationAttempts.push({ success: true, httpStatus: authentication.httpStatus, refreshed: true });
      createRequestStarted = true;
      response = await requestJson(
        requestUrl,
        payload,
        { Authorization: authentication.token },
      );
    }
    response.body = sanitizeResponseBody(response.body);

    if (!response.ok) {
      return {
        success: false,
        status: "failed",
        requestPayload: payload,
        requestMethod: "POST",
        requestUrl,
        authentication: { scheme: "Bearer token (value not logged)", attempts: authenticationAttempts },
        warnings,
        httpStatus: response.status,
        responseBody: response.body,
        error: {
          message: asText(response.body?.message ?? response.body?.error) || `Pidge returned HTTP ${response.status}`,
          httpStatus: response.status,
          responseBody: response.body,
          outcomeMayBeUnknown: response.status === 408 || response.status >= 500,
        },
      };
    }

    const data = response.body?.data;
    const pidgeOrderId = asText(data?.[payload.trips[0].source_order_id] ?? data?.id ?? data);
    return {
      success: true,
      status: "sent",
      requestPayload: payload,
      requestMethod: "POST",
      requestUrl,
      authentication: { scheme: "Bearer token (value not logged)", attempts: authenticationAttempts },
      warnings,
      httpStatus: response.status,
      responseBody: response.body,
      pidgeOrderId: pidgeOrderId || undefined,
    };
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    return {
      success: false,
      status: "failed",
      requestPayload: payload,
      requestMethod: "POST",
      requestUrl,
      authentication: {
        scheme: "Bearer token (value not logged)",
        attempts: [
          ...authenticationAttempts,
          ...(error?.httpStatus !== undefined
            ? [{ success: false, httpStatus: error.httpStatus, responseBody: sanitizeResponseBody(error.responseBody) }]
            : []),
        ],
      },
      warnings,
      error: {
        message: isTimeout ? "Pidge request timed out; verify Pidge before retrying." : (error?.message || "Pidge request failed"),
        httpStatus: error?.httpStatus,
        responseBody: error?.responseBody,
        outcomeMayBeUnknown: isTimeout || createRequestStarted,
      },
    };
  }
}
