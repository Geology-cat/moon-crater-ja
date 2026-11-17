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
  opts: { detail: 0, labels: true, outlines: true, sat: true, grid: false, limb: true, night: false, fontScale: 1 },
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

let dragDepth = 0;
window.addEventListener("dragenter", (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; $("drop-overlay").hidden = false; } });
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("drop-overlay").hidden = true; });
window.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; $("drop-overlay").hidden = true;
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("image/") || /\.(tiff?|webp|avif|heic)$/i.test(x.name));
  if (f) handleFile(f); else if (e.dataTransfer?.files?.length) alert("画像ファイルをドロップしてください。");
});
window.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) handleFile(item.getAsFile());
});
function hasFiles(e) { return [...(e.dataTransfer?.types || [])].includes("Files"); }

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
    // 解析用（長辺 2048px）
    const solveCanvas = resizeTo(work, SOLVE_MAX, Infinity);
    const b64 = await canvasToBase64(solveCanvas, "image/jpeg", 0.92);
    if (bmp.close) bmp.close();

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
    const k = work.width / solveCanvas.width;
    const v = res.view;
    state.view = { ...v, cx: (v.cx + 0.5) * k - 0.5, cy: (v.cy + 0.5) * k - 0.5, R: v.R * k };
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
    alert("エラーが発生しました：\n" + (err.message || err));
  }
}

async function decodeImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    // 一部ブラウザ向けのフォールバック
    const url = URL.createObjectURL(file);
    try {
      const im = new Image();
      im.src = url;
      await im.decode();
      return im;
    } catch (e2) {
      throw new Error("この形式の画像はブラウザで読み込めませんでした（HEIC や一部の TIFF は JPEG/PNG に変換してください）。");
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
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
      throw new Error("SkySolver に接続できませんでした。ネットワークを確認してください。");
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
      const msg = body?.message || `HTTP ${r.status}`;
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
new ResizeObserver(() => { if (!canvas.hidden) resizeCanvas(); }).observe($("stage"));

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
  const sun = state.solve?.sun;
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
  if (r.frame?.center) rows.push(["画像中心", `${fmtLon(r.frame.center.lon)} / ${fmtLat(r.frame.center.lat)}`]);
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
const pointers = new Map();
let panStart = null, pinchStart = null, moved = false;

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  moved = false;
  if (pointers.size === 1) {
    panStart = { x: e.offsetX, y: e.offsetY, tx: state.tx, ty: state.ty };
    canvas.classList.add("dragging");
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: state.scale, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, tx: state.tx, ty: state.ty };
    panStart = null;
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (pinchStart && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const ns = Math.max(minScale(), Math.min(pinchStart.scale * d / pinchStart.d, 40));
    const f = ns / pinchStart.scale;
    state.scale = ns;
    state.tx = mx - (pinchStart.mx - pinchStart.tx) * f;
    state.ty = my - (pinchStart.my - pinchStart.ty) * f;
    moved = true;
    requestDraw();
    return;
  }
  if (panStart) {
    const dx = e.offsetX - panStart.x, dy = e.offsetY - panStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    state.tx = panStart.tx + dx; state.ty = panStart.ty + dy;
    hideTooltip();
    requestDraw();
    return;
  }
  hoverAt(e.offsetX, e.offsetY);
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = null;
  if (pointers.size === 0) {
    canvas.classList.remove("dragging");
    // タップ（移動なし）なら地名を表示
    if (panStart && !moved) hoverAt(e.offsetX, e.offsetY);
    panStart = null;
  } else if (pointers.size === 1) {
    const [p] = [...pointers.values()];
    panStart = { x: p.x, y: p.y, tx: state.tx, ty: state.ty };
  }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("pointerleave", () => { if (!pointers.size) { setHover(null); hideTooltip(); $("coord").textContent = ""; } });
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
  zoomAt(f, e.offsetX, e.offsetY);
}, { passive: false });
canvas.addEventListener("dblclick", (e) => zoomAt(2, e.offsetX, e.offsetY));

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
for (const [id, key] of [["lay-labels", "labels"], ["lay-outlines", "outlines"], ["lay-sat", "sat"], ["lay-night", "night"], ["lay-grid", "grid"], ["lay-limb", "limb"]]) {
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
  const layoutW = Math.max(900, Math.min(state.W * state.scale, 12000));
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
document.fonts?.ready.then(requestDraw);
