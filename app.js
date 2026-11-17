/* 月面クレーター 日本語アノテーション
 * - 画像をブラウザ内で縮小 → SkySolver Moon API で月面の位置合わせ
 * - 返ってきた view（円盤の中心・半径・向き・秤動）で IAU 地名を写真上に投影
 * - 拡大率に応じて表示する地名を増やす
 */
"use strict";

const API_URL = "https://skysolver.app/api/v1/solve/moon";
const MOON_R_KM = 1737.4;
const SOLVE_MAX = 2048;          // API へ送る画像の長辺（API 側もこの大きさで解析する）
const WORK_MAX = 4096;           // 表示・保存用画像の長辺の上限
const WORK_MAX_PIXELS = 16e6;    // Safari のキャンバス上限対策
const DEG = Math.PI / 180;

// ---------- 地名の種類 ----------
const KINDS = {
  OC: { ja: "大洋", group: "mare" },
  ME: { ja: "海", group: "mare" },
  LC: { ja: "湖", group: "mare" },
  SI: { ja: "入江", group: "mare" },
  PA: { ja: "沼", group: "mare" },
  PL: { ja: "平原", group: "mare" },
  MO: { ja: "山・山脈", group: "mount" },
  PR: { ja: "岬", group: "mount" },
  RU: { ja: "崖", group: "mount" },
  VA: { ja: "谷", group: "rille" },
  RI: { ja: "谷（リマ）", group: "rille" },
  DO: { ja: "尾根（リッジ）", group: "ridge" },
  CA: { ja: "クレーター列", group: "rille" },
  AA: { ja: "クレーター", group: "crater" },
  SF: { ja: "副クレーター", group: "sat" },
  LF: { ja: "アポロ着陸地点付近の地名", group: "apollo" },
  ST: { ja: "着陸地点", group: "station" },
  AL: { ja: "アルベド地形", group: "mount" },
};
// 表示の閾値（画面上の大きさ［CSS px］）・色・文字サイズ
const STYLE = {
  mare:    { min: 26, color: "#9fd3ff", size: 16, weight: 700, rank: 0 },
  mount:   { min: 30, color: "#c8f29b", size: 12.5, weight: 400, rank: 2 },
  rille:   { min: 46, color: "#ffb3d1", size: 11.5, weight: 400, rank: 3 },
  ridge:   { min: 46, color: "#d5c4ff", size: 11.5, weight: 400, rank: 3 },
  crater:  { min: 13, color: "#ffe7a8", size: 12.5, weight: 400, rank: 1 },
  sat:     { min: 30, color: "#e8d9b0", size: 11, weight: 400, rank: 4 },
  apollo:  { min: 22, color: "#9ff0e0", size: 11, weight: 400, rank: 5 },
  station: { min: 0, color: "#ff9f7a", size: 12, weight: 700, rank: 0 },
};

// 小さくても早めに名前を出す有名な地形（全体表示で見つけやすくする）
const NOTABLE = new Set(["Tycho", "Copernicus", "Kepler", "Aristarchus", "Plato", "Clavius", "Ptolemaeus", "Alphonsus",
  "Arzachel", "Theophilus", "Cyrillus", "Catharina", "Archimedes", "Eratosthenes", "Posidonius", "Langrenus", "Petavius",
  "Grimaldi", "Gassendi", "Schickard", "Endymion", "Atlas", "Hercules", "Aristoteles", "Eudoxus", "Proclus", "Manilius",
  "Menelaus", "Plinius", "Bullialdus", "Maginus", "Stöfler", "Stofler", "Albategnius", "Hipparchus", "Walther", "Purbach",
  "Herodotus", "Pythagoras", "Messier", "Fracastorius", "Janssen", "Furnerius", "Vendelinus", "Cleomedes", "Bailly",
  "Longomontanus", "Wargentin", "Schiller", "Reinhold", "Fra Mauro", "Pitatus", "Hevelius", "Riccioli", "Mersenius",
  "Linné", "Linne", "Hyginus", "Rima Hyginus", "Rupes Recta", "Vallis Alpes", "Mons Pico", "Mons Piton",
  "Promontorium Laplace", "Promontorium Heraclides", "Statio Tranquillitatis", "Autolycus", "Aristillus", "Cassini",
  "Macrobius", "Taruntius", "Censorinus", "Dionysius", "Godin", "Agrippa", "Triesnecker", "Manilius", "Bessel",
  "Timocharis", "Lambert", "Euler", "Marius", "Reiner Gamma", "Mösting", "Mosting", "Lansberg", "Moretus"]);

// ---------- 状態 ----------
const state = {
  features: [],       // 地名（単位ベクトルなどを前計算）
  img: null,          // 表示用 ImageBitmap / Canvas
  W: 0, H: 0,         // 表示用画像の大きさ
  solve: null,        // API の答え
  view: null,         // 表示用画像座標での view
  proj: null,         // 投影の前計算
  scale: 1, tx: 0, ty: 0,  // 画面 CSS px = 画像 px * scale + t
  hover: null,
  drawn: [],          // 直近の描画で表示した地名（ヒットテスト用）
  fileName: "moon",
  sunVec: null,       // 太陽方向（明暗境界がわかったときのみ）
  opts: { detail: 0, labels: true, outlines: true, sat: true, grid: false, limb: true, night: false, mare: true, fontScale: 1 },
};

const $ = (id) => document.getElementById(id);
const canvas = $("view");
const ctx = canvas.getContext("2d");

// ---------- 地名データの読み込み ----------
const featuresReady = fetch("data/features.json")
  .then((r) => r.json())
  .then((json) => {
    state.features = json.features.map((f) => {
      const [ja, name, lon, lat, d, code, ext] = f;
      const kind = KINDS[code] || KINDS.AA;
      let diam = d;
      if (!(diam > 0)) diam = code === "ST" ? 0 : 5;
      // 海など広がりを持つ地形はその広がりも大きさの目安にする
      if (ext && kind.group === "mare") {
        const w = (ext[1] - ext[0]) * Math.cos(lat * DEG) * MOON_R_KM * DEG;
        const h = (ext[3] - ext[2]) * MOON_R_KM * DEG;
        diam = Math.max(diam, Math.min(w, h));
      }
      return {
        ja, name, lon, lat, d, code, kind, group: kind.group,
        diam,
        p: vec(lon, lat),
        a: (diam / 2) / MOON_R_KM, // 角半径［rad］
        boost: NOTABLE.has(name) ? 2.2 : 1,
      };
    });
  });

// ---------- 海の輪郭（LROC）の読み込み ----------
// rings: { name: 海の番号, v: 単位ベクトル列, c: 中心方向, r: 角半径 }
state.mare = null;
const mareReady = fetch("data/mare.json")
  .then((r) => r.json())
  .then((json) => {
    state.mare = {
      names: json.names,
      levels: json.levels.map((lv) => ({ tol: lv.tol, rings: lv.rings.map(decodeRing) })),
    };
    requestDraw();
  })
  .catch((e) => console.warn("海の輪郭を読み込めませんでした", e));

