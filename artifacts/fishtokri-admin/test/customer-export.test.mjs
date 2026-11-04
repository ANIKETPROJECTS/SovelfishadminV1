import assert from "node:assert/strict";
import test from "node:test";
import { filterCustomerRecords, toCustomerExportRow } from "../src/lib/customer-export.mjs";

const customers = [
  {
    id: "newer-match",
    email: "match@example.com",
    addresses: [{ city: "Airoli" }],
    walletBalance: 40,
    createdAt: "2026-10-05T12:00:00.000Z",
    currentOrders: [{ status: "confirmed" }],
    orderHistory: [],
  },
  {
    id: "older-match",
    email: "match2@example.com",
    addresses: [{ city: "Mumbai" }],
    walletBalance: 10,
    createdAt: "2026-10-01T12:00:00.000Z",
    orders: [{ status: "delivered" }],
  },
  {
    id: "no-match",
    email: "",
    addresses: [],
    walletBalance: 0,
    createdAt: "2026-09-01T12:00:00.000Z",
    orders: [],
  },
];

test("applies customer filters across the full result set", () => {
  const result = filterCustomerRecords(customers, {
    filterOrders: "has",
    filterEmail: "yes",
    filterAddr: "yes",
    filterWallet: "has",
    filterJoinedFrom: "2026-10-01",
    filterJoinedTo: "2026-10-05",
  });

  assert.deepEqual(result.map((customer) => customer.id), ["newer-match", "older-match"]);
});

test("filters customers without orders, email, addresses, or wallet balance", () => {
  const result = filterCustomerRecords(customers, {
    filterOrders: "none",
    filterEmail: "no",
    filterAddr: "no",
    filterWallet: "none",
  });

  assert.deepEqual(result.map((customer) => customer.id), ["no-match"]);
});

test("preserves full-list wallet sorting after filtering", () => {
  const result = filterCustomerRecords(customers, {
    filterWallet: "has",
    sort: "wallet_desc",
  });

  assert.deepEqual(result.map((customer) => customer.id), ["newer-match", "older-match"]);
});

test("exports only the Full Name and Phone columns", () => {
  const row = toCustomerExportRow({
    name: "Anita Patil",
    phone: "0987654321",
    email: "anita@example.com",
    walletBalance: 250,
  });

  assert.deepEqual(row, { "Full Name": "Anita Patil", Phone: "0987654321" });
  assert.deepEqual(Object.keys(row), ["Full Name", "Phone"]);
});
