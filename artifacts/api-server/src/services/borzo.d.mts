export interface BorzoPayloadBuildResult {
  payload: Record<string, any>;
  missingFields: string[];
  warnings: string[];
}

export interface BorzoDispatchResult {
  success: boolean;
  status: "sent" | "failed" | "already_sent" | "unknown" | "in_progress";
  environment?: "test" | "production";
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
    code?: string;
    category?: string;
    providerErrorCodes?: string[];
    parameterErrors?: any;
    recommendedAction?: string;
    retrySafe?: boolean;
    missingFields?: string[];
    httpStatus?: number;
    responseBody?: any;
    outcomeMayBeUnknown?: boolean;
  };
}

export function buildBorzoOrderPayload(order: any, env?: Record<string, string | undefined>): BorzoPayloadBuildResult;
export function buildBorzoBatchOrderPayload(orders: any[], env?: Record<string, string | undefined>): BorzoPayloadBuildResult;
export function getBorzoEnvironment(env?: Record<string, string | undefined>): "test" | "production";
export function createBorzoOrder(order: any): Promise<BorzoDispatchResult>;
export function createBorzoBatchOrder(orders: any[]): Promise<BorzoDispatchResult>;
export function getBorzoOrderDetails(orderId: string, environment?: "test" | "production"): Promise<any>;