function decodeRing(a) {
  const n = (a.length - 1) / 2;
  const v = new Float64Array(n * 3);
  let x = 0, y = 0, sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0) { x = a[1]; y = a[2]; } else { x += a[1 + 2 * i]; y += a[2 + 2 * i]; }
    const p = vec(x / 100, y / 100);
    v[3 * i] = p[0]; v[3 * i + 1] = p[1]; v[3 * i + 2] = p[2];
    sx += p[0]; sy += p[1]; sz += p[2];
  }
  const c = norm([sx, sy, sz]);
  let minDot = 1;
  for (let i = 0; i < n; i++) minDot = Math.min(minDot, c[0] * v[3 * i] + c[1] * v[3 * i + 1] + c[2] * v[3 * i + 2]);
  return { name: a[0], v, n, c, r: Math.acos(Math.max(-1, Math.min(1, minDot))) };
}

function vec(lon, lat) {
  const cl = Math.cos(lat * DEG);
  return [cl * Math.cos(lon * DEG), cl * Math.sin(lon * DEG), Math.sin(lat * DEG)];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ---------- 投影（API ドキュメントの式） ----------
function makeProjection(v) {
  const ez = vec(v.lon0, v.lat0);
  const n = [0, 0, 1];
  const k = dot(n, ez);
  const ey = norm([n[0] - k * ez[0], n[1] - k * ez[1], n[2] - k * ez[2]]);
  const ex = cross(ey, ez);
  const r = v.rho * DEG;
  return { ex, ey, ez, cx: v.cx, cy: v.cy, R: v.R, par: v.par, c: Math.cos(r), s: Math.sin(r) };
}
// 月面の単位ベクトル → 画像座標 [x, y, mu]（mu>0 で見える側）
function project(P, p) {
  const X = P.par * dot(p, P.ex);
  const Y = dot(p, P.ey);
  return [P.cx + P.R * (X * P.c - Y * P.s), P.cy - P.R * (X * P.s + Y * P.c), dot(p, P.ez)];
}
// 画像座標 → 経度・緯度（円盤外なら null）
function unproject(P, x, y) {
  const dx = (x - P.cx) / P.R, dy = -(y - P.cy) / P.R;
  const X = dx * P.c + dy * P.s;
  const Y = -dx * P.s + dy * P.c;
  const r2 = X * X + Y * Y;
  if (r2 > 1) return null;
  const Z = Math.sqrt(1 - r2);
  const xe = P.par * X;
  const p = [0, 1, 2].map((i) => xe * P.ex[i] + Y * P.ey[i] + Z * P.ez[i]);
  return { lon: Math.atan2(p[1], p[0]) / DEG, lat: Math.asin(Math.max(-1, Math.min(1, p[2]))) / DEG };
}

// ---------- ファイル受付 ----------
const fileInput = $("file-input");
fileInput.addEventListener("change", () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); fileInput.value = ""; });

const IMAGE_EXT = /\.(jpe?g|png|gif|bmp|webp|avif|tiff?|heic|heif|hif)$/i;
function toArray(list) { return list ? Array.prototype.slice.call(list) : []; }
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; $("drop-overlay").hidden = false; } });
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("drop-overlay").hidden = true; });
window.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; $("drop-overlay").hidden = true;
  const files = toArray(e.dataTransfer && e.dataTransfer.files);
  const f = files.find((x) => (x.type && x.type.indexOf("image/") === 0) || IMAGE_EXT.test(x.name));
  if (f) handleFile(f); else if (files.length) alert("画像ファイルをドロップしてください。");
});
window.addEventListener("paste", (e) => {
  const item = toArray(e.clipboardData && e.clipboardData.items).find((i) => i.type.indexOf("image/") === 0);
  if (item) handleFile(item.getAsFile());
});
function hasFiles(e) { return toArray(e.dataTransfer && e.dataTransfer.types).indexOf("Files") >= 0; }

function busy(text) {
  $("busy").hidden = !text;
  if (text) $("busy-text").textContent = text;
}

async function handleFile(file) {
  try {
    busy("画像を読み込み中…");
    state.fileName = (file.name || "moon").replace(/\.[^.]+$/, "") || "moon";
    const bmp = await decodeImage(file);
    busy("画像を縮小中…");
    // 表示・保存用（長辺 4096px / 16MP まで）
    const work = resizeTo(bmp, WORK_MAX, WORK_MAX_PIXELS);
    if (bmp.close) bmp.close();
    else if (bmp !== work && bmp.getContext) { bmp.width = 1; bmp.height = 1; } // メモリを早めに解放
    // 解析用（長辺 2048px）
    const solveCanvas = resizeTo(work, SOLVE_MAX, Infinity);
    const b64 = await canvasToBase64(solveCanvas, "image/jpeg", 0.92);
    const solveW = solveCanvas.width;
    if (solveCanvas !== work) { solveCanvas.width = 1; solveCanvas.height = 1; }

    await featuresReady;
    busy("月面を解析中…（SkySolver）");
    const res = await solveMoon(b64);
    state.solve = res;
    state.img = work; state.W = work.width; state.H = work.height;

    if (!res.view) {
      busy(null);
      alert("月面を特定できませんでした。\n" + (res.error ? "理由: " + res.error + "\n" : "") +
        "月がはっきり写った写真でお試しください（1つのクレーターだけが写るような強い拡大は苦手です）。");
      showViewer(false);
      return;
    }
    // 解析画像の座標 → 表示用画像の座標（画素中心が原点の座標系）
    const k = work.width / solveW;
    const v = res.view;
    state.view = Object.assign({}, v, { cx: (v.cx + 0.5) * k - 0.5, cy: (v.cy + 0.5) * k - 0.5, R: v.R * k });
    state.proj = makeProjection(state.view);
    const sun = res.sun;
    state.sunVec = sun && sun.terminator !== false ? vec(sun.lon, sun.lat || 0) : null;
    showViewer(true);
    fitView();
    updateInfo();
    busy(null);
  } catch (err) {
    console.error(err);
    busy(null);
    alert("エラーが発生しました：\n" + ((err && err.message) || err));
  }
}

