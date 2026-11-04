import mongoose from "mongoose";

if (!process.env.MONGODB_URI) {
  console.error("MONGODB_URI not set");
  process.exit(1);
}

const url = new URL(process.env.MONGODB_URI);
url.pathname = "/customers";
const uri = url.toString();

const conn = await mongoose.createConnection(uri).asPromise();
const col = conn.db.collection("customers");

const now = new Date();
const newCustomers = [
  {
    name: "Sairaj Koyande",
    email: "sairaj.koyande@example.com",
    phone: "9820011001",
    dateOfBirth: "",
    addresses: [{
      label: "Home", type: "house",
      name: "Sairaj Koyande", phone: "9820011001",
      building: "B-204, Sai Residency",
      street: "MG Road",
      area: "Airoli",
      pincode: "400601",
      instructions: "Ring bell twice",
      isDefault: true,
    }],
    orders: [], usedCoupons: [],
    createdAt: now, updatedAt: now,
  },
  {
    name: "Pratik Kadam",
    email: "pratik.kadam@example.com",
    phone: "9820022002",
    dateOfBirth: "",
    addresses: [{
      label: "Home", type: "house",
      name: "Pratik Kadam", phone: "9820022002",
      building: "A-101, Krishna Heights",
      street: "Station Road",
      area: "Dombivli East",
      pincode: "421201",
      instructions: "",
      isDefault: true,
    }],
    orders: [], usedCoupons: [],
    createdAt: now, updatedAt: now,
  },
  {
    name: "Abhijeet Singh",
    email: "abhijeet.singh@example.com",
    phone: "9820033003",
    dateOfBirth: "",
    addresses: [{
      label: "Home", type: "house",
      name: "Abhijeet Singh", phone: "9820033003",
      building: "C-12, Royal Enclave",
      street: "LBS Marg",
      area: "Mulund West",
      pincode: "400080",
      instructions: "Leave at door",
      isDefault: true,
    }],
    orders: [], usedCoupons: [],
    createdAt: now, updatedAt: now,
  },
  {
    name: "Sejal Yadav",
    email: "sejal.yadav@example.com",
    phone: "9820044004",
    dateOfBirth: "",
    addresses: [{
      label: "Home", type: "house",
      name: "Sejal Yadav", phone: "9820044004",
      building: "Flat 502, Greenwood Towers",
      street: "Pokhran Road No. 2",
      area: "Airoli",
      pincode: "400610",
      instructions: "",
      isDefault: true,
    }],
    orders: [], usedCoupons: [],
    createdAt: now, updatedAt: now,
  },
];

const phones = newCustomers.map((c) => c.phone);
const existing = await col.find({ phone: { $in: phones } }).project({ phone: 1, name: 1 }).toArray();
console.log("Existing matches:", existing);

const toInsert = newCustomers.filter((c) => !existing.some((e) => e.phone === c.phone));
console.log("Inserting", toInsert.length, "customers");

if (toInsert.length) {
  const res = await col.insertMany(toInsert);
  console.log("Inserted IDs:", Object.values(res.insertedIds).map(String));
}

const total = await col.countDocuments();
console.log("Total customers in collection:", total);

await conn.close();
process.exit(0);
