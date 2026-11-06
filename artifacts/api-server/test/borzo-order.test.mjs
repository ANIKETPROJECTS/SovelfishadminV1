import assert from "node:assert/strict";
import test from "node:test";
import { buildBorzoOrderPayload, createBorzoOrder } from "../src/services/borzo.mjs";

const pickupEnv = {
  BORZO_API_TOKEN: "test-token",
  BORZO_PICKUP_ADDRESS_LINE_1: "Test pickup, Building 8",
  BORZO_PICKUP_ADDRESS_LINE_2: "Test Road",
  BORZO_PICKUP_CITY: "Thane",
  BORZO_PICKUP_STATE: "Maharashtra",
  BORZO_PICKUP_COUNTRY: "India",
  BORZO_PICKUP_PINCODE: "400606",
  BORZO_PICKUP_NAME: "Test Sender",
  BORZO_PICKUP_MOBILE: "9000000001",
};

const ftwOrder = {
  _id: "local-order-id",
  orderId: "#FTW20261105001",
  customerName: "Test Customer",
  phone: "9000000003",
  address: "B-12, Lake View, Airoli",
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
  subtotal: 520,
  deliveryCharge: 80,
  dueAmount: 520,
  total: 600,
  items: [{ name: "Basa", productId: "basa-id", price: 520, quantity: 1, bulkWeightKg: 1 }],
};

test("builds Borzo test points, required contacts, item summary, and COD amount", () => {
  const result = buildBorzoOrderPayload(ftwOrder, pickupEnv);
  assert.deepEqual(result.missingFields, []);
  assert.equal(result.payload.type, "standard");
  assert.equal(result.payload.points.length, 2);
  assert.equal(result.payload.points[0].contact_person.phone, "919000000001");
  assert.match(result.payload.points[0].address, /400606/);
  assert.equal(result.payload.points[1].contact_person.phone, "919000000003");
  assert.equal(result.payload.points[1].client_order_id, "FTW20261105001");
  assert.equal(result.payload.points[1].taking_amount, "520.00");
  assert.equal(result.payload.points[1].is_cod_cash_voucher_required, true);
  assert.equal(result.payload.points[1].is_order_payment_here, undefined);
  assert.equal(result.payload.insurance_amount, "520.00");
  assert.ok(result.warnings.some((warning) => warning.includes("₹520.00")));
  assert.match(result.payload.matter, /Basa/);
  assert.equal(result.payload.total_weight_kg, 1);
});

test("does not request cash collection for a settled online payment", () => {
  const result = buildBorzoOrderPayload({
    ...ftwOrder,
    paymentStatus: "paid",
    paymentMode: "upi",
    dueAmount: 0,
  }, pickupEnv);
  assert.equal(result.payload.points[1].taking_amount, undefined);
  assert.equal(result.payload.points[1].is_cod_cash_voucher_required, undefined);
  assert.equal(result.payload.insurance_amount, "520.00");
});

test("derives declared goods value from item prices when subtotal is missing", () => {
  const result = buildBorzoOrderPayload({
    ...ftwOrder,
    subtotal: undefined,
    total: 620,
    deliveryCharge: 100,
    items: [
      { name: "Basa", price: 420, quantity: 1, bulkWeightKg: 1 },
      { name: "Pomfret", price: 100, quantity: 1, bulkWeightKg: 0.2 },
    ],
  }, pickupEnv);

  assert.equal(result.payload.insurance_amount, "520.00");
});

test("sends the full customer address snapshot, not the configured pickup address", () => {
  const customerAddress = "Flat 805, Wing A, Example Heights, Lake Road, Thane, Maharashtra, 400606";
  const result = buildBorzoOrderPayload({
    ...ftwOrder,
    address: customerAddress,
    deliveryArea: "Thane",
    deliveryAddressDetail: {
      houseNo: "Flat 805",
      buildingName: "Wing A, Example Heights",
      streetName: "Lake Road",
      locality: "Thane",
      pincode: "400606",
      city: "Thane",
      state: "Maharashtra",
    },
  }, pickupEnv);

  assert.equal(result.payload.points[1].address, customerAddress);
  assert.notEqual(result.payload.points[1].address, result.payload.points[0].address);
});