// ---------- 画像のデコード（TIFF・HEIC は変換してから読み込む） ----------
function readHead(file, n) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result));
    fr.onerror = () => resolve(new Uint8Array(0));
    fr.readAsArrayBuffer(file.slice(0, n));
  });
}
function readAll(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("ファイルを読み込めませんでした。"));
    fr.readAsArrayBuffer(file);
  });
}
// 先頭のバイト列から形式を判定する
function sniffFormat(h, name) {
  const s = (a, b) => String.fromCharCode.apply(null, h.subarray(a, b));
  if (h.length >= 4 && ((h[0] === 0x49 && h[1] === 0x49 && h[2] === 42 && h[3] === 0) || (h[0] === 0x4d && h[1] === 0x4d && h[2] === 0 && h[3] === 42))) return "tiff";
  if (h.length >= 12 && s(4, 8) === "ftyp") {
    const brands = s(8, Math.min(h.length, 40));
    if (/avif|avis/.test(brands)) return "avif";
    if (/hei[cfmsx]|hev[cmsx]|mif1|msf1/.test(brands)) return "heic";
  }
  if (h[0] === 0xff && h[1] === 0xd8) return "jpeg";
  if (/\.(heic|heif|hif)$/i.test(name)) return "heic";
  if (/\.tiff?$/i.test(name)) return "tiff";
  return "other";
}

// 外部スクリプトを必要になったときだけ読み込む
const scriptCache = {};
function loadScript(src) {
  if (!scriptCache[src]) {
    scriptCache[src] = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = resolve;
      el.onerror = () => { delete scriptCache[src]; reject(new Error("変換ライブラリを読み込めませんでした: " + src)); };
      document.head.appendChild(el);
    });
  }
  return scriptCache[src];
}

// 古いブラウザ向け: Blob.arrayBuffer（Safari 14 未満にはない）を補う
if (window.Blob && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function () { return readAll(this); };
}

// ブラウザがEXIFの向きを自動で反映するか（Safari 13.1 / Chrome 81 以降は反映する）
const AUTO_ORIENT = !!(window.CSS && CSS.supports && CSS.supports("image-orientation", "from-image"));

async function decodeImage(file) {
  const head = await readHead(file, 128 * 1024);
  const fmt = sniffFormat(head, file.name || "");
  // まずブラウザ自身のデコーダを試す（Safari は TIFF・HEIC も読める）
  if (fmt !== "tiff" || /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent)) {
    const im = await decodeNative(file, fmt === "jpeg" && !AUTO_ORIENT ? exifOrientation(head) : 1);
    if (im) return im;
  }
  if (fmt === "tiff") {
    busy("TIFF を変換中…");
    return decodeTiff(await readAll(file));
  }
  if (fmt === "heic") {
    busy("HEIC を JPEG に変換中…（初回は変換ライブラリを読み込むため時間がかかります）");
    const jpg = await convertHeic(file);
    const im = await decodeNative(jpg, 1);
    if (im) return im;
  }
  if (fmt === "avif") throw new Error("このブラウザは AVIF 形式を読み込めません。JPEG か PNG に変換してからお試しください。");
  throw new Error("この形式の画像はブラウザで読み込めませんでした。JPEG か PNG に変換してからお試しください。");
}

// ブラウザ標準のデコード。失敗したら null。
async function decodeNative(blob, orientation) {
  if (window.createImageBitmap && AUTO_ORIENT) {
    try { return await createImageBitmap(blob, { imageOrientation: "from-image" }); } catch (e) { /* 次の方法へ */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const im = new Image();
    await new Promise((resolve, reject) => { im.onload = resolve; im.onerror = reject; im.src = url; });
    if (!im.naturalWidth) return null;
    return orientation > 1 ? applyOrientation(im, orientation) : im;
  } catch (e) {
    return null;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

// JPEG の EXIF から向き（1〜8）を読む（古いブラウザ向け）
function exifOrientation(h) {
  try {
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    if (dv.getUint16(0) !== 0xffd8) return 1;
    let p = 2;
    while (p + 4 < dv.byteLength) {
      const marker = dv.getUint16(p);
      const len = dv.getUint16(p + 2);
      if (marker === 0xffe1 && dv.getUint32(p + 4) === 0x45786966) {
        const t = p + 10;
        const le = dv.getUint16(t) === 0x4949;
        const ifd = t + dv.getUint32(t + 4, le);
        const n = dv.getUint16(ifd, le);
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (dv.getUint16(e, le) === 0x0112) return dv.getUint16(e + 8, le);
        }
        return 1;
      }
      if ((marker & 0xff00) !== 0xff00) break;
      p += 2 + len;
    }
  } catch (e) { /* 読めなければ回転なし */ }
  return 1;
}
function applyOrientation(im, o) {
  const w = im.naturalWidth, h = im.naturalHeight;
  const c = document.createElement("canvas");
  const swap = o >= 5;
  c.width = swap ? h : w; c.height = swap ? w : h;
  const g = c.getContext("2d");
  const T = { 2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, h], 4: [1, 0, 0, -1, 0, h], 5: [0, 1, 1, 0, 0, 0],
    6: [0, 1, -1, 0, h, 0], 7: [0, -1, -1, 0, h, w], 8: [0, -1, 1, 0, 0, w] }[o];
  if (T) g.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
  g.drawImage(im, 0, 0);
  return c;
}

// TIFF（8/16 ビット、無圧縮・LZW・Deflate・PackBits など）を canvas に変換
async function decodeTiff(buf) {
  await loadScript("lib/pako_inflate.min.js");
  await loadScript("lib/UTIF.js");
  const UTIF = window.UTIF;
  const ifds = UTIF.decode(buf);
  // サムネイルを避け、いちばん大きな画像を選ぶ
  let best = null;
  for (const ifd of ifds) {
    const w = ifd.t256 ? ifd.t256[0] : 0, h = ifd.t257 ? ifd.t257[0] : 0;
    if (!best || w * h > best.w * best.h) best = { ifd, w, h };
  }
  if (!best || !best.w) throw new Error("TIFF の画像データが見つかりませんでした。");
  UTIF.decodeImage(buf, best.ifd, ifds);
  const rgba = UTIF.toRGBA8(best.ifd);
  const w = best.ifd.width, h = best.ifd.height;
  // 天体写真の 16 ビット TIFF などで暗すぎる場合は明るさを引き伸ばす
  let max = 0;
  const step = Math.max(4, ((rgba.length / 4 / 200000) | 0) * 4);
  for (let i = 0; i < rgba.length; i += step) { if (rgba[i] > max) max = rgba[i]; if (rgba[i + 1] > max) max = rgba[i + 1]; if (rgba[i + 2] > max) max = rgba[i + 2]; }
  if (max > 0 && max < 160) {
    const f = 255 / max;
    for (let i = 0; i < rgba.length; i += 4) { rgba[i] = Math.min(255, rgba[i] * f); rgba[i + 1] = Math.min(255, rgba[i + 1] * f); rgba[i + 2] = Math.min(255, rgba[i + 2] * f); }
  }
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  const id = g.createImageData(w, h);
  id.data.set(rgba);
  g.putImageData(id, 0, 0);
  return c;
}

// HEIC/HEIF → JPEG（新しい libheif の heic-to を優先し、だめなら heic2any）
async function convertHeic(file) {
  let firstErr = null;
  try {
    await loadScript("lib/heic-to.iife.js");
    if (window.HeicTo) return await window.HeicTo({ blob: file, type: "image/jpeg", quality: 0.95 });
  } catch (e) { firstErr = e; console.warn("heic-to failed", e); }
  try {
    await loadScript("lib/heic2any.min.js");
    const out = await window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.95 });
    return Array.isArray(out) ? out[0] : out;
  } catch (e) {
    console.warn("heic2any failed", e);
    throw new Error("HEIC 画像を変換できませんでした。写真アプリなどで JPEG に書き出してからお試しください。" + (firstErr ? "" : ""));
  }
}

