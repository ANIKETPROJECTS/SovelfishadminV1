/**
 * Sort by expiry only. Equal-expiry batches stay in their existing array order;
 * creation, receipt, and stock-edit timestamps do not affect order deductions.
 */
export function sortBatchesByExpiry(batches) {
  return [...batches].sort((a, b) => {
    const aExpiry = expiryTimestamp(a.expiryDate);
    const bExpiry = expiryTimestamp(b.expiryDate);
    if (aExpiry === bExpiry) return 0;
    return aExpiry < bExpiry ? -1 : 1;
  });
}

/**
 * Plan a deduction from an already-filtered set of eligible batches.
 * Returns exact per-batch quantities without mutating the input.
 */
export function planBatchConsumption(batches, quantity, preferredBatchId) {
  let remaining = Math.max(0, Number(quantity) || 0);
  const allocations = [];
  const orderedBatches = preferredBatchId == null
    ? sortBatchesByExpiry(batches)
    : sortBatchesByExpiry(
      batches.filter((batch) => batch._id != null && String(batch._id) === String(preferredBatchId)),
    );

  for (const batch of orderedBatches) {
    if (remaining <= 0) break;
    const take = Math.min(Math.max(0, Number(batch.quantity) || 0), remaining);
    if (take <= 0) continue;
    allocations.push({
      batchId: batch._id,
      batchNumber: batch.batchNumber || undefined,
      quantity: take,
    });
    remaining -= take;
  }

  return { allocations, remaining };
}

/**
 * Convert a number of sale packs to shared kilogram inventory.
 * Regular items remain quantity-based when no bulk portion weight is supplied.
 */
export function inventoryQuantityForOrder(quantity, bulkWeightKg) {
  const count = Math.max(0, Number(quantity) || 0);
  const weight = Number(bulkWeightKg);
  if (count <= 0) return 0;
  if (!Number.isFinite(weight) || weight <= 0) return count;
  return Math.round(count * weight * 1000) / 1000;
}

