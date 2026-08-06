/* QuickSign — sign PDFs entirely in the browser.
   Uses pdf-lib (MIT) for editing and pdf.js (Apache-2.0) for page rendering,
   both vendored locally. The Great Vibes font (OFL) renders typed signatures. */

"use strict";

const CONFIG = {
  premiumCheckoutUrl: "https://cordovil6.gumroad.com/l/quicksign",
  // Gumroad product ID, used for license key verification
  gumroadProductId: "a0CvukbVvCvrZF7KybOnmw==",
  premiumPrice: "$9",
};

const PREMIUM_KEY = "quicksign.premium";
const SIGS_KEY = "quicksign.sigs";

const $ = (id) => document.getElementById(id);
const { PDFDocument, StandardFonts, rgb } = PDFLib;

pdfjsLib.GlobalWorkerOptions.workerSrc = "pdf.worker.min.js";

/* ---------------- State ---------------- */

let pdfBytes = null;      // Uint8Array of the loaded file
let baseName = "document";
let pdfjsDoc = null;
let pageCount = 0;
let curPage = 0;          // 0-based
let cssW = 0, cssH = 0;   // rendered page size in CSS px
let fitScale = 1;         // CSS px per PDF point
let items = [];           // placed items
let nextId = 1;
let sigModalMode = "signature"; // or "initials"
let sigTab = "draw";
let scriptFontReady = false;

/* ---------------- Utilities ---------------- */

function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

function todayStr() {
  return new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/* ---------------- Loading ---------------- */

async function loadFile(file) {
  if (!file) return;
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) {
    showToast("That doesn't look like a PDF file.");
    return;
  }
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  try {
    // Validate with pdf-lib first so export won't surprise the user later.
    await PDFDocument.load(bytes);
  } catch (err) {
    const msg = String(err && err.message || err);
    if (/encrypted/i.test(msg)) {
      showToast("This PDF is password-protected. Remove the password first, then try again.");
    } else {
      showToast("Couldn't read this PDF — the file may be corrupt.");
    }
    return;
  }
  pdfjsDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  pdfBytes = bytes;
  baseName = file.name.replace(/\.pdf$/i, "") || "document";
  pageCount = pdfjsDoc.numPages;
  curPage = 0;
  items = [];
  $("dropzone").hidden = true;
  $("editor").hidden = false;
  await renderPage();
  showToast(`Loaded "${file.name}" — ${pageCount} page${pageCount === 1 ? "" : "s"}`);
}

/* ---------------- Page rendering ---------------- */

async function renderPage() {
  const page = await pdfjsDoc.getPage(curPage + 1);
  const base = page.getViewport({ scale: 1 });
  const avail = Math.min($("viewer").parentElement.clientWidth - 4 || 800, 820);
  fitScale = Math.min(avail / base.width, 1.6);
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: fitScale * dpr });
  const canvas = $("pageCanvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  cssW = Math.floor(vp.width / dpr);
  cssH = Math.floor(vp.height / dpr);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  $("pageIndicator").textContent = `${curPage + 1} / ${pageCount}`;
  $("prevPageBtn").disabled = curPage === 0;
  $("nextPageBtn").disabled = curPage === pageCount - 1;
  renderOverlay();
}

function renderOverlay() {
  const ov = $("overlay");
  ov.innerHTML = "";
  for (const it of items) {
    if (it.page !== curPage) continue;
    const el = document.createElement("div");
    el.className = "placed" + (it.type === "initials" ? " initials" : "");
    el.dataset.id = it.id;
    const wPx = it.wF * cssW;
    el.style.left = it.xF * cssW + "px";
    el.style.top = it.yF * cssH + "px";
    if (it.dataUrl) {
      const hPx = wPx * it.aspect;
      el.style.width = wPx + "px";
      el.style.height = hPx + "px";
      const img = document.createElement("img");
      img.src = it.dataUrl;
      img.draggable = false;
      el.appendChild(img);
    } else {
      const span = document.createElement("span");
      span.className = "txt";
      span.textContent = it.text;
      span.style.fontSize = it.fontPt * fitScale + "px";
      el.appendChild(span);
    }
    const rm = document.createElement("button");
    rm.className = "rm";
    rm.textContent = "✕";
    rm.title = "Remove";
    rm.addEventListener("click", (e) => { e.stopPropagation(); removeItem(it.id); });
    el.appendChild(rm);
    if (it.dataUrl) {
      const handle = document.createElement("div");
      handle.className = "handle";
      wireResize(handle, el, it);
      el.appendChild(handle);
    }
    if (it.type === "initials") {
      const all = document.createElement("button");
      all.className = "allpages";
      all.textContent = "→ all pages";
      all.title = "Stamp these initials on every page";
      all.addEventListener("click", (e) => { e.stopPropagation(); stampAllPages(it); });
      el.appendChild(all);
    }
    wireDrag(el, it);
    ov.appendChild(el);
  }
}