// 長辺 maxSide・総画素 maxPixels 以下に縮小した canvas を返す（拡大はしない）
function resizeTo(src, maxSide, maxPixels) {
  const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
  let f = Math.min(1, maxSide / Math.max(w0, h0));
  if (w0 * h0 * f * f > maxPixels) f = Math.sqrt(maxPixels / (w0 * h0));
  const w = Math.max(1, Math.round(w0 * f)), h = Math.max(1, Math.round(h0 * f));
  // 大きく縮小するときは半分ずつ縮めて画質を保つ
  let cur = src, cw = w0, ch = h0;
  while (cw / 2 >= w && ch / 2 >= h) {
    const c = document.createElement("canvas");
    c.width = Math.round(cw / 2); c.height = Math.round(ch / 2);
    const g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(cur, 0, 0, c.width, c.height);
    cur = c; cw = c.width; ch = c.height;
  }
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const g = out.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(cur, 0, 0, w, h);
  return out;
}

function canvasToBase64(c, type, q) {
  return new Promise((resolve, reject) => {
    c.toBlob((blob) => {
      if (!blob) return reject(new Error("画像の変換に失敗しました。"));
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(",")[1]);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    }, type, q);
  });
}

async function solveMoon(b64) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let r;
    try {
      r = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: b64 }),
      });
    } catch (e) {
      throw new Error("SkySolver に接続できませんでした。ネットワークを確認してください。\n" +
        "古い OS（iOS 12 / macOS 10.14 など）では、SkySolver の証明書（Let's Encrypt の ISRG Root X2 系）を信頼できず接続に失敗することがあります。" +
        "その場合は OS を更新するか、端末に ISRG Root X2 証明書を追加してください。");
    }
    if (r.status === 429) {
      const wait = Math.min(60, Number(r.headers.get("Retry-After")) || 5) + Math.random();
      for (let t = Math.ceil(wait); t > 0; t--) {
        busy(`SkySolver が混雑しています。${t} 秒後に再試行します…`);
        await new Promise((ok) => setTimeout(ok, 1000));
      }
      busy("月面を解析中…（SkySolver）");
      continue;
    }
    let body = null;
    try { body = await r.json(); } catch (e) { /* noop */ }
    if (!r.ok) {
      const msg = (body && body.message) || `HTTP ${r.status}`;
      throw new Error("SkySolver からエラーが返りました：" + msg);
    }
    return body;
  }
  throw new Error("SkySolver が混雑しているため解析できませんでした。しばらくしてから再度お試しください。");
}

// ---------- 表示 ----------
function showViewer(on) {
  $("dropzone").hidden = on;
  canvas.hidden = !on;
  $("zoom-ctrl").hidden = !on;
  $("coord").hidden = !on;
  $("panel").hidden = !on;
  resizeCanvas();
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  requestDraw();
}
if (window.ResizeObserver) new ResizeObserver(() => { if (!canvas.hidden) resizeCanvas(); }).observe($("stage"));
else window.addEventListener("resize", () => { if (!canvas.hidden) resizeCanvas(); });
window.addEventListener("orientationchange", () => setTimeout(() => { if (!canvas.hidden) resizeCanvas(); }, 300));

function fitView() {
  const r = canvas.getBoundingClientRect();
  const s = Math.min(r.width / state.W, r.height / state.H) * 0.96;
  state.scale = s;
  state.tx = (r.width - state.W * s) / 2;
  state.ty = (r.height - state.H * s) / 2;
  requestDraw();
}

function minScale() {
  const r = canvas.getBoundingClientRect();
  return Math.min(r.width / state.W, r.height / state.H) * 0.5;
}
function zoomAt(f, sx, sy) {
  const ns = Math.max(minScale(), Math.min(state.scale * f, 40));
  f = ns / state.scale;
  state.tx = sx - (sx - state.tx) * f;
  state.ty = sy - (sy - state.ty) * f;
  state.scale = ns;
  requestDraw();
}

let drawPending = false;
function requestDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => { drawPending = false; drawScreen(); });
}

