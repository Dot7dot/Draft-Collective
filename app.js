import * as db from './db.js';
import { applyStyle, lineMask, lineDiff, lineAlpha } from './filters.js';

const $ = (id) => document.getElementById(id);

const MAX_SIDE = 2400;   // 儲存時的最長邊
const THUMB_SIDE = 360;  // 縮圖最長邊

const state = {
  list: [],      // 依建立時間排序（新→舊）
  index: -1,     // 目前檢視中的畫作
  thumbURLs: [], // 畫冊縮圖的 object URL
  viewURL: null,
};

const current = () => state.list[state.index];

/* =========================================================
   工具
   ========================================================= */
const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}

// iOS 記憶體不足時 getContext 會回傳 null，這時要中止而不是存成空白圖
function ctx2d(c) {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  return ctx;
}

// bg：先鋪底色（讓透明的線稿變白底）
function drawScaled(src, maxSide, bg = null) {
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  try {
    const ctx = ctx2d(c);
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.drawImage(src, 0, 0, c.width, c.height);
  } catch (err) {
    releaseCanvas(c);
    throw err;
  }
  return c;
}

// iOS Safari 的 canvas 記憶體總量有限，用完立刻把尺寸設為 0 才會真正釋放
function releaseCanvas(c) {
  if (!c) return;
  c.width = 0;
  c.height = 0;
}

// 用 toDataURL 立即編碼：toBlob 在部分瀏覽器會等到「閒置時」才執行，
// 載入動畫進行中可能拖到好幾秒
async function toBlob(canvas, type, q) {
  const url = canvas.toDataURL(type, q);
  const comma = url.indexOf(',');
  if (comma < 0 || !url.startsWith('data:' + type)) throw new Error('encode failed');
  const bin = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function makeThumb(canvas) {
  const s = Math.min(1, THUMB_SIDE / Math.max(canvas.width, canvas.height));
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(canvas.width * s));
  t.height = Math.max(1, Math.round(canvas.height * s));
  let ctx;
  try {
    ctx = ctx2d(t);
  } catch (err) {
    releaseCanvas(t);
    throw err;
  }
  ctx.fillStyle = '#fff'; // 線稿透明處以白底顯示
  ctx.fillRect(0, 0, t.width, t.height);
  ctx.drawImage(canvas, 0, 0, t.width, t.height);
  try {
    return await toBlob(t, 'image/jpeg', 0.8);
  } finally {
    releaseCanvas(t);
  }
}

async function encodeRecord(canvas, kind) {
  const image = kind === 'lineart'
    ? await toBlob(canvas, 'image/png')
    : await toBlob(canvas, 'image/jpeg', 0.9);
  const thumb = await makeThumb(canvas);
  return { image, thumb, w: canvas.width, h: canvas.height };
}

let toastTimer;
function toast() {
  const t = $('toast');
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 800);
}

const busy = (on) => { $('busy').hidden = !on; };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/* =========================================================
   視圖切換（配合瀏覽器 / Android 返回鍵）
   ========================================================= */
let currentView = 'home';

function setView(name) {
  if (name === 'viewer' && !current()) name = state.list.length ? 'gallery' : 'home';
  const prev = currentView;
  currentView = name;
  // 離開編輯畫面時釋放大圖記憶體
  if (prev === 'crop' && name !== 'crop') releaseCrop();
  if (prev === 'lineart' && name !== 'lineart') releaseLine();
  if (prev === 'style' && name !== 'style') releaseStyle();
  if (prev === 'eraser' && name !== 'eraser') releaseEraser();
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === name));
  const theme = document.querySelector('meta[name="theme-color"]');
  const dark = $(name).classList.contains('dark');
  theme.content = dark ? '#121212' : getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();

  if (name === 'home') renderHome();
  if (name === 'gallery') renderGallery();
  if (name === 'viewer') renderViewer();
}

function go(name) {
  history.pushState({ view: name }, '');
  setView(name);
}

const back = () => history.back();

window.addEventListener('popstate', (e) => {
  $('confirm').hidden = true;
  if (currentView === 'note') saveNote();
  setView(e.state?.view || 'home');
});

document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', back));

/* =========================================================
   資料
   ========================================================= */
async function reload() {
  state.list = await db.all();
}

/* =========================================================
   首頁
   ========================================================= */
function renderHome() {
  const n = state.list.length;
  $('homeCount').hidden = n === 0;
  $('homeCount').textContent = n > 99 ? '99+' : String(n);
}

