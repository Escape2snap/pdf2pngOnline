import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";
import { zipSync } from "../vendor/fflate/fflate.mjs";

const PDFJS_BASE = new URL("../vendor/pdfjs/", import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", PDFJS_BASE).href;

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_PAGES = 300;
const MAX_PAGES_PER_JOB = 100;
const MAX_PAGE_PIXELS = 60_000_000;
const MAX_TOTAL_PIXELS = 300_000_000;
const PREVIEW_DPI = 110;
const PREVIEW_MAX_EDGE = 1500;
const DEFAULT_DPI = 300;

const $ = (id) => document.getElementById(id);
const els = {
  theme: $("theme-switch"),
  dropzone: $("dropzone"),
  dropEmpty: $("drop-empty"),
  fileInput: $("file-input"),
  fileCard: $("file-card"),
  fileName: $("file-name"),
  fileMeta: $("file-meta"),
  fileHint: $("file-hint"),
  fileRemove: $("file-remove"),
  dpi: $("dpi"),
  dpiPresets: $("dpi-presets"),
  allPages: $("all-pages"),
  pageFrom: $("page-from"),
  pageTo: $("page-to"),
  summaryPages: $("summary-pages"),
  summarySize: $("summary-size"),
  summaryMem: $("summary-mem"),
  summaryBox: $("summary-box"),
  stage: $("stage"),
  previewEmpty: $("preview-empty"),
  previewLoading: $("preview-loading"),
  previewMeta: $("preview-meta"),
  convert: $("convert"),
  downloadZip: $("download-zip"),
  cancel: $("cancel"),
  reset: $("reset"),
  progressWrap: $("progress-wrap"),
  progress: $("progress"),
  progressText: $("progress-text"),
  progressPct: $("progress-pct"),
  status: $("status"),
  resultsPanel: $("results-panel"),
  results: $("results"),
  resultsMeta: $("results-meta"),
  passwordDialog: $("password-dialog"),
  passwordForm: $("password-form"),
  passwordHint: $("password-hint"),
  passwordInput: $("password-input"),
  passwordError: $("password-error"),
  passwordCancel: $("password-cancel"),
};

const state = {
  file: null,
  pdf: null,
  loadingTask: null,
  pageCount: 0,
  baseName: "document",
  results: [],
  busy: false,
  cancelled: false,
  passwordCancelled: false,
  loadToken: 0,
  summaryToken: 0,
  previewToken: 0,
  dpi: DEFAULT_DPI,
  firstPageSize: null,
  rangeTooLarge: false,
};

const numberFormat = new Intl.NumberFormat("zh-CN");

/* ================= 基础工具 ================= */

function tick() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

function formatInt(value) {
  return numberFormat.format(value);
}

function sanitizeBaseName(name) {
  return String(name || "")
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "document";
}

function readDpi() {
  const raw = Number(els.dpi.value);
  if (!Number.isFinite(raw)) return DEFAULT_DPI;
  return clamp(Math.round(raw), 36, 600);
}

function readRange() {
  if (!state.pdf) return null;
  if (els.allPages.checked) {
    return { from: 1, to: state.pageCount, count: state.pageCount };
  }
  let from = Number.parseInt(els.pageFrom.value, 10) || 1;
  let to = Number.parseInt(els.pageTo.value, 10) || state.pageCount;
  from = clamp(from, 1, state.pageCount);
  to = clamp(to, 1, state.pageCount);
  if (from > to) [from, to] = [to, from];
  return { from, to, count: to - from + 1 };
}

function setStatus(message, kind = "") {
  els.status.textContent = message || "";
  els.status.className = "status" + (kind ? ` is-${kind}` : "");
}

function setProgress(value, total, label) {
  els.progressWrap.hidden = false;
  els.progress.max = Math.max(1, total);
  els.progress.value = clamp(value, 0, total);
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  els.progressPct.textContent = `${pct}%`;
  els.progressText.textContent = label;
}

function hideProgress() {
  els.progressWrap.hidden = true;
  els.progress.value = 0;
  els.progressPct.textContent = "0%";
}

function updateConvertState() {
  els.convert.disabled = !state.pdf || state.busy || state.rangeTooLarge;
  els.fileRemove.disabled = state.busy;
  els.reset.hidden = !state.file;
  els.dropzone.setAttribute("aria-busy", state.busy ? "true" : "false");
}

function setBusy(busy, showCancel = false) {
  state.busy = busy;
  els.fileInput.disabled = busy;
  els.dpi.disabled = busy;
  els.allPages.disabled = busy;
  els.pageFrom.disabled = busy || els.allPages.checked;
  els.pageTo.disabled = busy || els.allPages.checked;
  els.cancel.hidden = !(busy && showCancel);
  if (busy && showCancel) els.cancel.disabled = false;
  updateConvertState();
}

function showFile(file) {
  els.fileName.textContent = file.name;
  els.fileMeta.textContent = "正在读取…";
  els.fileHint.textContent = "读取中";
  els.dropEmpty.hidden = true;
  els.fileCard.hidden = false;
  els.dropzone.classList.add("has-file");
  updateConvertState();
}

function clearFileView() {
  els.fileCard.hidden = true;
  els.dropEmpty.hidden = false;
  els.dropzone.classList.remove("has-file", "is-dragover");
  els.fileName.textContent = "document.pdf";
  els.fileMeta.textContent = "—";
  els.fileHint.textContent = "未选择";
  updateConvertState();
}

function clearResults() {
  for (const result of state.results) {
    URL.revokeObjectURL(result.url);
  }
  state.results = [];
  els.results.replaceChildren();
  els.resultsPanel.hidden = true;
  els.resultsMeta.textContent = "";
  els.downloadZip.hidden = true;
  els.downloadZip.textContent = "下载全部 ZIP";
  els.convert.textContent = "开始转换";
}

function showEmptyPreview() {
  state.previewToken++;
  els.stage.querySelectorAll("canvas").forEach((canvas) => canvas.remove());
  els.previewEmpty.hidden = false;
  els.previewLoading.hidden = true;
  els.previewMeta.textContent = "等待 PDF";
  els.stage.classList.remove("has-preview");
}

function resetSummary() {
  state.firstPageSize = null;
  els.summaryPages.textContent = "—";
  els.summarySize.textContent = "—";
  els.summaryMem.textContent = "—";
  els.summaryMem.classList.remove("is-warn");
  els.summaryBox.hidden = true;
}

function updateDpiUi() {
  const dpi = readDpi();
  state.dpi = dpi;
  els.dpiPresets.querySelectorAll("[data-dpi]").forEach((button) => {
    button.classList.toggle("is-active", Number(button.dataset.dpi) === dpi);
  });
}

/* ================= 主题 ================= */

function syncThemeButton() {
  const dark = document.documentElement.classList.contains("dark");
  els.theme.setAttribute("aria-label", dark ? "切换到浅色" : "切换到深色");
}

els.theme.addEventListener("click", () => {
  const dark = document.documentElement.classList.toggle("dark");
  try {
    localStorage.setItem("pdf-theme", dark ? "dark" : "light");
  } catch (e) {}
  syncThemeButton();
});
syncThemeButton();

/* ================= PDF 文档 ================= */

async function closeDocument() {
  state.summaryToken++;
  state.previewToken++;
  const pdf = state.pdf;
  const task = state.loadingTask;
  state.pdf = null;
  state.loadingTask = null;
  state.pageCount = 0;
  if (pdf) {
    try { await pdf.destroy(); } catch (e) {}
  } else if (task) {
    try { await task.destroy(); } catch (e) {}
  }
}

async function requestPassword(reason) {
  const dialog = els.passwordDialog;
  const incorrect = reason === (pdfjsLib.PasswordResponses?.INCORRECT_PASSWORD ?? 2);
  els.passwordHint.textContent = incorrect
    ? "密码不正确，再试一次。密码不会被保存或上传。"
    : "输入打开密码后继续。密码不会被保存或上传。";
  els.passwordError.hidden = true;
  els.passwordInput.value = "";

  if (typeof dialog.showModal !== "function") {
    const value = window.prompt("这个 PDF 有密码，请输入打开密码：");
    if (value === null) throw new Error("PASSWORD_CANCELLED");
    return value;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      els.passwordForm.removeEventListener("submit", onSubmit);
      els.passwordCancel.removeEventListener("click", onCancelClick);
      dialog.removeEventListener("cancel", onCancelEvent);
      if (dialog.open) dialog.close();
      fn(value);
    };
    const onSubmit = (event) => {
      event.preventDefault();
      const password = els.passwordInput.value;
      if (!password) {
        els.passwordError.textContent = "请输入密码。";
        els.passwordError.hidden = false;
        els.passwordInput.focus();
        return;
      }
      finish(resolve, password);
    };
    const onCancelClick = () => finish(reject, new Error("PASSWORD_CANCELLED"));
    const onCancelEvent = (event) => {
      event.preventDefault();
      finish(reject, new Error("PASSWORD_CANCELLED"));
    };
    els.passwordForm.addEventListener("submit", onSubmit);
    els.passwordCancel.addEventListener("click", onCancelClick);
    dialog.addEventListener("cancel", onCancelEvent);
    dialog.showModal();
    requestAnimationFrame(() => els.passwordInput.focus());
  });
}

