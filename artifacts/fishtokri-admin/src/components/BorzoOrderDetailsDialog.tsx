import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Code2,
  Truck,
  XCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function readableDate(value: unknown): string {
  if (!value) return "—";
  const date = new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function jsonText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function InfoField({ label, value }: { label: string; value: unknown }) {
  const display = value === undefined || value === null || value === "" ? "—" : String(value);
  return (
    <div className="min-w-0 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold text-slate-900">{display}</p>
    </div>
  );
}

function JsonDetails({ title, value }: { title: string; value: unknown }) {
  const text = jsonText(value);
  if (!text) return null;
  return (
    <details className="rounded-lg border border-slate-200">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-semibold text-slate-800">
        <Code2 className="h-4 w-4 text-slate-500" />
        {title}
      </summary>
      <pre className="max-h-72 overflow-auto border-t border-slate-200 bg-slate-950 p-3 text-xs leading-relaxed text-slate-100">
        {text}
      </pre>
    </details>
  );
}

export function BorzoOrderDetailsDialog({
  open,
  onOpenChange,
  order,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: any;
}) {
  const dispatch = order?.borzoDispatch ?? null;
  const dispatchStatus = String(dispatch?.status ?? "").trim().toLowerCase();
  const isAccepted = dispatchStatus === "sent";
  const isFailed = dispatchStatus === "failed";
  const isUnknown = dispatchStatus === "unknown";
  const isSending = dispatchStatus === "sending";
  const providerState = isAccepted
    ? { label: "Accepted by Borzo", className: "bg-emerald-50 text-emerald-800 border-emerald-200", icon: CheckCircle2 }
    : isFailed
      ? { label: "Submission failed", className: "bg-red-50 text-red-800 border-red-200", icon: XCircle }
      : isUnknown
        ? { label: "Result uncertain", className: "bg-amber-50 text-amber-900 border-amber-200", icon: AlertTriangle }
        : isSending
          ? { label: "Submission in progress", className: "bg-blue-50 text-blue-800 border-blue-200", icon: Clock3 }
          : dispatch
            ? { label: dispatchStatus || "No status", className: "bg-slate-50 text-slate-700 border-slate-200", icon: Truck }
            : { label: "No submission recorded", className: "bg-slate-50 text-slate-700 border-slate-200", icon: AlertTriangle };
  const ProviderIcon = providerState.icon;
  const error = dispatch?.error ?? (dispatch?.errorMessage ? { message: dispatch.errorMessage } : undefined);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-slate-100 px-6 py-5 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2 text-lg font-bold text-slate-950">
            <Truck className="h-5 w-5 text-[#364F9F]" />
            Borzo order details
          </DialogTitle>
          <DialogDescription>
            Dispatch information for {order?.orderId || order?._id || "this order"}.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className={`flex items-start gap-3 rounded-xl border p-4 ${providerState.className}`}>
            <ProviderIcon className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-bold">{providerState.label}</p>
              <p className="mt-1 text-sm">
                {isAccepted
                  ? "Borzo accepted the API request. The provider status below is the latest status saved by this app."
                  : isFailed
                    ? "The saved result indicates Borzo rejected the request or the request failed."
                    : isUnknown
                      ? "The outcome could not be confirmed. Check the Borzo dashboard before retrying."
                      : isSending
                        ? "The request was claimed by the server and may still be processing."
                        : dispatch
                          ? "A dispatch attempt was recorded, but it was not marked as accepted."
                          : "There is no saved Borzo submission result for this order."}
              </p>
            </div>
          </div>

          <section className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-600">Submission summary</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <InfoField label="App order ID" value={order?.orderId || order?._id} />
              <InfoField label="Borzo order ID" value={dispatch?.borzoOrderId} />
              <InfoField label="Dispatch result" value={dispatch?.status || "not recorded"} />
              <InfoField label="Borzo order status" value={dispatch?.borzoOrderStatus} />
              <InfoField label="Environment" value={dispatch?.environment} />
              <InfoField label="HTTP response" value={dispatch?.httpStatus} />
              <InfoField label="Request method" value={dispatch?.requestMethod} />
              <InfoField label="Authentication" value={dispatch?.authentication?.scheme} />
              <InfoField label="Attempted at" value={readableDate(dispatch?.attemptedAt)} />
              <InfoField label="Completed at" value={readableDate(dispatch?.completedAt)} />
              <InfoField label="Server request ID" value={dispatch?.serverRequestId} />
              <InfoField label="Batch route ID" value={dispatch?.batchId} />
            </div>
            {dispatch?.requestUrl && (
              <InfoField label="Borzo endpoint" value={dispatch.requestUrl} />
            )}
            {dispatch?.batchOrderIds?.length > 0 && (
              <InfoField label="Orders in Borzo route" value={dispatch.batchOrderIds.join(", ")} />
            )}
          </section>

          {error && (
            <section className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-widest text-red-700">Error details</h3>
              <div className="rounded-lg border border-red-100 bg-red-50 p-3 text-sm text-red-900">
                {error.message || "Borzo returned an error without a message."}
              </div>
              <JsonDetails title="Full error response" value={error} />
            </section>
          )}

          {Array.isArray(dispatch?.warnings) && dispatch.warnings.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-widest text-amber-800">Warnings</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-amber-900">
                {dispatch.warnings.map((warning: unknown, index: number) => (
                  <li key={`${index}-${String(warning)}`}>{String(warning)}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-600">API exchange</h3>
            <JsonDetails
              title="Request payload (includes delivery contact and address)"
              value={dispatch?.requestPayload}
            />
            <JsonDetails title="Borzo response" value={dispatch?.responseBody} />
            {!dispatch?.requestPayload && !dispatch?.responseBody && (
              <p className="rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
                Detailed request and response bodies are not available for this record. They will be saved for future dispatches.
              </p>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