$('homeShoot').addEventListener('click', () => $('camInput').click());
$('galleryShoot').addEventListener('click', () => $('camInput').click());
$('importBtn').addEventListener('click', () => $('pickInput').click());
$('homeGallery').addEventListener('click', () => go('gallery'));

async function ingest(files, fromCamera) {
  if (!files.length) return;
  busy(true);
  let last = null;
  try {
    // 越早的檔案先存，讓最後一張排在最前面
    for (const file of files) {
      const img = await loadImage(file);
      const canvas = drawScaled(img, MAX_SIDE);
      let enc;
      try {
        enc = await encodeRecord(canvas, 'photo');
      } finally {
        releaseCanvas(canvas);
      }
      const now = Date.now();
      last = { id: uid(), created: now, updated: now, kind: 'photo', note: '', ...enc };
      await db.put(last);
      await new Promise((r) => setTimeout(r, 2)); // 保證時間戳不同
    }
    navigator.storage?.persist?.();
  } catch (err) {
    console.error(err);
  }
  await reload();
  busy(false);
  if (!last) return;

  state.index = state.list.findIndex((r) => r.id === last.id);
  if (fromCamera && files.length === 1) {
    // 拍完直接打開，方便立刻剪裁 / 寫筆記
    if (currentView === 'home') go('gallery');
    go('viewer');
  } else if (currentView === 'gallery') {
    renderGallery();
  } else {
    go('gallery');
  }
  toast();
}

$('camInput').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  ingest(files, true);
});
$('pickInput').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  ingest(files, false);
});

/* =========================================================
   畫冊
   ========================================================= */
function renderGallery() {
  state.thumbURLs.forEach((u) => URL.revokeObjectURL(u));
  state.thumbURLs = [];
  const grid = $('grid');
  grid.textContent = '';
  const frag = document.createDocumentFragment();
  state.list.forEach((rec, i) => {
    const b = document.createElement('button');
    b.className = 'tile';
    b.setAttribute('aria-label', new Date(rec.created).toLocaleString());
    const img = document.createElement('img');
    const url = URL.createObjectURL(rec.thumb);
    state.thumbURLs.push(url);
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    b.appendChild(img);
    if (rec.note?.trim()) b.insertAdjacentHTML('beforeend', '<i class="mk note"></i>');
    if (rec.style) b.insertAdjacentHTML('beforeend', '<i class="mk style"></i>');
    else if (rec.kind === 'lineart') b.insertAdjacentHTML('beforeend', '<i class="mk line"></i>');
    b.addEventListener('click', () => { state.index = i; go('viewer'); });
    frag.appendChild(b);
  });
  grid.appendChild(frag);
  $('empty').hidden = state.list.length > 0;
}

/* =========================================================
   檢視（左右滑動切換、雙擊 / 雙指縮放）
   ========================================================= */
const viewImg = $('viewImg');
const viewStage = $('viewStage');
const zoom = { s: 1, x: 0, y: 0 };

function applyZoom() {
  viewImg.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
}
function resetZoom() { zoom.s = 1; zoom.x = 0; zoom.y = 0; applyZoom(); }
function clampZoom() {
  const w = viewStage.clientWidth, h = viewStage.clientHeight;
  zoom.s = Math.min(6, Math.max(1, zoom.s));
  zoom.x = Math.min(0, Math.max(w * (1 - zoom.s), zoom.x));
  zoom.y = Math.min(0, Math.max(h * (1 - zoom.s), zoom.y));
}

function renderViewer() {
  const rec = current();
  if (!rec) return;
  if (state.viewURL) URL.revokeObjectURL(state.viewURL);
  state.viewURL = URL.createObjectURL(rec.image);
  viewImg.src = state.viewURL;
  viewStage.classList.toggle('paper', rec.kind === 'lineart');
  $('noteDot').hidden = !rec.note?.trim();
  resetZoom();
  renderPager();
}

function renderPager() {
  const n = state.list.length;
  const pager = $('pager');
  pager.textContent = '';
  if (n < 2) return;
  // 最多顯示 7 個點，代表目前位置
  const dots = Math.min(n, 7);
  const pos = n <= 7 ? state.index : Math.round((state.index / (n - 1)) * (dots - 1));
  for (let i = 0; i < dots; i++) {
    const d = document.createElement('i');
    if (i === pos) d.className = 'on';
    pager.appendChild(d);
  }
}

function step(dir) {
  const i = state.index + dir;
  if (i < 0 || i >= state.list.length) return;
  state.index = i;
  renderViewer();
}

