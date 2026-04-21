import {
  clearCurrentBillBatch,
  getCurrentBillBatch,
  getInvoiceTemplate,
  saveCurrentBillBatch,
  saveInvoiceTemplate
} from "./src/storage.js";

const OCR_ENDPOINT = "http://127.0.0.1:8765/api/ocr/bills";
const TAX_HOST_PATTERN = "https://dppt.xiamen.chinatax.gov.cn:8443/";

const els = {
  bridgeState: document.querySelector("#bridgeState"),
  statusText: document.querySelector("#statusText"),
  recognizedTotal: document.querySelector("#recognizedTotal"),
  messageList: document.querySelector("#messageList"),
  captureButton: document.querySelector("#captureButton"),
  saveTemplateButton: document.querySelector("#saveTemplateButton"),
  fillButton: document.querySelector("#fillButton"),
  clearBatchButton: document.querySelector("#clearBatchButton"),
  templateForm: document.querySelector("#templateForm")
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  await loadTemplate();
  await renderStoredBatch();
}

function bindEvents() {
  els.captureButton.addEventListener("click", handleCaptureAndOcr);
  els.saveTemplateButton.addEventListener("click", handleSaveTemplate);
  els.fillButton.addEventListener("click", handleFillTaxPage);
  els.clearBatchButton.addEventListener("click", handleClearBatch);
  els.templateForm.addEventListener("submit", (event) => event.preventDefault());
}

async function loadTemplate() {
  const template = await getInvoiceTemplate();
  Object.entries(template).forEach(([key, value]) => {
    const input = els.templateForm.elements[key];
    if (input) input.value = value;
  });
}

async function renderStoredBatch() {
  const batch = await getCurrentBillBatch();
  if (!batch) {
    setStatus("准备就绪", "neutral", "待识别");
    setTotal(null);
    renderMessages([]);
    return;
  }

  setStatus(`已载入临时批次 ${formatTime(batch.savedAt)}`, "success", "已识别");
  setTotal(extractRecognizedTotal(batch));
  renderMessages([
    ...normalizeMessages(batch.warnings, "warn"),
    ...normalizeMessages(batch.errors, "err")
  ]);
}

async function handleCaptureAndOcr() {
  await withBusy(els.captureButton, "识别中", async () => {
    try {
      setStatus("正在截取当前标签页", "neutral", "截图中");
      renderMessages([]);

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png"
      });

      setStatus("正在发送到本地 OCR bridge", "neutral", "识别中");
      const response = await fetch(OCR_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageDataUrl: screenshotDataUrl,
          sourceUrl: tab?.url || "",
          capturedAt: new Date().toISOString()
        })
      });

      const payload = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(payload?.message || payload?.error || `OCR bridge 返回 ${response.status}`);
      }

      const batch = await saveCurrentBillBatch(normalizeBillBatch(payload, tab));
      setStatus("账单识别完成，批次已临时保存", "success", "已识别");
      setTotal(extractRecognizedTotal(batch));
      renderMessages([
        ...normalizeMessages(batch.warnings, "warn"),
        ...normalizeMessages(batch.errors, "err")
      ]);
    } catch (error) {
      setStatus(error.message || "识别失败", "error", "失败");
      setTotal(null);
      renderMessages([{ type: "err", text: error.message || String(error) }]);
    }
  });
}

async function handleSaveTemplate() {
  await withBusy(els.saveTemplateButton, "保存中", async () => {
    const template = await saveInvoiceTemplate(readTemplateForm());
    Object.entries(template).forEach(([key, value]) => {
      const input = els.templateForm.elements[key];
      if (input) input.value = value;
    });
    setStatus("开票模板已保存到本机长期存储", "success", "已保存");
  });
}

async function handleFillTaxPage() {
  await withBusy(els.fillButton, "填充中", async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("没有找到当前标签页");
      if (!String(tab.url || "").startsWith(TAX_HOST_PATTERN)) {
        throw new Error("请先切换到厦门电子税务局开票页面");
      }

      const [template, currentBillBatch] = await Promise.all([
        saveInvoiceTemplate(readTemplateForm()),
        getCurrentBillBatch()
      ]);
      if (!currentBillBatch) throw new Error("还没有临时账单批次，请先识别账单");

      const fillPayload = { template, batch: currentBillBatch };
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/taxFiller.js"]
      });

      const [fillResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (detail) => {
          if (typeof window.wangdianFapiaoFill !== "function") {
            return { ok: false, message: "填充脚本未成功注入", filled: [], warnings: [] };
          }
          return window.wangdianFapiaoFill(detail);
        },
        args: [fillPayload]
      });

      const result = fillResult?.result;
      if (result && result.ok === false) {
        throw new Error(result.message || "填充脚本未能完成");
      }

      setStatus(result?.message || "已发送填充任务，请在页面内人工核对", "success", "已填充");
      renderMessages(normalizeMessages(result?.warnings, "warn"));
    } catch (error) {
      setStatus(error.message || "填充失败", "error", "失败");
      renderMessages([{ type: "err", text: error.message || String(error) }]);
    }
  });
}

async function handleClearBatch() {
  await clearCurrentBillBatch();
  setStatus("临时账单批次已清除", "neutral", "待识别");
  setTotal(null);
  renderMessages([]);
}

function readTemplateForm() {
  const formData = new FormData(els.templateForm);
  return {
    buyerName: formData.get("buyerName"),
    buyerTaxNo: formData.get("buyerTaxNo"),
    itemName: formData.get("itemName"),
    taxRate: formData.get("taxRate"),
    remark: formData.get("remark")
  };
}

function normalizeBillBatch(payload, tab) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  return {
    ...data,
    sourceUrl: data?.sourceUrl || tab?.url || "",
    capturedAt: data?.capturedAt || new Date().toISOString(),
    recognizedTotal: extractRecognizedTotal(data),
    warnings: asArray(data?.warnings || payload?.warnings),
    errors: asArray(data?.errors || payload?.errors)
  };
}

function extractRecognizedTotal(batch) {
  if (!batch) return null;
  return firstPresent([
    batch.recognizedTotal,
    batch.total,
    batch.totalAmount,
    batch.amountTotal,
    batch.summary?.total,
    batch.summary?.amount,
    batch.data?.recognizedTotal,
    batch.data?.total
  ]);
}

function firstPresent(values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeMessages(messages, type) {
  return asArray(messages).map((message) => ({
    type,
    text: typeof message === "string" ? message : JSON.stringify(message)
  }));
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function setStatus(text, tone, pillText) {
  els.statusText.textContent = text;
  els.bridgeState.textContent = pillText;
  els.bridgeState.className = `pill ${tone}`;
}

function setTotal(total) {
  if (total === null || total === undefined || total === "") {
    els.recognizedTotal.textContent = "--";
    return;
  }
  const number = Number(total);
  els.recognizedTotal.textContent = Number.isFinite(number)
    ? number.toLocaleString("zh-CN", { style: "currency", currency: "CNY" })
    : String(total);
}

function renderMessages(messages) {
  els.messageList.hidden = messages.length === 0;
  els.messageList.replaceChildren(
    ...messages.map((message) => {
      const item = document.createElement("div");
      item.className = `message ${message.type || ""}`.trim();
      item.textContent = message.text;
      return item;
    })
  );
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

async function withBusy(button, busyText, task) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}