function wireDrag(el, it) {
  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".handle") || e.target.closest("button")) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add("selected");
    const startX = e.clientX, startY = e.clientY;
    const origL = it.xF * cssW, origT = it.yF * cssH;
    const onMove = (ev) => {
      const l = origL + (ev.clientX - startX);
      const t = origT + (ev.clientY - startY);
      el.style.left = l + "px";
      el.style.top = t + "px";
    };
    const onUp = (ev) => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.classList.remove("selected");
      const l = origL + (ev.clientX - startX);
      const t = origT + (ev.clientY - startY);
      const wPx = parseFloat(el.style.width) || 10;
      const hPx = parseFloat(el.style.height) || 14;
      it.xF = Math.min(Math.max(l / cssW, -0.02), 1 - wPx / cssW + 0.02);
      it.yF = Math.min(Math.max(t / cssH, -0.02), 1 - hPx / cssH + 0.02);
      renderOverlay();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  });
}

function wireResize(handle, el, it) {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    el.classList.add("selected");
    const startX = e.clientX;
    const origW = it.wF * cssW;
    const onMove = (ev) => {
      const w = Math.max(28, origW + (ev.clientX - startX));
      el.style.width = w + "px";
      el.style.height = w * it.aspect + "px";
    };
    const onUp = (ev) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      el.classList.remove("selected");
      const w = Math.max(28, origW + (ev.clientX - startX));
      it.wF = Math.min(w / cssW, 0.95);
      renderOverlay();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
}

/* ---------------- Items ---------------- */

function addItem(type, opts = {}) {
  const it = {
    id: nextId++,
    type,
    page: curPage,
    xF: opts.xF ?? 0.34,
    yF: opts.yF ?? 0.42,
    wF: opts.wF ?? (type === "initials" ? 0.12 : 0.3),
    aspect: opts.aspect ?? 0,
    dataUrl: opts.dataUrl ?? null,
    text: opts.text ?? null,
    fontPt: opts.fontPt ?? 12,
  };
  items.push(it);
  renderOverlay();
  return it;
}

function removeItem(id) {
  items = items.filter((i) => i.id !== id);
  renderOverlay();
}

function stampAllPages(it) {
  for (let p = 0; p < pageCount; p++) {
    if (p === it.page) continue;
    if (items.some((o) => o.type === "initials" && o.page === p && o.dataUrl === it.dataUrl)) continue;
    items.push({ ...it, id: nextId++, page: p });
  }
  showToast(`Initials stamped on all ${pageCount} pages`);
  renderOverlay();
}

/* ---------------- Signature capture ---------------- */

let drawStrokes = [];
let drawing = false;

function initDrawCanvas() {
  const c = $("drawCanvas");
  const ctx = c.getContext("2d");
  const pos = (e) => {
    const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
  };
  c.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    c.setPointerCapture(e.pointerId);
    drawing = true;
    drawStrokes.push([pos(e)]);
  });
  c.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const stroke = drawStrokes[drawStrokes.length - 1];
    stroke.push(pos(e));
    const n = stroke.length;
    ctx.strokeStyle = "#141a49";
    ctx.lineWidth = 3.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(stroke[n - 2].x, stroke[n - 2].y);
    ctx.lineTo(stroke[n - 1].x, stroke[n - 1].y);
    ctx.stroke();
  });
  const end = () => { drawing = false; };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);
}

function clearDrawCanvas() {
  const c = $("drawCanvas");
  c.getContext("2d").clearRect(0, 0, c.width, c.height);
  drawStrokes = [];
}

