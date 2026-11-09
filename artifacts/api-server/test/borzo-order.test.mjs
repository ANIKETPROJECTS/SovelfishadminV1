import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBorzoBatchOrderPayload,
  buildBorzoOrderPayload,
  createBorzoBatchOrder,
  createBorzoOrder,
  getBorzoOrderDetails,
} from "../src/services/borzo.mjs";

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

const paidBatchOrders = [
  {
    ...ftwOrder,
    _id: "batch-order-1",
    orderId: "#FTS20261105001",
    paymentStatus: "paid",
    paymentMode: "upi",
    dueAmount: 0,
    paidAmount: 520,
    total: 600,
  },
  {
    ...ftwOrder,
    _id: "batch-order-2",
    orderId: "#FTW20261105002",
    customerName: "Second Test Customer",
    phone: "9000000004",
    address: "C-4, Garden Road, Thane",
    deliveryArea: "Thane",
    deliveryAddressDetail: {
      building: "C-4",
      street: "Garden Road",
      area: "Thane",
      pincode: "400610",
      latitude: 19.112233,
      longitude: 72.998877,
    },
    paymentStatus: "paid",
    paymentMode: "upi",
    subtotal: 300,
    dueAmount: 0,
    paidAmount: 300,
    total: 300,
    items: [{ name: "Pomfret", price: 300, quantity: 1, weightKg: 0.25 }],
  },
];

test("builds one Borzo job with one pickup and one customer stop per order", () => {
  const result = buildBorzoBatchOrderPayload(paidBatchOrders, pickupEnv);

  assert.deepEqual(result.missingFields, []);
  assert.equal(result.payload.points.length, 3);
  assert.equal(result.payload.points[0].address.includes("400606"), true);
  assert.equal(result.payload.points[1].client_order_id, "FTS20261105001");
  assert.equal(result.payload.points[2].client_order_id, "FTW20261105002");
  assert.notEqual(result.payload.points[1].address, result.payload.points[2].address);
  assert.equal(result.payload.points[2].latitude, "19.1122330");
  assert.equal(result.payload.points[2].longitude, "72.9988770");
  assert.equal(result.payload.points[1].taking_amount, undefined);
  assert.equal(result.payload.points[2].taking_amount, undefined);
  assert.equal(result.payload.insurance_amount, "820.00");
  assert.equal(result.payload.total_weight_kg, 2);
  assert.match(result.payload.matter, /FTS20261105001/);
  assert.match(result.payload.matter, /FTW20261105002/);
});

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

test("includes valid optional customer coordinates alongside the written address", () => {
  const customerAddress = "Flat 805, Wing A, Example Heights, Lake Road, Thane, Maharashtra, 400606";
  const result = buildBorzoOrderPayload({
    ...ftwOrder,
    address: customerAddress,
    deliveryArea: "Thane",
    deliveryAddressDetail: {
      building: "Flat 805, Wing A, Example Heights",
      street: "Lake Road",
      area: "Thane",
      pincode: "400606",
      city: "Thane",
      state: "Maharashtra",
      latitude: 19.218321,
      longitude: 72.978154,
    },
  }, pickupEnv);

  assert.equal(result.payload.points[1].address, customerAddress);
  assert.equal(result.payload.points[1].latitude, "19.2183210");
  assert.equal(result.payload.points[1].longitude, "72.9781540");
});

test("omits partial or out-of-range coordinates without dropping the address", () => {
  const result = buildBorzoOrderPayload({
    ...ftwOrder,
    deliveryAddressDetail: {
      ...ftwOrder.deliveryAddressDetail,
      latitude: 200,
    },
  }, pickupEnv);

  assert.ok(result.payload.points[1].address);
  assert.equal(result.payload.points[1].latitude, undefined);
  assert.equal(result.payload.points[1].longitude, undefined);
  assert.ok(result.warnings.some((warning) => warning.includes("coordinates were omitted")));
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

test("submits a multi-order batch as one Borzo test API request", async () => {
  const envKeys = ["BORZO_API_TOKEN"];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const requests = [];
  process.env.BORZO_API_TOKEN = "test-token";
  const pickupKeys = Object.keys(pickupEnv).filter((key) => key.startsWith("BORZO_PICKUP_"));
  const previousPickup = Object.fromEntries(pickupKeys.map((key) => [key, process.env[key]]));
  for (const key of pickupKeys) process.env[key] = pickupEnv[key];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({
      is_successful: true,
      order: { order_id: 54321, status: "new" },
    }), { status: 200 });
  };

  try {
    const result = await createBorzoBatchOrder(paidBatchOrders);
    const sentPayload = JSON.parse(requests[0].options.body);
    assert.equal(result.success, true);
    assert.equal(result.borzoOrderId, "54321");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://robotapitest-in.borzodelivery.com/api/business/1.8/create-order");
    assert.equal(sentPayload.points.length, 3);
    assert.deepEqual(result.batchOrderIds, ["FTS20261105001", "FTW20261105002"]);
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

test("fetches a specific Borzo test order and returns its live status and fees", async () => {
  const previousToken = process.env.BORZO_API_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.BORZO_API_TOKEN = "test-token";
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({
      is_successful: true,
      orders: [{
        order_id: 333402,
        status: "completed",
        status_description: "Completed",
        payment_amount: "125.00",
        delivery_fee_amount: "100.00",
        insurance_fee_amount: "25.00",
        points: [{ delivery: { status: "finished" } }],
      }],
    }), { status: 200 });
  };

  try {
    const result = await getBorzoOrderDetails("333402");
    assert.equal(result.success, true);
    assert.equal(result.order.status, "completed");
    assert.equal(result.order.delivery_fee_amount, "100.00");
    assert.equal(result.order.points[0].delivery.status, "finished");
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].url,
      "https://robotapitest-in.borzodelivery.com/api/business/1.8/orders?order_id=333402&count=1",
    );
    assert.equal(requests[0].options.method, "GET");
    assert.equal(requests[0].options.headers["X-DV-Auth-Token"], "test-token");
    assert.equal(requests[0].options.body, undefined);
    assert.equal(JSON.stringify(result).includes("test-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.BORZO_API_TOKEN;
    else process.env.BORZO_API_TOKEN = previousToken;
  }
});

test("reports when the requested Borzo order is not returned by the test account", async () => {
  const previousToken = process.env.BORZO_API_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.BORZO_API_TOKEN = "test-token";
  globalThis.fetch = async () => new Response(JSON.stringify({
    is_successful: true,
    orders: [{ order_id: 123, status: "new" }],
  }), { status: 200 });

  try {
    const result = await getBorzoOrderDetails("333402");
    assert.equal(result.success, false);
    assert.equal(result.error.code, "order_not_found");
    assert.match(result.error.message, /333402/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.BORZO_API_TOKEN;
    else process.env.BORZO_API_TOKEN = previousToken;
  }
});