(() => {
  const pts = new Map();
  let start = null;      // 單指起點
  let pinch = null;      // 雙指起始資訊
  let lastTap = 0;

  const local = (e) => {
    const r = viewStage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  viewStage.addEventListener('pointerdown', (e) => {
    viewStage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, local(e));
    if (pts.size === 1) {
      start = { ...local(e), zx: zoom.x, zy: zoom.y, t: Date.now(), moved: false };
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = {
        d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
        s: zoom.s, x: zoom.x, y: zoom.y,
      };
      start = null;
    }
  });

  viewStage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, local(e));
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const s = Math.min(6, Math.max(1, pinch.s * (d / pinch.d)));
      zoom.x = mx - (pinch.mx - pinch.x) * (s / pinch.s);
      zoom.y = my - (pinch.my - pinch.y) * (s / pinch.s);
      zoom.s = s;
      clampZoom();
      applyZoom();
    } else if (start) {
      const p = pts.get(e.pointerId);
      const dx = p.x - start.x, dy = p.y - start.y;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) start.moved = true;
      if (zoom.s > 1) {
        zoom.x = start.zx + dx;
        zoom.y = start.zy + dy;
        clampZoom();
        applyZoom();
      } else {
        viewImg.style.transform = `translateX(${dx * 0.6}px)`;
      }
    }
  });

  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (pinch) {
      if (pts.size < 2) pinch = null;
      if (zoom.s < 1.05) resetZoom();
      return;
    }
    if (!start) return;
    const dx = p.x - start.x, dy = p.y - start.y;
    if (!start.moved) {
      // 雙擊縮放
      const now = Date.now();
      if (now - lastTap < 300) {
        if (zoom.s > 1) resetZoom();
        else {
          zoom.s = 2.5;
          zoom.x = p.x - p.x * 2.5;
          zoom.y = p.y - p.y * 2.5;
          clampZoom();
          applyZoom();
        }
        lastTap = 0;
      } else lastTap = now;
    } else if (zoom.s === 1) {
      applyZoom();
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.2) step(dx < 0 ? 1 : -1);
    }
    start = null;
  };
  viewStage.addEventListener('pointerup', end);
  viewStage.addEventListener('pointercancel', end);
})();

window.addEventListener('resize', () => {
  if (currentView === 'viewer') { resetZoom(); }
  if (currentView === 'crop') layoutCrop(true);
  if (currentView === 'eraser') layoutEraser();
});

/* ---------- 分享 / 儲存 ---------- */
$('tShare').addEventListener('click', async () => {
  const rec = current();
  if (!rec) return;
  const ext = rec.kind === 'lineart' ? 'png' : 'jpg';
  const d = new Date(rec.created);
  const pad = (n) => String(n).padStart(2, '0');
  const name = `draft-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${rec.style ? '-' + rec.style : rec.kind === 'lineart' ? '-line' : ''}.${ext}`;
  const file = new File([rec.image], name, { type: rec.image.type });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text: rec.note || undefined });
      return;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

/* ---------- 刪除 ---------- */
let confirmURL = null;
$('tDelete').addEventListener('click', () => {
  const rec = current();
  if (!rec) return;
  if (confirmURL) URL.revokeObjectURL(confirmURL);
  confirmURL = URL.createObjectURL(rec.thumb);
  $('confirmThumb').src = confirmURL;
  $('confirm').hidden = false;
});
$('confirmNo').addEventListener('click', () => { $('confirm').hidden = true; });
$('confirm').addEventListener('click', (e) => { if (e.target === $('confirm')) $('confirm').hidden = true; });
$('confirmYes').addEventListener('click', async () => {
  $('confirm').hidden = true;
  const rec = current();
  if (!rec) return;
  await db.remove(rec.id);
  await reload();
  if (state.list.length) {
    state.index = Math.min(state.index, state.list.length - 1);
    renderViewer();
  } else {
    state.index = -1;
    back();
  }
});

/* =========================================================
   筆記
   ========================================================= */
let noteThumbURL = null;
let noteTimer = null;

$('tNote').addEventListener('click', () => {
  const rec = current();
  if (!rec) return;
  if (noteThumbURL) URL.revokeObjectURL(noteThumbURL);
  noteThumbURL = URL.createObjectURL(rec.thumb);
  $('noteThumb').src = noteThumbURL;
  $('noteText').value = rec.note || '';
  go('note');
  // 讓鍵盤自動彈出
  setTimeout(() => $('noteText').focus(), 50);
});

async function saveNote() {
  clearTimeout(noteTimer);
  const rec = current();
  if (!rec) return;
  const text = $('noteText').value;
  if (text === (rec.note || '')) return;
  rec.note = text;
  rec.updated = Date.now();
  await db.put(rec);
}