/* Crop a canvas to its inked bounding box and return {dataUrl, aspect}. */
function trimCanvas(c) {
  const ctx = c.getContext("2d");
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // empty
  const pad = 8;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  out.getContext("2d").drawImage(c, minX, minY, w, h, 0, 0, w, h);
  return { dataUrl: out.toDataURL("image/png"), aspect: h / w };
}

async function ensureScriptFont() {
  if (scriptFontReady) return;
  const face = new FontFace("GreatVibes", "url(GreatVibes-Regular.ttf)");
  await face.load();
  document.fonts.add(face);
  scriptFontReady = true;
}

async function renderTypedSig() {
  await ensureScriptFont();
  const c = $("typeCanvas");
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  const text = $("typeInput").value.trim();
  if (!text) return;
  ctx.font = "110px GreatVibes";
  ctx.fillStyle = "#141a49";
  ctx.textBaseline = "middle";
  const w = ctx.measureText(text).width;
  const scale = Math.min(1, (c.width - 60) / w);
  ctx.save();
  ctx.translate(c.width / 2, c.height / 2);
  ctx.scale(scale, scale);
  ctx.fillText(text, -w / 2, 0);
  ctx.restore();
}

function processUploadedSig(file) {
  const img = new Image();
  img.onload = () => {
    const c = $("uploadCanvas");
    const ctx = c.getContext("2d");
    const scale = Math.min(c.width / img.width, c.height / img.height, 1);
    const w = img.width * scale, h = img.height * scale;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
    // Whiten the paper background: bright pixels become transparent,
    // darker pixels become semi-opaque ink.
    const id = ctx.getImageData(0, 0, c.width, c.height);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum > 210) { d[i + 3] = 0; continue; }
      const alpha = Math.min(255, (210 - lum) * 1.8);
      d[i] = 20; d[i + 1] = 26; d[i + 2] = 73;
      d[i + 3] = alpha;
    }
    ctx.putImageData(id, 0, 0);
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
}

function currentSigCapture() {
  if (sigTab === "draw") {
    if (!drawStrokes.length) return null;
    return trimCanvas($("drawCanvas"));
  }
  if (sigTab === "type") return trimCanvas($("typeCanvas"));
  return trimCanvas($("uploadCanvas"));
}

/* ---------------- Signature modal ---------------- */

function openSigModal(mode) {
  sigModalMode = mode;
  $("sigModalTitle").textContent = mode === "initials" ? "Add your initials" : "Add your signature";
  $("sigModal").hidden = false;
  setSigTab("draw");
  clearDrawCanvas();
  $("typeInput").value = "";
  const tc = $("typeCanvas"); tc.getContext("2d").clearRect(0, 0, tc.width, tc.height);
  const uc = $("uploadCanvas"); uc.getContext("2d").clearRect(0, 0, uc.width, uc.height);
  $("saveSigCheck").checked = false;
}

function setSigTab(tab) {
  if ((tab === "type" || tab === "upload") && !isPremium()) { openPremiumModal(); return; }
  sigTab = tab;
  $("tabDraw").classList.toggle("active", tab === "draw");
  $("tabType").classList.toggle("active", tab === "type");
  $("tabUpload").classList.toggle("active", tab === "upload");
  $("paneDraw").hidden = tab !== "draw";
  $("paneType").hidden = tab !== "type";
  $("paneUpload").hidden = tab !== "upload";
}

function useSignature() {
  const cap = currentSigCapture();
  if (!cap) { showToast(sigTab === "type" ? "Type your name first." : "Draw something first."); return; }
  if ($("saveSigCheck").checked) {
    if (!isPremium()) { $("saveSigCheck").checked = false; openPremiumModal(); return; }
    saveSig(cap);
  }
  addItem(sigModalMode, { dataUrl: cap.dataUrl, aspect: cap.aspect, wF: sigModalMode === "initials" ? 0.12 : 0.3 });
  $("sigModal").hidden = true;
}

/* ---------------- Saved signatures (premium) ---------------- */

function getSavedSigs() {
  try { return JSON.parse(localStorage.getItem(SIGS_KEY) || "[]"); } catch { return []; }
}

function saveSig(cap) {
  const sigs = getSavedSigs();
  sigs.unshift({ d: cap.dataUrl, a: cap.aspect });
  try { localStorage.setItem(SIGS_KEY, JSON.stringify(sigs.slice(0, 5))); } catch {}
  renderSavedRow();
}

