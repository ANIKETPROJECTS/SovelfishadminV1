import { DEFAULT_CITY_AREAS } from "../data/default-city-areas.mjs";

const seedMarkerId = "default-city-areas-v1";

export async function ensureCityAreasInitialized(db) {
  const settings = db.collection("menu_settings");
  const marker = await settings.findOne({ _id: seedMarkerId });
  if (marker) return;

  const collection = db.collection("city_areas");
  const existingCount = await collection.countDocuments();
  if (existingCount === 0) {
    await collection.createIndex({ nameKey: 1 }, { unique: true });
    const now = new Date();
    await collection.bulkWrite(
      DEFAULT_CITY_AREAS.map(({ name, charge }) => ({
        updateOne: {
          filter: { nameKey: name.trim().toLocaleLowerCase("en-IN") },
          update: {
            $setOnInsert: {
              name,
              nameKey: name.trim().toLocaleLowerCase("en-IN"),
              charge,
              isActive: true,
              createdAt: now,
              updatedAt: now,
            },
          },
          upsert: true,
        },
      })),
      { ordered: true },
    );
  }

  await settings.updateOne(
    { _id: seedMarkerId },
    { $setOnInsert: { initializedAt: new Date(), source: "delivery-charge spreadsheet" } },
    { upsert: true },
  );
}