function drawScreen() {
  if (!state.img || canvas.hidden) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#05070b";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const vt = { s: state.scale * dpr, tx: state.tx * dpr, ty: state.ty * dpr, ui: dpr, w: canvas.width, h: canvas.height };
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(vt.s, 0, 0, vt.s, vt.tx, vt.ty);
  ctx.drawImage(state.img, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  state.drawn = state.proj ? renderOverlay(ctx, vt, state.hover) : [];
}

// ---------- 注釈の描画（画面・保存で共通） ----------
// vt: { s: キャンバス px / 画像 px, tx, ty: キャンバス px のずれ, ui: キャンバス px / レイアウト px, w, h }
function renderOverlay(g, vt, hover) {
  const P = state.proj;
  const o = state.opts;
  const L = vt.s / vt.ui;                 // レイアウト px / 画像 px
  const kmPerImgPx = MOON_R_KM / P.R;
  const detailF = Math.pow(2, -o.detail);
  const toC = (x, y) => [x * vt.s + vt.tx, y * vt.s + vt.ty];
  const ui = vt.ui;

  // 写真の範囲（キャンバス px）と、そのうち画面に見えている範囲
  const img = [vt.tx, vt.ty, vt.tx + state.W * vt.s, vt.ty + state.H * vt.s];
  const vis = [Math.max(0, img[0]), Math.max(0, img[1]), Math.min(vt.w, img[2]), Math.min(vt.h, img[3])];

  g.save();
  g.beginPath();
  g.rect(vis[0], vis[1], vis[2] - vis[0], vis[3] - vis[1]);
  g.clip();  // 注釈は写真の外にはみ出さない
  g.lineJoin = "round"; g.lineCap = "round";

  // 経緯線
  if (o.grid) drawGrid(g, vt, P, L);
  // 縁・明暗境界線
  if (o.limb) drawLimbTerminator(g, vt, P);
  // 海の輪郭
  if (o.mare && state.mare) drawMare(g, vt, P, L, hover);

  // 表示候補を選ぶ
  const cands = [];
  const margin = 60 * ui;
  for (const f of state.features) {
    const st = STYLE[f.group];
    if (f.group === "sat" && !o.sat) continue;
    // 夜側（太陽が当たっていない側）に完全に入っているものは省く
    if (!o.night && state.sunVec && dot(f.p, state.sunVec) < -Math.sin(Math.min(f.a, 0.3)) - 0.01) continue;
    const [x, y, mu] = project(P, f.p);
    if (mu < 0.03) continue;
    const [X, Y] = toC(x, y);
    const sizeL = (f.diam / kmPerImgPx) * L;        // レイアウト px での大きさ
    const eff = sizeL * (0.35 + 0.65 * mu) * f.boost; // 縁に近いものは縮んで見える
    let ok;
    if (f.group === "station") ok = kmPerImgPx / L < 2.2 * detailF;
    else ok = eff >= st.min * detailF;
    if (!ok) continue;
    const rC = (f.diam / 2 / kmPerImgPx) * vt.s;     // キャンバス px での半径
    // 中心が写真の外にあるものは出さない（画面外でも近くなら輪郭のため候補に残す）
    if (X < img[0] || Y < img[1] || X > img[2] || Y > img[3]) continue;
    if (X < vis[0] - rC - margin || Y < vis[1] - rC - margin || X > vis[2] + rC + margin || Y > vis[3] + rC + margin) continue;
    cands.push({ f, X, Y, mu, rC, sizeL, st });
  }
  // 海などを先に、次に大きさ（有名地形は大きめに扱う）の順で配置する
  cands.sort((a, b) => (a.st.rank - b.st.rank) || (b.f.diam * b.f.boost - a.f.diam * a.f.boost));

  const placed = [];   // 配置済みラベルの矩形
  const drawn = [];
  const maxLabels = Math.round(500 * Math.max(1, (vt.w * vt.h) / (ui * ui) / 1.5e6));
  const fs = o.fontScale;

  for (const c of cands) {
    if (drawn.length >= maxLabels) break;
    const { f, X, Y, rC, st } = c;
    let size = st.size;
    if (f.group === "mare") size = Math.max(13, Math.min(22, 11 + c.sizeL / 40));
    else if (f.group === "crater" && f.diam >= 80) size = st.size + 1;
    size *= fs * ui;
    const font = `${st.weight} ${size.toFixed(1)}px ${FONT}`;
    g.font = font;
    const text = f.ja;
    const tw = g.measureText(text).width;
    const th = size * 1.15;
    const pad = 3 * ui;

    // ラベル位置の候補
    const opts = [];
    const isRound = f.group === "crater" || f.group === "sat";
    if (!isRound || rC > 70 * ui) opts.push([X, Y + th * 0.35]);       // 中央
    if (isRound) {
      const r = Math.max(rC * Math.max(c.mu, 0.4), 3 * ui) + 2 * ui;
      opts.push([X, Y + r + th * 0.8]);            // 下
      opts.push([X, Y - r - th * 0.25]);           // 上
      opts.push([X + r + tw / 2 + 2 * ui, Y + th * 0.3]); // 右
      opts.push([X - r - tw / 2 - 2 * ui, Y + th * 0.3]); // 左
    } else if (f.group !== "mare") {
      opts.push([X, Y + th * 1.3], [X, Y - th * 0.7]);
    }
    let pos = null;
    for (const [lx, ly] of opts) {
      const rect = [lx - tw / 2 - pad, ly - th * 0.85 - pad, lx + tw / 2 + pad, ly + th * 0.25 + pad];
      if (rect[0] < vis[0] || rect[2] > vis[2] || rect[1] < vis[1] || rect[3] > vis[3]) continue;
      if (!placed.some((q) => rect[0] < q[2] && rect[2] > q[0] && rect[1] < q[3] && rect[3] > q[1])) {
        pos = [lx, ly, rect];
        break;
      }
    }
    if (!pos) continue;
    placed.push(pos[2]);

    const isHover = hover && hover === f;
    // 輪郭
    if (o.outlines && isRound && rC > 2.5 * ui) {
      strokeCircleOnSphere(g, vt, P, f, isHover ? "#ffffff" : st.color, (isHover ? 2 : 1) * ui, isHover ? 1 : 0.75);
    } else if (f.group === "station") {
      g.fillStyle = st.color;
      g.beginPath(); g.arc(X, Y, 3 * ui, 0, Math.PI * 2); g.fill();
    } else if (!isRound && f.group !== "mare") {
      // 線状・山などは中心に小さな点
      g.fillStyle = st.color;
      g.globalAlpha = 0.8;
      g.beginPath(); g.arc(X, Y, 1.8 * ui, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
    } else if (f.group === "station") {
      g.fillStyle = st.color;
      g.beginPath(); g.arc(X, Y, 3 * ui, 0, Math.PI * 2); g.fill();
    }
    if (o.labels) {
      g.font = font;
      g.textAlign = "center";
      g.textBaseline = "alphabetic";
      g.lineWidth = 3 * ui;
      g.strokeStyle = "rgba(0,0,0,0.85)";
      g.strokeText(text, pos[0], pos[1]);
      g.fillStyle = isHover ? "#ffffff" : st.color;
      g.fillText(text, pos[0], pos[1]);
    }
    drawn.push({ f, X, Y, rC, rect: pos[2] });
  }
  // ホバー中の地名が表示対象外でも輪郭を示す
  if (hover && !drawn.some((d) => d.f === hover)) {
    strokeCircleOnSphere(g, vt, P, hover, "#ffffff", 2 * ui, 1);
  }
  g.restore();
  return drawn;
}

const FONT = '"Noto Sans JP","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Meiryo",sans-serif';

// 球面上の円（クレーターの縁）を投影して描く
function strokeCircleOnSphere(g, vt, P, f, color, width, alpha) {
  const p = f.p;
  let t1 = cross([0, 0, 1], p);
  if (Math.hypot(...t1) < 1e-6) t1 = [1, 0, 0];
  t1 = norm(t1);
  const t2 = cross(p, t1);
  const a = Math.max(f.a, 1e-5);
  const ca = Math.cos(a), sa = Math.sin(a);
  const N = 40;
  g.strokeStyle = color; g.lineWidth = width; g.globalAlpha = alpha;
  g.beginPath();
  let pen = false;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    const ct = Math.cos(t), stt = Math.sin(t);
    const q = [0, 1, 2].map((k) => ca * p[k] + sa * (ct * t1[k] + stt * t2[k]));
    const [x, y, mu] = project(P, q);
    if (mu <= 0) { pen = false; continue; }
    const X = x * vt.s + vt.tx, Y = y * vt.s + vt.ty;
    if (pen) g.lineTo(X, Y); else { g.moveTo(X, Y); pen = true; }
  }
  g.stroke();
  g.globalAlpha = 1;
}

// 月面の大円・小円などの曲線を、見える部分だけ描く
function strokeSphereCurve(g, vt, P, pts) {
  let pen = false;
  for (const q of pts) {
    const [x, y, mu] = project(P, q);
    if (mu <= 0) { pen = false; continue; }
    const X = x * vt.s + vt.tx, Y = y * vt.s + vt.ty;
    if (pen) g.lineTo(X, Y); else { g.moveTo(X, Y); pen = true; }
  }
}

// 海の輪郭を描く。拡大率に応じて粗い版と細かい版を切り替える。
function drawMare(g, vt, P, L, hover) {
  const levels = state.mare.levels;
  const degPx = P.R * DEG * L;  // 1° がレイアウト px で何 px か
  // 誤差が画面上で約 1.2px 以内に収まる、いちばん粗い版を選ぶ（levels は粗い順）
  let lv = levels[levels.length - 1];
  for (const cand of levels) { if (cand.tol * degPx <= 1.2) { lv = cand; break; } }

  const ex = P.ex, ey = P.ey, ez = P.ez;
  const kx = P.R * vt.s, cxC = P.cx * vt.s + vt.tx, cyC = P.cy * vt.s + vt.ty;
  const pc = P.par * P.c, ps = P.par * P.s;
  const vcx = vt.w / 2, vcy = vt.h / 2, viewR = Math.hypot(vt.w, vt.h) / 2;
  const hoverName = hover && hover.group === "mare" ? hover.name : null;
  // 影の側を隠す設定のときは、夜側の部分の輪郭も描かない
  const sun = !state.opts.night && state.sunVec;
  const hiRings = [];

  const tracePath = (ring) => {
    const v = ring.v;
    let pen = false, allVis = true;
    for (let i = 0; i < ring.n; i++) {
      const x = v[3 * i], y = v[3 * i + 1], z = v[3 * i + 2];
      const mu = x * ez[0] + y * ez[1] + z * ez[2];
      if (mu <= 0 || (sun && x * sun[0] + y * sun[1] + z * sun[2] < -0.005)) { pen = false; allVis = false; continue; }
      const X = x * ex[0] + y * ex[1] + z * ex[2];
      const Y = x * ey[0] + y * ey[1] + z * ey[2];
      const sx = cxC + kx * (X * pc - Y * P.s);
      const sy = cyC - kx * (X * ps + Y * P.c);
      if (pen) g.lineTo(sx, sy); else { g.moveTo(sx, sy); pen = true; }
    }
    if (allVis) g.closePath();
  };

  g.beginPath();
  for (const ring of lv.rings) {
    const c = ring.c;
    // 完全に裏側にあるもの・画面から遠いものは省く
    if (c[0] * ez[0] + c[1] * ez[1] + c[2] * ez[2] < -Math.sin(ring.r)) continue;
    const pr = project(P, c);
    const X = pr[0] * vt.s + vt.tx, Y = pr[1] * vt.s + vt.ty;
    if (Math.hypot(X - vcx, Y - vcy) > viewR + ring.r * kx + 4) continue;
    if (hoverName && state.mare.names[ring.name][1] === hoverName) hiRings.push(ring);
    tracePath(ring);
  }
  g.strokeStyle = "#8fd0ff";
  g.globalAlpha = 0.6;
  g.lineWidth = 1.1 * vt.ui;
  g.stroke();
  if (hiRings.length) {
    g.beginPath();
    hiRings.forEach(tracePath);
    g.fillStyle = "rgba(143,208,255,0.12)";
    g.globalAlpha = 1;
    g.fill("evenodd");
    g.strokeStyle = "#ffffff";
    g.lineWidth = 2 * vt.ui;
    g.stroke();
  }
  g.globalAlpha = 1;
}

function drawGrid(g, vt, P, L) {
  // 画面上の間隔が 70 レイアウト px 以上になる刻みを選ぶ
  const degPx = (P.R * DEG) * L;
  const step = [30, 15, 10, 5, 2, 1, 0.5].find((s, i, arr) => i === arr.length - 1 || arr[i + 1] * degPx < 70) || 30;
  const sub = Math.min(step / 4, 1);
  g.strokeStyle = "#6fd6c9"; g.globalAlpha = 0.45; g.lineWidth = 1 * vt.ui;
  g.setLineDash([4 * vt.ui, 4 * vt.ui]);
  g.beginPath();
  for (let lon = -180; lon < 180; lon += step) {
    const pts = [];
    for (let lat = -90; lat <= 90; lat += sub) pts.push(vec(lon, lat));
    strokeSphereCurve(g, vt, P, pts);
  }
  for (let lat = -90 + step; lat < 90; lat += step) {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += sub) pts.push(vec(lon, lat));
    strokeSphereCurve(g, vt, P, pts);
  }
  g.stroke();
  g.setLineDash([]);
  // 経度0°・赤道は少し強く
  g.globalAlpha = 0.7;
  g.beginPath();
  const eq = [], pm = [];
  for (let t = -180; t <= 180; t += sub) eq.push(vec(t, 0));
  for (let t = -90; t <= 90; t += sub) pm.push(vec(0, t));
  strokeSphereCurve(g, vt, P, eq); strokeSphereCurve(g, vt, P, pm);
  g.stroke();
  g.globalAlpha = 1;
}