function deleteSig(idx) {
  const sigs = getSavedSigs();
  sigs.splice(idx, 1);
  try { localStorage.setItem(SIGS_KEY, JSON.stringify(sigs)); } catch {}
  renderSavedRow();
}

function renderSavedRow() {
  const row = $("savedRow");
  const sigs = isPremium() ? getSavedSigs() : [];
  row.hidden = sigs.length === 0;
  row.innerHTML = "";
  if (!sigs.length) return;
  const label = document.createElement("span");
  label.className = "saved-label";
  label.textContent = "Saved:";
  row.appendChild(label);
  sigs.forEach((s, i) => {
    const b = document.createElement("button");
    b.className = "saved-sig";
    b.title = "Place this signature";
    const img = document.createElement("img");
    img.src = s.d;
    b.appendChild(img);
    const del = document.createElement("span");
    del.className = "del";
    del.textContent = "✕";
    del.title = "Delete saved signature";
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteSig(i); });
    b.appendChild(del);
    b.addEventListener("click", () => addItem("signature", { dataUrl: s.d, aspect: s.a }));
    row.appendChild(b);
  });
}

/* ---------------- Export ---------------- */

async function makeSignedBlob() {
  const src = await PDFDocument.load(pdfBytes);
  const font = await src.embedFont(StandardFonts.Helvetica);
  const imgCache = new Map();
  for (const it of items) {
    const page = src.getPage(it.page);
    const { width: pw, height: ph } = page.getSize();
    if (it.dataUrl) {
      let img = imgCache.get(it.dataUrl);
      if (!img) {
        img = await src.embedPng(it.dataUrl);
        imgCache.set(it.dataUrl, img);
      }
      const w = it.wF * pw;
      const h = w * it.aspect;
      page.drawImage(img, { x: it.xF * pw, y: ph - it.yF * ph - h, width: w, height: h });
    } else {
      const size = it.fontPt;
      page.drawText(it.text, {
        x: it.xF * pw,
        y: ph - it.yF * ph - size,
        size,
        font,
        color: rgb(0.08, 0.1, 0.29),
      });
    }
  }
  const bytes = await src.save();
  return new Blob([bytes], { type: "application/pdf" });
}

async function doDownload() {
  if (!items.length) { showToast("Add a signature first."); return; }
  const btn = $("downloadBtn");
  btn.disabled = true;
  try {
    const blob = await makeSignedBlob();
    download(`${baseName}-signed.pdf`, blob);
    showToast("Signed PDF downloaded ✓");
  } catch (err) {
    showToast("Something went wrong signing this PDF.");
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

function resetApp() {
  pdfBytes = null; pdfjsDoc = null; items = []; pageCount = 0; curPage = 0;
  $("editor").hidden = true;
  $("dropzone").hidden = false;
  $("fileInput").value = "";
}

/* ---------------- Premium / license (Gumroad) ---------------- */

function isPremium() {
  try { return localStorage.getItem(PREMIUM_KEY) === "yes"; } catch { return false; }
}

function applyPremiumUI() {
  if (isPremium()) {
    $("premiumBtn").textContent = "✓ Premium";
    ["textLock", "initialsLock", "typeLock", "uploadLock", "saveLock"].forEach((id) => { $(id).hidden = true; });
  }
  renderSavedRow();
}

async function applyLicense() {
  const key = $("licenseInput").value.trim();
  const status = $("licenseStatus");
  status.className = "license-status";
  if (!key) {
    status.textContent = "Please paste your license key.";
    status.classList.add("err");
    return;
  }
  if (!CONFIG.gumroadProductId) {
    status.textContent = "Premium is not available yet. Check back soon!";
    status.classList.add("err");
    return;
  }
  status.textContent = "Checking…";
  try {
    const res = await fetch("https://api.gumroad.com/v2/licenses/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        product_id: CONFIG.gumroadProductId,
        license_key: key,
        increment_uses_count: "true",
      }),
    });
    const data = await res.json();
    if (data.success && !data.purchase.refunded && !data.purchase.chargebacked) {
      try { localStorage.setItem(PREMIUM_KEY, "yes"); } catch {}
      status.textContent = "Premium activated. Enjoy!";
      status.classList.add("ok");
      showToast("✨ Premium activated!");
      applyPremiumUI();
      setTimeout(closePremiumModal, 1200);
    } else {
      status.textContent = "That key doesn't look valid. Check your Gumroad receipt.";
      status.classList.add("err");
    }
  } catch {
    status.textContent = "Could not reach the license server. Try again in a moment.";
    status.classList.add("err");
  }
}

