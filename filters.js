// 線稿與風格濾鏡
// 風格都以「線條」為對象：線稿檔直接用它的線，照片先自動提取線條。
// 輸出為透明背景的 ImageData。level 0~1 為強度；
// 所有尺寸都依圖片大小縮放，所以預覽（小圖）和存檔（大圖）效果一致。

/* ---------------- 基本工具 ---------------- */

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

const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

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

// 1D 滑動最大值（單調佇列，O(n)）
function slideMax(src, out, start, stride, len, r, q) {
  let head = 0, tail = 0;
  for (let i = 0, add = 0; i < len; i++) {
    // 把視窗右端 i + r 加進佇列
    for (; add <= Math.min(len - 1, i + r); add++) {
      const v = src[start + add * stride];
      while (tail > head && src[start + q[tail - 1] * stride] <= v) tail--;
      q[tail++] = add;
    }
    while (q[head] < i - r) head++;
    out[start + i * stride] = src[start + q[head] * stride];
  }
}

// 膨脹（把線條變粗）：方形最大值濾波
function dilate(src, w, h, r) {
  if (r < 1) return src;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const q = new Int32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) slideMax(src, tmp, y * w, 1, w, r, q);
  for (let x = 0; x < w; x++) slideMax(tmp, out, x, w, h, r, q);
  return out;
}

// 十字形（菱形）膨脹一格
function cross(src, out, w, h) {
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      let v = src[i];
      if (x > 0 && src[i - 1] > v) v = src[i - 1];
      if (x < w - 1 && src[i + 1] > v) v = src[i + 1];
      if (y > 0 && src[i - w] > v) v = src[i - w];
      if (y < h - 1 && src[i + w] > v) v = src[i + w];
      out[i] = v;
    }
  }
}

// 接近圓形的膨脹：方形 + 菱形 = 八角形，線頭與轉角才會圓
function dilateRound(src, w, h, r) {
  const s = Math.round(r / 2.414);
  const d = Math.round(r * 0.586);
  let a = s > 0 ? dilate(src, w, h, s) : Float32Array.from(src);
  if (d > 0) {
    let b = new Float32Array(w * h);
    for (let k = 0; k < d; k++) { cross(a, b, w, h); [a, b] = [b, a]; }
  }
  return a;
}

/* ---------------- 線稿提取 ----------------
   自適應閾值：每個像素和周圍區域的平均亮度比較，
   比周圍暗的部分視為線條，其餘（紙張、陰影、光線不均）變透明。 */

// 回傳每個像素「比周圍暗多少」（0~1）
export function lineDiff(data, w, h) {
  const n = w * h;
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
      // 相對於周圍亮度的暗度，在亮紙上更敏感
      diff[y * w + x] = (mean - soft[y * w + x]) / Math.max(40, mean);
    }
  }
  return diff;
}

// 暗度 → 線條不透明度（0~255）。level 0=淡 1=濃
export function lineAlpha(d, level) {
  const t = 0.30 - level * 0.27;
  const ramp = 0.10 + level * 0.06;
  const a = (d - t) / ramp;
  return a <= 0 ? 0 : a >= 1 ? 255 : Math.round(Math.sqrt(a) * 255);
}

// 取得線條遮罩（0~1）：線稿檔用透明度；照片先自動提取線條
export function lineMask(imageData, isLineart) {
  const { data, width: w, height: h } = imageData;
  const n = w * h;
  const m = new Float32Array(n);
  if (isLineart) {
    for (let i = 0; i < n; i++) m[i] = data[i * 4 + 3] / 255;
  } else {
    const diff = lineDiff(data, w, h);
    for (let i = 0; i < n; i++) m[i] = lineAlpha(diff[i], 0.65) / 255;
  }
  return m;
}

/* ---------------- 風格 ---------------- */

// 先把半透明的雜點收斂成明確的線（膨脹前用，避免淡雜點被放大）
function solid(m) {
  const out = new Float32Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = smooth(0.18, 0.5, m[i]);
  return out;
}

function put(o, j, rgb, a) {
  o[j] = rgb[0]; o[j + 1] = rgb[1]; o[j + 2] = rgb[2];
  o[j + 3] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
}

/* 素描：石墨色、筆壓不均、斜向鉛筆顆粒，再加一道淡淡的偏移副線，像手繪草稿 */
function sketch(m, w, h, level, unit) {
  const soft = gaussian(m, w, h, Math.round(unit * 0.4));
  const off = Math.max(1, Math.round(unit * 1.8));
  const ghostK = 0.15 + level * 0.25;
  const dark = 0.95 + level * 0.5;
  const out = new ImageData(w, h);
  const o = out.data;
  const GRAPHITE = [56, 56, 64];
  for (let y = 0, i = 0; y < h; y++) {
    const ys = Math.max(0, y - off) * w;
    for (let x = 0; x < w; x++, i++) {
      const ghost = soft[ys + Math.min(w - 1, x + off)] * ghostK;
      let a = Math.max(soft[i], ghost);
      if (a < 0.01) continue;
      const press = 0.7 + 0.3 * valueNoise(x / (unit * 26), y / (unit * 26));
      const grain = 0.6 + 0.4 * valueNoise((x + y) / (unit * 0.8), (x - y) / (unit * 3.2));
      a *= press * grain * dark;
      put(o, i * 4, GRAPHITE, a);
    }
  }
  return out;
}

