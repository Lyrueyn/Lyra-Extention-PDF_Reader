/* Lyra PDF Reader — PDF.js 3.11 public APIs, no remote services. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const viewer = $("viewer"), pagesEl = $("pages"), thumbs = $("thumbs");
  const MAX_PAGE_PIXELS = 8 * 1024 * 1024;
  const MAX_CACHE_PIXELS = 24 * 1024 * 1024;
  const MAX_CACHED_PAGES = 8, MAX_CACHED_THUMBS = 28;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));
  let doc = null, openToken = 0, loadingTask = null, passwordCallback = null;
  let frame = 0, resizeTimer = 0, pageTimer = 0, searchTimer = 0;
  let mode = "width", manualScale = 1, rotation = 0, sidebarTab = "thumbs";
  let lastViewerWidth = 0, lastViewerHeight = 0;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";

  function status(message, error = false) {
    $("status").textContent = message;
    $("status").classList.toggle("error", error);
  }
  function hostReady() {
    // Only book-ready: lyra-ready asks old hosts to send the same file again.
    window.chrome?.webview?.postMessage({ type: "lyra-book-ready" });
  }
  function controls() {
    const has = !!doc;
    document.querySelectorAll("[data-document]").forEach(el => { el.disabled = !has; });
    $("pageInput").disabled = !has;
    $("pageTotal").textContent = "/ " + (doc?.pdf.numPages || 0);
    if (document.activeElement !== $("pageInput")) $("pageInput").value = String(doc?.current || 1);
    $("prevBtn").disabled = !has || doc.current <= 1;
    $("nextBtn").disabled = !has || doc.current >= doc.pdf.numPages;
    $("zoomMode").value = mode;
    const scale = has ? pageScale(doc.pages[doc.current - 1]) : 1;
    $("zoomValue").textContent = Math.round(scale * 100) + "%";
    $("zoomOutBtn").disabled = !has || (mode === "custom" && manualScale <= .25);
    $("zoomInBtn").disabled = !has || (mode === "custom" && manualScale >= 5);
    $("readingProgress").textContent = has ? `${doc.current} / ${doc.pdf.numPages} 页` : "";
  }
  function padding() { return parseFloat(getComputedStyle(viewer).paddingLeft) || 20; }
  function dimensions(p) {
    return rotation % 180 ? { w: p.baseH, h: p.baseW } : { w: p.baseW, h: p.baseH };
  }
  function pageScale(p) {
    const size = dimensions(p), pad = padding();
    if (mode === "custom") return manualScale;
    const widthScale = Math.max(40, viewer.clientWidth - pad * 2) / size.w;
    return Math.max(.02, Math.min(5, mode === "page"
      ? Math.min(widthScale, Math.max(40, viewer.clientHeight - pad * 2) / size.h)
      : widthScale));
  }
  // Numeric offsets make current-page detection logarithmic, without scanning DOM on scroll.
  function pageAt(y) {
    if (!doc?.pages.length) return 0;
    let lo = 0, hi = doc.pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1, p = doc.pages[mid];
      if (p.top + p.height + 18 <= y) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  function anchor() {
    if (!doc) return null;
    const p = doc.pages[pageAt(viewer.scrollTop + padding())];
    return { page: p.num, fraction: (viewer.scrollTop - p.top) / p.height,
      x: (viewer.scrollLeft + viewer.clientWidth / 2) / Math.max(viewer.scrollWidth, 1) };
  }
  function restoreAnchor(a) {
    const p = a && doc?.pages[a.page - 1];
    if (!p) return;
    viewer.scrollTop = p.top + a.fraction * p.height;
    viewer.scrollLeft = a.x * viewer.scrollWidth - viewer.clientWidth / 2;
  }
  function layout(a = anchor()) {
    if (!doc) return;
    let top = padding(), width = 0;
    for (const p of doc.pages) {
      const size = dimensions(p), scale = pageScale(p);
      p.width = size.w * scale; p.height = size.h * scale; p.top = top;
      p.wrap.style.width = p.width + "px"; p.wrap.style.height = p.height + "px";
      p.thumbSheet.style.aspectRatio = `${size.w} / ${size.h}`;
      top += p.height + 18; width = Math.max(width, p.width);
    }
    pagesEl.style.width = width + "px";
    restoreAnchor(a);
    if (doc.navigationPosition) doc.navigationPosition.top = viewer.scrollTop;
    controls(); schedule();
  }
  function setGeometry(d, p, page, relayout = true) {
    const base = page.getViewport({ scale: 1 });
    const changed = p.baseW !== base.width || p.baseH !== base.height;
    p.baseW = base.width; p.baseH = base.height; p.known = true;
    if (changed && relayout && d === doc) layout();
    return changed;
  }
  function cancelJob(job) {
    job.cancelled = true;
    job.renderTask?.cancel(); job.textTask?.cancel();
  }
  function releasePage(d, p) {
    const job = d.mainJobs.get(p.num);
    if (job) cancelJob(job);
    if (p.canvas) { p.canvas.width = 0; p.canvas.height = 0; p.canvas.remove(); }
    p.canvas = null; p.pixels = 0; p.drawEpoch = -1;
    p.textLayer?.remove(); p.textLayer = null; p.textDivs = null; p.textStrings = null;
    p.wrap.classList.add("unloaded");
    // PDF.js can release decoded operator/image resources once no render owns this page.
    if (!job && !d.thumbJobs.has(p.num)) p.proxy?.cleanup();
  }
  function releaseThumb(d, p) {
    const job = d.thumbJobs.get(p.num);
    if (job) cancelJob(job);
    if (p.thumbCanvas) { p.thumbCanvas.width = 0; p.thumbCanvas.height = 0; p.thumbCanvas.remove(); }
    p.thumbCanvas = null; p.thumbEpoch = -1;
    if (!job && !d.mainJobs.has(p.num) && !p.canvas) p.proxy?.cleanup();
  }
  function dispose(d) {
    if (!d) return;
    d.searchToken++;
    for (const job of [...d.mainJobs.values(), ...d.thumbJobs.values()]) cancelJob(job);
    for (const p of d.pages) { releasePage(d, p); releaseThumb(d, p); }
  }
  function valid(d, job) { return d === doc && !job.cancelled && job.epoch === d.epoch; }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; refresh(); });
  }
  function setCurrent(n, followThumb = true) {
    if (!doc) return;
    const old = doc.pages[doc.current - 1], p = doc.pages[n - 1];
    if (!p) return;
    old?.thumb.classList.remove("active"); old?.thumb.removeAttribute("aria-current");
    doc.current = n; p.thumb.classList.add("active"); p.thumb.setAttribute("aria-current", "page");
    controls();
    if (followThumb && !$("sidebar").hidden && sidebarTab === "thumbs") {
      const top = p.thumb.offsetTop, bottom = top + p.thumb.offsetHeight;
      if (top < thumbs.scrollTop || bottom > thumbs.scrollTop + thumbs.clientHeight) {
        thumbs.scrollTop = top - thumbs.clientHeight / 2 + p.thumb.offsetHeight / 2;
      }
    }
  }
  function refresh() {
    const d = doc;
    if (!d?.pages.length) return;
    const start = viewer.scrollTop, end = start + viewer.clientHeight;
    let current = pageAt(start + Math.min(viewer.clientHeight * .25, 150));
    if (start >= viewer.scrollHeight - viewer.clientHeight - 2) current = d.pages.length - 1;
    // At the end of a zoomed-out document, several target pages share the same clamped scrollTop.
    if (d.navigationPosition && Math.abs(start - d.navigationPosition.top) < 1) current = d.navigationPosition.page - 1;
    else d.navigationPosition = null;
    if (current + 1 !== d.current) setCurrent(current + 1);
    const from = pageAt(Math.max(0, start - viewer.clientHeight * .6));
    const to = pageAt(end + viewer.clientHeight * .6);
    d.wanted = new Set(); d.visible = new Set();
    for (let i = from; i <= to; i++) {
      const p = d.pages[i]; d.wanted.add(p.num);
      if (p.top < end && p.top + p.height > start) d.visible.add(p.num);
    }
    for (const [num, job] of d.mainJobs) if (!d.wanted.has(num)) cancelJob(job);
    trimCache(d);
    const candidates = [...d.wanted].map(n => d.pages[n - 1]).sort((a, b) =>
      Number(d.visible.has(b.num)) - Number(d.visible.has(a.num)) || Math.abs(a.num - d.current) - Math.abs(b.num - d.current));
    let reserved = d.pages.reduce((sum, p) => sum + p.pixels, 0);
    const reservedPages = new Set(d.pages.filter(p => p.canvas).map(p => p.num));
    for (const [num] of d.mainJobs) { reserved += estimatedPixels(d.pages[num - 1]); reservedPages.add(num); }
    for (const p of candidates) {
      if (d.mainJobs.size >= 2) break;
      if (d.mainJobs.has(p.num) || p.drawEpoch === d.epoch || p.errorEpoch === d.epoch) continue;
      const pixels = estimatedPixels(p);
      // Do not endlessly render and evict a prefetched page that cannot fit the budget.
      if (!d.visible.has(p.num) && (reserved + pixels > MAX_CACHE_PIXELS ||
        (!reservedPages.has(p.num) && reservedPages.size >= MAX_CACHED_PAGES))) continue;
      reserved += pixels; reservedPages.add(p.num); renderPage(d, p);
    }
    refreshThumbs(d);
  }
  function estimatedPixels(p) {
    const ratio = Math.min(window.devicePixelRatio || 1, 2,
      Math.sqrt(MAX_PAGE_PIXELS / (p.width * p.height)), 8192 / Math.max(p.width, p.height));
    return Math.max(1, Math.floor(p.width * ratio)) * Math.max(1, Math.floor(p.height * ratio));
  }
  function trimCache(d) {
    const cached = d.pages.filter(p => p.canvas).sort((a, b) => Math.abs(b.num - d.current) - Math.abs(a.num - d.current));
    let pixels = cached.reduce((sum, p) => sum + p.pixels, 0), count = cached.length;
    for (const p of cached) {
      if (d.visible.has(p.num)) continue;
      if (!d.wanted.has(p.num) || count > MAX_CACHED_PAGES || pixels > MAX_CACHE_PIXELS) {
        pixels -= p.pixels; count--; releasePage(d, p);
      }
    }
  }
  async function renderPage(d, p) {
    const job = { epoch: d.epoch, cancelled: false }, canvas = document.createElement("canvas");
    d.mainJobs.set(p.num, job);
    let attached = false;
    try {
      const page = await d.pdf.getPage(p.num);
      if (!valid(d, job)) return;
      p.proxy = page; setGeometry(d, p, page);
      const scale = pageScale(p), vp = page.getViewport({ scale, rotation: page.rotate + rotation });
      const ratio = Math.min(window.devicePixelRatio || 1, 2,
        Math.sqrt(MAX_PAGE_PIXELS / (vp.width * vp.height)), 8192 / Math.max(vp.width, vp.height));
      canvas.width = Math.max(1, Math.floor(vp.width * ratio));
      canvas.height = Math.max(1, Math.floor(vp.height * ratio));
      job.renderTask = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: vp,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null });
      await job.renderTask.promise;
      if (!valid(d, job)) return;
      const previous = p.canvas;
      p.canvas = canvas; p.pixels = canvas.width * canvas.height; attached = true;
      if (previous) { previous.replaceWith(canvas); previous.width = 0; previous.height = 0; }
      else p.wrap.prepend(canvas);
      p.wrap.classList.remove("unloaded"); p.wrap.querySelector(".pageError")?.remove();
      // Text extraction failure must not hide a correctly rendered scan/page.
      try {
        const content = await page.getTextContent();
        if (!valid(d, job)) return;
        const layer = document.createElement("div"), textDivs = [], textStrings = [];
        layer.className = "textLayer"; layer.style.setProperty("--scale-factor", scale);
        job.textTask = pdfjsLib.renderTextLayer({ textContentSource: content, container: layer,
          viewport: vp, textDivs, textContentItemsStr: textStrings });
        await job.textTask.promise;
        if (!valid(d, job)) return;
        p.textLayer?.remove(); p.textLayer = layer; p.textDivs = textDivs; p.textStrings = textStrings;
        p.wrap.append(layer); highlightPage(d, p);
      } catch (error) {
        if (!valid(d, job)) return;
        status(`第 ${p.num} 页已显示，文字层暂不可用`, true);
      }
      if (!valid(d, job)) return;
      p.drawEpoch = d.epoch;
      if (!d.ready) { d.ready = true; $("loading").hidden = true; hostReady(); }
      revealMatch(d, p);
    } catch (error) {
      if (!valid(d, job) || error?.name === "RenderingCancelledException") return;
      p.errorEpoch = d.epoch; p.wrap.classList.remove("unloaded");
      const box = document.createElement("div"), retry = document.createElement("button");
      box.className = "pageError"; box.append(`第 ${p.num} 页加载失败`);
      retry.className = "btn"; retry.textContent = "重试";
      retry.onclick = () => { p.errorEpoch = -1; box.remove(); schedule(); };
      box.append(retry); p.wrap.querySelector(".pageError")?.remove(); p.wrap.append(box);
      status(`第 ${p.num} 页加载失败：${error.message || error}`, true);
      $("loading").hidden = true; hostReady();
    } finally {
      if (!attached) { canvas.width = 0; canvas.height = 0; }
      if (d.mainJobs.get(p.num) === job) d.mainJobs.delete(p.num);
      if (d === doc) { trimCache(d); schedule(); }
    }
  }
  function refreshThumbs(d) {
    const visible = !$("sidebar").hidden && sidebarTab === "thumbs";
    const candidates = [];
    if (visible) {
      const top = thumbs.scrollTop - 240, bottom = thumbs.scrollTop + thumbs.clientHeight + 240;
      let lo = 0, hi = d.pages.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1, el = d.pages[mid].thumb;
        if (el.offsetTop + el.offsetHeight < top) lo = mid + 1; else hi = mid;
      }
      for (let i = lo; i < d.pages.length; i++) {
        const p = d.pages[i];
        if (p.thumb.offsetTop > bottom) break;
        candidates.push(p);
      }
    }
    const wanted = new Set(candidates.map(p => p.num));
    for (const [num, job] of d.thumbJobs) if (!wanted.has(num)) cancelJob(job);
    const cached = d.pages.filter(p => p.thumbCanvas).sort((a, b) => Math.abs(b.num - d.current) - Math.abs(a.num - d.current));
    let count = cached.length;
    for (const p of cached) if (count > MAX_CACHED_THUMBS && !wanted.has(p.num)) { releaseThumb(d, p); count--; }
    if (d.thumbJobs.size) return;
    const next = candidates.find(p => p.thumbEpoch !== d.epoch && p.thumbErrorEpoch !== d.epoch);
    if (next) renderThumb(d, next);
  }
  async function renderThumb(d, p) {
    const job = { epoch: d.epoch, cancelled: false }, canvas = document.createElement("canvas");
    d.thumbJobs.set(p.num, job);
    let attached = false;
    try {
      const page = await d.pdf.getPage(p.num);
      if (!valid(d, job)) return;
      p.proxy = page; setGeometry(d, p, page);
      const base = page.getViewport({ scale: 1, rotation: page.rotate + rotation });
      const vp = page.getViewport({ scale: 144 / base.width, rotation: page.rotate + rotation });
      canvas.width = Math.max(1, Math.floor(vp.width)); canvas.height = Math.max(1, Math.floor(vp.height));
      job.renderTask = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: vp });
      await job.renderTask.promise;
      if (!valid(d, job)) return;
      const old = p.thumbCanvas;
      p.thumbSheet.replaceChildren(canvas); p.thumbCanvas = canvas; p.thumbEpoch = d.epoch; attached = true;
      if (old) { old.width = 0; old.height = 0; }
    } catch (error) {
      if (valid(d, job)) { p.thumbErrorEpoch = d.epoch; p.thumb.title = `第 ${p.num} 页（缩略图暂不可用，点击阅读）`; }
    } finally {
      if (!attached) { canvas.width = 0; canvas.height = 0; }
      if (d.thumbJobs.get(p.num) === job) d.thumbJobs.delete(p.num);
      if (d === doc) schedule();
    }
  }
  function invalidate() {
    if (!doc) return;
    doc.epoch++;
    for (const job of [...doc.mainJobs.values(), ...doc.thumbJobs.values()]) cancelJob(job);
    // Keep the old bitmap while the replacement renders. Never resize a canvas PDF.js owns.
    for (const p of doc.pages) {
      p.textLayer?.remove(); p.textLayer = null; p.textDivs = null; p.textStrings = null;
      p.wrap.querySelector(".pageError")?.remove();
    }
  }
  function changeZoom(nextMode, scale = manualScale) {
    if (!doc) return;
    doc.navigation++; doc.reveal = null;
    const a = anchor(); mode = nextMode; manualScale = clamp(scale, .25, 5);
    invalidate(); layout(a);
  }
  function zoomBy(factor) { if (doc) changeZoom("custom", pageScale(doc.pages[doc.current - 1]) * factor); }
  async function gotoPage(value, reveal = null) {
    const d = doc, n = Math.round(clamp(Number(value) || 1, 1, d?.pages.length || 1));
    if (!d) return;
    const p = d.pages[n - 1], navigation = ++d.navigation;
    d.reveal = reveal ? { ...reveal, navigation } : null;
    try {
      if (!p.known) {
        const page = await d.pdf.getPage(n);
        if (d !== doc || navigation !== d.navigation) return;
        setGeometry(d, p, page);
      }
      if (d !== doc || navigation !== d.navigation) return;
      // Long smooth scrolls would render every intervening page in a large document.
      viewer.scrollTop = Math.max(0, p.top - padding());
      d.navigationPosition = { page: n, top: viewer.scrollTop };
      setCurrent(n); schedule();
    } catch (error) { if (d === doc) status(`无法跳转到第 ${n} 页：${error.message}`, true); }
  }
  function buildPages(d, first) {
    const base = first.getViewport({ scale: 1 }), pageFragment = document.createDocumentFragment(), thumbFragment = document.createDocumentFragment();
    for (let num = 1; num <= d.pdf.numPages; num++) {
      const wrap = document.createElement("section"), thumb = document.createElement("button"), sheet = document.createElement("div"), label = document.createElement("span");
      wrap.className = "pageWrap unloaded"; wrap.dataset.page = num; wrap.setAttribute("aria-label", `第 ${num} 页`);
      thumb.className = "thumb"; thumb.title = `第 ${num} 页`; thumb.setAttribute("aria-label", `转到第 ${num} 页`);
      sheet.className = "thumbSheet"; label.className = "n"; label.textContent = num;
      thumb.append(sheet, label); thumb.onclick = () => gotoPage(num);
      pageFragment.append(wrap); thumbFragment.append(thumb);
      d.pages.push({ num, wrap, thumb, thumbSheet: sheet, baseW: base.width, baseH: base.height,
        known: num === 1, canvas: null, pixels: 0, drawEpoch: -1, thumbEpoch: -1, errorEpoch: -1, thumbErrorEpoch: -1 });
    }
    pagesEl.replaceChildren(pageFragment); $("thumbList").replaceChildren(thumbFragment);
    viewer.scrollTop = 0; viewer.scrollLeft = 0; thumbs.scrollTop = 0;
    layout(null); setCurrent(1); schedule();
  }
  async function measurePages(d) {
    // Discover mixed page sizes incrementally; do not block the first visible page on the whole PDF.
    for (let start = 1; start < d.pages.length && d === doc; start += 8) {
      const batch = d.pages.slice(start, start + 8).filter(p => !p.known);
      const sizes = await Promise.all(batch.map(async p => {
        try { return [p, await d.pdf.getPage(p.num)]; } catch { return null; }
      }));
      if (d !== doc) return;
      const a = anchor(); let changed = false;
      for (const pair of sizes) if (pair) changed = setGeometry(d, pair[0], pair[1], false) || changed;
      if (changed) layout(a);
      await yieldUI();
    }
  }
  async function loadOutline(d) {
    try {
      const outline = await d.pdf.getOutline();
      if (d !== doc) return;
      if (!outline?.length) { $("outline").replaceChildren(message("这份 PDF 没有内置目录，可以使用页面缩略图或全文查找。")); return; }
      function tree(items, depth = 0) {
        const ul = document.createElement("ul");
        for (const item of items) {
          const li = document.createElement("li"), button = document.createElement("button");
          button.textContent = item.title || "未命名章节";
          button.onclick = async event => {
            event.preventDefault();
            const navigation = ++d.navigation; d.reveal = null;
            try {
              let dest = item.dest;
              if (typeof dest === "string") dest = await d.pdf.getDestination(dest);
              if (d !== doc || navigation !== d.navigation || !dest?.length) return;
              const index = typeof dest[0] === "number" ? dest[0] : await d.pdf.getPageIndex(dest[0]);
              if (d === doc && navigation === d.navigation) await gotoPage(index + 1);
            } catch { if (d === doc) status("这个目录项暂时无法定位", true); }
          };
          if (!item.dest) button.disabled = true;
          if (item.items?.length && depth < 32) {
            const details = document.createElement("details"), summary = document.createElement("summary");
            details.open = depth < 1; summary.append(button); details.append(summary, tree(item.items, depth + 1)); li.append(details);
          } else li.append(button);
          ul.append(li);
        }
        return ul;
      }
      $("outline").replaceChildren(tree(outline));
    } catch { if (d === doc) $("outline").replaceChildren(message("目录暂时无法读取")); }
  }
  function message(text) { const p = document.createElement("p"); p.className = "muted"; p.textContent = text; return p; }

  // Search stores compact strings/offsets only, never a document's worth of text-layer DOM.
  function textIndex(content) {
    let text = ""; const parts = [];
    for (const item of content.items) {
      if (typeof item.str !== "string") continue;
      parts.push({ start: text.length, length: item.str.length });
      text += item.str + (item.hasEOL ? " " : "");
    }
    return { text, parts };
  }
  function searchUI(d, scanning = false) {
    if (d !== doc) return;
    const count = d.matches.length;
    $("searchCount").textContent = scanning ? `正在查找… ${count} 处` : count
      ? `${d.matchIndex + 1} / ${count}${d.truncated ? "+" : ""} 处`
      : d.query ? "未找到文字（扫描件需先识别文字）" : "输入关键词";
    $("searchPrev").disabled = $("searchNext").disabled = !count;
  }
  async function search() {
    const d = doc;
    if (!d) return;
    const token = ++d.searchToken, query = $("searchInput").value.trim();
    d.query = query; d.matches = []; d.matchIndex = -1; d.truncated = false; d.reveal = null;
    d.pageMatches = new Map();
    for (const p of d.pages) highlightPage(d, p);
    searchUI(d, !!query);
    if (!query) return;
    // Literal, case-insensitive search: user input is escaped, never interpreted as a regexp.
    const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    let failures = 0;
    for (const p of d.pages) {
      if (d !== doc || token !== d.searchToken) return;
      try {
        let index = d.textCache.get(p.num);
        if (!index) {
          const page = await d.pdf.getPage(p.num), content = await page.getTextContent();
          if (d !== doc || token !== d.searchToken) return;
          index = textIndex(content);
          if (d.textCacheChars + index.text.length <= 4 * 1024 * 1024) {
            d.textCache.set(p.num, index); d.textCacheChars += index.text.length;
          }
          if (!p.canvas && !p.thumbCanvas && !d.mainJobs.has(p.num) && !d.thumbJobs.has(p.num)) page.cleanup();
        }
        regex.lastIndex = 0;
        const matches = []; let found;
        while ((found = regex.exec(index.text))) {
          const match = { page: p.num, start: found.index, end: found.index + found[0].length,
            id: d.matches.length, parts: index.parts };
          matches.push(match); d.matches.push(match);
          if (d.matches.length >= 10000) { d.truncated = true; break; }
        }
        if (matches.length) d.pageMatches.set(p.num, matches);
        if (d.matchIndex < 0 && d.matches.length) { d.matchIndex = 0; selectMatch(0); }
        highlightPage(d, p); searchUI(d, true);
      } catch { failures++; }
      if (d.truncated) break;
      if (p.num % 4 === 0) await yieldUI();
    }
    if (d !== doc || token !== d.searchToken) return;
    searchUI(d);
    if (failures) $("searchCount").textContent += `（${failures} 页无法提取文字）`;
  }
  function highlightPage(d, p) {
    if (!p.textDivs) return;
    const matches = d.pageMatches.get(p.num) || [];
    const parts = matches[0]?.parts;
    p.textDivs.forEach((span, i) => {
      const text = p.textStrings[i] || "";
      const segments = parts?.[i] ? matches.filter(m => m.start < parts[i].start + text.length && m.end > parts[i].start) : [];
      span.replaceChildren(); let offset = 0;
      for (const match of segments) {
        const start = Math.max(0, match.start - parts[i].start), end = Math.min(text.length, match.end - parts[i].start);
        span.append(document.createTextNode(text.slice(offset, start)));
        const mark = document.createElement("mark"); mark.textContent = text.slice(start, end);
        mark.dataset.match = match.id;
        mark.classList.toggle("selected", match.id === d.matchIndex);
        span.append(mark); offset = end;
      }
      span.append(document.createTextNode(text.slice(offset)));
    });
  }
  function revealMatch(d, p) {
    if (d !== doc || !d.reveal || d.reveal.navigation !== d.navigation || d.reveal.page !== p.num || p.drawEpoch !== d.epoch) return;
    const mark = p.textLayer?.querySelector(`mark[data-match="${d.reveal.id}"]`);
    if (!mark) return;
    const r = mark.getBoundingClientRect(), box = viewer.getBoundingClientRect();
    viewer.scrollTop += r.top - box.top - viewer.clientHeight * .35;
    if (r.left < box.left || r.right > box.right) viewer.scrollLeft += r.left - box.left - viewer.clientWidth * .3;
    d.navigationPosition = { page: p.num, top: viewer.scrollTop };
    setCurrent(p.num); d.reveal = null; schedule();
  }
  async function selectMatch(delta) {
    const d = doc;
    if (!d?.matches.length) return;
    d.matchIndex = (d.matchIndex + delta + d.matches.length) % d.matches.length;
    const match = d.matches[d.matchIndex];
    for (const p of d.pages) if (p.textLayer) highlightPage(d, p);
    searchUI(d); await gotoPage(match.page, match);
    if (doc === d && d.reveal?.id === match.id) revealMatch(d, d.pages[match.page - 1]);
  }
  function showSearch(show) {
    $("searchBar").hidden = !show;
    if (show) { $("searchInput").focus(); $("searchInput").select(); }
    else {
      clearTimeout(searchTimer);
      if (doc) { doc.searchToken++; doc.navigation++; doc.query = ""; doc.matches = []; doc.pageMatches.clear(); doc.reveal = null; for (const p of doc.pages) highlightPage(doc, p); }
      $("searchInput").value = ""; viewer.focus();
    }
  }

  async function openDocument(source, name) {
    const token = ++openToken;
    clearTimeout(pageTimer); clearTimeout(searchTimer);
    dispose(doc); doc = null;
    const oldTask = loadingTask; loadingTask = null;
    if (oldTask) oldTask.destroy().catch(() => {});
    passwordCallback = null; $("passwordDialog").close(); $("passwordInput").value = "";
    pagesEl.replaceChildren(); $("thumbList").replaceChildren(); $("outline").replaceChildren(message("正在读取目录…"));
    $("searchBar").hidden = true; $("searchInput").value = "";
    $("fileName").textContent = name; $("fileName").title = name;
    document.title = name + " · 璃鸢镜";
    $("empty").hidden = true; $("loading").hidden = false; $("loadingText").textContent = "正在打开 PDF…";
    status("正在打开：" + name); controls();
    try {
      const input = typeof source === "function" ? { data: new Uint8Array(await source()) } : { url: source };
      if (token !== openToken) return;
      const task = pdfjsLib.getDocument({ ...input, cMapUrl: "cmaps/", cMapPacked: true,
        standardFontDataUrl: "standard_fonts/", isEvalSupported: false });
      loadingTask = task;
      task.onProgress = progress => {
        if (token === openToken && progress.total > 0) $("loadingText").textContent = `正在加载… ${Math.min(100, Math.round(progress.loaded / progress.total * 100))}%`;
      };
      task.onPassword = (callback, reason) => {
        if (token !== openToken) return;
        passwordCallback = callback;
        $("passwordHint").textContent = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD ? "密码不正确，请重新输入。" : "输入文档密码后继续阅读。";
        $("passwordInput").value = "";
        if (!$("passwordDialog").open) $("passwordDialog").showModal();
        $("passwordInput").focus();
      };
      const pdf = await task.promise;
      if (token !== openToken) { await pdf.destroy(); return; }
      const first = await pdf.getPage(1);
      if (token !== openToken) return;
      mode = "width"; rotation = 0;
      doc = { pdf, pages: [], current: 1, epoch: 0, mainJobs: new Map(), thumbJobs: new Map(),
        wanted: new Set(), visible: new Set(), navigation: 0, ready: false, searchToken: 0,
        query: "", matches: [], pageMatches: new Map(), matchIndex: -1, textCache: new Map(), textCacheChars: 0 };
      buildPages(doc, first); loadOutline(doc); measurePages(doc);
      status(`已打开：${name} · ${pdf.numPages} 页`);
    } catch (error) {
      if (token !== openToken) return;
      dispose(doc); doc = null;
      loadingTask?.destroy().catch(() => {}); loadingTask = null;
      $("passwordDialog").close(); passwordCallback = null;
      $("loading").hidden = true; $("empty").hidden = false;
      pagesEl.replaceChildren(); $("thumbList").replaceChildren();
      status("打开失败：" + (error?.message || error), true); controls(); hostReady();
    }
  }
  function openFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { status("请选择 PDF 文件", true); return; }
    openDocument(() => file.arrayBuffer(), file.name || "PDF");
  }
  function pickFile() { $("fileInput").value = ""; $("fileInput").click(); }
  $("openBtn").onclick = $("emptyOpenBtn").onclick = pickFile;
  $("fileInput").onchange = () => openFile($("fileInput").files[0]);
  $("passwordForm").onsubmit = event => {
    event.preventDefault(); const callback = passwordCallback; passwordCallback = null;
    const value = $("passwordInput").value; $("passwordInput").value = ""; $("passwordDialog").close(); callback?.(value);
  };
  function cancelPassword() {
    openToken++; passwordCallback = null; $("passwordInput").value = ""; $("passwordDialog").close();
    loadingTask?.destroy().catch(() => {}); loadingTask = null;
    $("loading").hidden = true; $("empty").hidden = false; status("已取消打开加密文档"); hostReady();
  }
  $("passwordCancel").onclick = cancelPassword;
  $("passwordDialog").oncancel = event => { event.preventDefault(); cancelPassword(); };
  $("prevBtn").onclick = () => gotoPage(doc.current - 1);
  $("nextBtn").onclick = () => gotoPage(doc.current + 1);
  function commitPage(final = false) {
    clearTimeout(pageTimer);
    if (!doc) return;
    const input = $("pageInput"), value = input.value.trim();
    if (!/^\d+$/.test(value)) { if (final) input.value = String(doc.current); return; }
    const n = Number(value);
    if (!final && (n < 1 || n > doc.pages.length)) return;
    const target = clamp(n, 1, doc.pages.length);
    gotoPage(target);
    if (final) input.value = String(target);
  }
  $("pageInput").onfocus = () => $("pageInput").select();
  $("pageInput").oninput = () => { clearTimeout(pageTimer); pageTimer = setTimeout(() => commitPage(false), 650); };
  $("pageInput").onblur = () => commitPage(true);
  $("pageInput").onkeydown = event => {
    if (event.key === "Enter") { event.preventDefault(); commitPage(true); viewer.focus(); }
    if (event.key === "Escape") { clearTimeout(pageTimer); $("pageInput").value = String(doc?.current || 1); viewer.focus(); }
  };
  $("zoomInBtn").onclick = () => zoomBy(1.2);
  $("zoomOutBtn").onclick = () => zoomBy(1 / 1.2);
  $("zoomMode").onchange = () => changeZoom($("zoomMode").value);
  function rotate() { if (doc) { const a = anchor(); rotation = (rotation + 90) % 360; invalidate(); layout(a); } }
  $("rotateBtn").onclick = rotate;
  $("nightBtn").onclick = () => {
    const on = document.body.classList.toggle("night");
    $("nightBtn").setAttribute("aria-pressed", String(on)); $("nightBtn").textContent = on ? "日间" : "夜间";
  };
  $("sidebarBtn").onclick = () => {
    const a = anchor(); $("sidebar").hidden = !$("sidebar").hidden;
    $("sidebarBtn").setAttribute("aria-expanded", String(!$("sidebar").hidden));
    if (mode !== "custom") invalidate(); layout(a);
  };
  function showTab(tab) {
    sidebarTab = tab; thumbs.hidden = tab !== "thumbs"; $("outline").hidden = tab !== "outline";
    for (const [id, value] of [["thumbTab", "thumbs"], ["outlineTab", "outline"]]) {
      $(id).setAttribute("aria-selected", String(tab === value)); $(id).tabIndex = tab === value ? 0 : -1;
    }
    schedule();
  }
  $("thumbTab").onclick = () => showTab("thumbs"); $("outlineTab").onclick = () => showTab("outline");
  document.querySelector(".tabs").onkeydown = event => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); showTab(sidebarTab === "thumbs" ? "outline" : "thumbs");
    $(sidebarTab === "thumbs" ? "thumbTab" : "outlineTab").focus();
  };
  $("searchBtn").onclick = () => showSearch($("searchBar").hidden);
  $("searchClose").onclick = () => showSearch(false);
  $("searchInput").oninput = () => {
    clearTimeout(searchTimer);
    if (doc) { doc.searchToken++; doc.navigation++; doc.reveal = null; }
    searchTimer = setTimeout(search, 220);
  };
  $("searchBar").onsubmit = event => { event.preventDefault(); selectMatch(1); };
  $("searchPrev").onclick = () => selectMatch(-1);
  $("searchInput").onkeydown = event => {
    if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); selectMatch(-1); }
    if (event.key === "Escape") { event.preventDefault(); showSearch(false); }
  };
  viewer.addEventListener("scroll", schedule, { passive: true });
  thumbs.addEventListener("scroll", schedule, { passive: true });
  function interruptNavigation() {
    if (doc) { doc.navigation++; doc.navigationPosition = null; doc.reveal = null; }
  }
  viewer.addEventListener("pointerdown", interruptNavigation, { passive: true });
  viewer.addEventListener("touchstart", interruptNavigation, { passive: true });
  viewer.addEventListener("wheel", event => {
    interruptNavigation();
    if (event.ctrlKey && doc) { event.preventDefault(); zoomBy(Math.exp(-event.deltaY * .002)); }
  }, { passive: false });
  window.addEventListener("keydown", event => {
    const edit = event.target.closest?.("input, textarea, select, [contenteditable='true']");
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") { event.preventDefault(); pickFile(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && doc) { event.preventDefault(); showSearch(true); return; }
    if (!doc || edit || $("passwordDialog").open || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape" && !$("searchBar").hidden) { showSearch(false); return; }
    if (event.key === "ArrowRight") { event.preventDefault(); gotoPage(doc.current + 1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); gotoPage(doc.current - 1); }
    else if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", " "].includes(event.key)) {
      if (event.key === " " && event.target.closest?.("button, summary")) return;
      event.preventDefault(); interruptNavigation();
      const dir = event.key === "ArrowUp" || event.key === "PageUp" || (event.key === " " && event.shiftKey) ? -1 : 1;
      viewer.scrollTop += dir * (event.key.startsWith("Arrow") ? 60 : viewer.clientHeight * .85);
    } else if (event.key === "Home") { event.preventDefault(); gotoPage(1); }
    else if (event.key === "End") { event.preventDefault(); gotoPage(doc.pages.length); }
    else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomBy(1.2); }
    else if (event.key === "-") { event.preventDefault(); zoomBy(1 / 1.2); }
    else if (event.key === "0") changeZoom("width");
    else if (event.key.toLowerCase() === "r") rotate();
  });
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const w = viewer.clientWidth, h = viewer.clientHeight;
      if (doc && (w !== lastViewerWidth || (mode === "page" && h !== lastViewerHeight))) {
        const a = anchor(); if (mode !== "custom") invalidate(); layout(a);
      }
      lastViewerWidth = w; lastViewerHeight = h; schedule();
    }, 120);
  }).observe(viewer);
  let dragDepth = 0;
  window.addEventListener("dragenter", event => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault(); dragDepth++; document.body.classList.add("dragging");
  });
  window.addEventListener("dragover", event => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("drop", event => {
    event.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging");
    openFile(event.dataTransfer?.files[0]);
  });
  window.addEventListener("pagehide", () => { dispose(doc); doc = null; loadingTask?.destroy().catch(() => {}); });
  controls();
  const query = new URLSearchParams(location.search), source = query.get("file") || query.get("pdf");
  // ★ 关闭握手：宿主会在 Close 时发 host.finalize；即使没有需要落盘的状态也要回执，避免恒定等 1.5s。
  const hostSession = query.get("sessionId") || "";
  window.chrome?.webview?.addEventListener("message", event => {
    const msg = event.data;
    if (!msg || msg.type !== "host.finalize") return;
    try {
      window.chrome.webview.postMessage({ type: "host.finalized", requestId: msg.requestId || "", sessionId: hostSession, ok: true, revision: 0 });
    } catch { }
  });
  if (source) {
    // URLSearchParams has already decoded name. A second decode breaks literal '%' names.
    let fallback = source.split("/").pop() || "PDF";
    try { fallback = decodeURIComponent(fallback); } catch { /* retain literal filename */ }
    openDocument(source, query.get("name") || fallback);
  }
})();