test("builds the recipient address from legacy customer address fields", () => {
  const result = buildBorzoOrderPayload({
    ...ftwOrder,
    address: "",
    deliveryArea: "",
    deliveryAddressDetail: {
      flatNo: "Flat 12",
      society: "Sample Residency",
      road: "Market Road",
      neighbourhood: "Airoli",
      zipCode: "400708",
      city: "Navi Mumbai",
      state: "Maharashtra",
    },
  }, pickupEnv);

  assert.match(result.payload.points[1].address, /Flat 12/);
  assert.match(result.payload.points[1].address, /Sample Residency/);
  assert.match(result.payload.points[1].address, /Market Road/);
  assert.match(result.payload.points[1].address, /Airoli/);
  assert.match(result.payload.points[1].address, /400708/);
});

test("rejects incomplete customer and pickup data before making an API request", () => {
  const result = buildBorzoOrderPayload({
    ...ftwOrder,
    phone: "",
    address: "",
    deliveryArea: "",
    deliveryAddressDetail: { building: "", pincode: "" },
  }, { BORZO_API_TOKEN: "test-token" });
  assert.ok(result.missingFields.includes("pickup address"));
  assert.ok(result.missingFields.includes("valid Indian pickup phone"));
  assert.ok(result.missingFields.includes("customer delivery address"));
  assert.ok(result.missingFields.includes("valid Indian customer phone"));
});

test("submits only to Borzo test with the documented auth-token header", async () => {
  const envKeys = ["BORZO_API_TOKEN", "BORZO_CLIENT_ID"];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const requests = [];
  process.env.BORZO_API_TOKEN = "test-token";
  process.env.BORZO_CLIENT_ID = "test-client-id";
  const pickupKeys = Object.keys(pickupEnv).filter((key) => key.startsWith("BORZO_PICKUP_"));
  const previousPickup = Object.fromEntries(pickupKeys.map((key) => [key, process.env[key]]));
  for (const key of pickupKeys) process.env[key] = pickupEnv[key];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({
      is_successful: true,
      order: { order_id: 12345, status: "new" },
    }), { status: 200 });
  };

  try {
    const result = await createBorzoOrder(ftwOrder);
    assert.equal(result.success, true);
    assert.equal(result.status, "sent");
    assert.equal(result.borzoOrderId, "12345");
    assert.equal(result.borzoOrderStatus, "new");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://robotapitest-in.borzodelivery.com/api/business/1.8/create-order");
    assert.equal(requests[0].options.headers["X-DV-Auth-Token"], "test-token");
    assert.equal(requests[0].options.headers["X-DV-Client-ID"], undefined);
    assert.equal(JSON.parse(requests[0].options.body).points[1].client_order_id, "FTW20261105001");
    assert.equal(JSON.stringify(result).includes("test-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const [key, value] of Object.entries(previousPickup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("marks server errors as uncertain to prevent duplicate delivery orders", async () => {
  const envKeys = ["BORZO_API_TOKEN"];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  process.env.BORZO_API_TOKEN = "test-token";
  const pickupKeys = Object.keys(pickupEnv).filter((key) => key.startsWith("BORZO_PICKUP_"));
  const previousPickup = Object.fromEntries(pickupKeys.map((key) => [key, process.env[key]]));
  for (const key of pickupKeys) process.env[key] = pickupEnv[key];
  globalThis.fetch = async () => new Response(JSON.stringify({ errors: ["internal_error"] }), { status: 500 });

  try {
    const result = await createBorzoOrder(ftwOrder);
    assert.equal(result.success, false);
    assert.equal(result.status, "unknown");
    assert.equal(result.error.outcomeMayBeUnknown, true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const [key, value] of Object.entries(previousPickup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("includes Borzo's exact field path when the API rejects request parameters", async () => {
  const envKeys = ["BORZO_API_TOKEN"];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  process.env.BORZO_API_TOKEN = "test-token";
  const pickupKeys = Object.keys(pickupEnv).filter((key) => key.startsWith("BORZO_PICKUP_"));
  const previousPickup = Object.fromEntries(pickupKeys.map((key) => [key, process.env[key]]));
  for (const key of pickupKeys) process.env[key] = pickupEnv[key];
  globalThis.fetch = async () => new Response(JSON.stringify({
    is_successful: false,
    errors: ["invalid_parameters"],
    parameter_errors: { points: [null, { taking_amount: ["not_allowed"] }] },
  }), { status: 400 });

  try {
    const result = await createBorzoOrder(ftwOrder);
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.match(result.error.message, /points\[1\]\.taking_amount: not_allowed/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const [key, value] of Object.entries(previousPickup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