function roundKg(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

/**
 * Bulk sale options use their midpoint as the priced and deducted weight.
 * Older products only store exact weights, so those remain valid options.
 */
export function normalizeBulkPortionOptions(options, legacyWeights = []) {
  const source = Array.isArray(options) && options.length > 0
    ? options
    : (Array.isArray(legacyWeights) ? legacyWeights : []).map((weightKg) => ({ weightKg }));
  const normalized = [];
  const seenWeights = new Set();

  for (const raw of source) {
    const hasMin = typeof raw === "object" && raw?.minWeightKg != null && raw.minWeightKg !== "";
    const hasMax = typeof raw === "object" && raw?.maxWeightKg != null && raw.maxWeightKg !== "";
    let weightKg;
    let minWeightKg;
    let maxWeightKg;

    if (hasMin || hasMax) {
      if (!hasMin || !hasMax) continue;
      minWeightKg = roundKg(raw.minWeightKg);
      maxWeightKg = roundKg(raw.maxWeightKg);
      if (!Number.isFinite(minWeightKg) || minWeightKg <= 0 ||
        !Number.isFinite(maxWeightKg) || maxWeightKg <= minWeightKg) continue;
      weightKg = roundKg((minWeightKg + maxWeightKg) / 2);
    } else {
      weightKg = roundKg(typeof raw === "number" ? raw : raw?.weightKg);
      if (!Number.isFinite(weightKg) || weightKg <= 0) continue;
    }

    const key = weightKg.toFixed(3);
    if (seenWeights.has(key)) continue;
    seenWeights.add(key);
    normalized.push({
      weightKg,
      ...(minWeightKg != null && maxWeightKg != null ? { minWeightKg, maxWeightKg } : {}),
      ...(typeof raw === "object" && String(raw?.pieces ?? "").trim()
        ? { pieces: String(raw.pieces).trim().slice(0, 120) }
        : {}),
      ...(typeof raw === "object" && String(raw?.serves ?? "").trim()
        ? { serves: String(raw.serves).trim().slice(0, 120) }
        : {}),
    });
  }

  return normalized.sort((a, b) => a.weightKg - b.weightKg);
}

export function isValidBulkPortionOptions(options) {
  if (!Array.isArray(options) || options.length === 0) return false;
  const seenWeights = new Set();

  for (const raw of options) {
    if (typeof raw !== "number" && (!raw || typeof raw !== "object")) return false;
    const hasMin = typeof raw === "object" && raw.minWeightKg != null && raw.minWeightKg !== "";
    const hasMax = typeof raw === "object" && raw.maxWeightKg != null && raw.maxWeightKg !== "";
    let weightKg;

    if (hasMin || hasMax) {
      if (!hasMin || !hasMax) return false;
      const minWeightKg = roundKg(raw.minWeightKg);
      const maxWeightKg = roundKg(raw.maxWeightKg);
      if (!Number.isFinite(minWeightKg) || minWeightKg <= 0 ||
        !Number.isFinite(maxWeightKg) || maxWeightKg <= minWeightKg) return false;
      weightKg = roundKg((minWeightKg + maxWeightKg) / 2);
    } else {
      weightKg = roundKg(typeof raw === "number" ? raw : raw.weightKg);
      if (!Number.isFinite(weightKg) || weightKg <= 0) return false;
    }

    const key = weightKg.toFixed(3);
    if (seenWeights.has(key)) return false;
    seenWeights.add(key);
  }

  return true;
}

export function formatBulkPortionWeightLabel(weightKg) {
  const weight = Number(weightKg);
  if (!Number.isFinite(weight) || weight <= 0) return "";
  return weight < 1
    ? `${Math.round(weight * 1000)} g`
    : `${weight.toLocaleString("en-IN", { maximumFractionDigits: 3 })} kg`;
}

export function formatBulkPortionRangeLabel(option) {
  if (option?.minWeightKg == null || option?.maxWeightKg == null) {
    return formatBulkPortionWeightLabel(option?.weightKg);
  }
  return `${formatBulkPortionWeightLabel(option.minWeightKg)}–${formatBulkPortionWeightLabel(option.maxWeightKg)}`;
}

/**
 * Return deductions that have not yet been reversed. New restore movements
 * explicitly reference their deduction movement IDs. Older movements did not
 * have references, so pair those in chronological order for compatibility.
 */
export function getOutstandingDeductionMovements(deductions, restores) {
  const restoredIds = new Set();
  const legacyRestores = [];

  for (const restore of restores) {
    const refs = Array.isArray(restore.reversesMovementIds)
      ? restore.reversesMovementIds
      : restore.reversesMovementId != null
        ? [restore.reversesMovementId]
        : [];
    if (refs.length > 0) {
      for (const id of refs) restoredIds.add(String(id));
    } else {
      legacyRestores.push(restore);
    }
  }

  const legacyDeductions = deductions
    .filter((movement) => !Array.isArray(movement.batchAllocations))
    .sort((a, b) => eventTime(a) - eventTime(b));
  const pendingLegacyIds = legacyDeductions
    .filter((movement) => !restoredIds.has(String(movement._id)))
    .map((movement) => String(movement._id));

  const legacyEvents = [
    ...legacyDeductions
      .filter((movement) => pendingLegacyIds.includes(String(movement._id)))
      .map((movement) => ({ kind: "deduct", movement })),
    ...legacyRestores.map((movement) => ({ kind: "restore", movement })),
  ].sort((a, b) => {
    const timeDifference = eventTime(a.movement) - eventTime(b.movement);
    if (timeDifference !== 0) return timeDifference;
    if (a.kind === b.kind) return 0;
    return a.kind === "deduct" ? -1 : 1;
  });

  const unmatchedLegacyDeductions = [];
  for (const event of legacyEvents) {
    if (event.kind === "deduct") unmatchedLegacyDeductions.push(String(event.movement._id));
    else if (unmatchedLegacyDeductions.length > 0) {
      restoredIds.add(unmatchedLegacyDeductions.shift());
    }
  }

  return deductions.filter((movement) => !restoredIds.has(String(movement._id)));
}

/**
 * Restore each allocation to its original batch ID. If that batch was removed,
 * recreate it from the metadata captured at deduction time. Legacy allocations
 * without IDs can target a unique batch number.
 */
export function restoreBatchAllocations(batches, allocations) {
  const restoredBatches = batches.map((batch) => ({ ...batch }));
  const restoredAllocations = [];
  const unmatchedAllocations = [];

  for (const allocation of allocations) {
    const quantity = Math.max(0, Number(allocation.quantity) || 0);
    if (quantity === 0) continue;

    let index = -1;
    if (allocation.batchId != null) {
      index = restoredBatches.findIndex(
        (batch) => batch._id != null && String(batch._id) === String(allocation.batchId),
      );
    } else if (allocation.batchNumber) {
      index = restoredBatches.findIndex(
        (batch) => String(batch.batchNumber ?? "") === String(allocation.batchNumber),
      );
    }

    if (index >= 0) {
      restoredBatches[index] = {
        ...restoredBatches[index],
        quantity: (Number(restoredBatches[index].quantity) || 0) + quantity,
      };
      restoredAllocations.push(allocation);
      continue;
    }

    if (allocation.batchId != null && allocation.batchSnapshot) {
      restoredBatches.push({
        ...allocation.batchSnapshot,
        _id: allocation.batchId,
        quantity,
      });
      restoredAllocations.push(allocation);
      continue;
    }

    unmatchedAllocations.push(allocation);
  }

  return { batches: restoredBatches, restoredAllocations, unmatchedAllocations };
}

function expiryTimestamp(expiryDate) {
  if (expiryDate == null) return Infinity;
  const timestamp = new Date(expiryDate).getTime();
  return Number.isFinite(timestamp) ? timestamp : Infinity;
}

function eventTime(movement) {
  const timestamp = new Date(movement.createdAt ?? 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}