$('noteText').addEventListener('input', () => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(saveNote, 400);
});
$('noteText').addEventListener('blur', saveNote);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNote(); });

/* =========================================================
   剪裁
   顯示用 <img> + CSS 旋轉，不建立全尺寸 canvas；
   只有按下完成時才建立一張輸出 canvas，用完立刻釋放。
   （iOS Safari 的 canvas 記憶體有上限，用滿後新的 canvas 會變成黑畫面）
   ========================================================= */
const cropImgEl = $('cropImg');
const cropRect = $('cropRect');
const cropBox = $('cropBox');
const crop = { scale: 1, dw: 0, dh: 0, x: 0, y: 0, w: 0, h: 0, rot: 0, iw: 0, ih: 0 };

// 旋轉後的原圖尺寸
const cropSize = () => (crop.rot % 2 ? { w: crop.ih, h: crop.iw } : { w: crop.iw, h: crop.ih });

$('tCrop').addEventListener('click', async () => {
  const rec = current();
  if (!rec || !state.viewURL) return;
  crop.iw = crop.ih = crop.rot = 0;
  cropRect.hidden = true;
  go('crop');
  // 使用檢視畫面已經顯示的同一張圖（已解碼，不另外佔記憶體）
  try {
    await new Promise((resolve, reject) => {
      cropImgEl.onload = resolve;
      cropImgEl.onerror = reject;
      cropImgEl.src = state.viewURL;
      if (cropImgEl.complete && cropImgEl.naturalWidth) resolve();
    });
  } catch (err) {
    console.error(err);
    if (currentView === 'crop') back();
    return;
  }
  if (currentView !== 'crop') return;
  crop.iw = cropImgEl.naturalWidth;
  crop.ih = cropImgEl.naturalHeight;
  cropRect.hidden = false;
  layoutCrop(false);
});

function releaseCrop() {
  crop.iw = crop.ih = 0;
  cropImgEl.onload = cropImgEl.onerror = null;
  cropImgEl.removeAttribute('src'); // 圖片網址屬於檢視畫面，不在這裡回收
}

function layoutCrop(keepRect) {
  if (!crop.iw) return;
  const stage = $('cropStage');
  const cs = getComputedStyle(stage);
  const aw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const old = { ...crop };
  const { w, h } = cropSize();
  const scale = Math.min(aw / w, ah / h);
  crop.scale = scale;
  crop.dw = Math.round(w * scale);
  crop.dh = Math.round(h * scale);

  cropBox.style.width = crop.dw + 'px';
  cropBox.style.height = crop.dh + 'px';
  // 圖片本身以未旋轉的尺寸擺在中央，再用 CSS 旋轉
  cropImgEl.style.width = Math.round(crop.iw * scale) + 'px';
  cropImgEl.style.height = Math.round(crop.ih * scale) + 'px';
  cropImgEl.style.transform = `translate(-50%, -50%) rotate(${crop.rot * 90}deg)`;

  if (keepRect && old.dw) {
    const k = crop.dw / old.dw;
    Object.assign(crop, { x: old.x * k, y: old.y * k, w: old.w * k, h: old.h * k });
  } else {
    Object.assign(crop, { x: 0, y: 0, w: crop.dw, h: crop.dh });
  }
  drawCropRect();
}

function drawCropRect() {
  Object.assign(cropRect.style, {
    left: crop.x + 'px', top: crop.y + 'px', width: crop.w + 'px', height: crop.h + 'px',
  });
}

(() => {
  const MIN = 40;
  let drag = null;
  const pos = (e) => {
    const r = cropBox.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  $('cropStage').addEventListener('pointerdown', (e) => {
    const p = pos(e);
    const handle = e.target.closest('.h')?.dataset.h;
    let mode = handle;
    if (!mode) {
      const inside = p.x >= crop.x && p.x <= crop.x + crop.w && p.y >= crop.y && p.y <= crop.y + crop.h;
      if (inside) mode = 'move';
      else {
        // 點選最近的角
        const cx = p.x < crop.x + crop.w / 2 ? 'w' : 'e';
        const cy = p.y < crop.y + crop.h / 2 ? 'n' : 's';
        mode = cy + cx;
      }
    }
    drag = { mode, p, r: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } };
    $('cropStage').setPointerCapture(e.pointerId);
  });

  $('cropStage').addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pos(e);
    const dx = p.x - drag.p.x, dy = p.y - drag.p.y;
    const r = drag.r;
    let { x, y, w, h } = r;
    if (drag.mode === 'move') {
      x = Math.min(crop.dw - w, Math.max(0, r.x + dx));
      y = Math.min(crop.dh - h, Math.max(0, r.y + dy));
    } else {
      let x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
      if (drag.mode.includes('w')) x1 = Math.min(x2 - MIN, Math.max(0, r.x + dx));
      if (drag.mode.includes('e')) x2 = Math.max(x1 + MIN, Math.min(crop.dw, r.x + r.w + dx));
      if (drag.mode.includes('n')) y1 = Math.min(y2 - MIN, Math.max(0, r.y + dy));
      if (drag.mode.includes('s')) y2 = Math.max(y1 + MIN, Math.min(crop.dh, r.y + r.h + dy));
      x = x1; y = y1; w = x2 - x1; h = y2 - y1;
    }
    Object.assign(crop, { x, y, w, h });
    drawCropRect();
  });

  const stop = () => { drag = null; };
  $('cropStage').addEventListener('pointerup', stop);
  $('cropStage').addEventListener('pointercancel', stop);
})();

