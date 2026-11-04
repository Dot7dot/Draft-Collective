import * as db from './db.js';

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

function drawScaled(src, maxSide, w = src.naturalWidth || src.width, h = src.naturalHeight || src.height) {
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// iOS Safari 的 canvas 記憶體總量有限，用完立刻把尺寸設為 0 才會真正釋放
function releaseCanvas(c) {
  if (!c) return;
  c.width = 0;
  c.height = 0;
}

const toBlob = (canvas, type, q) =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, q));

async function makeThumb(canvas) {
  const s = Math.min(1, THUMB_SIDE / Math.max(canvas.width, canvas.height));
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(canvas.width * s));
  t.height = Math.max(1, Math.round(canvas.height * s));
  const ctx = t.getContext('2d');
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
    if (rec.kind === 'lineart') b.insertAdjacentHTML('beforeend', '<i class="mk line"></i>');
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
});

/* ---------- 分享 / 儲存 ---------- */
$('tShare').addEventListener('click', async () => {
  const rec = current();
  if (!rec) return;
  const ext = rec.kind === 'lineart' ? 'png' : 'jpg';
  const d = new Date(rec.created);
  const pad = (n) => String(n).padStart(2, '0');
  const name = `draft-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${rec.kind === 'lineart' ? '-line' : ''}.${ext}`;
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
let cropURL = null;

// 旋轉後的原圖尺寸
const cropSize = () => (crop.rot % 2 ? { w: crop.ih, h: crop.iw } : { w: crop.iw, h: crop.ih });

$('tCrop').addEventListener('click', async () => {
  const rec = current();
  if (!rec) return;
  busy(true);
  try {
    if (cropURL) URL.revokeObjectURL(cropURL);
    cropURL = URL.createObjectURL(rec.image);
    cropImgEl.src = cropURL;
    await cropImgEl.decode();
    crop.iw = cropImgEl.naturalWidth;
    crop.ih = cropImgEl.naturalHeight;
    crop.rot = 0;
  } catch (err) {
    console.error(err);
    busy(false);
    return;
  }
  busy(false);
  go('crop');
  layoutCrop(false);
});

function releaseCrop() {
  crop.iw = crop.ih = 0;
  cropImgEl.removeAttribute('src');
  if (cropURL) URL.revokeObjectURL(cropURL);
  cropURL = null;
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
    const ctx = out.getContext('2d');
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
    line.out = lineCanvas.getContext('2d').createImageData(line.w, line.h);
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
  const w = src.width, h = src.height, n = w * h;
  const data = src.getContext('2d').getImageData(0, 0, w, h).data;

  // 灰階（若有透明則視為白紙）
  const gray = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = data[j + 3] / 255;
    const g = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    gray[i] = g * a + 255 * (1 - a);
  }

  // 輕微模糊去除雜訊（3x3）
  const soft = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1) * w, y1 = y * w, y2 = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1), x2 = Math.min(w - 1, x + 1);
      soft[y1 + x] = (
        gray[y0 + x0] + gray[y0 + x] + gray[y0 + x2] +
        gray[y1 + x0] + gray[y1 + x] * 2 + gray[y1 + x2] +
        gray[y2 + x0] + gray[y2 + x] + gray[y2 + x2]
      ) / 10;
    }
  }

  // 積分圖求區域平均
  const W = w + 1;
  const integral = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integral[(y + 1) * W + x + 1] = integral[y * W + x + 1] + row;
    }
  }

  const r = Math.max(8, Math.round(Math.min(w, h) / 30));
  const diff = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r), yb = Math.min(h - 1, y + r) + 1;
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r), xb = Math.min(w - 1, x + r) + 1;
      const sum = integral[yb * W + xb] - integral[ya * W + xb] - integral[yb * W + xa] + integral[ya * W + xa];
      const mean = sum / ((xb - xa) * (yb - ya));
      // 相對於周圍亮度的暗度（0~1），在亮紙上更敏感
      diff[y * w + x] = (mean - soft[y * w + x]) / Math.max(40, mean);
    }
  }

  Object.assign(line, { w, h, diff });
}

function renderLineart() {
  if (!line.diff || !line.out) return;
  const level = Number($('lineLevel').value) / 100; // 0=淡 1=濃
  const t = 0.30 - level * 0.27;  // 閾值
  const ramp = 0.10 + level * 0.06;
  const { diff } = line;
  const out = line.out.data;
  for (let i = 0, j = 0; i < diff.length; i++, j += 4) {
    let a = (diff[i] - t) / ramp;
    a = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(Math.sqrt(a) * 255);
    out[j] = 18; out[j + 1] = 18; out[j + 2] = 18; out[j + 3] = a;
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
   啟動
   ========================================================= */
(async () => {
  history.replaceState({ view: 'home' }, '');
  await reload();
  setView('home');
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