async function handleFile(file) {
  if (!file || state.busy) return;
  if (file.size > MAX_FILE_BYTES) {
    setStatus(`文件超过 100 MB（当前 ${formatBytes(file.size)}），请先压缩或拆分。`, "error");
    return;
  }
  if (file.type && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    setStatus("请选择 PDF 文件。", "error");
    return;
  }

  const arrayBuffer = await file.arrayBuffer();
  const header = new TextDecoder("latin1").decode(
    new Uint8Array(arrayBuffer, 0, Math.min(1024, arrayBuffer.byteLength))
  );
  if (!header.includes("%PDF-")) {
    setStatus("这个文件不是有效的 PDF（缺少 PDF 文件头）。", "error");
    return;
  }

  const token = ++state.loadToken;
  await closeDocument();
  clearResults();
  resetSummary();
  state.file = file;
  state.baseName = sanitizeBaseName(file.name);
  state.rangeTooLarge = false;
  state.passwordCancelled = false;
  showFile(file);
  showEmptyPreview();
  els.previewEmpty.hidden = true;
  els.previewLoading.hidden = false;
  els.previewMeta.textContent = "解析中";
  setBusy(true);
  setStatus("正在解析 PDF…");

  const data = new Uint8Array(arrayBuffer);
  const loadingTask = pdfjsLib.getDocument({
    data,
    cMapUrl: new URL("cmaps/", PDFJS_BASE).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("standard_fonts/", PDFJS_BASE).href,
    wasmUrl: new URL("wasm/", PDFJS_BASE).href,
    iccUrl: new URL("iccs/", PDFJS_BASE).href,
    isEvalSupported: false,
  });
  state.loadingTask = loadingTask;
  loadingTask.onPassword = (updatePassword, reason) => {
    requestPassword(reason)
      .then((password) => updatePassword(password))
      .catch(() => {
        state.passwordCancelled = true;
        loadingTask.destroy().catch(() => {});
      });
  };

  try {
    const pdf = await loadingTask.promise;
    if (token !== state.loadToken) {
      await pdf.destroy();
      return;
    }
    state.pdf = pdf;
    state.pageCount = pdf.numPages;
    state.loadingTask = null;

    if (pdf.numPages > MAX_PAGES) {
      setStatus(`这个 PDF 有 ${pdf.numPages} 页，超过 ${MAX_PAGES} 页限制。请拆分后再试。`, "error");
      await closeDocument();
      els.previewLoading.hidden = true;
      els.previewEmpty.hidden = false;
      els.fileHint.textContent = "页数过多";
      updateConvertState();
      return;
    }

    els.pageFrom.max = String(pdf.numPages);
    els.pageTo.max = String(pdf.numPages);
    els.pageFrom.value = "1";
    els.pageTo.value = String(pdf.numPages);
    els.allPages.checked = true;
    els.pageFrom.disabled = true;
    els.pageTo.disabled = true;
    els.fileMeta.textContent = `${pdf.numPages} 页 · ${formatBytes(file.size)}`;
    els.fileHint.textContent = `${pdf.numPages} 页`;

    await renderPreview(1);
    await updateSummary();
    setStatus(`已载入 ${pdf.numPages} 页`, "success");
    els.convert.textContent = "开始转换";
  } catch (error) {
    if (state.passwordCancelled) {
      setStatus("已取消输入密码。", "");
    } else if (error?.name === "PasswordException") {
      setStatus("需要密码才能打开这个 PDF。", "error");
    } else if (error?.name === "InvalidPDFException") {
      setStatus("PDF 文件损坏或格式无法识别。", "error");
    } else {
      setStatus(`无法解析这个 PDF：${error?.message || error}`, "error");
    }
    await closeDocument();
    els.previewLoading.hidden = true;
    els.previewEmpty.hidden = false;
    els.fileHint.textContent = "读取失败";
    els.previewMeta.textContent = "等待 PDF";
    resetSummary();
  } finally {
    if (token === state.loadToken) {
      els.previewLoading.hidden = true;
      setBusy(false);
      updateConvertState();
    }
  }
}