$('cropRotate').addEventListener('click', () => {
  if (!crop.iw) return;
  crop.rot = (crop.rot + 1) % 4;
  layoutCrop(false);
});

$('cropOk').addEventListener('click', async () => {
  const rec = current();
  if (!rec || !crop.iw) return;
  const s = crop.scale;
  const full = cropSize();
  const sx = Math.max(0, Math.round(crop.x / s));
  const sy = Math.max(0, Math.round(crop.y / s));
  const sw = Math.max(1, Math.min(full.w - sx, Math.round(crop.w / s)));
  const sh = Math.max(1, Math.min(full.h - sy, Math.round(crop.h / s)));
  const untouched = crop.rot === 0 && sx === 0 && sy === 0 && sw === full.w && sh === full.h;
  if (untouched) { back(); return; }

  busy(true);
  await nextFrame();
  const out = document.createElement('canvas');
  try {
    out.width = sw;
    out.height = sh;
    const ctx = ctx2d(out);
    // 把旋轉後的整張圖往左上平移，canvas 自然只留下剪裁範圍
    ctx.translate(-sx, -sy);
    ctx.translate(full.w / 2, full.h / 2);
    ctx.rotate((crop.rot * Math.PI) / 2);
    ctx.drawImage(cropImgEl, -crop.iw / 2, -crop.ih / 2, crop.iw, crop.ih);
    Object.assign(rec, await encodeRecord(out, rec.kind), { updated: Date.now() });
    await db.put(rec);
  } catch (err) {
    console.error(err);
    busy(false);
    return;
  } finally {
    releaseCanvas(out);
  }
  busy(false);
  back();
  toast();
});

/* =========================================================
   提取去背線稿
   自適應閾值：每個像素和周圍區域的平均亮度比較，
   比周圍暗的部分視為線條，其餘（紙張、陰影、光線不均）變透明。
   ========================================================= */
const lineCanvas = $('lineCanvas');
const line = { w: 0, h: 0, diff: null, out: null, bg: 0 };
const BG_CLASSES = ['', 'bg-white', 'bg-dark'];

$('tLine').addEventListener('click', async () => {
  const rec = current();
  if (!rec) return;
  busy(true);
  await nextFrame();
  try {
    const img = await loadImage(rec.image);
    const src = drawScaled(img, MAX_SIDE);
    try {
      prepareLineart(src);
    } finally {
      releaseCanvas(src);
    }
    lineCanvas.width = line.w;
    lineCanvas.height = line.h;
    line.out = ctx2d(lineCanvas).createImageData(line.w, line.h);
    renderLineart();
    go('lineart');
  } catch (err) {
    console.error(err);
    releaseLine();
  } finally {
    busy(false);
  }
});

function releaseLine() {
  cancelAnimationFrame(lineRAF);
  line.diff = null;
  line.out = null;
  releaseCanvas(lineCanvas);
}

function prepareLineart(src) {
  const w = src.width, h = src.height;
  const data = ctx2d(src).getImageData(0, 0, w, h).data;
  Object.assign(line, { w, h, diff: lineDiff(data, w, h) });
}

function renderLineart() {
  if (!line.diff || !line.out) return;
  const level = Number($('lineLevel').value) / 100; // 0=淡 1=濃
  const { diff } = line;
  const out = line.out.data;
  for (let i = 0, j = 0; i < diff.length; i++, j += 4) {
    out[j] = 18; out[j + 1] = 18; out[j + 2] = 18; out[j + 3] = lineAlpha(diff[i], level);
  }
  lineCanvas.getContext('2d').putImageData(line.out, 0, 0);
}