/* 蠟筆：線條變粗，邊緣粗糙不規則，筆觸裡露出紙紋 */
function crayon(m, w, h, level, unit) {
  const r = Math.max(1, Math.round(unit * (1.2 + level * 3.3)));
  const d = gaussian(dilateRound(solid(m), w, h, r), w, h, Math.max(1, Math.round(r * 0.5)));
  const out = new ImageData(w, h);
  const o = out.data;
  const WAX = [42, 35, 31];
  const rgb = [0, 0, 0];
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (d[i] < 0.05) continue;
      // 粗糙邊緣：閾值隨位置變動
      const t = 0.5 + (valueNoise(x / (unit * 1.7), y / (unit * 1.7)) - 0.5) * 0.6;
      let a = smooth(t - 0.07, t + 0.07, d[i]);
      if (a <= 0) continue;
      // 蠟質紙紋：斜向條紋 + 細顆粒，高的地方露出紙
      const streak = valueNoise((x + y) / (unit * 1.3), (x - y) / (unit * 7));
      const tooth = hash((x / Math.max(1, unit * 0.7)) | 0, (y / Math.max(1, unit * 0.7)) | 0);
      const tex = streak * 0.65 + tooth * 0.35;
      a *= tex > 0.7 ? 0.12 : 0.95 - tex * 0.2;
      const shade = (streak - 0.5) * 26;
      rgb[0] = WAX[0] + shade; rgb[1] = WAX[1] + shade; rgb[2] = WAX[2] + shade;
      put(o, i * 4, rgb, a);
    }
  }
  return out;
}

/* 麥克筆：粗一點、圓滑、實心的線條 */
function marker(m, w, h, level, unit) {
  const r = Math.max(1, Math.round(unit * (1.5 + level * 4)));
  const d = gaussian(dilateRound(solid(m), w, h, r), w, h, Math.max(1, Math.round(r * 0.6)));
  const out = new ImageData(w, h);
  const o = out.data;
  const INK = [17, 17, 20];
  for (let i = 0; i < d.length; i++) {
    if (d[i] < 0.3) continue;
    put(o, i * 4, INK, smooth(0.42, 0.58, d[i]));
  }
  return out;
}

/* 浮雕：線條變成凸起的石膏條，左上受光、右下有陰影 */
function emboss(m, w, h, level, unit) {
  const r = Math.max(1, Math.round(unit * (0.8 + level * 1.8)));
  const body = gaussian(dilateRound(solid(m), w, h, r), w, h, Math.max(1, Math.round(unit * 1.2)));
  const so = Math.max(1, Math.round(unit * (1.5 + level * 2)));
  const shadow = gaussian(body, w, h, Math.max(1, Math.round(unit * 1.6)));
  const d = Math.max(1, Math.round(unit * 1.2));
  const depth = 140 + level * 120;
  const out = new ImageData(w, h);
  const o = out.data;
  const rgb = [0, 0, 0];
  for (let y = 0, i = 0; y < h; y++) {
    const ya = Math.max(0, y - d) * w, yb = Math.min(h - 1, y + d) * w, ys = Math.max(0, y - so) * w;
    for (let x = 0; x < w; x++, i++) {
      const b = smooth(0.25, 0.5, body[i]);
      const sh = shadow[ys + Math.max(0, x - so)] * 0.45;
      const a = b + (1 - b) * sh;
      if (a < 0.01) continue;
      // 左上受光：高度往右下增加的邊緣（線條的左上側）較亮
      const xa = Math.max(0, x - d), xb = Math.min(w - 1, x + d);
      const slope = body[yb + xb] - body[ya + xa];
      const lum = Math.min(255, Math.max(40, 160 + slope * depth));
      // 陰影是黑色，混合後換算成非預乘顏色
      const k = b / a;
      rgb[0] = lum * 1.02 * k; rgb[1] = lum * 0.99 * k; rgb[2] = lum * 0.93 * k;
      put(o, i * 4, rgb, a);
    }
  }
  return out;
}

export const STYLES = { sketch, crayon, marker, emboss };

// mask：lineMask() 的結果
export function applyStyle(mask, w, h, style, level) {
  const unit = Math.max(0.35, Math.max(w, h) / 1200);
  return STYLES[style](mask, w, h, level, unit);
}