function openPremiumModal() {
  $("premiumModal").hidden = false;
}

function closePremiumModal() {
  $("premiumModal").hidden = true;
}

/* ---------------- Wiring ---------------- */

function wireDropzone(dz, input, handler) {
  dz.addEventListener("click", () => input.click());
  input.addEventListener("change", () => { handler(input.files[0]); });
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragging"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragging"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("dragging");
    handler(e.dataTransfer.files[0]);
  });
}

function init() {
  wireDropzone($("dropzone"), $("fileInput"), loadFile);
  $("chooseBtn").addEventListener("click", (e) => { e.stopPropagation(); $("fileInput").click(); });

  $("prevPageBtn").addEventListener("click", () => { if (curPage > 0) { curPage--; renderPage(); } });
  $("nextPageBtn").addEventListener("click", () => { if (curPage < pageCount - 1) { curPage++; renderPage(); } });

  $("addSigBtn").addEventListener("click", () => openSigModal("signature"));
  $("addDateBtn").addEventListener("click", () => addItem("date", { text: todayStr(), fontPt: 12, xF: 0.6, yF: 0.5 }));
  $("addTextBtn").addEventListener("click", () => {
    if (!isPremium()) { openPremiumModal(); return; }
    $("textInput").value = "";
    $("textModal").hidden = false;
    $("textInput").focus();
  });
  $("addInitialsBtn").addEventListener("click", () => {
    if (!isPremium()) { openPremiumModal(); return; }
    openSigModal("initials");
  });

  $("tabDraw").addEventListener("click", () => setSigTab("draw"));
  $("tabType").addEventListener("click", () => setSigTab("type"));
  $("tabUpload").addEventListener("click", () => setSigTab("upload"));
  $("clearDrawBtn").addEventListener("click", clearDrawCanvas);
  $("typeInput").addEventListener("input", renderTypedSig);
  $("sigImgInput").addEventListener("change", () => {
    const f = $("sigImgInput").files[0];
    if (f) processUploadedSig(f);
  });
  $("sigCancelBtn").addEventListener("click", () => { $("sigModal").hidden = true; });
  $("sigModal").addEventListener("click", (e) => { if (e.target === $("sigModal")) $("sigModal").hidden = true; });
  $("sigUseBtn").addEventListener("click", useSignature);
  initDrawCanvas();

  $("textCancelBtn").addEventListener("click", () => { $("textModal").hidden = true; });
  $("textOkBtn").addEventListener("click", () => {
    const t = $("textInput").value.trim();
    if (t) addItem("text", { text: t, fontPt: 12 });
    $("textModal").hidden = true;
  });
  $("textInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("textOkBtn").click(); });

  $("downloadBtn").addEventListener("click", doDownload);
  $("resetBtn").addEventListener("click", resetApp);

  $("premiumBtn").addEventListener("click", openPremiumModal);
  $("premiumCloseBtn").addEventListener("click", closePremiumModal);
  $("premiumModal").addEventListener("click", (e) => { if (e.target === $("premiumModal")) closePremiumModal(); });
  $("buyBtn").addEventListener("click", () => {
    if (CONFIG.premiumCheckoutUrl) window.open(CONFIG.premiumCheckoutUrl, "_blank");
    else showToast("Premium is not available yet. Check back soon!");
  });
  $("haveKeyLink").addEventListener("click", (e) => { e.preventDefault(); $("licenseRow").hidden = false; $("licenseInput").focus(); });
  $("licenseVerifyBtn").addEventListener("click", applyLicense);
  $("licenseInput").addEventListener("keydown", (e) => { if (e.key === "Enter") applyLicense(); });

  window.addEventListener("resize", () => {
    clearTimeout(init._rt);
    init._rt = setTimeout(() => { if (pdfjsDoc) renderPage(); }, 200);
  });

  applyPremiumUI();
}

document.addEventListener("DOMContentLoaded", init);