let lineRAF = 0;
$('lineLevel').addEventListener('input', () => {
  cancelAnimationFrame(lineRAF);
  lineRAF = requestAnimationFrame(renderLineart);
});

$('lineBg').addEventListener('click', () => {
  const stage = $('lineStage');
  BG_CLASSES.forEach((c) => c && stage.classList.remove(c));
  line.bg = (line.bg + 1) % BG_CLASSES.length;
  if (BG_CLASSES[line.bg]) stage.classList.add(BG_CLASSES[line.bg]);
});

$('lineOk').addEventListener('click', async () => {
  const rec = current();
  if (!rec || !line.diff) return;
  busy(true);
  await nextFrame();
  const enc = await encodeRecord(lineCanvas, 'lineart');
  const now = Date.now();
  const created = { id: uid(), created: now, updated: now, kind: 'lineart', note: rec.note || '', source: rec.id, ...enc };
  await db.put(created);
  await reload();
  state.index = state.list.findIndex((r) => r.id === created.id);
  busy(false);
  back(); // 返回時 setView 會呼叫 releaseLine()
  toast();
});

/* =========================================================
   橡皮擦
   單指擦除、雙指縮放移動；記錄每一筆，復原時從原圖重畫。
   線稿（透明 PNG）擦成透明；照片擦成附近的紙張顏色。
   ========================================================= */
const eraseStage = $('eraseStage');
const eraseWrap = $('eraseWrap');
const eraseCanvas = $('eraseCanvas');
const brushEl = $('brush');
const er = {
  img: null, transparent: false, paper: null, pattern: null,
  strokes: [], cur: null,
  fit: 1, ox: 0, oy: 0, z: 1, px: 0, py: 0, dw: 0, dh: 0,
};
const brushPx = () => Number($('eraseSize').value); // 螢幕上的直徑

$('tErase').addEventListener('click', async () => {
  const rec = current();
  if (!rec) return;
  busy(true);
  await nextFrame();
  try {
    const img = await loadImage(rec.image);
    eraseCanvas.width = img.naturalWidth;
    eraseCanvas.height = img.naturalHeight;
    const ctx = ctx2d(eraseCanvas);
    ctx.drawImage(img, 0, 0);
    er.img = img;
    er.transparent = rec.kind === 'lineart';
    er.strokes = [];
    er.cur = null;
    if (!er.transparent) {
      er.paper = paperCanvas(img);
      er.pattern = ctx.createPattern(er.paper, 'no-repeat');
      er.pattern.setTransform(new DOMMatrix().scale(img.naturalWidth / er.paper.width, img.naturalHeight / er.paper.height));
    }
    updateUndo();
    go('eraser');
    layoutEraser();
  } catch (err) {
    console.error(err);
    releaseEraser();
  } finally {
    busy(false);
  }
});

