export interface BorzoPayloadBuildResult {
  payload: Record<string, any>;
  missingFields: string[];
  warnings: string[];
}

export interface BorzoDispatchResult {
  success: boolean;
  status: "sent" | "failed" | "already_sent" | "unknown" | "in_progress";
  requestPayload: Record<string, any>;
  requestMethod?: string;
  requestUrl?: string;
  authentication?: { scheme: string };
  warnings: string[];
  message?: string;
  httpStatus?: number;
  responseBody?: any;
  borzoOrderId?: string;
  borzoOrderStatus?: string;
  batchId?: string;
  batchOrderIds?: string[];
  error?: {
    message: string;
    missingFields?: string[];
    httpStatus?: number;
    responseBody?: any;
    outcomeMayBeUnknown?: boolean;
  };
}

export function buildBorzoOrderPayload(order: any, env?: Record<string, string | undefined>): BorzoPayloadBuildResult;
export function buildBorzoBatchOrderPayload(orders: any[], env?: Record<string, string | undefined>): BorzoPayloadBuildResult;
export function createBorzoOrder(order: any): Promise<BorzoDispatchResult>;
export function createBorzoBatchOrder(orders: any[]): Promise<BorzoDispatchResult>;