/* ================= 预览与摘要 ================= */

async function renderPreview(pageNumber) {
  if (!state.pdf) return;
  const token = ++state.previewToken;
  try {
    const page = await state.pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(PREVIEW_DPI / 72, PREVIEW_MAX_EDGE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    await page.render({ canvas, canvasContext: context, viewport, background: "#ffffff" }).promise;
    page.cleanup();
    if (token !== state.previewToken) return;
    els.stage.querySelectorAll("canvas").forEach((old) => old.remove());
    els.previewEmpty.hidden = true;
    els.previewLoading.hidden = true;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `第 ${pageNumber} 页预览`);
    els.stage.append(canvas);
    els.stage.classList.add("has-preview");
    els.previewMeta.textContent = `第 ${pageNumber} 页 · 预览`;
  } catch (error) {
    if (token !== state.previewToken) return;
    els.previewMeta.textContent = "预览失败";
    setStatus(`预览失败：${error?.message || error}`, "error");
  }
}

async function updateSummary() {
  if (!state.pdf) {
    resetSummary();
    return;
  }
  const range = readRange();
  if (!range) {
    resetSummary();
    return;
  }
  if (range.count > MAX_PAGES_PER_JOB) {
    state.rangeTooLarge = true;
    els.summaryPages.textContent = `${range.count} 页`;
    els.summaryPages.classList.add("is-warn");
    setStatus(`单次最多导出 ${MAX_PAGES_PER_JOB} 页，请缩小页面范围。`, "error");
    updateConvertState();
    return;
  }
  state.rangeTooLarge = false;
  els.summaryPages.classList.remove("is-warn");
  els.summaryPages.textContent = `${range.count} 页`;
  const dpi = readDpi();
  state.dpi = dpi;
  const token = ++state.summaryToken;
  try {
    const page = await state.pdf.getPage(range.from);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    page.cleanup();
    if (token !== state.summaryToken) return;
    const pixels = width * height;
    state.firstPageSize = { width, height, pixels };
    els.summaryBox.hidden = false;
    els.summarySize.textContent = `${formatInt(width)} × ${formatInt(height)} px`;
    els.summaryMem.textContent = `${formatBytes(pixels * 4)} / 页`;
    els.summaryMem.classList.toggle("is-warn", pixels > 40_000_000);
    if (!state.busy) els.convert.disabled = false;
  } catch (error) {
    if (token !== state.summaryToken) return;
    els.summarySize.textContent = "—";
    els.summaryMem.textContent = "—";
    setStatus(`无法读取页面尺寸：${error?.message || error}`, "error");
  }
}

