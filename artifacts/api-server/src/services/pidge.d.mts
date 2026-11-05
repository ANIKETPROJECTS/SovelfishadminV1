export interface PidgePayloadBuildResult {
  payload: Record<string, any>;
  missingFields: string[];
  warnings: string[];
}

export interface PidgeDispatchResult {
  success: boolean;
  status: "sent" | "failed" | "already_sent" | "unknown" | "in_progress";
  requestPayload: Record<string, any>;
  requestMethod?: string;
  requestUrl?: string;
  authentication?: {
    scheme: string;
    attempts: { success: boolean; httpStatus?: number; refreshed?: boolean; responseBody?: any }[];
  };
  warnings: string[];
  message?: string;
  httpStatus?: number;
  responseBody?: any;
  pidgeOrderId?: string;
  error?: {
    message: string;
    missingFields?: string[];
    httpStatus?: number;
    responseBody?: any;
    outcomeMayBeUnknown?: boolean;
  };
}

export function buildPidgeOrderPayload(order: any, env?: Record<string, string | undefined>): PidgePayloadBuildResult;
export function createPidgeOrder(order: any): Promise<PidgeDispatchResult>;
