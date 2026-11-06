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
  const title = `[Borzo test] ${orderId}: ${String(borzo.status ?? "unknown").toUpperCase()}`;
  console.groupCollapsed(title);
  console.info("Submission result:", borzo.success ? "success" : "not successful");
  console.info("Environment: Borzo test");
  if (borzo.requestMethod || borzo.requestUrl) {
    console.info("Borzo endpoint:", borzo.requestMethod ?? "POST", borzo.requestUrl ?? "(not configured)");
  }
  if (borzo.authentication) console.info("Authentication (token hidden):", borzo.authentication);
  if (borzo.httpStatus !== undefined) console.info("HTTP status:", borzo.httpStatus);
  if (borzo.borzoOrderId) console.info("Borzo order ID:", borzo.borzoOrderId);
  if (borzo.borzoOrderStatus) console.info("Borzo order status:", borzo.borzoOrderStatus);
  if (borzo.message) console.info("Message:", borzo.message);
  if (Array.isArray(borzo.warnings) && borzo.warnings.length > 0) {
    console.warn("Payload warnings:", borzo.warnings);
  }
  if (borzo.requestPayload) console.info("Request payload (credentials excluded):", borzo.requestPayload);
  if (borzo.responseBody !== undefined) console.info("Borzo response:", borzo.responseBody);
  if (borzo.error) console.error("Borzo error:", borzo.error);
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