/* ================= 转换 ================= */

function showError(error) {
  setStatus(error?.message || String(error), "error");
}

async function buildPlan(range, dpi) {
  if (range.count > MAX_PAGES_PER_JOB) {
    throw new Error(`单次最多导出 ${MAX_PAGES_PER_JOB} 页，当前选择了 ${range.count} 页。`);
  }
  const plan = [];
  let totalPixels = 0;
  for (let pageNumber = range.from; pageNumber <= range.to; pageNumber++) {
    const page = await state.pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    page.cleanup();
    const pixels = width * height;
    if (pixels > MAX_PAGE_PIXELS) {
      throw new Error(
        `第 ${pageNumber} 页在 ${dpi} DPI 下是 ${formatInt(width)} × ${formatInt(height)} px（${(pixels / 1_000_000).toFixed(1)} MP），超过单页 60 MP 限制。请降低 DPI 或缩小页面范围。`
      );
    }
    totalPixels += pixels;
    if (totalPixels > MAX_TOTAL_PIXELS) {
      throw new Error(
        `所选页面总计超过 300 MP（当前约 ${(totalPixels / 1_000_000).toFixed(0)} MP），请降低 DPI 或减少页数。`
      );
    }
    plan.push({ pageNumber, width, height, pixels });
    if (plan.length % 10 === 0) await tick();
  }
  return plan;
}