// 估計每個位置的紙張顏色：縮成小圖，每點取附近最亮的顏色（把線條「撐」掉）
function paperCanvas(img) {
  const k = 20;
  const sw = Math.max(2, Math.round(img.naturalWidth / k));
  const sh = Math.max(2, Math.round(img.naturalHeight / k));
  const c = document.createElement('canvas');
  c.width = sw;
  c.height = sh;
  const ctx = ctx2d(c);
  ctx.drawImage(img, 0, 0, sw, sh);
  const src = ctx.getImageData(0, 0, sw, sh);
  const out = ctx.createImageData(sw, sh);
  const s = src.data, o = out.data, R = 2;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let best = -1, bi = 0;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= sh) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= sw) continue;
          const j = (yy * sw + xx) * 4;
          const l = s[j] * 0.299 + s[j + 1] * 0.587 + s[j + 2] * 0.114;
          if (l > best) { best = l; bi = j; }
        }
      }
      const j = (y * sw + x) * 4;
      o[j] = s[bi]; o[j + 1] = s[bi + 1]; o[j + 2] = s[bi + 2]; o[j + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

function layoutEraser() {
  if (!er.img) return;
  const W = eraseStage.clientWidth, H = eraseStage.clientHeight;
  const cw = eraseCanvas.width, ch = eraseCanvas.height;
  er.fit = Math.min((W - 24) / cw, (H - 24) / ch);
  er.dw = cw * er.fit;
  er.dh = ch * er.fit;
  er.ox = (W - er.dw) / 2;
  er.oy = (H - er.dh) / 2;
  er.z = 1; er.px = 0; er.py = 0;
  eraseWrap.style.width = er.dw + 'px';
  eraseWrap.style.height = er.dh + 'px';
  applyEraseView();
}

function applyEraseView() {
  eraseWrap.style.transform = `translate(${er.ox + er.px}px, ${er.oy + er.py}px) scale(${er.z})`;
}

// 螢幕座標（相對於 stage）→ 圖片座標
function toImage(p) {
  const k = er.z * er.fit;
  return { x: (p.x - er.ox - er.px) / k, y: (p.y - er.oy - er.py) / k };
}

function paint(ctx, stroke, from = 0) {
  const pts = stroke.pts;
  ctx.save();
  if (er.transparent) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = ctx.fillStyle = '#000';
  } else {
    ctx.strokeStyle = ctx.fillStyle = er.pattern;
  }
  ctx.lineWidth = stroke.r * 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, stroke.r, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    const a = Math.max(0, from - 1);
    ctx.moveTo(pts[a].x, pts[a].y);
    for (let i = a + 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  ctx.restore();
}

function redrawEraser() {
  const ctx = ctx2d(eraseCanvas);
  ctx.clearRect(0, 0, eraseCanvas.width, eraseCanvas.height);
  ctx.drawImage(er.img, 0, 0);
  er.strokes.forEach((s) => paint(ctx, s));
}

function updateUndo() {
  $('eraseUndo').disabled = er.strokes.length === 0;
}

function showBrush(p, size) {
  brushEl.hidden = false;
  brushEl.style.width = brushEl.style.height = size + 'px';
  brushEl.style.transform = `translate(${p.x - size / 2}px, ${p.y - size / 2}px)`;
}
let brushTimer = 0;
function hideBrush(delay = 0) {
  clearTimeout(brushTimer);
  brushTimer = setTimeout(() => { brushEl.hidden = true; }, delay);
}

(() => {
  const pts = new Map();
  let pinch = null;
  let locked = false; // 雙指手勢後，直到全部放開前不擦
  const local = (e) => {
    const r = eraseStage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  eraseStage.addEventListener('pointerdown', (e) => {
    if (!er.img) return;
    eraseStage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, local(e));
    if (pts.size === 1 && !locked) {
      const p = local(e);
      const ip = toImage(p);
      er.cur = { r: brushPx() / 2 / (er.z * er.fit), pts: [ip], t: Date.now() };
      paint(ctx2d(eraseCanvas), er.cur);
      clearTimeout(brushTimer);
      showBrush(p, brushPx());
    } else if (pts.size === 2) {
      // 雙指：取消剛開始的那一筆，改成縮放
      if (er.cur) {
        if (er.cur.pts.length < 6 && Date.now() - er.cur.t < 300) {
          er.cur = null;
          redrawEraser();
        } else {
          er.strokes.push(er.cur);
          er.cur = null;
          updateUndo();
        }
      }
      hideBrush();
      locked = true;
      const [a, b] = [...pts.values()];
      pinch = {
        d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
        z: er.z, px: er.px, py: er.py,
      };
    }
  });

  eraseStage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    pts.set(e.pointerId, p);
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const z = Math.min(8, Math.max(1, pinch.z * (d / pinch.d)));
      // 讓雙指中心點下的位置保持不動
      const bx = er.ox + pinch.px, by = er.oy + pinch.py;
      const nbx = mx - (pinch.mx - bx) * (z / pinch.z);
      const nby = my - (pinch.my - by) * (z / pinch.z);
      er.z = z;
      er.px = nbx - er.ox;
      er.py = nby - er.oy;
      applyEraseView();
    } else if (er.cur) {
      er.cur.pts.push(toImage(p));
      paint(ctx2d(eraseCanvas), er.cur, er.cur.pts.length - 1);
      showBrush(p, brushPx());
    }
  });

  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (er.cur && pts.size === 0) {
      er.strokes.push(er.cur);
      er.cur = null;
      updateUndo();
    }
    if (pts.size === 0) {
      locked = false;
      if (er.z < 1.03) { er.z = 1; er.px = 0; er.py = 0; applyEraseView(); }
      hideBrush(120);
    }
  };
  eraseStage.addEventListener('pointerup', end);
  eraseStage.addEventListener('pointercancel', end);
})();

$('eraseSize').addEventListener('input', () => {
  // 在畫面中央預覽筆刷大小
  showBrush({ x: eraseStage.clientWidth / 2, y: eraseStage.clientHeight / 2 }, brushPx());
  hideBrush(700);
});

$('eraseUndo').addEventListener('click', () => {
  if (!er.strokes.length) return;
  er.strokes.pop();
  redrawEraser();
  updateUndo();
});

