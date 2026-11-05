import assert from "node:assert/strict";
import test from "node:test";
import { buildPidgeOrderPayload, createPidgeOrder } from "../src/services/pidge.mjs";

const pickupEnv = {
  PIDGE_PICKUP_ADDRESS_LINE_1: "Hubtown Greenwood CHS, Flat 805/A Wing",
  PIDGE_PICKUP_ADDRESS_LINE_2: "Pokhran Road No. 1, Vartak Nagar",
  PIDGE_PICKUP_CITY: "Thane",
  PIDGE_PICKUP_STATE: "Maharashtra",
  PIDGE_PICKUP_COUNTRY: "India",
  PIDGE_PICKUP_PINCODE: "400606",
  PIDGE_PICKUP_NAME: "Test Sender",
  PIDGE_PICKUP_MOBILE: "9000000001",
  PIDGE_SUPPORT_NAME: "Test Support",
  PIDGE_SUPPORT_MOBILE: "9000000002",
};

const ftwOrder = {
  _id: "local-order-id",
  orderId: "#FTW20261105001",
  customerName: "Test Customer",
  phone: "9000000003",
  email: "customer@example.test",
  address: "B-12, Lake View, Airoli, 400708",
  deliveryArea: "Airoli",
  deliveryAddressDetail: {
    building: "B-12",
    street: "Lake View Road",
    area: "Airoli",
    pincode: "400708",
  },
  deliveryType: "delivery",
  paymentStatus: "unpaid",
  paymentMode: "cash",
  dueAmount: 520,
  total: 520,
  items: [{ name: "Basa", productId: "basa-id", price: 520, quantity: 1, bulkWeightKg: 1 }],
};

test("builds the Pidge delivery payload with required contacts, addresses, source, and COD", () => {
  const result = buildPidgeOrderPayload(ftwOrder, pickupEnv);
  assert.deepEqual(result.missingFields, []);
  assert.equal(result.payload.channel, "FTW");
  assert.equal(result.payload.sender_detail.name, "Test Sender");
  assert.equal(result.payload.sender_detail.address.pincode, "400606");
  assert.equal(result.payload.poc_detail.mobile, "9000000002");
  assert.equal(result.payload.trips[0].source_order_id, "FTW20261105001");
  assert.equal(result.payload.trips[0].cod_amount, 520);
  assert.equal(result.payload.trips[0].receiver_detail.address.address_line_1, "B-12, Lake View Road");
  assert.equal(result.payload.trips[0].receiver_detail.address.city, "Thane");
  assert.equal(result.payload.trips[0].products[0].dimension.dead_weight, 1000);
  assert.ok(result.warnings.some((warning) => warning.includes("city")));
  assert.ok(result.warnings.some((warning) => warning.includes("state")));
});

test("does not set Pidge COD for a settled online order", () => {
  const result = buildPidgeOrderPayload({
    ...ftwOrder,
    paymentStatus: "paid",
    paymentMode: "upi",
    dueAmount: 0,
  }, pickupEnv);
  assert.equal(result.payload.trips[0].cod_amount, 0);
});

test("normalizes Indian phone numbers to ten digits", () => {
  const result = buildPidgeOrderPayload({
    ...ftwOrder,
    phone: "+91 75072 19775",
  }, pickupEnv);
  assert.equal(result.payload.trips[0].receiver_detail.mobile, "7507219775");
});

test("reports missing customer data instead of sending an incomplete Pidge order", () => {
  const result = buildPidgeOrderPayload({
    ...ftwOrder,
    phone: "",
    address: "",
    deliveryAddressDetail: { building: "", pincode: "" },
  }, pickupEnv);
  assert.ok(result.missingFields.includes("customer mobile"));
  assert.ok(result.missingFields.includes("customer address line 1"));
  assert.ok(result.missingFields.includes("valid 6-digit customer pincode"));
});

test("logs in and creates a Pidge order, without exposing auth credentials", async () => {
  const envKeys = ["PIDGE_PRODUCTION_API_BASE_URL", "Pidge_Username", "Pidge_Password"];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const requests = [];
  process.env.PIDGE_PRODUCTION_API_BASE_URL = "https://pidge.test";
  process.env.Pidge_Username = "test-user";
  process.env.Pidge_Password = "test-password";
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/login")) {
      return new Response(JSON.stringify({ data: { token: "Bearer test-token" } }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ data: { FTW20261105001: "pidge-order-123" } }),
      { status: 200 },
    );
  };

  try {
    const result = await createPidgeOrder(ftwOrder);
    assert.equal(result.success, true);
    assert.equal(result.status, "sent");
    assert.equal(result.pidgeOrderId, "pidge-order-123");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].options.headers.Authorization, "Bearer test-token");
    assert.equal(requests[1].options.headers.Authorization.includes("test-password"), false);
    assert.equal(result.requestPayload.trips[0].source_order_id, "FTW20261105001");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("refreshes an expired token once after a 401 response", async () => {
  const envKeys = ["PIDGE_PRODUCTION_API_BASE_URL", "Pidge_Username", "Pidge_Password"];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let loginCount = 0;
  let createCount = 0;
  process.env.PIDGE_PRODUCTION_API_BASE_URL = "https://pidge.test";
  process.env.Pidge_Username = "test-user";
  process.env.Pidge_Password = "test-password";
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/login")) {
      loginCount += 1;
      return new Response(JSON.stringify({ data: { token: `Bearer token-${loginCount}` } }), { status: 200 });
    }
    createCount += 1;
    if (createCount === 1) return new Response(JSON.stringify({ message: "expired" }), { status: 401 });
    return new Response(JSON.stringify({ data: { FTW20261105001: "pidge-order-123" } }), { status: 200 });
  };

  try {
    const result = await createPidgeOrder(ftwOrder);
    assert.equal(result.success, true);
    assert.equal(loginCount, 2);
    assert.equal(createCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
