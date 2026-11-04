// 風格濾鏡：素描 / 蠟筆 / 浮雕
// 輸入輸出都是 ImageData（RGBA），level 0~1 為強度。
// 所有半徑都依圖片大小縮放，所以預覽（小圖）和存檔（大圖）效果一致。

const PAPER = [246, 242, 233];

// 依座標產生 0~1 的固定亂數（同一位置永遠同一值）
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// 平滑的值雜訊
function valueNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function toGray(data, n) {
  const g = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }
  return g;
}

// 可分離的方框模糊（前綴和），三次近似高斯
function boxBlur(src, w, h, r) {
  if (r < 1) return src;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const pre = new Float32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + src[o + x];
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      tmp[o + x] = (pre[b + 1] - pre[a]) / (b - a + 1);
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
      out[y * w + x] = (pre[b + 1] - pre[a]) / (b - a + 1);
    }
  }
  return out;
}
const gaussian = (src, w, h, r) => boxBlur(boxBlur(boxBlur(src, w, h, r), w, h, r), w, h, r);

// 自動對比：把 1%~99% 的亮度拉到 0~255
function levels(gray, n) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[gray[i] | 0]++;
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255; lo++) { acc += hist[lo]; if (acc > n * 0.01) break; }
  acc = 0;
  for (; hi > 0; hi--) { acc += hist[hi]; if (acc > n * 0.01) break; }
  if (hi - lo < 16) return { lo: 0, k: 1 };
  return { lo, k: 255 / (hi - lo) };
}

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

// 紙張光線：把圖切成粗格子，取每格最亮的部分（通常是紙）當作當地光線，
// 再向鄰格擴張、平滑、內插回全圖。大面積塗色不會被誤當成紙。
function paperLight(gray, w, h) {
  const cell = Math.max(8, Math.ceil(Math.max(w, h) / 14));
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const grid = new Float32Array(gw * gh);
  const hist = new Uint32Array(256);
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      hist.fill(0);
      const x0 = cx * cell, y0 = cy * cell;
      const x1 = Math.min(w, x0 + cell), y1 = Math.min(h, y0 + cell);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[gray[y * w + x] | 0]++;
      const target = (x1 - x0) * (y1 - y0) * 0.05; // 第 95 百分位
      let v = 255, acc = 0;
      for (; v > 0; v--) { acc += hist[v]; if (acc >= target) break; }
      grid[cy * gw + cx] = v;
    }
  }
  // 向鄰格取最大值（塗滿顏色的格子借用旁邊紙張的亮度），再平滑兩次
  const dil = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < gw && yy < gh) m = Math.max(m, grid[yy * gw + xx]);
    }
    dil[y * gw + x] = m;
  }
  let g = dil;
  for (let pass = 0; pass < 2; pass++) {
    const t = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let sum = 0, cnt = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < gw && yy < gh) { sum += g[yy * gw + xx]; cnt++; }
      }
      t[y * gw + x] = sum / cnt;
    }
    g = t;
  }
  // 雙線性內插回全圖
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / cell - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / cell - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      const a = g[y0 * gw + x0] + (g[y0 * gw + x1] - g[y0 * gw + x0]) * tx;
      const b = g[y1 * gw + x0] + (g[y1 * gw + x1] - g[y1 * gw + x0]) * tx;
      out[y * w + x] = Math.max(60, a + (b - a) * ty);
    }
  }
  return out;
}

/* ---------------- 素描 ----------------
   經典鉛筆素描：灰階 + 反相模糊 + 色彩加亮（dodge），
   再加上紙張色調與鉛筆顆粒。 */
function sketch(src, level, unit) {
  const { width: w, height: h, data } = src;
  const n = w * h;
  const gray = toGray(data, n);
  const inv = new Float32Array(n);
  for (let i = 0; i < n; i++) inv[i] = 255 - gray[i];
  const blur = gaussian(inv, w, h, Math.max(1, Math.round(unit * (2 + level * 5))));
  const light = paperLight(gray, w, h);
  const out = new ImageData(w, h);
  const o = out.data;
  const contrast = 1.2 + level * 1.8;
  const period = Math.max(3, unit * 7);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      let v = Math.min(255, (gray[i] * 255) / Math.max(1, 255 - blur[i]));
      v = 255 - (255 - v) * contrast; // 加深線條
      // 排線陰影：依「相對於紙張」的暗度，暗處畫斜線，更暗處再交叉
      const tone = 1 - Math.min(1, gray[i] / Math.max(40, light[i] * 0.97));
      if (tone > 0.12) {
        const wob = valueNoise(x / (unit * 20), y / (unit * 20)) * 0.6;
        const a = ((x + y) / period + wob) % 1;
        const b = ((x - y + 1e6) / period + wob) % 1;
        const w1 = smooth(0.12, 0.75, tone) * 0.55;
        const w2 = smooth(0.4, 0.9, tone) * 0.5;
        const ink = (a < w1 ? 1 : 0) * 0.5 + (b < w2 ? 1 : 0) * 0.45;
        v *= 1 - ink * (0.45 + level * 0.4);
      }
      // 鉛筆顆粒：斜向細紋，只出現在有筆觸的地方
      const grain = valueNoise((x + y) / (unit * 0.9), (x - y) / (unit * 3.5)) - 0.5;
      v += grain * 40 * (1 - v / 255);
      v = clamp(v) / 255;
      const j = i * 4;
      // 石墨偏冷灰，紙張偏暖白
      o[j] = PAPER[0] * v + 38 * (1 - v);
      o[j + 1] = PAPER[1] * v + 40 * (1 - v);
      o[j + 2] = PAPER[2] * v + 46 * (1 - v);
      o[j + 3] = 255;
    }
  }
  return out;
}

