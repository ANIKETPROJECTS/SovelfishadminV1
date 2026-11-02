const LEGACY_UNIT_MAP: Record<string, string> = {
  "per kg": "kg",
  kg: "kg",
  "per 500g": "gram",
  "per 250g": "gram",
  "per 100g": "gram",
  "per g": "gram",
  g: "gram",
  gram: "gram",
  grams: "gram",
  "per pack": "pack",
};

export function normalizeProductUnit(value: unknown, fallback = "pack"): string {
  const raw = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!raw) return fallback;
  return LEGACY_UNIT_MAP[raw.toLowerCase()] ?? raw;
}

export function getProductUnitSuffix(value: unknown): string {
  const unit = normalizeProductUnit(value, "");
  return unit.replace(/^per\s+/i, "");
}

export function formatVariantLabelWithUnit(
  labelValue: unknown,
  unitValue: unknown,
  fallback = "Standard",
): string {
  const label = String(labelValue ?? "").trim();
  if (!label || label.toLowerCase() === "standard") return fallback;

  const suffix = getProductUnitSuffix(unitValue);
  if (!suffix) return label;

  const canonicalLabel = label.replace(/\s+per\s+(kg|500g|250g|100g)$/i, (_match, legacyUnit: string) =>
    ` ${normalizeProductUnit(`per ${legacyUnit}`, suffix)}`,
  );
  if (/(?:^|\s|[0-9])(?:kg|g|grams?|pieces?|tray|pack)$/i.test(canonicalLabel)) {
    return canonicalLabel;
  }
  return `${canonicalLabel} ${suffix}`;
}