function drawLimbTerminator(g, vt, P) {
  const ui = vt.ui;
  // 縁
  g.strokeStyle = "#5fd0c0"; g.globalAlpha = 0.55; g.lineWidth = 1.2 * ui;
  g.beginPath();
  g.arc(P.cx * vt.s + vt.tx, P.cy * vt.s + vt.ty, P.R * vt.s, 0, Math.PI * 2);
  g.stroke();
  // 明暗境界線（太陽方向に垂直な大円）
  const sun = state.solve && state.solve.sun;
  if (sun && sun.terminator !== false) {
    const sv = vec(sun.lon, sun.lat || 0);
    let u = cross(sv, [0, 0, 1]);
    if (Math.hypot(...u) < 1e-6) u = [1, 0, 0];
    u = norm(u);
    const w = cross(sv, u);
    const pts = [];
    for (let i = 0; i <= 360; i++) {
      const t = i * DEG;
      pts.push([0, 1, 2].map((k) => Math.cos(t) * u[k] + Math.sin(t) * w[k]));
    }
    g.strokeStyle = "#ffb86b"; g.globalAlpha = 0.7; g.lineWidth = 1.2 * ui;
    g.setLineDash([6 * ui, 5 * ui]);
    g.beginPath();
    strokeSphereCurve(g, vt, P, pts);
    g.stroke();
    g.setLineDash([]);
  }
  g.globalAlpha = 1;
}