function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG 编码失败，可能是画布尺寸超过浏览器限制。"));
    }, "image/png");
  });
}

function addResultCard(result) {
  const card = document.createElement("article");
  card.className = "page-card";

  const thumb = document.createElement("div");
  thumb.className = "page-thumb";
  const image = document.createElement("img");
  image.src = result.url;
  image.alt = `第 ${result.pageNumber} 页预览`;
  image.loading = "lazy";
  image.decoding = "async";
  thumb.append(image);

  const info = document.createElement("div");
  info.className = "page-info";
  const title = document.createElement("div");
  title.className = "page-title";
  const label = document.createElement("span");
  label.textContent = `第 ${result.pageNumber} 页`;
  const badge = document.createElement("span");
  badge.className = "page-badge";
  badge.textContent = "PNG";
  title.append(label, badge);

  const meta = document.createElement("div");
  meta.className = "page-meta";
  meta.textContent = `${formatInt(result.width)} × ${formatInt(result.height)} · ${formatBytes(result.blob.size)}`;

  const actions = document.createElement("div");
  actions.className = "page-actions";
  const dimensions = document.createElement("span");
  dimensions.className = "page-meta";
  dimensions.textContent = `${result.dpi} DPI`;
  const link = document.createElement("a");
  link.className = "dl-link";
  link.href = result.url;
  link.download = result.filename;
  link.textContent = "下载";
  actions.append(dimensions, link);

  info.append(title, meta, actions);
  card.append(thumb, info);
  els.results.append(card);
}