/* ---------------- 蠟筆 ----------------
   色彩簡化 + 提高飽和度 + 蠟質斜向筆觸（紙紋露白）+ 邊緣加深 */
function crayon(src, level, unit) {
  const { width: w, height: h, data } = src;
  const n = w * h;
  const gray = toGray(data, n);
  const light = paperLight(gray, w, h);
  const soft = gaussian(gray, w, h, Math.max(1, Math.round(unit)));
  const out = new ImageData(w, h);
  const o = out.data;
  const steps = 6 - Math.round(level * 2); // 色階數：越強越簡化
  const sat = 1.35 + level * 0.6;
  const gap = 0.18 + level * 0.3; // 露白程度
  const edgeK = 0.5 + level * 0.9;
  const q = (v) => Math.round((v / 255) * (steps - 1)) * (255 / (steps - 1));
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const j = i * 4;
      // 攤平光線：紙張變白
      const f = Math.min(3, 240 / Math.max(40, light[i]));
      let r = clamp(data[j] * f), g = clamp(data[j + 1] * f), b = clamp(data[j + 2] * f);
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      // 只對真正有顏色的地方加飽和；紙張與鉛筆（低彩度）變中性
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const s2 = sat * smooth(12, 38, chroma);
      // 色彩簡化：只量化亮度，保留色相，避免出現色帶
      const dl = q(l) - l;
      r = clamp(l + (r - l) * s2 + dl); g = clamp(l + (g - l) * s2 + dl); b = clamp(l + (b - l) * s2 + dl);
      // 邊緣（Sobel）
      const xa = x > 0 ? i - 1 : i, xb = x < w - 1 ? i + 1 : i;
      const ya = y > 0 ? i - w : i, yb = y < h - 1 ? i + w : i;
      const gx = soft[xb] - soft[xa], gy = soft[yb] - soft[ya];
      const e = Math.min(1, Math.sqrt(gx * gx + gy * gy) / 60) * edgeK;
      r *= 1 - e * 0.75; g *= 1 - e * 0.75; b *= 1 - e * 0.75;
      // 蠟質筆觸：沿斜向拉長的雜訊 + 細顆粒，越亮的地方越容易露出紙張
      const stroke = valueNoise((x + y) / (unit * 2.2), (x - y) / (unit * 14));
      const fine = hash((x / Math.max(1, unit * 0.6)) | 0, (y / Math.max(1, unit * 0.6)) | 0);
      const t = stroke * 0.7 + fine * 0.3;
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const showPaper = t > 1 - gap * (0.4 + lum) ? 0.85 : 0;
      // 顏色印在紙上（白 → 紙色）
      r *= PAPER[0] / 255; g *= PAPER[1] / 255; b *= PAPER[2] / 255;
      o[j] = r + (PAPER[0] - r) * showPaper;
      o[j + 1] = g + (PAPER[1] - g) * showPaper;
      o[j + 2] = b + (PAPER[2] - b) * showPaper;
      o[j + 3] = 255;
    }
  }
  return out;
}

/* ---------------- 浮雕 ----------------
   以左上方光源計算高低差，呈現石膏 / 石雕質感 */
function emboss(src, level, unit) {
  const { width: w, height: h, data } = src;
  const n = w * h;
  const gray = toGray(data, n);
  const { lo, k } = levels(gray, n);
  for (let i = 0; i < n; i++) gray[i] = clamp((gray[i] - lo) * k);
  const g = gaussian(gray, w, h, Math.max(1, Math.round(unit * 0.8)));
  const d = Math.max(1, Math.round(unit * 1.5));
  const depth = 1.2 + level * 4.5;
  const out = new ImageData(w, h);
  const o = out.data;
  for (let y = 0, i = 0; y < h; y++) {
    const ya = Math.max(0, y - d) * w, yb = Math.min(h - 1, y + d) * w;
    for (let x = 0; x < w; x++, i++) {
      const xa = Math.max(0, x - d), xb = Math.min(w - 1, x + d);
      // 暗的筆觸視為凸起：左上亮、右下暗
      let v = 168 + (g[yb + xb] - g[ya + xa]) * depth;
      // 細微石材顆粒
      v += (hash(x, y) - 0.5) * 10;
      v = clamp(v);
      const j = i * 4;
      o[j] = clamp(v * 1.02);
      o[j + 1] = clamp(v * 0.99);
      o[j + 2] = clamp(v * 0.93);
      o[j + 3] = 255;
    }
  }
  return out;
}

export const STYLES = { sketch, crayon, emboss };

// unit：以 1200px 為基準的縮放倍數
export function applyStyle(imageData, style, level) {
  const unit = Math.max(imageData.width, imageData.height) / 1200;
  return STYLES[style](imageData, level, Math.max(0.35, unit));
}