// ---------- 解析結果パネル ----------
const PHASE_JA = {
  "new moon": "新月", "waxing crescent": "三日月（満ちていく月）", "first quarter": "上弦の月",
  "waxing gibbous": "満月前の月（十日夜〜十四夜）", "full moon": "満月", "waning gibbous": "満月後の月（十六夜〜）",
  "last quarter": "下弦の月", "waning crescent": "有明の月（欠けていく月）",
};
const VERDICT_JA = { verified: "確実", plausible: "おそらく正しい", unsure: "不確か（推定）" };
function fmtLon(v) { return (v >= 0 ? "東経 " : "西経 ") + Math.abs(v).toFixed(1) + "°"; }
function fmtLat(v) { return (v >= 0 ? "北緯 " : "南緯 ") + Math.abs(v).toFixed(1) + "°"; }

function updateInfo() {
  const r = state.solve, v = r.view;
  const rows = [];
  rows.push(["判定", `${VERDICT_JA[r.verdict] || r.verdict}（一致度 ${(r.confidence * 100).toFixed(0)}%）`]);
  rows.push(["方法", r.path === "disk" ? "月の縁から解析" : r.path === "closeup" ? "拡大写真として解析" : "—"]);
  if (r.phase) {
    rows.push(["月齢の目安", PHASE_JA[r.phase.name] || r.phase.name]);
    rows.push(["輝面比", (r.phase.fraction * 100).toFixed(0) + "%"]);
  }
  rows.push(["秤動", `${fmtLon(v.lon0)} / ${fmtLat(v.lat0)}`]);
  rows.push(["北の向き", `画像の上から反時計回りに ${v.rho.toFixed(1)}°` + (v.par < 0 ? "（鏡像）" : "")]);
  const kmpx = MOON_R_KM / state.view.R;
  rows.push(["縮尺", `${kmpx.toFixed(2)} km/px（表示画像 ${state.W}×${state.H}px）`]);
  if (r.frame && r.frame.center) rows.push(["画像中心", `${fmtLon(r.frame.center.lon)} / ${fmtLat(r.frame.center.lat)}`]);
  $("info").innerHTML = rows.map(([k, val]) => `<dt>${k}</dt><dd>${escapeHtml(val)}</dd>`).join("");
  const warn = $("warn");
  if (r.verdict !== "verified") {
    warn.hidden = false;
    warn.textContent = r.verdict === "unsure"
      ? "月面の位置を確定できませんでした。表示は推定結果で、地名の位置がずれている可能性があります。"
      : "位置合わせは確定ではありません。地名の位置がずれている場合があります。";
  } else warn.hidden = true;
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---------- 操作（パン・ズーム・ホバー） ----------
// Pointer Events がない古い Safari（12 など）ではマウス・タッチイベントで同じ処理を行う
const pointers = new Map();
let panStart = null, pinchStart = null, moved = false;
function localXY(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function pointerValues() { const a = []; pointers.forEach((v) => a.push(v)); return a; }

function inputDown(id, x, y) {
  pointers.set(id, { x, y });
  moved = false;
  if (pointers.size === 1) {
    panStart = { x, y, tx: state.tx, ty: state.ty };
    canvas.classList.add("dragging");
  } else if (pointers.size === 2) {
    const ab = pointerValues(), a = ab[0], b = ab[1];
    pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: state.scale, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, tx: state.tx, ty: state.ty };
    panStart = null;
  }
}
function inputMove(id, x, y) {
  if (pointers.has(id)) pointers.set(id, { x, y });
  if (pinchStart && pointers.size === 2) {
    const ab = pointerValues(), a = ab[0], b = ab[1];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const ns = Math.max(minScale(), Math.min(pinchStart.scale * d / pinchStart.d, 40));
    const f = ns / pinchStart.scale;
    state.scale = ns;
    state.tx = mx - (pinchStart.mx - pinchStart.tx) * f;
    state.ty = my - (pinchStart.my - pinchStart.ty) * f;
    moved = true;
    hideTooltip();
    requestDraw();
    return;
  }
  if (panStart) {
    const dx = x - panStart.x, dy = y - panStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    state.tx = panStart.tx + dx; state.ty = panStart.ty + dy;
    if (moved) hideTooltip();
    requestDraw();
    return;
  }
  hoverAt(x, y);
}
function inputUp(id, x, y) {
  pointers.delete(id);
  if (pointers.size < 2) pinchStart = null;
  if (pointers.size === 0) {
    canvas.classList.remove("dragging");
    // タップ（移動なし）なら地名を表示
    if (panStart && !moved) hoverAt(x, y);
    panStart = null;
  } else if (pointers.size === 1) {
    const p = pointerValues()[0];
    panStart = { x: p.x, y: p.y, tx: state.tx, ty: state.ty };
  }
}
function inputLeave() { if (!pointers.size) { setHover(null); hideTooltip(); $("coord").textContent = ""; } }

if (window.PointerEvent) {
  canvas.addEventListener("pointerdown", (e) => {
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    const p = localXY(e); inputDown(e.pointerId, p.x, p.y);
  });
  canvas.addEventListener("pointermove", (e) => { const p = localXY(e); inputMove(e.pointerId, p.x, p.y); });
  const up = (e) => { const p = localXY(e); inputUp(e.pointerId, p.x, p.y); };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointerleave", inputLeave);
} else {
  // マウス
  canvas.addEventListener("mousedown", (e) => {
    const p = localXY(e); inputDown("mouse", p.x, p.y);
    const mm = (ev) => { const q = localXY(ev); inputMove("mouse", q.x, q.y); };
    const mu = (ev) => {
      window.removeEventListener("mousemove", mm); window.removeEventListener("mouseup", mu);
      const q = localXY(ev); inputUp("mouse", q.x, q.y);
    };
    window.addEventListener("mousemove", mm); window.addEventListener("mouseup", mu);
  });
  canvas.addEventListener("mousemove", (e) => { if (!pointers.size) { const p = localXY(e); inputMove("hover", p.x, p.y); } });
  canvas.addEventListener("mouseleave", inputLeave);
  // タッチ（指ごとに identifier で区別）
  const touchHandler = (fn) => (e) => {
    e.preventDefault();
    toArray(e.changedTouches).forEach((t) => { const p = localXY(t); fn("t" + t.identifier, p.x, p.y); });
  };
  canvas.addEventListener("touchstart", touchHandler(inputDown), { passive: false });
  canvas.addEventListener("touchmove", touchHandler(inputMove), { passive: false });
  canvas.addEventListener("touchend", touchHandler(inputUp), { passive: false });
  canvas.addEventListener("touchcancel", touchHandler(inputUp), { passive: false });
}
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const p = localXY(e);
  const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
  zoomAt(f, p.x, p.y);
}, { passive: false });
canvas.addEventListener("dblclick", (e) => { const p = localXY(e); zoomAt(2, p.x, p.y); });
// macOS Safari のトラックパッドのピンチ操作
let gestureScale = 1;
canvas.addEventListener("gesturestart", (e) => { e.preventDefault(); gestureScale = 1; });
canvas.addEventListener("gesturechange", (e) => {
  e.preventDefault();
  const p = localXY(e);
  zoomAt(e.scale / gestureScale, p.x, p.y);
  gestureScale = e.scale;
});
canvas.addEventListener("gestureend", (e) => e.preventDefault());