async function convert() {
  if (!state.pdf || state.busy) return;
  const dpi = readDpi();
  els.dpi.value = String(dpi);
  updateDpiUi();
  const range = readRange();
  if (!range || range.count < 1) {
    setStatus("请选择有效的页面范围。", "error");
    return;
  }

  clearResults();
  state.cancelled = false;
  setBusy(true, true);
  els.convert.textContent = "转换中…";
  els.resultsPanel.hidden = false;
  els.resultsMeta.textContent = `${range.count} 页 · ${dpi} DPI`;
  setStatus("正在检查页面尺寸…");
  setProgress(0, range.count, "正在准备…");

  let plan;
  try {
    plan = await buildPlan(range, dpi);
  } catch (error) {
    hideProgress();
    showError(error);
    setBusy(false);
    updateConvertState();
    els.resultsPanel.hidden = true;
    return;
  }

  const filenameBase = `${state.baseName}-${dpi}dpi`;
  let completed = 0;
  let failedPage = null;
  try {
    for (let index = 0; index < plan.length; index++) {
      if (state.cancelled) break;
      const item = plan[index];
      setProgress(index, plan.length, `正在渲染第 ${item.pageNumber} 页 / 共 ${plan.length} 页`);
      const page = await state.pdf.getPage(item.pageNumber);
      try {
        const viewport = page.getViewport({ scale: dpi / 72 });
        const canvas = document.createElement("canvas");
        canvas.width = item.width;
        canvas.height = item.height;
        const context = canvas.getContext("2d", { alpha: false });
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, item.width, item.height);
        await page.render({ canvas, canvasContext: context, viewport, background: "#ffffff" }).promise;
        const blob = await canvasToPng(canvas);
        const filename = `${filenameBase}-${String(item.pageNumber).padStart(3, "0")}.png`;
        const result = {
          pageNumber: item.pageNumber,
          width: item.width,
          height: item.height,
          dpi,
          blob,
          url: URL.createObjectURL(blob),
          filename,
        };
        state.results.push(result);
        addResultCard(result);
        completed++;
        els.resultsMeta.textContent = `${completed} / ${plan.length} 页 · ${dpi} DPI`;
        setProgress(completed, plan.length, `已完成 ${completed} / ${plan.length} 页`);
      } finally {
        page.cleanup();
      }
      await tick();
    }

    if (state.cancelled) {
      setStatus(`已取消，保留已完成的 ${completed} 页。`, "");
    } else {
      const totalBytes = state.results.reduce((sum, result) => sum + result.blob.size, 0);
      setStatus(`完成 ${completed} 页 · ${dpi} DPI · ${formatBytes(totalBytes)}`, "success");
    }
  } catch (error) {
    failedPage = plan[completed]?.pageNumber ?? null;
    showError(
      failedPage
        ? `第 ${failedPage} 页导出失败（已完成 ${completed} 页）：${error?.message || error}`
        : `导出失败：${error?.message || error}`
    );
  } finally {
    hideProgress();
    setBusy(false);
    updateConvertState();
    els.convert.textContent = state.results.length ? "重新转换" : "开始转换";
    els.downloadZip.hidden = state.results.length === 0;
    els.resultsPanel.hidden = state.results.length === 0;
    if (state.results.length) {
      els.downloadZip.textContent = `下载全部 ZIP（${state.results.length} 页）`;
    }
  }
}

async function downloadZip() {
  if (!state.results.length || state.busy) return;
  const button = els.downloadZip;
  button.disabled = true;
  setStatus("正在打包 PNG…");
  try {
    await tick();
    const files = {};
    for (const result of state.results) {
      files[result.filename] = new Uint8Array(await result.blob.arrayBuffer());
    }
    const zipped = zipSync(files, { level: 0 });
    const blob = new Blob([zipped], { type: "application/zip" });
    const dpi = state.results[0]?.dpi || state.dpi;
    downloadBlob(blob, `${state.baseName}-${dpi}dpi.zip`);
    setStatus(`已打包 ${state.results.length} 页 · ${formatBytes(blob.size)}`, "success");
  } catch (error) {
    setStatus(`打包失败：${error?.message || error}`, "error");
  } finally {
    button.disabled = false;
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ================= 交互 ================= */

function commitSettingsChange() {
  if (state.busy) return;
  const dpi = readDpi();
  els.dpi.value = String(dpi);
  updateDpiUi();
  if (state.results.length) {
    clearResults();
    setStatus("设置已更新，请重新转换。", "");
  }
  updateSummary();
  const range = readRange();
  if (range) renderPreview(range.from);
}

els.dpi.addEventListener("input", () => {
  updateDpiUi();
  if (state.busy) return;
  clearTimeout(els.dpi._timer);
  els.dpi._timer = setTimeout(() => updateSummary(), 180);
});
els.dpi.addEventListener("change", commitSettingsChange);

els.dpiPresets.addEventListener("click", (event) => {
  const button = event.target.closest("[data-dpi]");
  if (!button || state.busy) return;
  els.dpi.value = button.dataset.dpi;
  commitSettingsChange();
});

els.allPages.addEventListener("change", () => {
  if (state.busy) return;
  els.pageFrom.disabled = els.allPages.checked;
  els.pageTo.disabled = els.allPages.checked;
  if (els.allPages.checked && state.pageCount) {
    els.pageFrom.value = "1";
    els.pageTo.value = String(state.pageCount);
  }
  commitSettingsChange();
});

els.pageFrom.addEventListener("change", () => {
  if (!state.pdf || state.busy) return;
  let from = clamp(Number.parseInt(els.pageFrom.value, 10) || 1, 1, state.pageCount);
  let to = clamp(Number.parseInt(els.pageTo.value, 10) || state.pageCount, 1, state.pageCount);
  if (from > to) to = from;
  els.pageFrom.value = String(from);
  els.pageTo.value = String(to);
  commitSettingsChange();
});

els.pageTo.addEventListener("change", () => {
  if (!state.pdf || state.busy) return;
  let from = clamp(Number.parseInt(els.pageFrom.value, 10) || 1, 1, state.pageCount);
  let to = clamp(Number.parseInt(els.pageTo.value, 10) || state.pageCount, 1, state.pageCount);
  if (to < from) from = to;
  els.pageFrom.value = String(from);
  els.pageTo.value = String(to);
  commitSettingsChange();
});

els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files?.[0];
  if (!file) return;
  handleFile(file).catch((error) => setStatus(`读取失败：${error?.message || error}`, "error"))
    .finally(() => { els.fileInput.value = ""; });
});

