function getToken() { return localStorage.getItem("fishtokri_token") || ""; }
function getBase() { return import.meta.env.BASE_URL?.replace(/\/$/, "") || ""; }

export function getCurrentAdmin(): { name: string; email: string } {
  try {
    const a = JSON.parse(localStorage.getItem("fishtokri_admin") || "{}");
    return { name: a.name || a.email || "", email: a.email || "" };
  } catch {
    return { name: "", email: "" };
  }
}

export function getCurrentAdminScope(): {
  role: string;
  superHubIds: string[];
  subHubIds: string[];
} {
  try {
    const a = JSON.parse(localStorage.getItem("fishtokri_admin") || "{}");
    return {
      role: typeof a.role === "string" ? a.role : "",
      superHubIds: Array.isArray(a.superHubIds)
        ? a.superHubIds.filter((x: any) => typeof x === "string")
        : [],
      subHubIds: Array.isArray(a.subHubIds)
        ? a.subHubIds.filter((x: any) => typeof x === "string")
        : [],
    };
  } catch {
    return { role: "", superHubIds: [], subHubIds: [] };
  }
}

export async function apiFetch(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${getBase()}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message ?? "Request failed");
  }
  return res.json();
}

export function logBorzoDispatchResult(orderId: string, borzo: any) {
  if (!borzo) return;
  const environment = borzo.environment === "production"
    ? "production"
    : borzo.environment === "test"
      ? "test"
      : "unknown environment";
  const title = `[Borzo ${environment}] ${orderId}: ${String(borzo.status ?? "unknown").toUpperCase()}`;
  console.group(title);
  console.info("Submission result:", borzo.success ? "success" : "not successful");
  console.info("Environment:", environment);
  if (borzo.requestMethod || borzo.requestUrl) {
    console.info("Borzo endpoint:", borzo.requestMethod ?? "POST", borzo.requestUrl ?? "(not configured)");
  }
  if (borzo.authentication) console.info("Authentication (token hidden):", borzo.authentication);
  if (borzo.batchId) console.info("Borzo batch ID:", borzo.batchId);
  if (Array.isArray(borzo.batchOrderIds)) console.info("Source orders in this batch:", borzo.batchOrderIds);
  if (borzo.httpStatus !== undefined) console.info("HTTP status:", borzo.httpStatus);
  if (borzo.serverRequestId !== undefined) {
    console.info("API request ID (use this to find the matching server log):", borzo.serverRequestId);
  }
  if (borzo.borzoOrderId) console.info("Borzo order ID:", borzo.borzoOrderId);
  if (borzo.borzoOrderStatus) console.info("Borzo order status:", borzo.borzoOrderStatus);
  if (borzo.message) console.info("Message:", borzo.message);
  if (Array.isArray(borzo.warnings) && borzo.warnings.length > 0) {
    console.warn("Payload warnings:", borzo.warnings);
  }
  if (borzo.requestPayload) {
    console.info(
      "Request payload (full JSON; API token excluded):\n" +
      JSON.stringify(borzo.requestPayload, null, 2),
    );
  }
  if (borzo.responseBody !== undefined) {
    console.info(
      "Borzo response (full JSON):\n" +
      JSON.stringify(borzo.responseBody, null, 2),
    );
  }
  if (borzo.error) {
    if (borzo.error.code) console.error("Borzo provider error code:", borzo.error.code);
    if (borzo.error.category) console.info("Error category:", borzo.error.category);
    if (Array.isArray(borzo.error.providerErrorCodes)) {
      console.error("All Borzo error codes:", borzo.error.providerErrorCodes);
    }
    if (borzo.error.parameterErrors !== undefined) {
      console.error("Borzo parameter errors:", borzo.error.parameterErrors);
    }
    if (borzo.error.recommendedAction) {
      console.info("Recommended next step:", borzo.error.recommendedAction);
    }
    if (borzo.error.retrySafe !== undefined) {
      console.info("Retry safe after resolving the error:", borzo.error.retrySafe);
    }
    console.error(
      "Borzo error details (full JSON):\n" +
      JSON.stringify(borzo.error, null, 2),
    );
  }
  if (borzo.status === "failed") {
    console.info("Borzo order created:", "No — Borzo rejected the request.");
  } else if (borzo.status === "unknown") {
    console.warn("Borzo order created:", "Unknown — check the matching Borzo account before retrying.");
  } else if (borzo.status === "sent") {
    console.info("Borzo order created:", "Yes.");
  }
  console.groupEnd();
}

export function formatRupees(n: number) {
  return `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatDateDDMMYYYY(d: any) {
  if (!d) return "—";
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = dt.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}
