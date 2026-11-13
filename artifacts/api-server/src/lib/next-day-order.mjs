export function getTodayISODateIST(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const year = ist.getUTCFullYear();
  const month = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const day = String(ist.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getTomorrowISODateIST(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  ist.setUTCDate(ist.getUTCDate() + 1);
  const year = ist.getUTCFullYear();
  const month = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const day = String(ist.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isAfterFivePMIST(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours() >= 17;
}

export function isFutureNextDayOrder(order, todayISO = getTodayISODateIST()) {
  const deliveryDate = String(order?.deliveryDate ?? "").trim().slice(0, 10);
  return order?.nextDayOrder === true &&
    /^\d{4}-\d{2}-\d{2}$/.test(deliveryDate) &&
    deliveryDate > todayISO;
}