$('eraseOk').addEventListener('click', async () => {
  const rec = current();
  if (!rec || !er.img) return;
  if (!er.strokes.length) { back(); return; }
  busy(true);
  await nextFrame();
  try {
    Object.assign(rec, await encodeRecord(eraseCanvas, rec.kind), { updated: Date.now() });
    await db.put(rec);
  } catch (err) {
    console.error(err);
    busy(false);
    return;
  }
  busy(false);
  back(); // 返回時 setView 會呼叫 releaseEraser()
  toast();
});

function releaseEraser() {
  er.img = null;
  er.pattern = null;
  releaseCanvas(er.paper);
  er.paper = null;
  er.strokes = [];
  er.cur = null;
  brushEl.hidden = true;
  releaseCanvas(eraseCanvas);
}

/* =========================================================
   風格：素描 / 蠟筆 / 麥克筆 / 浮雕
   以線條為對象：線稿檔直接用它的線；照片先自動提取線條。
   預覽用 1200px 小圖即時計算；按 ✓ 時才用原尺寸計算，
   存成新的一張透明背景線稿（原圖保留）。
   ========================================================= */
const styleCanvas = $('styleCanvas');
const sty = { img: null, mask: null, w: 0, h: 0, isLine: false, style: 'sketch', raf: 0 };

// 讀出線條遮罩：線稿保留透明度，照片鋪白底後提取線條
function maskOf(img, maxSide, isLine) {
  const c = drawScaled(img, maxSide, isLine ? null : '#fff');
  try {
    const id = ctx2d(c).getImageData(0, 0, c.width, c.height);
    return { mask: lineMask(id, isLine), w: c.width, h: c.height };
  } finally {
    releaseCanvas(c);
  }
}
const PREVIEW_SIDE = 1200;
const styleLevel = () => Number($('styleLevel').value) / 100;

$('tStyle').addEventListener('click', async () => {
  const rec = current();
  if (!rec) return;
  busy(true);
  await nextFrame();
  try {
    const img = await loadImage(rec.image);
    sty.isLine = rec.kind === 'lineart';
    Object.assign(sty, maskOf(img, PREVIEW_SIDE, sty.isLine));
    sty.img = img;
    styleCanvas.width = sty.w;
    styleCanvas.height = sty.h;
    renderStyle();
    go('style');
  } catch (err) {
    console.error(err);
    releaseStyle();
  } finally {
    busy(false);
  }
});

function renderStyle() {
  if (!sty.mask) return;
  try {
    ctx2d(styleCanvas).putImageData(applyStyle(sty.mask, sty.w, sty.h, sty.style, styleLevel()), 0, 0);
  } catch (err) {
    console.error(err);
  }
}

function scheduleStyle() {
  cancelAnimationFrame(sty.raf);
  sty.raf = requestAnimationFrame(renderStyle);
}

function releaseStyle() {
  cancelAnimationFrame(sty.raf);
  sty.mask = null;
  sty.img = null;
  releaseCanvas(styleCanvas);
}

$('styleChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip || chip.dataset.style === sty.style) return;
  sty.style = chip.dataset.style;
  document.querySelectorAll('#styleChips .chip').forEach((c) => c.classList.toggle('on', c === chip));
  scheduleStyle();
});
$('styleLevel').addEventListener('input', scheduleStyle);

$('styleOk').addEventListener('click', async () => {
  const rec = current();
  if (!rec || !sty.img) return;
  busy(true);
  await nextFrame();
  let enc;
  let c = null;
  try {
    const full = maskOf(sty.img, MAX_SIDE, sty.isLine);
    c = document.createElement('canvas');
    c.width = full.w;
    c.height = full.h;
    ctx2d(c).putImageData(applyStyle(full.mask, full.w, full.h, sty.style, styleLevel()), 0, 0);
    enc = await encodeRecord(c, 'lineart');
  } catch (err) {
    console.error(err);
    busy(false);
    return;
  } finally {
    releaseCanvas(c);
  }
  const now = Date.now();
  const created = {
    id: uid(), created: now, updated: now, kind: 'lineart', style: sty.style,
    note: rec.note || '', source: rec.id, ...enc,
  };
  await db.put(created);
  await reload();
  state.index = state.list.findIndex((r) => r.id === created.id);
  busy(false);
  back(); // 返回時 setView 會呼叫 releaseStyle()
  toast();
});

/* =========================================================
   啟動
   ========================================================= */
(async () => {
  history.replaceState({ view: 'home' }, '');
  await reload();
  setView('home');
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // 有新版本接手時自動重新整理，避免手機一直停在舊版
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      if (currentView === 'home' || currentView === 'gallery') location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((reg) => reg.update())
      .catch(() => {});
  }
})();