$("zoom-in").onclick = () => { const r = canvas.getBoundingClientRect(); zoomAt(1.6, r.width / 2, r.height / 2); };
$("zoom-out").onclick = () => { const r = canvas.getBoundingClientRect(); zoomAt(1 / 1.6, r.width / 2, r.height / 2); };
$("zoom-fit").onclick = fitView;

function hoverAt(sx, sy) {
  if (!state.proj) return;
  const dpr = window.devicePixelRatio || 1;
  const X = sx * dpr, Y = sy * dpr;
  // カーソル位置の月面座標
  const ix = (sx - state.tx) / state.scale, iy = (sy - state.ty) / state.scale;
  const ll = unproject(state.proj, ix, iy);
  $("coord").textContent = ll ? `${fmtLon(ll.lon)}　${fmtLat(ll.lat)}` : "月面の外";
  // 表示中のラベル・輪郭に当たるものを探す（小さいものを優先）
  let best = null, bestScore = Infinity;
  for (const d of state.drawn) {
    const [x0, y0, x1, y1] = d.rect;
    const inLabel = X >= x0 && X <= x1 && Y >= y0 && Y <= y1;
    const dist = Math.hypot(X - d.X, Y - d.Y);
    const inCircle = dist <= Math.max(d.rC, 8 * dpr);
    if (inLabel || inCircle) {
      const score = inLabel ? -1 : d.rC + dist;
      if (score < bestScore) { bestScore = score; best = d.f; }
    }
  }
  setHover(best);
  if (best) showTooltip(best, sx, sy); else hideTooltip();
}
function setHover(f) {
  if (state.hover !== f) { state.hover = f; requestDraw(); }
}
function showTooltip(f, sx, sy) {
  const tt = $("tooltip");
  const sizeLabel = ["RI", "DO", "VA", "CA", "RU", "MO"].includes(f.code) ? "長さ" : "直径";
  tt.innerHTML = `<div class="ja">${escapeHtml(f.ja)}</div><div class="la">${escapeHtml(f.name)}</div>` +
    `<div class="meta">${escapeHtml(f.kind.ja)}${f.d > 0 ? `・${sizeLabel} ${f.d >= 10 ? f.d.toFixed(0) : f.d.toFixed(1)} km` : ""}</div>` +
    `<div class="meta">${fmtLon(f.lon)}　${fmtLat(f.lat)}</div>`;
  tt.hidden = false;
  const st = $("stage").getBoundingClientRect();
  const w = tt.offsetWidth, h = tt.offsetHeight;
  let x = sx + 14, y = sy + 14;
  if (x + w > st.width - 6) x = sx - w - 14;
  if (y + h > st.height - 6) y = sy - h - 14;
  tt.style.left = Math.max(4, x) + "px"; tt.style.top = Math.max(4, y) + "px";
}
function hideTooltip() { $("tooltip").hidden = true; }

// ---------- 表示設定 ----------
const DETAIL_JA = { "-2": "最少", "-1.5": "とても少なめ", "-1": "少なめ", "-0.5": "やや少なめ", "0": "標準", "0.5": "やや多め", "1": "多め", "1.5": "とても多め", "2": "最多" };
$("detail").addEventListener("input", (e) => {
  state.opts.detail = Number(e.target.value);
  $("detail-out").textContent = DETAIL_JA[e.target.value] || e.target.value;
  requestDraw();
});
$("fontscale").addEventListener("input", (e) => { state.opts.fontScale = Number(e.target.value); requestDraw(); });
for (const [id, key] of [["lay-labels", "labels"], ["lay-mare", "mare"], ["lay-outlines", "outlines"], ["lay-sat", "sat"], ["lay-night", "night"], ["lay-grid", "grid"], ["lay-limb", "limb"]]) {
  $(id).addEventListener("change", (e) => { state.opts[key] = e.target.checked; requestDraw(); });
}

// ---------- 保存 ----------
async function ensureFonts() {
  try {
    await Promise.all([document.fonts.load(`400 16px "Noto Sans JP"`, "月の海"), document.fonts.load(`700 16px "Noto Sans JP"`, "月の海")]);
    await document.fonts.ready;
  } catch (e) { /* フォントが読めない場合はシステムフォントで描く */ }
}

function drawCredit(g, w, h, ui) {
  const text = "注釈: SkySolver.app Moon API / 地名: IAU・USGS";
  g.font = `400 ${(10 * ui).toFixed(1)}px ${FONT}`;
  g.textAlign = "right"; g.textBaseline = "alphabetic";
  g.lineWidth = 3 * ui; g.strokeStyle = "rgba(0,0,0,0.8)";
  g.strokeText(text, w - 8 * ui, h - 8 * ui);
  g.fillStyle = "rgba(230,236,245,0.85)";
  g.fillText(text, w - 8 * ui, h - 8 * ui);
}

function saveCanvas(c, suffix) {
  const type = $("fmt").value;
  const ext = type === "image/png" ? "png" : "jpg";
  c.toBlob((blob) => {
    if (!blob) { alert("画像の書き出しに失敗しました。"); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${state.fileName}_${suffix}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 20000);
  }, type, 0.93);
}

$("save-full").addEventListener("click", async () => {
  if (!state.img) return;
  busy("画像を書き出し中…");
  await ensureFonts();
  const c = document.createElement("canvas");
  c.width = state.W; c.height = state.H;
  const g = c.getContext("2d");
  g.drawImage(state.img, 0, 0);
  // 画面と同じ詳細度：画像全体を「現在の拡大率で表示した幅」でレイアウトする
  // 拡大しすぎると文字が小さくなりすぎるので、画像幅の 1.2 倍までに抑える
  const layoutW = Math.max(900, Math.min(state.W * state.scale, state.W * 1.2));
  const ui = state.W / layoutW;
  renderOverlay(g, { s: 1, tx: 0, ty: 0, ui, w: c.width, h: c.height }, null);
  drawCredit(g, c.width, c.height, Math.max(ui, state.W / 1800));
  busy(null);
  saveCanvas(c, "annotated");
});

$("save-view").addEventListener("click", async () => {
  if (!state.img) return;
  await ensureFonts();
  const hover = state.hover;
  state.hover = null;
  drawScreen();
  const c = document.createElement("canvas");
  c.width = canvas.width; c.height = canvas.height;
  const g = c.getContext("2d");
  g.drawImage(canvas, 0, 0);
  drawCredit(g, c.width, c.height, window.devicePixelRatio || 1);
  state.hover = hover;
  requestDraw();
  saveCanvas(c, "view");
});

// フォント読み込み後に再描画（初回の描画が代替フォントになるのを防ぐ）
if (document.fonts && document.fonts.ready) document.fonts.ready.then(requestDraw);
