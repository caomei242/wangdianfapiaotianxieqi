const TEMPLATE_KEY = "invoiceTemplate";
const BILL_BATCH_KEY = "currentBillBatch";

const DEFAULT_TEMPLATE = {
  buyerName: "",
  buyerTaxNo: "",
  itemName: "*现代服务*信息服务费",
  taxRate: "1%",
  remark: ""
};

function ensureChromeStorage(area) {
  if (!globalThis.chrome?.storage?.[area]) {
    throw new Error(`chrome.storage.${area} 不可用`);
  }
}

export function getDefaultTemplate() {
  return { ...DEFAULT_TEMPLATE };
}

export async function getInvoiceTemplate() {
  ensureChromeStorage("local");
  const result = await chrome.storage.local.get(TEMPLATE_KEY);
  return { ...DEFAULT_TEMPLATE, ...(result[TEMPLATE_KEY] || {}) };
}

export async function saveInvoiceTemplate(template) {
  ensureChromeStorage("local");
  const normalized = {
    buyerName: String(template?.buyerName || "").trim(),
    buyerTaxNo: String(template?.buyerTaxNo || "").trim(),
    itemName: String(template?.itemName || "").trim(),
    taxRate: String(template?.taxRate || "").trim(),
    remark: String(template?.remark || "").trim()
  };
  await chrome.storage.local.set({ [TEMPLATE_KEY]: normalized });
  return normalized;
}

export async function getCurrentBillBatch() {
  ensureChromeStorage("session");
  const result = await chrome.storage.session.get(BILL_BATCH_KEY);
  return result[BILL_BATCH_KEY] || null;
}

export async function saveCurrentBillBatch(batch) {
  ensureChromeStorage("session");
  const normalized = {
    ...(batch || {}),
    savedAt: new Date().toISOString()
  };
  await chrome.storage.session.set({ [BILL_BATCH_KEY]: normalized });
  return normalized;
}

export async function clearCurrentBillBatch() {
  ensureChromeStorage("session");
  await chrome.storage.session.remove(BILL_BATCH_KEY);
}
