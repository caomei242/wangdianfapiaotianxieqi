(async function taxFillerInjected(args) {
  const TARGET_ORIGIN = "https://dppt.xiamen.chinatax.gov.cn:8443";
  const TARGET_PATH = "/blue-invoice-makeout/invoice-makeout";
  const SAFE_ITEM_NAME = "*现代服务*信息服务费";
  const DEFAULT_QUANTITY = "1";
  const DEFAULT_TAX_RATE = "1%";

  function normalizeInput(rawArgs) {
    const payload = Array.isArray(rawArgs) ? rawArgs[0] : rawArgs;
    return {
      template: payload && typeof payload.template === "object" ? payload.template : {},
      batch:
        payload && typeof payload.batch === "object"
          ? payload.batch
          : payload && typeof payload.currentBillBatch === "object"
            ? payload.currentBillBatch
            : {},
    };
  }

  function isTargetPage() {
    return window.location.origin === TARGET_ORIGIN && window.location.pathname.startsWith(TARGET_PATH);
  }

  function visibleText(value) {
    return String(value || "")
      .replace(/\s+/g, "")
      .replace(/[：:]/g, "")
      .trim();
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function fieldSelector() {
    return [
      "input:not([type=hidden]):not([disabled]):not([readonly])",
      "textarea:not([disabled]):not([readonly])",
      "[contenteditable=true]",
      ".el-input__inner:not([disabled]):not([readonly])",
      ".ant-input:not([disabled]):not([readonly])",
    ].join(",");
  }

  function getFields(root) {
    return Array.from((root || document).querySelectorAll(fieldSelector())).filter(isVisible);
  }

  function describeField(field) {
    const attrs = ["aria-label", "placeholder", "name", "id", "title", "data-field", "data-name"];
    return attrs
      .map((attr) => field.getAttribute && field.getAttribute(attr))
      .filter(Boolean)
      .join(" ");
  }

  function fieldValue(field) {
    if (field.isContentEditable) return field.textContent || "";
    return "value" in field ? field.value : field.textContent || "";
  }

  function setNativeValue(field, value) {
    const text = String(value == null ? "" : value);
    field.focus({ preventScroll: true });

    if (field.isContentEditable) {
      field.textContent = text;
    } else if ("value" in field) {
      const prototype = Object.getPrototypeOf(field);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor && typeof descriptor.set === "function") {
        descriptor.set.call(field, text);
      } else {
        field.value = text;
      }
    } else {
      field.textContent = text;
    }

    ["input", "change", "blur"].forEach((type) => {
      field.dispatchEvent(new Event(type, { bubbles: true }));
    });
  }

  function clickLikeHuman(element) {
    if (!element || !isVisible(element)) return false;
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.click();
    return true;
  }

  function textOf(element) {
    return visibleText(
      [
        element && element.textContent,
        element && element.getAttribute && element.getAttribute("aria-label"),
        element && element.getAttribute && element.getAttribute("title"),
        element && element.getAttribute && element.getAttribute("placeholder"),
      ]
        .filter(Boolean)
        .join(" ")
    );
  }

  function isReasonableLabelElement(element) {
    const text = textOf(element);
    if (!text || text.length > 40) return false;
    if (getFields(element).length > 2) return false;
    return true;
  }

  function elementLabelScore(element, labels) {
    const haystack = visibleText([textOf(element), describeField(element)].join(" "));
    let score = 0;
    labels.forEach((label) => {
      const normalized = visibleText(label);
      if (!normalized) return;
      if (haystack === normalized) score += 80;
      if (haystack.includes(normalized)) score += 50;
      if (normalized.includes(haystack) && haystack.length >= 2) score += 15;
    });
    return score;
  }

  function nearestFieldToLabel(labelElement) {
    const candidates = [];
    const labelRect = labelElement.getBoundingClientRect();
    const roots = [
      labelElement.parentElement,
      labelElement.closest(".el-form-item, .ant-form-item, tr, .row, .form-item, .formItem, li, section, div"),
      document,
    ].filter(Boolean);

    roots.forEach((root, rootIndex) => {
      getFields(root).forEach((field) => {
        const rect = field.getBoundingClientRect();
        const sameRowPenalty = Math.abs(rect.top - labelRect.top) < Math.max(rect.height, labelRect.height) * 1.4 ? 0 : 60;
        const distance = Math.abs(rect.left - labelRect.right) + Math.abs(rect.top - labelRect.top) + sameRowPenalty;
        candidates.push({ field, score: distance + rootIndex * 25 });
      });
    });

    candidates.sort((a, b) => a.score - b.score);
    return candidates.length ? candidates[0].field : null;
  }

  function findField(labels, options) {
    const opts = options || {};
    const allFields = getFields(document);
    const directMatches = allFields
      .map((field, index) => ({
        field,
        score: elementLabelScore(field, labels) + (opts.preferEmpty && fieldValue(field) ? -10 : 0) - index * 0.01,
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    if (directMatches.length) return directMatches[0].field;

    const labelCandidates = Array.from(document.querySelectorAll("label, span, div, td, th, p"))
      .filter(isVisible)
      .filter(isReasonableLabelElement)
      .map((element) => ({ element, score: elementLabelScore(element, labels) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    for (const item of labelCandidates) {
      const field = nearestFieldToLabel(item.element);
      if (field) return field;
    }

    return null;
  }

  function findClickable(labels) {
    const selectors = [
      "button",
      "[role=button]",
      ".el-select",
      ".el-select__wrapper",
      ".ant-select",
      ".ant-select-selector",
      ".el-input",
      ".ant-input-affix-wrapper",
      "input",
    ].join(",");

    const candidates = Array.from(document.querySelectorAll(selectors))
      .filter(isVisible)
      .map((element) => ({ element, score: elementLabelScore(element, labels) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    return candidates.length ? candidates[0].element : null;
  }

  async function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function selectOption(labels, value, fieldName, filled, warnings) {
    if (!value) return false;
    const field = findField(labels);
    if (field) {
      setNativeValue(field, value);
      filled.push(fieldName);
      return true;
    }

    const opener = findClickable(labels);
    if (!opener || !clickLikeHuman(opener)) return false;
    await wait(150);

    const normalizedValue = visibleText(value);
    const option = Array.from(document.querySelectorAll("[role=option], .el-select-dropdown__item, .ant-select-item-option, li, span"))
      .filter(isVisible)
      .find((item) => textOf(item).includes(normalizedValue));
    if (option) {
      clickLikeHuman(option);
      filled.push(fieldName);
      return true;
    }
    warnings.push(`未找到可选项：${fieldName}=${value}`);
    return false;
  }

  function fillByLabels(fieldName, labels, value, required, filled, warnings) {
    if (value == null || value === "") {
      if (required) warnings.push(`缺少必填数据：${fieldName}`);
      return false;
    }

    const field = findField(labels, { preferEmpty: true });
    if (!field) {
      warnings.push(`未找到字段：${fieldName}`);
      return false;
    }

    setNativeValue(field, value);
    filled.push(fieldName);
    return true;
  }

  function normalizeAmount(value) {
    if (value == null) return "";
    const raw = String(value).replace(/,/g, "").replace(/[^\d.-]/g, "");
    if (!raw) return "";
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) return "";
    return amount.toFixed(2);
  }

  function resolveAmount(batch) {
    return normalizeAmount(
      batch.totalAmount ||
        batch.recognizedTotal ||
        batch.total ||
        batch.amount ||
        batch.summary?.total ||
        batch.summary?.amount ||
        batch.ocrTotalAmount ||
        batch.ocrResultTotalAmount ||
        batch.resultTotalAmount
    );
  }

  function normalizeTaxRate(value) {
    const raw = String(value || "").trim();
    if (!raw) return DEFAULT_TAX_RATE;
    if (raw.endsWith("%")) return raw;
    const number = Number(raw);
    if (!Number.isFinite(number)) return raw;
    return number <= 1 ? `${roundRate(number * 100)}%` : `${roundRate(number)}%`;
  }

  function roundRate(value) {
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  }

  function getTemplateValue(template, keys) {
    for (const key of keys) {
      if (template[key] != null && template[key] !== "") return String(template[key]).trim();
    }
    return "";
  }

  function warnIfDangerButtonsPresent(warnings) {
    const dangerWords = ["开票", "提交", "上传", "确认开具", "立即开具", "发票开具", "提交开具"];
    const safeWords = ["保存", "草稿", "预览", "取消", "返回"];
    const buttons = Array.from(document.querySelectorAll("button, [role=button], input[type=button], input[type=submit]")).filter(isVisible);
    const found = buttons
      .map((button) => textOf(button))
      .filter((text) => text && dangerWords.some((word) => text.includes(visibleText(word))) && !safeWords.some((word) => text.includes(visibleText(word))));
    if (found.length) {
      warnings.push(`已避开最终确认按钮：${Array.from(new Set(found)).join("、")}`);
    }
  }

  function inferUntaxedAmount(totalAmount) {
    const total = Number(totalAmount);
    if (!Number.isFinite(total)) return "";
    return (Math.round((total / 1.01) * 100) / 100).toFixed(2);
  }

  async function runFill(rawArgs) {
    const filled = [];
    const warnings = [];

    function finish(ok, message) {
      return { ok, message, filled, warnings };
    }

    try {
      if (!isTargetPage()) {
        return finish(false, `当前页面不是目标开票页：${window.location.href}`);
      }

      const { template, batch } = normalizeInput(rawArgs);
      const totalAmount = resolveAmount(batch);
      if (!totalAmount) {
        return finish(false, "未收到有效 OCR 合计金额");
      }

      const buyerName = getTemplateValue(template, ["buyerName", "name", "companyName", "purchaserName", "购买方名称", "客户名称"]);
      const buyerTaxNo = getTemplateValue(template, ["buyerTaxNo", "taxNo", "taxNumber", "creditCode", "purchaserTaxNo", "统一社会信用代码", "纳税人识别号"]);
      const buyerAddressPhone = getTemplateValue(template, ["buyerAddressPhone", "addressPhone", "addressTel", "addrTel", "地址电话"]);
      const buyerBankAccount = getTemplateValue(template, ["buyerBankAccount", "bankAccount", "bank", "开户行及账号", "银行账号"]);
      const buyerEmail = getTemplateValue(template, ["buyerEmail", "email", "邮箱"]);
      const buyerPhone = getTemplateValue(template, ["buyerPhone", "phone", "mobile", "手机号", "电话"]);
      const itemName = getTemplateValue(template, ["itemName", "projectName", "serviceName", "项目名称"]) || SAFE_ITEM_NAME;
      const quantity = getTemplateValue(template, ["quantity", "数量"]) || DEFAULT_QUANTITY;
      const taxRate = normalizeTaxRate(getTemplateValue(template, ["taxRate", "rate", "税率"]) || DEFAULT_TAX_RATE);

      fillByLabels("购买方名称", ["购买方名称", "购方名称", "客户名称", "名称"], buyerName, true, filled, warnings);
      fillByLabels("购买方纳税人识别号", ["购买方纳税人识别号", "购方税号", "纳税人识别号", "统一社会信用代码", "税号"], buyerTaxNo, true, filled, warnings);
      fillByLabels("购买方地址电话", ["购买方地址电话", "地址电话", "地址、电话", "购方地址电话"], buyerAddressPhone, false, filled, warnings);
      fillByLabels("购买方开户行及账号", ["购买方开户行及账号", "开户行及账号", "开户银行", "银行账号"], buyerBankAccount, false, filled, warnings);
      fillByLabels("购买方邮箱", ["购买方邮箱", "邮箱", "电子邮箱"], buyerEmail, false, filled, warnings);
      fillByLabels("购买方电话", ["购买方电话", "手机号码", "手机号", "电话"], buyerPhone, false, filled, warnings);

      await selectOption(["项目名称", "货物或应税劳务、服务名称", "商品名称", "服务名称"], itemName, "项目名称", filled, warnings);
      fillByLabels("规格型号", ["规格型号", "规格"], getTemplateValue(template, ["spec", "model", "规格型号"]) || "", false, filled, warnings);
      fillByLabels("单位", ["单位"], getTemplateValue(template, ["unit", "单位"]) || "次", false, filled, warnings);
      fillByLabels("数量", ["数量"], quantity, true, filled, warnings);
      fillByLabels("单价", ["单价", "不含税单价"], inferUntaxedAmount(totalAmount), false, filled, warnings);
      fillByLabels("金额", ["金额", "不含税金额", "销售额"], inferUntaxedAmount(totalAmount), true, filled, warnings);
      await selectOption(["税率", "征收率"], taxRate, "税率", filled, warnings);
      fillByLabels("价税合计", ["价税合计", "含税金额", "合计金额", "总金额"], totalAmount, false, filled, warnings);

      warnIfDangerButtonsPresent(warnings);

      if (!filled.length) {
        return finish(false, "没有成功填入任何字段，请确认页面表单已加载完成");
      }

      return finish(true, `已填充 ${filled.length} 个字段，请人工核对后再决定是否开票`);
    } catch (error) {
      warnings.push(error && error.stack ? error.stack : String(error));
      return finish(false, "填充过程发生异常");
    }
  }

  if (typeof window !== "undefined") {
    window.wangdianFapiaoFill = async function wangdianFapiaoFill(detail) {
      const result = await runFill(detail);
      window.wangdianFapiaoLastFillResult = result;
      return result;
    };
    window.addEventListener("wangdianfapiao:fill", async (event) => {
      await window.wangdianFapiaoFill(event.detail);
    });
  }

  if (args) return runFill(args);
  return { ok: true, message: "填充器已注入", filled: [], warnings: [] };
})(typeof arguments !== "undefined" ? arguments[0] : undefined);
