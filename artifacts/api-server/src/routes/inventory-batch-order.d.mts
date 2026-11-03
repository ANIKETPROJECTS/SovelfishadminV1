export interface ExpiryBatch {
  expiryDate?: Date | string | null;
}

export interface BatchAllocation {
  batchId?: unknown;
  batchNumber?: string;
  quantity: number;
  deductionMovementId?: unknown;
  batchSnapshot?: {
    batchNumber?: string;
    shelfLifeDays?: number | null;
    receivedDate?: Date | string | null;
    expiryDate?: Date | string | null;
    notes?: string;
    createdAt?: Date | string;
  };
}

export interface InventoryMovement {
  _id: unknown;
  productId?: string;
  createdAt?: Date | string;
  batchAllocations?: BatchAllocation[];
  reversesMovementId?: unknown;
  reversesMovementIds?: unknown[];
}

export declare function sortBatchesByExpiry<T extends ExpiryBatch>(
  batches: T[],
): T[];

export declare function planBatchConsumption<
  T extends ExpiryBatch & { _id?: unknown; batchNumber?: string; quantity: number },
>(
  batches: T[],
  quantity: number,
  preferredBatchId?: unknown,
): { allocations: BatchAllocation[]; remaining: number };

export declare function getOutstandingDeductionMovements<T extends InventoryMovement>(
  deductions: T[],
  restores: InventoryMovement[],
): T[];

export declare function restoreBatchAllocations<
  T extends { _id?: unknown; batchNumber?: string; quantity: number },
>(
  batches: T[],
  allocations: BatchAllocation[],
): {
  batches: T[];
  restoredAllocations: BatchAllocation[];
  unmatchedAllocations: BatchAllocation[];
};