els.dropzone.addEventListener("click", (event) => {
  if (event.target.closest("#file-remove")) return;
  if (state.busy) return;
  els.fileInput.click();
});

els.dropzone.addEventListener("keydown", (event) => {
  if (state.busy || event.target.closest("#file-remove")) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    els.fileInput.click();
  }
});

let dragDepth = 0;
els.dropzone.addEventListener("dragenter", (event) => {
  event.preventDefault();
  if (state.busy) return;
  dragDepth++;
  els.dropzone.classList.add("is-dragover");
});
els.dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
els.dropzone.addEventListener("dragleave", (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropzone.classList.remove("is-dragover");
});
els.dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  els.dropzone.classList.remove("is-dragover");
  if (state.busy) return;
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    handleFile(file).catch((error) => setStatus(`读取失败：${error?.message || error}`, "error"));
  }
});

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => event.preventDefault());

els.fileRemove.addEventListener("click", async (event) => {
  event.stopPropagation();
  if (state.busy) return;
  await resetAll();
});

els.convert.addEventListener("click", () => {
  convert().catch((error) => {
    setStatus(`转换失败：${error?.message || error}`, "error");
    setBusy(false);
    updateConvertState();
  });
});

els.cancel.addEventListener("click", () => {
  if (!state.busy) return;
  state.cancelled = true;
  els.cancel.disabled = true;
  setStatus("正在停止，当前页完成后结束…", "");
});

els.downloadZip.addEventListener("click", () => {
  downloadZip().catch((error) => setStatus(`打包失败：${error?.message || error}`, "error"));
});

async function resetAll() {
  if (state.busy) return;
  state.loadToken++;
  await closeDocument();
  clearResults();
  state.file = null;
  state.baseName = "document";
  state.pageCount = 0;
  state.cancelled = false;
  state.rangeTooLarge = false;
  els.fileInput.value = "";
  els.dpi.value = String(DEFAULT_DPI);
  state.dpi = DEFAULT_DPI;
  els.allPages.checked = true;
  els.allPages.disabled = false;
  els.pageFrom.value = "1";
  els.pageTo.value = "1";
  els.pageFrom.disabled = true;
  els.pageTo.disabled = true;
  els.pageFrom.removeAttribute("max");
  els.pageTo.removeAttribute("max");
  els.cancel.hidden = true;
  els.cancel.disabled = false;
  clearFileView();
  resetSummary();
  showEmptyPreview();
  hideProgress();
  setStatus("");
  updateDpiUi();
  updateConvertState();
}

els.reset.addEventListener("click", resetAll);

window.addEventListener("beforeunload", () => {
  for (const result of state.results) URL.revokeObjectURL(result.url);
});

/* ================= 启动 ================= */

els.dpi.value = String(DEFAULT_DPI);
state.dpi = DEFAULT_DPI;
updateDpiUi();
resetSummary();
updateConvertState();
