// Doodle Alive — all app code in one file (built from src/ by pack.py).
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import {
  getFirestore, collection, addDoc, setDoc, getDocs, query, orderBy, limit, deleteDoc, doc, serverTimestamp,
} from 'firebase/firestore';

// ---- imaging ----
const { dilate, labelComponents, floodExterior, otsu, clamp, smoothstep } = (() => {
// Small image-processing helpers shared by photo cleanup and character detection.

/** Square dilation of a 0/1 mask by radius r (separable running window). */
function dilate(mask, w, h, r) {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w; let count = 0;
    for (let k = 0; k <= r && k < w; k++) count += mask[row + k];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = count > 0 ? 1 : 0;
      const add = x + r + 1, rem = x - r;
      if (add < w) count += mask[row + add];
      if (rem >= 0) count -= mask[row + rem];
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let k = 0; k <= r && k < h; k++) count += tmp[k * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = count > 0 ? 1 : 0;
      const add = y + r + 1, rem = y - r;
      if (add < h) count += tmp[add * w + x];
      if (rem >= 0) count -= tmp[rem * w + x];
    }
  }
  return out;
}

/** 4-connected component labeling. labels: 0 = background, 1..count. */
function labelComponents(mask, w, h) {
  const N = w * h, labels = new Int32Array(N), stack = new Int32Array(N);
  const areas = [0]; let count = 0;
  for (let i = 0; i < N; i++) {
    if (!mask[i] || labels[i]) continue;
    count++; let sp = 0, area = 0;
    labels[i] = count; stack[sp++] = i;
    while (sp) {
      const p = stack[--sp]; area++;
      const x = p % w;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = count; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = count; stack[sp++] = p + 1; }
      if (p >= w && mask[p - w] && !labels[p - w]) { labels[p - w] = count; stack[sp++] = p - w; }
      if (p < N - w && mask[p + w] && !labels[p + w]) { labels[p + w] = count; stack[sp++] = p + w; }
    }
    areas.push(area);
  }
  return { labels, count, areas };
}

/** Cells reachable from the image border without crossing `block`. */
function floodExterior(block, w, h) {
  const N = w * h, ext = new Uint8Array(N), stack = new Int32Array(N); let sp = 0;
  const push = (p) => { if (!block[p] && !ext[p]) { ext[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp) {
    const p = stack[--sp], x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < N - w) push(p + w);
  }
  return ext;
}

/** Otsu threshold for a 256-bin histogram, returned in 0..1. */
function otsu(hist) {
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  let sumB = 0, wB = 0, best = 0, th = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; th = i; }
  }
  return th / 255;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

return { dilate, labelComponents, floodExterior, otsu, clamp, smoothstep };
})();

// ---- photo ----
const { fileToCanvas, rotateCanvas, cleanPhoto } = (() => {
// Turns a phone photo of a paper drawing into clean, transparent artwork:
// removes uneven lighting and shadows, lifts the paper away, keeps pencil and marker
// colors vivid, and clears specks of dust.

async function fileToCanvas(file, maxSide = 1400) {
  let src;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    src = await new Promise((res, rej) => {
      const img = new Image(); const u = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(u); res(img); };
      img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('bad image')); };
      img.src = u;
    });
  }
  const k = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
  if (src.close) src.close();
  return c;
}

function rotateCanvas(src) {
  const c = document.createElement('canvas'); c.width = src.height; c.height = src.width;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.translate(c.width, 0); x.rotate(Math.PI / 2); x.drawImage(src, 0, 0);
  return c;
}

/**
 * @param {HTMLCanvasElement} src photo
 * @param {number} strength 0.5 (keep faint lines) .. 1.6 (remove more)
 * @returns {HTMLCanvasElement|null} cropped artwork on a transparent background
 */
function cleanPhoto(src, strength = 1) {
  const w = src.width, h = src.height, N = w * h;
  const p = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const lumAt = (i) => p[i] * 0.3 + p[i + 1] * 0.59 + p[i + 2] * 0.11;

  // 1. Estimate the paper color in a coarse grid (brighter half of each block).
  const bs = Math.max(12, Math.round(Math.max(w, h) / 36));
  const gw = Math.ceil(w / bs), gh = Math.ceil(h / bs), G = gw * gh;
  let R = new Float32Array(G), Gc = new Float32Array(G), B = new Float32Array(G), L = new Float32Array(G);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const x0 = gx * bs, y0 = gy * bs, x1 = Math.min(w, x0 + bs), y1 = Math.min(h, y0 + bs);
    let sl = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { sl += lumAt((y * w + x) * 4); n++; }
    const m = sl / Math.max(1, n);
    let r = 0, g = 0, b = 0, k = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = (y * w + x) * 4; if (lumAt(i) >= m) { r += p[i]; g += p[i + 1]; b += p[i + 2]; k++; }
    }
    const j = gy * gw + gx; k = Math.max(1, k);
    R[j] = r / k; Gc[j] = g / k; B[j] = b / k; L[j] = R[j] * 0.3 + Gc[j] * 0.59 + B[j] * 0.11;
  }
  // Blocks fully covered by ink borrow the brightest neighbor (radius 2).
  {
    const R2 = new Float32Array(G), G2 = new Float32Array(G), B2 = new Float32Array(G);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      let best = -1, bj = gy * gw + gx;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const yy = gy + dy, xx = gx + dx; if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue;
        const j = yy * gw + xx; if (L[j] > best) { best = L[j]; bj = j; }
      }
      const j = gy * gw + gx; R2[j] = R[bj]; G2[j] = Gc[bj]; B2[j] = B[bj];
    }
    R = R2; Gc = G2; B = B2;
  }
  // Smooth the paper estimate (two 3x3 box blurs).
  const blur = (A) => {
    const o = new Float32Array(G);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = gy + dy, xx = gx + dx; if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue;
        s += A[yy * gw + xx]; n++;
      }
      o[gy * gw + gx] = s / n;
    }
    return o;
  };
  R = blur(blur(R)); Gc = blur(blur(Gc)); B = blur(blur(B));

  // 2. Local paper brightness by grayscale "closing": thin dark lines vanish, but the sharp
  //    edge of a phone shadow is kept, so shadows are not mistaken for ink.
  const lumArr = new Float32Array(N);
  for (let j = 0; j < N; j++) lumArr[j] = lumAt(j * 4);
  const rad = Math.max(6, Math.round(Math.max(w, h) / 70));
  const paperL = morph(morph(lumArr, w, h, rad, true), w, h, rad, false);

  // 3. Divide out the paper (fixes shadows and color casts) and score each pixel as "ink".
  const nr = new Float32Array(N), ng = new Float32Array(N), nb = new Float32Array(N), score = new Float32Array(N);
  const hist = new Uint32Array(256);
  for (let y = 0; y < h; y++) {
    const fy = clamp((y + 0.5) / bs - 0.5, 0, gh - 1), y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = clamp((x + 0.5) / bs - 0.5, 0, gw - 1), x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      const a = y0 * gw + x0, b = y0 * gw + x1, c = y1 * gw + x0, d = y1 * gw + x1;
      const bil = (A) => (A[a] * (1 - tx) + A[b] * tx) * (1 - ty) + (A[c] * (1 - tx) + A[d] * tx) * ty;
      const j = y * w + x, i = j * 4;
      // paper color = coarse color tint, scaled to the local paper brightness
      const cr = bil(R), cg = bil(Gc), cb = bil(B), cl = Math.max(1, cr * 0.3 + cg * 0.59 + cb * 0.11);
      const k = Math.max(20, paperL[j]) / cl;
      const r = Math.min(1, p[i] / Math.max(20, cr * k)), g = Math.min(1, p[i + 1] / Math.max(20, cg * k)), bl = Math.min(1, p[i + 2] / Math.max(20, cb * k));
      nr[j] = r; ng[j] = g; nb[j] = bl;
      const dark = clamp(1 - lumArr[j] / Math.max(20, paperL[j]), 0, 1);
      const sat = Math.max(r, g, bl) - Math.min(r, g, bl);
      const sc = Math.max(dark, sat * 0.9);
      score[j] = sc; hist[Math.min(255, (sc * 255) | 0)]++;
    }
  }

  // 4. Pick a threshold that separates paper from ink.
  const t = clamp(otsu(hist), 0.1, 0.36) * strength;
  const lo = t * 0.62, hi = t * 1.25;
  const alpha = new Float32Array(N);
  for (let j = 0; j < N; j++) alpha[j] = smoothstep(lo, hi, score[j]);

  // 5. Remove specks (tiny isolated dots of dust or paper grain).
  const solid = new Uint8Array(N);
  for (let j = 0; j < N; j++) solid[j] = alpha[j] > 0.5 ? 1 : 0;
  const { labels, areas } = labelComponents(solid, w, h);
  const minArea = Math.max(24, N * 0.00004);
  // Small blobs touching the photo's edge are table, fingers or shadow corners, not drawing.
  const edgeHit = new Uint8Array(areas.length);
  for (let x = 0; x < w; x++) { edgeHit[labels[x]] = 1; edgeHit[labels[(h - 1) * w + x]] = 1; }
  for (let y = 0; y < h; y++) { edgeHit[labels[y * w]] = 1; edgeHit[labels[y * w + w - 1]] = 1; }
  const keep = new Uint8Array(N);
  for (let j = 0; j < N; j++) {
    const l = labels[j];
    if (l && areas[l] >= minArea && !(edgeHit[l] && areas[l] < N * 0.03)) keep[j] = 1;
  }
  const near = dilate(keep, w, h, 2);

  // 6. Write vivid colors; edge pixels are un-mixed from the paper so no white halo shows.
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const octx = out.getContext('2d', { willReadFrequently: true });
  const od = octx.createImageData(w, h), q = od.data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let j = 0; j < N; j++) {
    let a = alpha[j];
    if (!near[j] || (labels[j] && !keep[j])) a = 0;
    if (a <= 0.02) continue;
    let r = nr[j], g = ng[j], b = nb[j];
    if (a < 1) { const k = Math.max(a, 0.08); r = clamp((r - (1 - a)) / k, 0, 1); g = clamp((g - (1 - a)) / k, 0, 1); b = clamp((b - (1 - a)) / k, 0, 1); }
    r = Math.pow(r, 1.35); g = Math.pow(g, 1.35); b = Math.pow(b, 1.35);
    const l = r * 0.3 + g * 0.59 + b * 0.11;
    r = clamp(l + (r - l) * 1.4, 0, 1); g = clamp(l + (g - l) * 1.4, 0, 1); b = clamp(l + (b - l) * 1.4, 0, 1);
    const i = j * 4;
    q[i] = r * 255; q[i + 1] = g * 255; q[i + 2] = b * 255; q[i + 3] = a * 255;
    if (a > 0.5) { const x = j % w, y = (j / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  octx.putImageData(od, 0, 0);
  const m = 8;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w, x1 + m); y1 = Math.min(h, y1 + m);
  const crop = document.createElement('canvas'); crop.width = x1 - x0; crop.height = y1 - y0;
  crop.getContext('2d').drawImage(out, x0, y0, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return crop;
}

/** Separable sliding-window max (isMax) or min filter with radius r, O(n) via monotonic queues. */
function morph(src, w, h, r, isMax) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const dq = new Int32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) {
    const row = y * w; let head = 0, tail = 0;
    for (let x = 0; x < w + r; x++) {
      if (x < w) {
        const v = src[row + x];
        if (isMax) { while (tail > head && v >= src[row + dq[tail - 1]]) tail--; }
        else { while (tail > head && v <= src[row + dq[tail - 1]]) tail--; }
        dq[tail++] = x;
      }
      const c = x - r;
      if (c >= 0) { while (dq[head] < c - r) head++; tmp[row + c] = src[row + dq[head]]; }
    }
  }
  for (let x = 0; x < w; x++) {
    let head = 0, tail = 0;
    for (let y = 0; y < h + r; y++) {
      if (y < h) {
        const v = tmp[y * w + x];
        if (isMax) { while (tail > head && v >= tmp[dq[tail - 1] * w + x]) tail--; }
        else { while (tail > head && v <= tmp[dq[tail - 1] * w + x]) tail--; }
        dq[tail++] = y;
      }
      const c = y - r;
      if (c >= 0) { while (dq[head] < c - r) head++; out[c * w + x] = tmp[dq[head] * w + x]; }
    }
  }
  return out;
}

return { fileToCanvas, rotateCanvas, cleanPhoto };
})();

// ---- actors ----
const { ER, NAMES, MAX_ACTORS, segmentActors, actorFromCanvas, LIMB_KEYS, finishRig, TRAITS, MOVE_WORDS, pose, drawEye, drawHat, drawActor, drawBubble } = (() => {
// Finds each separate character on the paper, rigs its arms and legs, gives it a
// personality, and draws it with motion, eyes, mouth, hats and speech bubbles.

const ER = 36; // googly eye radius in drawing pixels
const NAMES = ['Zippy', 'Noodle', 'Pickles', 'Mango', 'Bubbles', 'Sprout', 'Ziggy', 'Pip', 'Coco', 'Biscuit', 'Waffles', 'Jellybean', 'Doodle', 'Sunny', 'Wobble'];
const MAX_ACTORS = 6;

/* ---------------- segmentation ---------------- */
function segmentActors(drawCv, eyes, { fill = true } = {}) {
  const DW = drawCv.width, DH = drawCv.height;
  const data = drawCv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, DW, DH).data;
  const F = 2, w = Math.ceil(DW / F), h = Math.ceil(DH / F);
  const m = new Uint8Array(w * h);
  for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) if (data[(y * DW + x) * 4 + 3] > 20) m[(y >> 1) * w + (x >> 1)] = 1;
  for (const e of eyes) {
    const cx = e.x / F, cy = e.y / F, r = ER / F;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, cy + r); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, cx + r); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) m[y * w + x] = 1;
  }
  // Strokes closer than ~12px belong to the same character.
  const dm = dilate(m, w, h, 6);
  const { labels, count } = labelComponents(dm, w, h);
  if (!count) return [];

  const parent = Array.from({ length: count + 1 }, (_, i) => i);
  const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const raw = Array.from({ length: count + 1 }, () => ({ x0: 1e9, y0: 1e9, x1: -1, y1: -1, area: 0 }));
  for (let i = 0; i < w * h; i++) if (m[i]) {
    const b = raw[labels[i]], x = i % w, y = (i / w) | 0;
    if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y; b.area++;
  }
  const groups = () => {
    const g = new Map();
    for (let l = 1; l <= count; l++) {
      if (!raw[l].area) continue;
      const r = find(l), b = raw[l];
      const u = g.get(r) || { root: r, x0: 1e9, y0: 1e9, x1: -1, y1: -1, area: 0 };
      u.x0 = Math.min(u.x0, b.x0); u.y0 = Math.min(u.y0, b.y0); u.x1 = Math.max(u.x1, b.x1); u.y1 = Math.max(u.y1, b.y1); u.area += b.area;
      g.set(r, u);
    }
    return [...g.values()];
  };
  const boxArea = (b) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
  const gap = (a, b) => Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1), Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));

  // Merge parts that mostly overlap (a hat floating over a head, a big shape around a small one).
  for (let changed = true; changed;) {
    changed = false; const gs = groups();
    outer: for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) {
      const a = gs[i], b = gs[j];
      const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (ix > 0 && iy > 0 && ix * iy > 0.3 * Math.min(boxArea(a), boxArea(b))) { parent[find(b.root)] = find(a.root); changed = true; break outer; }
    }
  }
  // Tiny specks join a nearby character or disappear.
  let gs = groups();
  const big = gs.filter((g) => g.area >= 60);
  for (const g of gs) if (g.area < 60) {
    let best = null, bd = 1e9;
    for (const b of big) { const d = gap(g, b); if (d < bd) { bd = d; best = b; } }
    if (best && bd < 30) parent[find(g.root)] = find(best.root); else g.drop = true;
  }
  const dropped = new Set(gs.filter((g) => g.drop).map((g) => find(g.root)));
  gs = groups().filter((g) => !dropped.has(find(g.root)));
  // Keep at most MAX_ACTORS: the smallest join their nearest neighbor.
  while (gs.length > MAX_ACTORS) {
    gs.sort((a, b) => a.area - b.area);
    const s = gs[0]; let best = gs[1], bd = 1e9;
    for (const b of gs.slice(1)) { const d = gap(s, b); if (d < bd) { bd = d; best = b; } }
    parent[find(s.root)] = find(best.root);
    gs = groups().filter((g) => !dropped.has(find(g.root)));
  }
  gs.sort((a, b) => (a.x0 + a.x1) - (b.x0 + b.x1));
  const rootToIdx = new Map(gs.map((g, i) => [find(g.root), i]));
  const labelToActor = new Int16Array(count + 1).fill(-1);
  for (let l = 1; l <= count; l++) { const k = rootToIdx.get(find(l)); if (k !== undefined) labelToActor[l] = k; }

  return gs.map((g, k) => {
    const pad = 10;
    const X0 = Math.max(0, g.x0 * F - pad), Y0 = Math.max(0, g.y0 * F - pad);
    const X1 = Math.min(DW, (g.x1 + 1) * F + pad), Y1 = Math.min(DH, (g.y1 + 1) * F + pad);
    const aw = X1 - X0, ah = Y1 - Y0;
    const cv = document.createElement('canvas'); cv.width = aw; cv.height = ah;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(drawCv, X0, Y0, aw, ah, 0, 0, aw, ah);
    const id = ctx.getImageData(0, 0, aw, ah), d = id.data;
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
      const i = (y * aw + x) * 4; if (!d[i + 3]) continue;
      const l = labels[((Y0 + y) >> 1) * w + ((X0 + x) >> 1)];
      if (!l || labelToActor[l] !== k) d[i + 3] = 0;
    }
    if (fill) fillInside(d, aw, ah);
    ctx.putImageData(id, 0, 0);
    const myEyes = eyes.filter((e) => {
      const l = labels[(Math.min(h - 1, Math.round(e.y) >> 1)) * w + (Math.min(w - 1, Math.round(e.x) >> 1))];
      return l && labelToActor[l] === k;
    }).map((e) => ({ x: e.x - X0, y: e.y - Y0 }));
    const A = { cv, w: aw, h: ah, x0: X0, y0: Y0, cx: X0 + aw / 2, cy: Y0 + ah / 2, eyes: myEyes };
    A.rig = analyzeRig(cv);
    A.persona = makePersona(d, aw, ah, A.rig, (Y0 + ah / 2) / DH, k);
    finishRig(A, null);
    A.thumb = cv.toDataURL('image/png');
    return A;
  });
}

/** Build a character from a saved cut-out (a character from the library). */
function actorFromCanvas(cv, eyes, k = 99) {
  const w = cv.width, h = cv.height;
  const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const A = { cv, w, h, x0: 0, y0: 0, cx: 0, cy: 0, eyes: (eyes || []).map((e) => ({ x: e.x, y: e.y })), guest: true };
  A.rig = analyzeRig(cv);
  A.persona = makePersona(d, w, h, A.rig, 0.6, k);
  finishRig(A, null);
  A.thumb = cv.toDataURL('image/png');
  return A;
}

const LIMB_KEYS = [['armL', 'arm', -1], ['armR', 'arm', 1], ['legL', 'leg', -1], ['legR', 'leg', 1]];

/** Rasterize painted strokes ({pts:[x,y,...], r}) into a 0/1 mask. */
function paintMask(strokes, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true }); x.strokeStyle = '#000'; x.fillStyle = '#000'; x.lineCap = 'round'; x.lineJoin = 'round';
  for (const st of strokes) {
    const p = st.pts; x.lineWidth = st.r * 2;
    if (p.length === 2) { x.beginPath(); x.arc(p[0], p[1], st.r, 0, Math.PI * 2); x.fill(); continue; }
    x.beginPath(); x.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) x.lineTo(p[i], p[i + 1]); x.stroke();
  }
  const d = x.getImageData(0, 0, w, h).data, m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 0 ? 1 : 0;
  return m;
}

/**
 * Cut the arms and legs out of the drawing so they can swing, each in two pieces
 * (upper and lower) so elbows and knees can bend. `paint` (optional) is the child's own
 * marking of which pixels are which limb; without it, the automatic guess is used.
 */
function finishRig(A, paint) {
  const w = A.w, h = A.h, N = w * h;
  const img = A.cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h), d = img.data;
  let cxs = 0, cys = 0, cn = 0;
  for (let i = 0; i < N; i++) if (d[i * 4 + 3] > 24) { cxs += i % w; cys += (i / w) | 0; cn++; }
  const cx = cn ? cxs / cn : w / 2, cy = cn ? cys / cn : h / 2;
  const specs = [];
  if (paint) {
    for (const [key, kind, side] of LIMB_KEYS) if (paint[key] && paint[key].length) specs.push({ kind, side, mask: paintMask(paint[key], w, h) });
  } else {
    for (const L of A.rig.autoArms || A.rig.arms) specs.push({ kind: 'arm', side: L.side, rect: L, px: L.px, py: L.py });
    for (const L of A.rig.autoLegs || A.rig.legs) specs.push({ kind: 'leg', side: L.side, rect: L, px: L.px, py: L.py });
  }
  if (!A.rig.autoArms) { A.rig.autoArms = A.rig.arms; A.rig.autoLegs = A.rig.legs; }
  const owned = new Uint8Array(N), arms = [], legs = [];
  for (const sp of specs) {
    const pix = [];
    if (sp.rect) {
      const R = sp.rect;
      for (let y = Math.max(0, R.y0 | 0); y < Math.min(h, Math.ceil(R.y1)); y++) for (let x = Math.max(0, R.x0 | 0); x < Math.min(w, Math.ceil(R.x1)); x++) { const i = y * w + x; if (d[i * 4 + 3] > 8 && !owned[i]) pix.push(i); }
    } else {
      for (let i = 0; i < N; i++) if (sp.mask[i] && d[i * 4 + 3] > 8 && !owned[i]) pix.push(i);
    }
    if (pix.length < 30) continue;
    let px = sp.px, py = sp.py;
    if (px === undefined) {
      let best = Infinity;
      for (const i of pix) { const x = i % w, y = (i / w) | 0, dd = (x - cx) ** 2 + (y - cy) ** 2; if (dd < best) { best = dd; px = x; py = y; } }
    }
    let tx = px, ty = py, far = -1, x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (const i of pix) {
      const x = i % w, y = (i / w) | 0, dd = (x - px) ** 2 + (y - py) ** 2;
      if (dd > far) { far = dd; tx = x; ty = y; }
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const jx = (px + tx) / 2, jy = (py + ty) / 2, ax = tx - px, ay = ty - py, len2 = Math.max(1, ax * ax + ay * ay);
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const upC = document.createElement('canvas'), loC = document.createElement('canvas');
    upC.width = loC.width = bw; upC.height = loC.height = bh;
    const ui = upC.getContext('2d').createImageData(bw, bh), li = loC.getContext('2d').createImageData(bw, bh);
    for (const i of pix) {
      const x = i % w, y = (i / w) | 0, t = ((x - px) * ax + (y - py) * ay) / len2;
      const o = ((y - y0) * bw + (x - x0)) * 4, s4 = i * 4;
      if (t < 0.56) { ui.data[o] = d[s4]; ui.data[o + 1] = d[s4 + 1]; ui.data[o + 2] = d[s4 + 2]; ui.data[o + 3] = d[s4 + 3]; }
      if (t > 0.44) { li.data[o] = d[s4]; li.data[o + 1] = d[s4 + 1]; li.data[o + 2] = d[s4 + 2]; li.data[o + 3] = d[s4 + 3]; }
      owned[i] = 1;
    }
    upC.getContext('2d').putImageData(ui, 0, 0); loC.getContext('2d').putImageData(li, 0, 0);
    const limb = { side: sp.side, kind: sp.kind, px, py, jx, jy, bx: x0, by: y0, up: upC, lo: loC };
    (sp.kind === 'arm' ? arms : legs).push(limb);
  }
  const body = document.createElement('canvas'); body.width = w; body.height = h;
  const bi = body.getContext('2d').createImageData(w, h);
  for (let i = 0; i < N; i++) if (!owned[i]) { const s4 = i * 4; bi.data[s4] = d[s4]; bi.data[s4 + 1] = d[s4 + 1]; bi.data[s4 + 2] = d[s4 + 2]; bi.data[s4 + 3] = d[s4 + 3]; }
  body.getContext('2d').putImageData(bi, 0, 0);
  A.bodyCv = body; A.rig.arms = arms; A.rig.legs = legs; A.rig.painted = !!paint;
}

/** Paint enclosed transparent areas white so outline drawings look solid. */
function fillInside(d, w, h) {
  const N = w * h, am = new Uint8Array(N);
  for (let i = 0; i < N; i++) am[i] = d[i * 4 + 3] > 60 ? 1 : 0;
  const dl = dilate(am, w, h, 3);
  const ext = dilate(floodExterior(dl, w, h), w, h, 3);
  for (let i = 0; i < N; i++) {
    if (ext[i]) continue;
    const j = i * 4, a = d[j + 3] / 255;
    if (a >= 1) continue;
    d[j] = d[j] * a + 255 * (1 - a); d[j + 1] = d[j + 1] * a + 255 * (1 - a); d[j + 2] = d[j + 2] * a + 255 * (1 - a); d[j + 3] = 255;
  }
}

/* ---------------- rig: arms, legs, top of head ---------------- */
function analyzeRig(cv) {
  const charW = cv.width, charH = cv.height;
  const rig = { arms: [], legs: [], top: { x: charW / 2, y: 0 } };
  const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, charW, charH).data;
  const A = (x, y) => d[(y * charW + x) * 4 + 3] > 24;
  const rows = [];
  for (let y = 0; y < charH; y++) { let l = -1, r = -1; for (let x = 0; x < charW; x++) if (A(x, y)) { if (l < 0) l = x; r = x; } rows.push({ l, r }); }
  const firstRow = rows.findIndex((r) => r.l >= 0);
  if (firstRow >= 0) {
    let sx = 0, n = 0;
    for (let y = firstRow; y < Math.min(charH, firstRow + Math.max(6, charH * 0.06)); y++) if (rows[y].l >= 0) { sx += (rows[y].l + rows[y].r) / 2; n++; }
    rig.top = { x: n ? sx / n : charW / 2, y: firstRow };
  }
  const band = rows.slice(Math.floor(charH * 0.2), Math.floor(charH * 0.9)).filter((r) => r.l >= 0);
  if (band.length < 10) return rig;
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const ls = band.map((r) => r.l).sort((a, b) => a - b), rs = band.map((r) => r.r).sort((a, b) => a - b);
  const bodyL = q(ls, 0.7), bodyR = q(rs, 0.3);
  const minP = charW * 0.07;

  for (const side of [-1, 1]) {
    let a0 = -1, a1 = -1;
    for (let y = Math.floor(charH * 0.12); y < charH * 0.75; y++) {
      const r = rows[y]; if (r.l < 0) continue;
      const out = side < 0 ? r.l < bodyL - minP : r.r > bodyR + minP;
      if (out) { if (a0 < 0) a0 = y; a1 = y; }
    }
    if (a0 >= 0 && a1 - a0 > charH * 0.05) {
      const span = Math.round(charH * 0.12);
      let edge = side < 0 ? bodyL : bodyR;
      for (let y = Math.max(0, a0 - span); y < Math.min(charH, a1 + span); y++) {
        if (y >= a0 && y <= a1) continue;
        const r = rows[y]; if (r.l < 0) continue;
        edge = side < 0 ? Math.min(edge, r.l) : Math.max(edge, r.r);
      }
      const ay0 = Math.max(0, a0 - 6), ay1 = Math.min(charH, a1 + 6);
      const L = side < 0
        ? { side, x0: 0, x1: edge - 3, y0: ay0, y1: ay1, px: edge - 3, py: (a0 + a1) / 2 }
        : { side, x0: edge + 3, x1: charW, y0: ay0, y1: ay1, px: edge + 3, py: (a0 + a1) / 2 };
      // Arms are thin and long. A beak, a bulge or a filled shape is not an arm.
      let solid = 0;
      for (let y = L.y0; y < L.y1; y++) for (let x = Math.max(0, L.x0); x < Math.min(charW, L.x1); x++) if (A(x, y)) solid++;
      const area = Math.max(1, (L.x1 - L.x0) * (L.y1 - L.y0));
      if (L.x1 - L.x0 > minP * 0.8 && solid / area < 0.36 && (ay1 - ay0) < charH * 0.36) rig.arms.push(L);
    }
  }

  const by0 = Math.floor(charH * 0.86);
  const col = new Uint8Array(charW);
  for (let y = by0; y < charH; y++) for (let x = 0; x < charW; x++) if (A(x, y)) col[x] = 1;
  let best = null;
  for (let x = Math.floor(charW * 0.2); x < charW * 0.8; x++) {
    if (col[x]) continue;
    const s = x; while (x < charW && !col[x]) x++;
    const e = x, mid = (s + e) / 2;
    if (mid > charW * 0.28 && mid < charW * 0.72 && col.subarray(0, s).some((v) => v) && col.subarray(e).some((v) => v)) {
      if (!best || e - s > best.e - best.s) best = { s, e };
    }
  }
  if (best) {
    const gx = Math.round((best.s + best.e) / 2);
    let gy = charH - 1; while (gy > charH * 0.45 && !A(gx, gy)) gy--;
    if (charH - gy > charH * 0.08) {
      const meanX = (a, b) => { let s = 0, n = 0; for (let x = a; x < b; x++) if (col[x]) { s += x; n++; } return n ? s / n : (a + b) / 2; };
      rig.legs.push({ side: -1, x0: 0, x1: gx, y0: gy - 2, y1: charH, px: meanX(0, gx), py: gy });
      rig.legs.push({ side: 1, x0: gx, x1: charW, y0: gy - 2, y1: charH, px: meanX(gx, charW), py: gy });
    }
  }
  return rig;
}

/* ---------------- personality ---------------- */
function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const TRAITS = ['bouncy', 'giggly', 'brave', 'sleepy', 'zippy', 'curious', 'silly', 'shy'];
const MOVE_WORDS = { Walk: 'go for walks', Hop: 'hop around', Dance: 'dance', Wave: 'wave hello', Fly: 'fly', Swim: 'swim', Spin: 'spin', Jelly: 'wiggle like jelly' };

function makePersona(d, w, h, rig, centerY, k) {
  let hs = 2166136261 >>> 0;
  for (let i = 3; i < d.length; i += 2039) hs = Math.imul(hs ^ d[i] ^ d[i - 1] ^ d[i - 2], 16777619) >>> 0;
  const r = mulberry(hs ^ (w * 31 + h * 17 + k * 101));
  const hasLegs = rig.legs.length > 0, hasArms = rig.arms.length > 0, aspect = w / h;
  let c = [];
  if (hasLegs) c.push('Walk', 'Dance', 'Hop');
  if (hasArms) c.push('Wave', 'Dance');
  if (aspect > 1.35) c.push('Swim', 'Jelly');
  if (!hasLegs && !hasArms && aspect <= 1.35) c.push('Hop', 'Jelly', 'Spin');
  if (centerY < 0.4 || (hasArms && !hasLegs)) c.push('Fly');
  if (!c.length) c = ['Hop', 'Jelly'];
  const signature = c[Math.floor(r() * c.length)];
  let second = c[Math.floor(r() * c.length)];
  if (second === signature) second = ['Spin', 'Hop', 'Jelly', 'Dance'][Math.floor(r() * 4)];
  if (second === signature) second = 'Spin';
  return {
    signature, second,
    tempo: 0.75 + r() * 0.55, bounce: 0.6 + r() * 0.8, sway: 0.5 + r() * 1, armAmp: 0.6 + r() * 0.6,
    offset: r() * 20, trait: TRAITS[Math.floor(r() * TRAITS.length)], nameIdx: Math.floor(r() * NAMES.length),
  };
}

/* ---------------- poses ---------------- */
function pose(name, a, P, home, range, rig) {
  let x = home, lift = 0; const o = { wave: 0.25 * P.sway, phase: a * 5, sx: 1, sy: 1 };
  const B = P.bounce, AA = P.armAmp;
  switch (name) {
    case 'Walk': {
      const cyc = (a * 0.16) % 2, tri = cyc < 1 ? cyc : 2 - cyc; x = home + (tri * 2 - 1) * range; o.flip = cyc >= 1;
      const st = Math.sin(a * 7); lift = Math.abs(st) * 14 * B; o.rot = 0.05 * st;
      o.legL = 0.38 * st; o.legR = -0.38 * st; o.armL = -0.45 * st * AA; o.armR = 0.45 * st * AA; o.wave = 0.2; break;
    }
    case 'Hop': {
      const p = Math.abs(Math.sin(a * 3)); lift = p * 190 * B; x = home + Math.sin(a * 1.5) * range * 0.6;
      o.sy = p < 0.15 ? 0.84 + p : 1.05; o.sx = 1 / o.sy; o.legL = -0.35 * p; o.legR = 0.35 * p; o.armL = o.armR = 1.1 * p * AA; o.wave = 0.15; break;
    }
    case 'Dance': {
      o.rot = 0.2 * Math.sin(a * 4) * P.sway; x = home + Math.sin(a * 2) * range * 0.5; lift = Math.abs(Math.sin(a * 4)) * 26 * B;
      o.armL = (0.4 + Math.max(0, Math.sin(a * 4))) * AA; o.armR = (0.4 + Math.max(0, -Math.sin(a * 4))) * AA;
      o.legL = 0.3 * Math.max(0, Math.sin(a * 4)); o.legR = -0.3 * Math.max(0, -Math.sin(a * 4)); o.wave = 0.45; o.phase = a * 8; break;
    }
    case 'Wave': {
      o.rot = 0.04 * Math.sin(a * 2); lift = Math.max(0, Math.sin(a * 1.3)) ** 8 * 40 * B;
      const wv = 1.0 + 0.35 * Math.sin(a * 10);
      if (rig.arms.some((L) => L.side > 0)) { o.armR = wv; o.armL = 0.1 * Math.sin(a * 2); } else o.armL = wv;
      o.wave = 0.15; break;
    }
    case 'Fly': {
      x = home + Math.sin(a * 0.7) * range; lift = 150 + Math.sin(a * 2.3) * 36; o.rot = Math.cos(a * 0.7) * 0.2; o.flip = Math.cos(a * 0.7) < 0;
      const f = Math.sin(a * 12); o.armL = o.armR = 0.9 * f * AA; o.legL = 0.25; o.legR = -0.25; o.sy = 1 + 0.05 * f; o.wave = 0.3; break;
    }
    case 'Swim': {
      x = home + Math.sin(a * 0.6) * range; lift = 120 + Math.sin(a * 1.8) * 40; o.flip = Math.cos(a * 0.6) < 0;
      o.rot = (o.flip ? 1 : -1) * 0.25 + Math.sin(a * 3) * 0.08; o.wave = 0.9; o.phase = a * 6;
      o.armL = 0.8 * Math.sin(a * 5) * AA; o.armR = -0.8 * Math.sin(a * 5) * AA; o.legL = 0.3 * Math.sin(a * 9); o.legR = -0.3 * Math.sin(a * 9); break;
    }
    case 'Idle': {
      lift = 0; o.wave = 0.12; o.phase = a * 2; o.sy = 1 + 0.025 * Math.sin(a * 2.2); o.sx = 1 / o.sy;
      o.armL = 0.15 + 0.1 * Math.sin(a * 1.7) * AA; o.armR = 0.15 + 0.1 * Math.sin(a * 1.9 + 1) * AA; break;
    }
    case 'Spin': o.rot = a * 3.2; o.pivotMid = true; lift = 40 + Math.abs(Math.sin(a * 1.6)) * 60 * B; o.armL = o.armR = AA; break;
    default:
      o.wave = 1.1 * P.sway; o.phase = a * 6; o.sy = 1 + 0.06 * Math.sin(a * 6); o.sx = 1 / o.sy;
      o.armL = 0.3 * Math.sin(a * 6) * AA; o.armR = 0.3 * Math.sin(a * 6 + 1) * AA;
  }
  return { x, lift, o };
}

/* ---------------- drawing ---------------- */
function drawEye(c, x, y, r, blink, lx, ly) {
  const k = 1 - blink * 0.9;
  c.save(); c.translate(x, y);
  c.fillStyle = '#fff'; c.strokeStyle = '#1B1B2F'; c.lineWidth = r * 0.16;
  c.beginPath(); c.ellipse(0, 0, r, r * k, 0, 0, Math.PI * 2); c.fill(); c.stroke();
  if (k > 0.3) {
    c.fillStyle = '#1B1B2F'; c.beginPath(); c.ellipse(lx * r * 0.42, ly * r * 0.42 * k, r * 0.48, r * 0.48 * k, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(lx * r * 0.42 - r * 0.16, ly * r * 0.42 * k - r * 0.16 * k, r * 0.13, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}

function drawHat(c, type, x, y, size) {
  if (!type || type === 'none') return;
  c.save(); c.translate(x, y); c.lineJoin = 'round'; c.lineWidth = size * 0.05; c.strokeStyle = '#2A1F5C';
  if (type === 'crown') {
    const s = size * 0.5;
    c.beginPath(); c.moveTo(-s, s * 0.15); c.lineTo(-s, -s * 0.75); c.lineTo(-s * 0.5, -s * 0.3); c.lineTo(0, -s * 0.95); c.lineTo(s * 0.5, -s * 0.3); c.lineTo(s, -s * 0.75); c.lineTo(s, s * 0.15); c.closePath();
    c.fillStyle = '#FFC83D'; c.fill(); c.stroke();
    [[-s * 0.55, -s * 0.05, '#E0302B'], [0, -s * 0.12, '#2F80ED'], [s * 0.55, -s * 0.05, '#2BB673']].forEach(([gx, gy, col]) => { c.fillStyle = col; c.beginPath(); c.arc(gx, gy, s * 0.13, 0, Math.PI * 2); c.fill(); });
  } else if (type === 'party') {
    c.rotate(-0.18);
    const bw = size * 0.38, hh = size * 0.95;
    c.beginPath(); c.moveTo(-bw, size * 0.12); c.lineTo(0, -hh); c.lineTo(bw, size * 0.12); c.closePath();
    c.fillStyle = '#2F80ED'; c.fill();
    c.save(); c.clip(); c.fillStyle = '#FFC83D';
    for (let i = -3; i < 4; i++) { c.beginPath(); c.moveTo(-bw * 2, i * size * 0.28); c.lineTo(bw * 2, i * size * 0.28 - size * 0.25); c.lineTo(bw * 2, i * size * 0.28 - size * 0.12); c.lineTo(-bw * 2, i * size * 0.28 + size * 0.13); c.fill(); }
    c.restore();
    c.beginPath(); c.moveTo(-bw, size * 0.12); c.lineTo(0, -hh); c.lineTo(bw, size * 0.12); c.closePath(); c.stroke();
    c.fillStyle = '#FF8FB1'; c.beginPath(); c.arc(0, -hh, size * 0.13, 0, Math.PI * 2); c.fill(); c.stroke();
  } else if (type === 'bow') {
    const s = size * 0.42;
    c.fillStyle = '#FF5C93';
    c.beginPath(); c.moveTo(0, -s * 0.2); c.lineTo(-s, -s * 0.8); c.lineTo(-s, s * 0.4); c.closePath(); c.fill(); c.stroke();
    c.beginPath(); c.moveTo(0, -s * 0.2); c.lineTo(s, -s * 0.8); c.lineTo(s, s * 0.4); c.closePath(); c.fill(); c.stroke();
    c.beginPath(); c.arc(0, -s * 0.2, s * 0.28, 0, Math.PI * 2); c.fill(); c.stroke();
  } else if (type === 'cap') {
    const s = size * 0.5;
    c.fillStyle = '#E0302B';
    c.beginPath(); c.arc(0, s * 0.15, s * 0.8, Math.PI, 0); c.closePath(); c.fill(); c.stroke();
    c.beginPath(); c.ellipse(s * 0.75, s * 0.12, s * 0.6, s * 0.16, 0, 0, Math.PI * 2); c.fill(); c.stroke();
    c.fillStyle = '#FFC83D'; c.beginPath(); c.arc(0, -s * 0.66, s * 0.12, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}

function drawLimb(c, A, L, angle, bend, offAt) {
  c.save();
  c.translate(L.px - A.w / 2 + offAt(L.py), L.py - A.h);
  c.rotate(angle);
  c.drawImage(L.up, L.bx - L.px, L.by - L.py);
  c.translate(L.jx - L.px, L.jy - L.py);
  c.rotate(bend);
  c.drawImage(L.lo, L.bx - L.jx, L.by - L.jy);
  c.restore();
}

/** Draw actor A with its feet at (x, footY), scale s, pose options o. */
function drawActor(c, A, x, footY, s, o) {
  const W = A.w, H = A.h, rig = A.rig;
  c.save(); c.translate(x, footY);
  if (o.pivotMid) { c.translate(0, -H * s / 2); c.rotate(o.rot || 0); c.translate(0, H * s / 2); } else c.rotate(o.rot || 0);
  c.scale((o.flip ? -1 : 1) * s * (o.sx || 1), s * (o.sy || 1));
  const amp = (o.wave || 0) * W * 0.07, ph = o.phase || 0;
  const offAt = (y) => amp * Math.sin(ph + (y / H) * 4) * (1 - y / H);

  rig.legs.forEach((L) => {
    const a = L.side < 0 ? (o.legL || 0) : (o.legR || 0);
    const knee = (L.side < 0 ? o.kneeL : o.kneeR) ?? Math.abs(a) * 0.75;
    drawLimb(c, A, L, a, knee, offAt);
  });
  const body = A.bodyCv || A.cv, N = 30, sh = H / N;
  for (let i = 0; i < N; i++) { const y0 = i * sh; c.drawImage(body, 0, y0, W, sh + 1.2, -W / 2 + offAt(y0 + sh / 2), -H + y0, W, sh + 1.2); }
  rig.arms.forEach((L) => {
    const a = L.side < 0 ? (o.armL || 0) : -(o.armR || 0);
    const elbow = (L.side < 0 ? o.elbowL : o.elbowR) ?? a * 0.6;
    drawLimb(c, A, L, a, elbow, offAt);
  });

  A.eyes.forEach((e) => drawEye(c, e.x - W / 2 + offAt(e.y), e.y - H, ER, o.blink || 0, o.lx || 0, o.ly || 0));
  if (A.eyes.length && o.mood) drawMood(c, A, o, offAt);
  if (A.eyes.length && o.talk > 0.06) {
    const mx = A.eyes.reduce((a, e) => a + e.x, 0) / A.eyes.length, my = Math.max(...A.eyes.map((e) => e.y)) + ER * 2.1;
    c.fillStyle = '#3A0E1E'; c.beginPath(); c.ellipse(mx - W / 2 + offAt(my), my - H, ER * 0.7, ER * (0.15 + o.talk * 0.85), 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#FF6F91'; c.beginPath(); c.ellipse(mx - W / 2 + offAt(my), my - H + ER * o.talk * 0.45, ER * 0.38, ER * 0.18 * o.talk + 1, 0, 0, Math.PI * 2); c.fill();
  }
  const hatSize = Math.max(70, Math.min(230, W * 0.34));
  drawHat(c, o.hat, rig.top.x - W / 2 + offAt(rig.top.y), rig.top.y - H + hatSize * 0.08, hatSize);
  c.restore();
}

/** Eyebrows, cheeks and mouth for a feeling: happy, surprised, sad, angry. */
function drawMood(c, A, o, offAt) {
  const W = A.w, H = A.h, eyes = A.eyes, mood = o.mood;
  const mx = eyes.reduce((a, e) => a + e.x, 0) / eyes.length, my = Math.max(...eyes.map((e) => e.y)) + ER * 2.1;
  c.save(); c.strokeStyle = '#1B1B2F'; c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = ER * 0.26;
  eyes.forEach((e) => {
    const inner = eyes.length > 1 ? (e.x < mx ? 1 : -1) : 1;
    let tilt = 0, lift = 0;
    if (mood === 'angry') tilt = 0.5 * inner;
    if (mood === 'sad') tilt = -0.45 * inner;
    if (mood === 'surprised') lift = ER * 0.45;
    if (mood === 'happy') lift = ER * 0.12;
    c.save(); c.translate(e.x - W / 2 + offAt(e.y), e.y - H - ER * 1.42 - lift); c.rotate(tilt);
    c.beginPath();
    if (mood === 'happy' || mood === 'surprised') c.arc(0, ER * 0.55, ER * 0.85, -Math.PI * 0.78, -Math.PI * 0.22);
    else { c.moveTo(-ER * 0.8, 0); c.lineTo(ER * 0.8, 0); }
    c.stroke(); c.restore();
  });
  if (mood === 'happy') {
    c.fillStyle = 'rgba(255,95,140,.42)';
    eyes.forEach((e) => { const dx = eyes.length > 1 ? (e.x < mx ? -1 : 1) : 1; c.beginPath(); c.ellipse(e.x - W / 2 + offAt(e.y) + dx * ER * 0.5, e.y - H + ER * 1.45, ER * 0.5, ER * 0.3, 0, 0, Math.PI * 2); c.fill(); });
  }
  if (!(o.talk > 0.06)) {
    const x = mx - W / 2 + offAt(my), y = my - H;
    c.lineWidth = ER * 0.24; c.beginPath();
    if (mood === 'happy') { c.arc(x, y - ER * 0.7, ER * 0.95, Math.PI * 0.15, Math.PI * 0.85); c.stroke(); }
    else if (mood === 'sad') { c.arc(x, y + ER * 0.75, ER * 0.75, Math.PI * 1.2, Math.PI * 1.8); c.stroke(); }
    else if (mood === 'surprised') { c.fillStyle = '#3A0E1E'; c.ellipse(x, y, ER * 0.42, ER * 0.58, 0, 0, Math.PI * 2); c.fill(); }
    else if (mood === 'angry') { c.moveTo(x - ER * 0.8, y); for (let i = 1; i <= 4; i++) c.lineTo(x - ER * 0.8 + i * ER * 0.4, y + (i % 2 ? -ER * 0.2 : 0)); c.stroke(); }
  }
  c.restore();
}

/** Speech bubble whose tail points at (hx, hy). */
function drawBubble(c, text, hx, hy, Wd) {
  c.save();
  c.font = "600 28px Lexend, system-ui, sans-serif";
  const words = text.split(/\s+/), lines = []; let line = '';
  for (const wd of words) { const t = line ? line + ' ' + wd : wd; if (c.measureText(t).width > 380 && line) { lines.push(line); line = wd; } else line = t; }
  if (line) lines.push(line);
  if (lines.length > 4) { lines.length = 4; lines[3] += '…'; }
  const lh = 36, pad = 18;
  const bw = Math.min(440, Math.max(...lines.map((l) => c.measureText(l).width)) + pad * 2), bh = lines.length * lh + pad * 2 - 8;
  let bx = Math.max(12, Math.min(Wd - bw - 12, hx - bw / 2));
  let by = Math.max(12, hy - 34 - bh);
  const tailX = Math.max(bx + 24, Math.min(bx + bw - 24, hx));
  c.fillStyle = '#fff'; c.strokeStyle = '#1F2A5C'; c.lineWidth = 4;
  c.beginPath(); c.roundRect(bx, by, bw, bh, 22); c.fill(); c.stroke();
  c.beginPath(); c.moveTo(tailX - 14, by + bh - 2); c.lineTo(tailX, Math.min(hy - 6, by + bh + 26)); c.lineTo(tailX + 14, by + bh - 2); c.closePath(); c.fill();
  c.beginPath(); c.moveTo(tailX - 14, by + bh); c.lineTo(tailX, Math.min(hy - 6, by + bh + 26)); c.lineTo(tailX + 14, by + bh); c.stroke();
  c.fillStyle = '#1F2A5C'; c.textBaseline = 'top';
  lines.forEach((l, i) => c.fillText(l, bx + pad, by + pad - 2 + i * lh));
  c.restore();
}

return { ER, NAMES, MAX_ACTORS, segmentActors, actorFromCanvas, LIMB_KEYS, finishRig, TRAITS, MOVE_WORDS, pose, drawEye, drawHat, drawActor, drawBubble };
})();

// ---- scenes ----
const { W, H, GY, SCENES, drawScene } = (() => {
// Animated backgrounds for the stage (1280 x 720).
const W = 1280;
const H = 720;
const GY = H * 0.88;
const rnd = (a, b) => a + Math.random() * (b - a);

const SCENES = [['meadow', 'Meadow'], ['ocean', 'Under the sea'], ['space', 'Outer space'], ['snow', 'Snow day'], ['party', 'Party']];

const starsBG = Array.from({ length: 120 }, () => ({ x: rnd(0, W), y: rnd(0, GY), r: rnd(0.8, 2.6), p: rnd(0, 6) }));
const bubbles = Array.from({ length: 26 }, () => ({ x: rnd(0, W), y: rnd(0, H), r: rnd(5, 18), s: rnd(30, 80) }));
const confetti = Array.from({ length: 90 }, () => ({ x: rnd(0, W), y: rnd(-H, H), s: rnd(50, 120), r: rnd(0, 6), c: ['#F2552C', '#FFC83D', '#2BB673', '#2F80ED', '#FF8FB1', '#8E6CF0'][Math.floor(rnd(0, 6))] }));
const clouds = Array.from({ length: 4 }, (_, i) => ({ x: i * 360 + rnd(0, 120), y: rnd(70, 200), s: rnd(0.7, 1.2) }));
const flakes = Array.from({ length: 110 }, () => ({ x: rnd(0, W), y: rnd(-H, H), r: rnd(2, 6), s: rnd(25, 70), p: rnd(0, 6) }));

function cloud(c, x, y, s) {
  c.fillStyle = 'rgba(255,255,255,.92)'; c.beginPath();
  [[0, 0, 40], [40, -18, 50], [90, 0, 42], [45, 14, 44]].forEach(([dx, dy, r]) => { c.moveTo(x + dx * s + r * s, y + dy * s); c.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2); });
  c.fill();
}
function pine(c, x, base, h) {
  c.fillStyle = '#5B3A1E'; c.fillRect(x - h * 0.05, base - h * 0.15, h * 0.1, h * 0.15);
  c.fillStyle = '#1E6B4A';
  for (let i = 0; i < 3; i++) { const y = base - h * 0.12 - i * h * 0.27, wd = h * (0.42 - i * 0.1); c.beginPath(); c.moveTo(x - wd, y); c.lineTo(x, y - h * 0.38); c.lineTo(x + wd, y); c.closePath(); c.fill(); }
  c.fillStyle = '#fff';
  for (let i = 0; i < 3; i++) { const y = base - h * 0.12 - i * h * 0.27; c.beginPath(); c.moveTo(x - h * 0.08, y - h * 0.3); c.lineTo(x, y - h * 0.38); c.lineTo(x + h * 0.08, y - h * 0.3); c.closePath(); c.fill(); }
}

function drawScene(c, t, dt, scene, photo) {
  if (scene === 'photo' && photo) {
    const k = Math.max(W / photo.width, H / photo.height), pw = photo.width * k, ph = photo.height * k;
    c.drawImage(photo, (W - pw) / 2, (H - ph) / 2, pw, ph);
    const g = c.createLinearGradient(0, GY - 40, 0, H); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.28)');
    c.fillStyle = g; c.fillRect(0, GY - 40, W, H - GY + 40);
    return;
  }
  if (scene === 'ocean') {
    const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#1FA2D6'); g.addColorStop(1, '#08436E'); c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(255,255,255,.07)'; for (let i = 0; i < 5; i++) { const x = i * 300 + Math.sin(t * 0.5 + i) * 40; c.beginPath(); c.moveTo(x, 0); c.lineTo(x + 120, 0); c.lineTo(x + 40, GY); c.lineTo(x - 60, GY); c.fill(); }
    for (let i = 0; i < 7; i++) { const x = 80 + i * 190; c.strokeStyle = i % 2 ? '#2BB673' : '#1E8C57'; c.lineWidth = 12; c.lineCap = 'round'; c.beginPath(); c.moveTo(x, GY + 10); for (let k = 1; k <= 6; k++) c.lineTo(x + Math.sin(t * 1.6 + k * 0.8 + i) * 14, GY + 10 - k * 28); c.stroke(); }
    c.fillStyle = '#E9D29A'; c.fillRect(0, GY, W, H - GY);
    c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 2.5;
    bubbles.forEach((b) => { b.y -= b.s * dt; if (b.y < -20) { b.y = H + 10; b.x = rnd(0, W); } c.beginPath(); c.arc(b.x + Math.sin(t * 2 + b.r) * 6, b.y, b.r, 0, Math.PI * 2); c.stroke(); });
  } else if (scene === 'space') {
    const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#0B0E2E'); g.addColorStop(1, '#2A1B5C'); c.fillStyle = g; c.fillRect(0, 0, W, H);
    starsBG.forEach((s) => { c.globalAlpha = 0.45 + 0.55 * Math.abs(Math.sin(t * 1.4 + s.p)); c.fillStyle = '#fff'; c.beginPath(); c.arc(s.x, s.y, s.r, 0, Math.PI * 2); c.fill(); }); c.globalAlpha = 1;
    c.save(); c.translate(1030, 170); c.fillStyle = '#FF8FB1'; c.beginPath(); c.arc(0, 0, 78, 0, Math.PI * 2); c.fill();
    c.fillStyle = 'rgba(255,255,255,.18)'; c.beginPath(); c.arc(-20, -24, 26, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#FFC83D'; c.lineWidth = 9; c.beginPath(); c.ellipse(0, 0, 130, 26, -0.3, 0, Math.PI * 2); c.stroke(); c.restore();
    c.fillStyle = '#C7C3D9'; c.fillRect(0, GY, W, H - GY); c.fillStyle = '#A9A4C2';
    [[120, 30, 40], [480, 20, 26], [860, 40, 34], [1180, 22, 30]].forEach(([x, dy, r]) => { c.beginPath(); c.ellipse(x, GY + dy, r, r * 0.35, 0, 0, Math.PI * 2); c.fill(); });
  } else if (scene === 'snow') {
    const g = c.createLinearGradient(0, 0, 0, GY); g.addColorStop(0, '#8EBFE8'); g.addColorStop(1, '#E3F0FA'); c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.fillStyle = '#C9DCEE'; c.beginPath(); c.moveTo(0, GY - 120); c.lineTo(180, GY - 300); c.lineTo(380, GY - 140); c.lineTo(600, GY - 330); c.lineTo(860, GY - 150); c.lineTo(1080, GY - 290); c.lineTo(W, GY - 160); c.lineTo(W, GY); c.lineTo(0, GY); c.fill();
    c.fillStyle = '#F7FBFF'; [[180, 300], [600, 330], [1080, 290]].forEach(([x, hgt]) => { c.beginPath(); c.moveTo(x - 55, GY - hgt + 70); c.lineTo(x, GY - hgt); c.lineTo(x + 55, GY - hgt + 70); c.closePath(); c.fill(); });
    [[90, 170], [250, 130], [1010, 160], [1190, 200]].forEach(([x, hgt]) => pine(c, x, GY + 8, hgt));
    c.fillStyle = '#F4F8FC'; c.fillRect(0, GY, W, H - GY);
    c.fillStyle = '#DCE8F4'; for (let i = 0; i < 6; i++) { c.beginPath(); c.ellipse(i * 240 + 60, GY + 40, 120, 14, 0, 0, Math.PI * 2); c.fill(); }
    c.fillStyle = '#fff';
    flakes.forEach((f) => { f.y += f.s * dt; if (f.y > H) { f.y = -10; f.x = rnd(0, W); } c.beginPath(); c.arc(f.x + Math.sin(t + f.p) * 14, f.y, f.r, 0, Math.PI * 2); c.fill(); });
  } else if (scene === 'party') {
    c.fillStyle = '#FFE6F0'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#FFD1E3'; for (let i = 0; i < 14; i++) c.fillRect(i * 96, 0, 48, GY);
    for (let i = 0; i < 9; i++) { const x = i * 160 + 40; c.strokeStyle = '#E5A0BD'; c.lineWidth = 2; c.beginPath(); c.moveTo(x, 0); c.quadraticCurveTo(x + 80, 60, x + 160, 0); c.stroke(); c.fillStyle = ['#F2552C', '#FFC83D', '#2BB673', '#2F80ED'][i % 4]; c.beginPath(); c.moveTo(x + 60, 32); c.lineTo(x + 100, 32); c.lineTo(x + 80, 70); c.fill(); }
    c.fillStyle = '#8E6CF0'; c.fillRect(0, GY, W, H - GY);
    confetti.forEach((p) => { p.y += p.s * dt; p.r += dt * 3; if (p.y > GY) { p.y = -10; p.x = rnd(0, W); } c.save(); c.translate(p.x + Math.sin(t + p.r) * 10, p.y); c.rotate(p.r); c.fillStyle = p.c; c.fillRect(-6, -3, 12, 6); c.restore(); });
  } else {
    const g = c.createLinearGradient(0, 0, 0, GY); g.addColorStop(0, '#5BB8F5'); g.addColorStop(1, '#C9ECFF'); c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.save(); c.translate(1090, 120); c.rotate(t * 0.2); c.fillStyle = '#FFD84D';
    for (let i = 0; i < 12; i++) { c.rotate(Math.PI / 6); c.beginPath(); c.moveTo(70, -10); c.lineTo(110, 0); c.lineTo(70, 10); c.fill(); }
    c.beginPath(); c.arc(0, 0, 58, 0, Math.PI * 2); c.fill(); c.restore();
    clouds.forEach((cl) => { cl.x += dt * 14 * cl.s; if (cl.x > W + 160) cl.x = -200; cloud(c, cl.x, cl.y, cl.s); });
    c.fillStyle = '#7BCB5B'; c.beginPath(); c.ellipse(260, GY + 40, 520, 170, 0, Math.PI, 0); c.fill();
    c.fillStyle = '#66BB47'; c.beginPath(); c.ellipse(1050, GY + 50, 560, 150, 0, Math.PI, 0); c.fill();
    c.fillStyle = '#4FA637'; c.fillRect(0, GY, W, H - GY);
    for (let i = 0; i < 16; i++) { const x = (i * 83 + 40) % W, y = GY + 18 + (i % 3) * 14, s = Math.sin(t * 2 + i) * 3; c.strokeStyle = '#2E7D32'; c.lineWidth = 3; c.beginPath(); c.moveTo(x, y + 12); c.lineTo(x + s, y); c.stroke(); c.fillStyle = ['#FF8FB1', '#FFF', '#FFC83D'][i % 3]; c.beginPath(); c.arc(x + s, y, 6, 0, Math.PI * 2); c.fill(); }
  }
}

return { W, H, GY, SCENES, drawScene };
})();

// ---- gate ----
const { parentGate } = (() => {
// "Grown-ups only" check before signing in or posting to YouTube.
let passedAt = 0;
let el = null;

function build() {
  el = document.createElement('div');
  el.className = 'gate'; el.hidden = true;
  el.innerHTML = `
    <div class="gate-card" role="dialog" aria-modal="true" aria-labelledby="gateTitle">
      <h3 id="gateTitle">Grown-ups only</h3>
      <p>Please ask a grown-up to answer this to continue.</p>
      <label for="gateIn" id="gateQ" class="gate-q"></label>
      <input id="gateIn" type="text" inputmode="numeric" autocomplete="off">
      <p class="gate-err" id="gateErr" hidden>That's not it. Here's a new one.</p>
      <div class="row">
        <button class="btn go" id="gateOk">Continue</button>
        <button class="btn small" id="gateNo">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });
}
function close() { el.hidden = true; }

let answer = 0, pending = null;
function newQuestion() {
  const a = 3 + Math.floor(Math.random() * 7), b = 4 + Math.floor(Math.random() * 6);
  answer = a * b;
  el.querySelector('#gateQ').textContent = `What is ${a} × ${b}?`;
  el.querySelector('#gateIn').value = '';
}

/** Runs `action` right away if a grown-up passed in the last 10 minutes; otherwise asks first.
 *  `action` runs inside the Continue click, so it may open sign-in pop-ups. */
function parentGate(action) {
  if (Date.now() - passedAt < 10 * 60 * 1000) { action(); return; }
  if (!el) build();
  pending = action; newQuestion(); el.querySelector('#gateErr').hidden = true; el.hidden = false;
  setTimeout(() => el.querySelector('#gateIn').focus(), 30);
  const ok = el.querySelector('#gateOk'), no = el.querySelector('#gateNo'), input = el.querySelector('#gateIn');
  const submit = () => {
    if (parseInt(input.value, 10) === answer) { passedAt = Date.now(); close(); const a = pending; pending = null; a && a(); }
    else { el.querySelector('#gateErr').hidden = false; newQuestion(); input.focus(); }
  };
  ok.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
  no.onclick = close;
}

return { parentGate };
})();

// ---- firebase ----
const { app, auth, db, signInGoogle, getYouTubeToken, signOutUser, onUser, saveCharacter, listCharacters, deleteCharacter, saveLibraryChar, listLibrary, deleteLibraryChar, friendlyAuthError } = (() => {

// Firebase web config is public by design; security comes from Firestore rules (see firestore.rules).
const firebaseConfig = {
  apiKey: 'AIzaSyAA7gx3OZeBXQJPndJsRMdp8K3gJ6gSYtE',
  authDomain: 'drawfina-8af10.firebaseapp.com',
  projectId: 'drawfina-8af10',
  storageBucket: 'drawfina-8af10.firebasestorage.app',
  messagingSenderId: '1016665340296',
  appId: '1:1016665340296:web:8440526c2b3b0d2128623d',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const YT_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
const YT_FULL = 'https://www.googleapis.com/auth/youtube'; // only needed to add videos to a playlist
let ytToken = null;
let ytTokenAt = 0;
let ytScopes = [];

/** Google sign-in. `scopes` are extra permissions (YouTube) to ask for. */
async function signInGoogle(scopes = []) {
  const provider = new GoogleAuthProvider();
  scopes.forEach((sc) => provider.addScope(sc));
  provider.setCustomParameters({ prompt: 'select_account' });
  const res = await signInWithPopup(auth, provider);
  if (scopes.length) {
    const cred = GoogleAuthProvider.credentialFromResult(res);
    ytToken = cred?.accessToken || null;
    ytTokenAt = Date.now();
    ytScopes = scopes.slice();
  }
  return res.user;
}

/** A YouTube access token (lasts about an hour). Call it first thing inside a click. */
async function getYouTubeToken(needPlaylist = false) {
  const want = needPlaylist ? [YT_UPLOAD, YT_FULL] : [YT_UPLOAD];
  if (ytToken && Date.now() - ytTokenAt < 50 * 60 * 1000 && want.every((sc) => ytScopes.includes(sc))) return ytToken;
  await signInGoogle(want);
  if (!ytToken) throw Object.assign(new Error('No YouTube permission was given.'), { code: 'yt/no-token' });
  return ytToken;
}

function signOutUser() {
  ytToken = null;
  return signOut(auth);
}

const onUser = (cb) => onAuthStateChanged(auth, cb);

async function saveCharacter(uid, data) {
  const ref = await addDoc(collection(db, 'users', uid, 'characters'), { ...data, createdAt: serverTimestamp() });
  return ref.id;
}

async function listCharacters(uid) {
  const q = query(collection(db, 'users', uid, 'characters'), orderBy('createdAt', 'desc'), limit(24));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

const deleteCharacter = (uid, id) => deleteDoc(doc(db, 'users', uid, 'characters', id));

/* Saved characters ("My characters"), so they follow the family to other devices. */
async function saveLibraryChar(uid, item) {
  await setDoc(doc(db, 'users', uid, 'library', item.id), { ...item, createdAt: serverTimestamp() });
}
async function listLibrary(uid) {
  const q = query(collection(db, 'users', uid, 'library'), orderBy('createdAt', 'desc'), limit(40));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
}
const deleteLibraryChar = (uid, id) => deleteDoc(doc(db, 'users', uid, 'library', id));

function friendlyAuthError(e) {
  const c = e?.code || '';
  if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request') return '';
  if (c === 'auth/popup-blocked') return 'The sign-in window was blocked. Allow pop-ups for this site and try again.';
  if (c === 'auth/unauthorized-domain') return 'This website is not allowed to sign in yet. Add it in Firebase → Authentication → Settings → Authorized domains.';
  if (c === 'auth/operation-not-allowed') return 'Google sign-in is turned off. Turn it on in Firebase → Authentication → Sign-in method.';
  if (c === 'auth/configuration-not-found' || c === 'auth/admin-restricted-operation')
    return 'Sign-in is not set up yet. In the Firebase console open Authentication, press Get started, then turn on Google under Sign-in method.';
  if (c === 'auth/network-request-failed') return 'No internet connection. Check the Wi-Fi and try again.';
  if (c === 'auth/web-storage-unsupported') return 'This browser is blocking sign-in. Turn off private browsing and try again.';
  if (c === 'yt/no-token') return 'YouTube permission was not given. Tick the YouTube box when Google asks.';
  return 'Sign-in did not work. Try again.' + (c ? ` (${c.replace('auth/', '')})` : '');
}

return { app, auth, db, signInGoogle, getYouTubeToken, signOutUser, onUser, saveCharacter, listCharacters, deleteCharacter, saveLibraryChar, listLibrary, deleteLibraryChar, friendlyAuthError };
})();

// ---- youtube ----
const { uploadToYouTube, addToPlaylist, setThumbnail } = (() => {
// YouTube Data API v3: resumable video upload + custom thumbnail, straight from the browser.
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const THUMB = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=';

async function uploadToYouTube({ token, blob, title, description, tags, privacy, madeForKids, publishAt, onProgress }) {
  const type = (blob.type || 'video/webm').split(';')[0];
  const cleanTags = [];
  let len = 0;
  for (const t of tags || []) {
    const v = String(t).replace(/[<>]/g, '').trim().slice(0, 60);
    if (!v || cleanTags.includes(v)) continue;
    len += v.length + (v.includes(' ') ? 3 : 1);
    if (len > 480) break;
    cleanTags.push(v);
  }
  const meta = {
    snippet: {
      title: (title || 'My Doodle Alive movie').replace(/[<>]/g, '').slice(0, 100),
      description: (description || '').replace(/[<>]/g, '').slice(0, 4900),
      categoryId: '1', // Film & Animation
      tags: cleanTags,
      defaultLanguage: 'en',
    },
    status: { privacyStatus: privacy, selfDeclaredMadeForKids: !!madeForKids, embeddable: true },
  };
  if (publishAt) { meta.status.privacyStatus = 'private'; meta.status.publishAt = publishAt; }

  const init = await fetch(UPLOAD, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': type,
      'X-Upload-Content-Length': String(blob.size),
    },
    body: JSON.stringify(meta),
  });
  if (!init.ok) throw new Error(explain(init.status, await init.text()));
  const uploadUrl = init.headers.get('Location');
  if (!uploadUrl) throw new Error("YouTube didn't return an upload address. Try again.");

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); }
      } else reject(new Error(explain(xhr.status, xhr.responseText)));
    };
    xhr.onerror = () => reject(new Error('The connection dropped during upload. Check the internet and try again.'));
    xhr.send(blob);
  });
}

/** Adds the video to the playlist with this name, creating the playlist if needed. Returns '' or a reason. */
async function addToPlaylist(token, videoId, name, privacy) {
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const API = 'https://www.googleapis.com/youtube/v3/';
  try {
    let r = await fetch(API + 'playlists?part=snippet&mine=true&maxResults=50', { headers: H });
    if (!r.ok) return `Couldn't open your playlists (error ${r.status}).`;
    let pl = ((await r.json()).items || []).find((p) => p.snippet.title.trim().toLowerCase() === name.trim().toLowerCase());
    if (!pl) {
      r = await fetch(API + 'playlists?part=snippet,status', { method: 'POST', headers: H, body: JSON.stringify({ snippet: { title: name.slice(0, 150), description: 'Made with Doodle Alive' }, status: { privacyStatus: privacy === 'private' ? 'private' : privacy } }) });
      if (!r.ok) return `Couldn't make the playlist (error ${r.status}).`;
      pl = await r.json();
    }
    r = await fetch(API + 'playlistItems?part=snippet', { method: 'POST', headers: H, body: JSON.stringify({ snippet: { playlistId: pl.id, resourceId: { kind: 'youtube#video', videoId } } }) });
    return r.ok ? '' : `Couldn't add it to the playlist (error ${r.status}).`;
  } catch {
    return "Couldn't reach YouTube to add it to the playlist.";
  }
}

/** Returns '' on success or a friendly reason the thumbnail was skipped. */
async function setThumbnail(token, videoId, jpegBlob) {
  try {
    const r = await fetch(THUMB + encodeURIComponent(videoId), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: jpegBlob });
    if (r.ok) return '';
    const body = await r.text();
    if (r.status === 403) return 'Custom thumbnails need a verified YouTube account (verify at youtube.com/verify), so YouTube picked one.';
    return `YouTube picked the thumbnail (error ${r.status}${/forbidden|permission/i.test(body) ? ', no permission' : ''}).`;
  } catch {
    return 'YouTube picked the thumbnail (connection problem).';
  }
}

function explain(status, body = '') {
  if (status === 401) return 'Your Google sign-in expired. Press Post again to sign in.';
  if (/youtubeSignupRequired/.test(body)) return 'This Google account has no YouTube channel yet. Create one on youtube.com, then try again.';
  if (/quotaExceeded|uploadLimitExceeded/.test(body)) return 'The YouTube upload limit for today is reached. Try again tomorrow.';
  if (/accessNotConfigured|has not been used|SERVICE_DISABLED/i.test(body)) return 'The YouTube Data API is not turned on for this project yet (see README, step 4).';
  if (/invalidTags/.test(body)) return 'YouTube did not accept one of the keywords. Remove unusual characters and try again.';
  if (/invalidTitle/.test(body)) return 'YouTube did not accept the title. Make it shorter and try again.';
  if (status === 403) return 'YouTube refused the upload. Make sure you allowed YouTube access when signing in.';
  return `The upload failed (error ${status}). Try again.`;
}

return { uploadToYouTube, addToPlaylist, setThumbnail };
})();

// ---- store ----
const { idbPut, idbAll, idbDel } = (() => {
// Small IndexedDB wrapper: scenes, movies, sounds and saved characters live on this device.
const DB_NAME = 'doodle-alive';
const STORES = ['scenes', 'movies', 'sounds', 'library'];
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      if (!window.indexedDB) { rej(new Error('no indexedDB')); return; }
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { const d = r.result; for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbPromise;
}

async function idbPut(store, value) {
  const d = await openDb();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, 'readwrite'); tx.objectStore(store).put(value);
    tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
  });
}

async function idbAll(store) {
  const d = await openDb();
  return new Promise((res, rej) => {
    const r = d.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
  });
}

async function idbDel(store, id) {
  const d = await openDb();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, 'readwrite'); tx.objectStore(store).delete(id);
    tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
  });
}

return { idbPut, idbAll, idbDel };
})();

// ---- app ----

if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    this.moveTo(x + r, y); this.arcTo(x + w, y, x + w, y + h, r); this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r); this.arcTo(x, y, x + w, y, r); this.closePath();
  };
}

const $ = (id) => document.getElementById(id);
const DW = 1000, DH = 750;
const rnd = (a, b) => a + Math.random() * (b - a);
const LS_KEY = 'doodle-alive:v2';

let toastT;
function toast(msg, ms = 3200) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }

function chipGroup(el, items, cur, cb) {
  el.innerHTML = '';
  items.forEach(([v, label]) => {
    const b = document.createElement('button'); b.className = 'chip'; b.textContent = label; b.dataset.v = v;
    b.setAttribute('aria-pressed', String(v) === String(cur));
    b.onclick = () => { setPressed(el, v); cb(v); };
    el.appendChild(b);
  });
}
const setPressed = (el, v) => [...el.children].forEach((x) => x.setAttribute('aria-pressed', x.dataset.v === String(v)));


/* =========================================================
   DRAWING
   ========================================================= */
const draw = $('draw'), dctx = draw.getContext('2d', { willReadFrequently: true });
const ov = $('eyesOv'), octx = ov.getContext('2d');
const COLORS = ['#1F2A5C', '#F2552C', '#FF8FB1', '#FFC83D', '#2BB673', '#2F80ED', '#8E6CF0', '#8B5A2B', '#00B5B8', '#E0302B', '#9AA3B5', 'rainbow'];
let color = COLORS[0], size = 14, tool = 'crayon', hue = 0;
let eyes = [], undoStack = [], drawing = false, last = null;
let sampleIntact = true;

const sw = $('swatches');
COLORS.forEach((c, i) => {
  const b = document.createElement('button'); b.className = 'sw' + (c === 'rainbow' ? ' rainbow' : '');
  if (c !== 'rainbow') b.style.background = c;
  b.setAttribute('aria-label', c === 'rainbow' ? 'Rainbow crayon' : 'Crayon color ' + (i + 1));
  b.setAttribute('aria-pressed', i === 0);
  b.onclick = () => { color = c; [...sw.children].forEach((x) => x.setAttribute('aria-pressed', x === b)); setTool('crayon'); };
  sw.appendChild(b);
});
const sizesEl = $('sizes');
[[7, 10], [14, 16], [30, 26]].forEach(([s, d], i) => {
  const b = document.createElement('button'); b.className = 'size'; b.setAttribute('aria-label', 'Size ' + (i + 1)); b.setAttribute('aria-pressed', i === 1);
  b.innerHTML = `<i style="width:${d}px;height:${d}px"></i>`;
  b.onclick = () => { size = s; [...sizesEl.children].forEach((x) => x.setAttribute('aria-pressed', x === b)); };
  sizesEl.appendChild(b);
});
function setTool(t) {
  tool = t;
  document.querySelectorAll('#tools .chip').forEach((x) => x.setAttribute('aria-pressed', x.dataset.tool === t));
  $('eyesHint').hidden = t !== 'eyes'; draw.style.cursor = t === 'eyes' ? 'pointer' : 'crosshair';
}
document.querySelectorAll('#tools .chip').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

function touched() { if (sampleIntact) { sampleIntact = false; $('exampleTag').hidden = true; } }
function changed() { actorsDirty = true; saveLocal(); }
function pushUndo() { undoStack.push({ img: dctx.getImageData(0, 0, DW, DH), eyes: eyes.map((e) => ({ ...e })) }); if (undoStack.length > 25) undoStack.shift(); }
$('undo').onclick = () => { const s = undoStack.pop(); if (!s) return toast('Nothing to undo'); dctx.putImageData(s.img, 0, 0); eyes = s.eyes; renderEyesOv(); changed(); };
$('clear').onclick = () => { pushUndo(); touched(); dctx.clearRect(0, 0, DW, DH); eyes = []; renderEyesOv(); hidePhotoBox(); forgetCast(); changed(); };
function forgetCast() { actors = []; pendingSettings = null; titleEdited = false; }
$('fillBtn').onchange = () => { actorsDirty = true; };

function pos(e) { const r = draw.getBoundingClientRect(); return { x: (e.clientX - r.left) * DW / r.width, y: (e.clientY - r.top) * DH / r.height }; }
function strokeTo(p) {
  dctx.lineCap = 'round'; dctx.lineJoin = 'round'; dctx.lineWidth = size;
  if (tool === 'eraser') { dctx.globalCompositeOperation = 'destination-out'; dctx.strokeStyle = '#000'; dctx.lineWidth = size * 2.2; }
  else { dctx.globalCompositeOperation = 'source-over'; if (color === 'rainbow') { hue = (hue + 5) % 360; dctx.strokeStyle = `hsl(${hue} 85% 55%)`; } else dctx.strokeStyle = color; }
  dctx.beginPath(); dctx.moveTo(last.x, last.y); dctx.lineTo(p.x + 0.01, p.y); dctx.stroke();
  dctx.globalCompositeOperation = 'source-over'; last = p;
}
draw.addEventListener('pointerdown', (e) => {
  const p = pos(e); touched();
  if (tool === 'eyes') {
    pushUndo();
    const hit = eyes.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < ER * 1.2);
    if (hit >= 0) eyes.splice(hit, 1);
    else if (eyes.length >= 12) { toast('That is a lot of eyes! Remove one first.'); return; }
    else eyes.push(p);
    renderEyesOv(); changed(); return;
  }
  pushUndo(); drawing = true; last = p; draw.setPointerCapture(e.pointerId); strokeTo(p);
});
draw.addEventListener('pointermove', (e) => { if (drawing) strokeTo(pos(e)); });
['pointerup', 'pointercancel'].forEach((t) => draw.addEventListener(t, () => { if (drawing) { drawing = false; changed(); } }));
function renderEyesOv() { octx.clearRect(0, 0, DW, DH); eyes.forEach((e) => drawEye(octx, e.x, e.y, ER, 0, 0.2, 0.1)); }

/* example drawing: a monster and a little bird */
function drawSample() {
  const c = dctx; c.lineCap = 'round'; c.lineJoin = 'round';
  const O = '#2A1F5C';
  c.save(); c.translate(-170, 0);
  c.lineWidth = 14; c.strokeStyle = O;
  c.beginPath(); c.moveTo(440, 560); c.lineTo(432, 650); c.moveTo(560, 560); c.lineTo(568, 650); c.stroke();
  c.fillStyle = '#FF8FB1';
  [[420, 662], [580, 662]].forEach(([x, y]) => { c.beginPath(); c.ellipse(x, y, 42, 20, 0, 0, Math.PI * 2); c.fill(); c.lineWidth = 10; c.stroke(); });
  c.lineWidth = 14; c.beginPath(); c.moveTo(340, 420); c.quadraticCurveTo(270, 410, 250, 330); c.moveTo(660, 420); c.quadraticCurveTo(730, 410, 750, 330); c.stroke();
  c.fillStyle = '#FFC83D'; [[248, 318], [752, 318]].forEach(([x, y]) => { c.beginPath(); c.arc(x, y, 24, 0, Math.PI * 2); c.fill(); c.lineWidth = 10; c.stroke(); });
  c.lineWidth = 10;
  c.beginPath(); c.moveTo(415, 262); c.lineTo(392, 165); c.lineTo(470, 235); c.closePath(); c.fill(); c.stroke();
  c.beginPath(); c.moveTo(585, 262); c.lineTo(608, 165); c.lineTo(530, 235); c.closePath(); c.fill(); c.stroke();
  c.fillStyle = '#8E6CF0'; c.lineWidth = 14;
  c.beginPath(); c.moveTo(390, 570); c.bezierCurveTo(300, 540, 295, 320, 380, 262); c.bezierCurveTo(440, 215, 560, 215, 620, 262); c.bezierCurveTo(705, 320, 700, 540, 610, 570); c.quadraticCurveTo(500, 600, 390, 570); c.closePath(); c.fill(); c.stroke();
  c.fillStyle = '#B9A6FF'; c.beginPath(); c.ellipse(500, 490, 95, 62, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#6A4BD8'; [[372, 380, 16], [640, 420, 20], [610, 330, 11]].forEach(([x, y, r]) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); });
  c.lineWidth = 12; c.beginPath(); c.moveTo(445, 418); c.quadraticCurveTo(500, 465, 555, 418); c.stroke();
  c.fillStyle = '#fff'; c.beginPath(); c.moveTo(482, 433); c.lineTo(492, 452); c.lineTo(504, 435); c.closePath(); c.fill(); c.lineWidth = 5; c.stroke();
  c.restore();
  // bird
  c.strokeStyle = O; c.lineWidth = 10;
  c.beginPath(); c.moveTo(770, 590); c.lineTo(764, 650); c.moveTo(830, 590); c.lineTo(836, 650); c.stroke();
  c.lineWidth = 8; c.beginPath(); c.moveTo(744, 652); c.lineTo(784, 652); c.moveTo(816, 652); c.lineTo(856, 652); c.stroke();
  c.fillStyle = '#FFC83D'; c.lineWidth = 12;
  c.beginPath(); c.ellipse(800, 500, 105, 95, 0, 0, Math.PI * 2); c.fill(); c.stroke();
  c.fillStyle = '#F2552C'; c.lineWidth = 8;
  c.beginPath(); c.moveTo(895, 470); c.lineTo(955, 492); c.lineTo(895, 515); c.closePath(); c.fill(); c.stroke();
  c.fillStyle = '#FFB000'; c.beginPath(); c.ellipse(770, 525, 52, 34, -0.4, 0, Math.PI * 2); c.fill(); c.stroke();
  c.lineWidth = 9; c.beginPath(); c.moveTo(790, 407); c.quadraticCurveTo(780, 360, 805, 350); c.moveTo(805, 405); c.quadraticCurveTo(815, 365, 840, 368); c.stroke();
  eyes = [{ x: 285, y: 338 }, { x: 376, y: 338 }, { x: 845, y: 455 }];
  renderEyesOv();
}

/* =========================================================
   AUTOSAVE (this device only)
   ========================================================= */
let saveT = null, pendingSettings = null;
function settingsSnapshot() {
  if (actors.length) return actors.map((A) => ({ cx: A.cx, cy: A.cy, name: A.settings.name, move: A.settings.move, hat: A.settings.hat, voice: A.settings.voice, rigPaint: A.settings.rigPaint || null })).filter((q, i) => !actors[i].guest);
  return pendingSettings || [];
}
function saveLocal() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ sample: sampleIntact, drawing: draw.toDataURL('image/png'), eyes, settings: settingsSnapshot(), scene, title: titleEdited ? $('movieTitle').value : '', guests: guests.map((g) => g.libId).filter(Boolean) }));
    } catch { /* storage full or blocked: drawing still works */ }
  }, 700);
}
function restoreLocal() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { saved = null; }
  if (!saved || !saved.drawing) { drawSample(); actorsDirty = true; return; }
  const img = new Image();
  img.onload = () => {
    dctx.clearRect(0, 0, DW, DH); dctx.drawImage(img, 0, 0, DW, DH);
    eyes = saved.eyes || []; renderEyesOv();
    pendingSettings = saved.settings || null; sampleIntact = !!saved.sample; $('exampleTag').hidden = !sampleIntact;
    pendingGuestIds = saved.guests && saved.guests.length ? saved.guests : null;
    if (saved.scene) setScene(saved.scene);
    if (saved.title) { $('movieTitle').value = saved.title; titleEdited = true; }
    actorsDirty = true;
  };
  img.onerror = () => { drawSample(); actorsDirty = true; };
  img.src = saved.drawing;
}

/* =========================================================
   PHOTOS OF PAPER DRAWINGS
   ========================================================= */
let photoSrc = null, photoTimer = null;
function hidePhotoBox() { $('photoBox').hidden = true; photoSrc = null; }
async function onPhotoFile(file) {
  if (!file) return;
  $('busy').hidden = false;
  try {
    photoSrc = await fileToCanvas(file);
    $('photoStrength').value = '1';
    applyPhoto(true);
    $('photoBox').hidden = false;
  } catch {
    $('busy').hidden = true;
    toast("That photo couldn't be opened. Try a JPG or PNG.");
  }
}
function applyPhoto(isNew) {
  if (!photoSrc) return;
  $('busy').hidden = false;
  setTimeout(() => {
    const art = cleanPhoto(photoSrc, +$('photoStrength').value);
    $('busy').hidden = true;
    if (!art) { toast('No drawing found. Try a brighter photo with the paper filling the picture.', 4500); return; }
    if (isNew) { pushUndo(); forgetCast(); }
    touched();
    dctx.clearRect(0, 0, DW, DH); eyes = []; renderEyesOv();
    const k = Math.min((DW - 60) / art.width, (DH - 60) / art.height, 2.2);
    const w = art.width * k, h = art.height * k;
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(art, (DW - w) / 2, (DH - h) / 2, w, h);
    changed();
    if (isNew) toast('Photo cleaned up! Add googly eyes, then bring them to life.');
  }, 30);
}
['photoCam', 'photoPick'].forEach((id) => ($(id).onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; onPhotoFile(f); }));
$('photoStrength').oninput = () => { clearTimeout(photoTimer); photoTimer = setTimeout(() => applyPhoto(false), 180); };
$('photoRotate').onclick = () => { if (!photoSrc) return; photoSrc = rotateCanvas(photoSrc); applyPhoto(false); };
$('photoDone').onclick = hidePhotoBox;

/* =========================================================
   CAST (each separate drawing is its own character)
   ========================================================= */
let actors = [], actorsDirty = true, sel = 0, range = 200;
const SAMPLE_SETTINGS = [{ name: 'Blobby' }, { name: 'Peep' }];
const HATS = [['none', 'None'], ['crown', 'Crown'], ['party', 'Party hat'], ['bow', 'Bow'], ['cap', 'Cap']];
const MOVES = [['Auto', 'Their own way'], ['Idle', 'Stand still'], ['Walk', 'Walk'], ['Hop', 'Hop'], ['Dance', 'Dance'], ['Wave', 'Wave'], ['Fly', 'Fly'], ['Swim', 'Swim'], ['Jelly', 'Jelly']];

function defaultSettings(A, used) {
  let i = A.persona.nameIdx, name = NAMES[i % NAMES.length], k = 0;
  while (used.has(name) && k < NAMES.length) name = NAMES[(i + ++k) % NAMES.length];
  return { name, move: 'Auto', hat: 'none', voice: 'normal' };
}
function buildActors() {
  if (!actorsDirty) return actors.length > 0;
  actorsDirty = false;
  const next = segmentActors(draw, eyes, { fill: $('fillBtn').checked });
  const cands = actors.map((o) => ({ cx: o.cx, cy: o.cy, s: o.settings }))
    .concat((pendingSettings || []).map((p) => ({ cx: p.cx, cy: p.cy, s: { name: p.name || '', move: p.move || 'Auto', hat: p.hat || 'none', voice: p.voice || 'normal', rigPaint: p.rigPaint || null } })));
  const claimed = new Set(), used = new Set();
  next.forEach((A, i) => {
    let best = -1, bd = 160;
    cands.forEach((c, j) => { if (claimed.has(j)) return; const d = Math.hypot(c.cx - A.cx, c.cy - A.cy); if (d < bd) { bd = d; best = j; } });
    if (best >= 0) { claimed.add(best); A.settings = cands[best].s; }
    else if (sampleIntact && next.length === 2 && SAMPLE_SETTINGS[i]) A.settings = { ...defaultSettings(A, used), ...SAMPLE_SETTINGS[i] };
    else A.settings = defaultSettings(A, used);
    used.add(A.settings.name);
    if (A.settings.rigPaint) finishRig(A, paintShift(A.settings.rigPaint, -A.x0, -A.y0));
    initRuntime(A);
  });
  pendingSettings = null;
  actors = next.concat(guests);
  layoutActors();
  sel = Math.max(0, Math.min(sel, actors.length - 1));
  renderCast(); renderSelected(); refreshTitle();
  return actors.length > 0;
}
function initRuntime(A) {
  Object.assign(A, {
    autoT: 0, vol: 0, tickle: 0, blinkAt: rnd(1, 4), blinkT: -9, lift: 0, vy: 0, act: null, actUntil: 0,
    flipT: -1, spinT: -1, mood: '', run: false, fly: false, sleep: false, frozen: false, fx: null, hugWith: null, hugUntil: 0, hiddenUntil: 0, layer: 0, stomp: false,
    big: 1, bigNow: 1, bigStep: 0, face: 1, walk: 0, drag: null, squash: 0, bubble: null, mix: 1, targetX: null, replaying: false, newFrames: null,
  });
}
function layoutActors() {
  const own = actors.filter((a) => !a.guest);
  const n = own.length; if (!n) return;
  const maxH = Math.max(...own.map((a) => a.h));
  const Hmax = n === 1 ? H * 0.5 : n === 2 ? H * 0.44 : n <= 4 ? H * 0.36 : H * 0.3;
  const maxW = n === 1 ? W * 0.42 : (W * 0.86) / n;
  own.forEach((A) => { const th = Math.max(H * 0.18, (A.h / maxH) * Hmax); A.scale = Math.min(th / A.h, maxW / A.w); });
  [...own].sort((a, b) => a.cx - b.cx).forEach((A, i) => {
    const fromPaper = 90 + (A.cx / DW) * (W - 180), even = (W / n) * (i + 0.5);
    A.home = n === 1 ? W / 2 : even * 0.6 + fromPaper * 0.4;
  });
  range = n === 1 ? 260 : Math.min(260, (W / n) * 0.4);
}
function renderCast() {
  const el = $('who'); el.innerHTML = '';
  if (actors.length > 1) { const l = document.createElement('span'); l.className = 'lead'; l.textContent = 'Moving:'; el.appendChild(l); }
  actors.forEach((A, i) => {
    const b = document.createElement('button'); b.className = 'whob'; b.setAttribute('aria-pressed', i === sel);
    b.setAttribute('aria-label', 'Move ' + (A.settings.name || 'character') + (i < 9 ? ` (key ${i + 1})` : ''));
    const img = document.createElement('img'); img.src = A.thumb; img.alt = '';
    const s2 = document.createElement('span'); s2.textContent = A.settings.name || 'No name';
    b.append(img, s2);
    if (A.settings.part) { const t = document.createElement('em'); t.className = 'ptag'; t.textContent = 'part'; t.title = 'Has a recorded part'; b.append(t); } b.onclick = () => selectActor(i); el.appendChild(b);
  });
}
function selectActor(i) {
  if (recState !== 'idle' && recKind === 'part') return;
  if (i !== sel && actors[sel]) actors[sel].targetX = null;
  sel = i; selStk = null; [...$('who').querySelectorAll('.whob')].forEach((b, j) => b.setAttribute('aria-pressed', j === i)); renderSelected();
  if (micOn) buildVoice(voiceOf(actors[i]));
}
function renderSelected() {
  const A = actors[sel]; if (!A) return; const S = A.settings, P = A.persona;
  $('charName').value = S.name;
  setPressed($('moves'), S.move); setPressed($('hats'), S.hat);
  syncPad(); renderVoices();
  $('bodyInfo').textContent = A.rig.painted ? 'You colored these yourself.' : (A.rig.arms.length || A.rig.legs.length) ? 'Found automatically. Fix them if they look wrong when moving.' : "No arms or legs found yet. Color them in so they can swing.";
  const part = S.part;
  $('partInfo').textContent = part ? `Recorded part: ${fmtTime(part.dur)}${part.audio ? ' with voice' : ''}. ${S.name || 'This character'} acts it out every time you record.` : 'No part yet. Pick "One part" by the red button to record just this character.';
  $('partDel').hidden = !part;
  $('guestRemove').hidden = !A.guest;
  $('libSave').textContent = A.libId ? 'Update in My characters' : 'Save to My characters';
  $('selImg').src = A.thumb;
  document.querySelectorAll('#feelings .feel').forEach((f) => f.setAttribute('aria-pressed', f.dataset.v === (A.mood || '')));
  const parts = [];
  if (A.rig.arms.length) parts.push(A.rig.arms.length === 2 ? 'two arms' : 'an arm');
  if (A.rig.legs.length) parts.push('legs');
  const per = $('persona'); per.innerHTML = '';
  const b = document.createElement('b'); b.textContent = S.name || 'This character';
  per.append(b, ` is ${P.trait} and loves to ${MOVE_WORDS[P.signature]}.${parts.length ? ` We found ${parts.join(' and ')}.` : ''}`);
}
const cur = () => actors[sel]?.settings;
$('partDel').onclick = () => { const A = actors[sel]; if (!A) return; A.settings.part = null; renderSelected(); renderCast(); toast('Part deleted.'); };
$('charName').addEventListener('input', (e) => {
  const S = cur(); if (!S) return; S.name = e.target.value;
  const span = $('who').querySelectorAll('.whob')[sel]?.querySelector('span'); if (span) span.textContent = S.name || 'No name';
  const pb = $('persona').querySelector('b'); if (pb) pb.textContent = S.name || 'This character';
  refreshTitle(); saveLocal();
});

/* =========================================================
   AUDIO: music, sound effects, microphone
   ========================================================= */
let actx = null, master = null, musicGain = null, noiseBuf = null;
function ensureAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return actx; }
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
  actx = new AC();
  master = actx.createGain(); master.gain.value = 0.9; master.connect(actx.destination);
  musicGain = actx.createGain(); musicGain.gain.value = 0.14; musicGain.connect(master);
  noiseBuf = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate);
  const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  return actx;
}
document.addEventListener('pointerdown', ensureAudio, { passive: true });

function tone(f, dur, type = 'sine', vol = 0.25, to = null, when = 0, dest = null) {
  if (!actx) return; const t = actx.currentTime + when;
  const o = actx.createOscillator(), g = actx.createGain(); o.type = type; o.frequency.setValueAtTime(f, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(dest || master); o.start(t); o.stop(t + dur + 0.05);
}
function noise(when, dur, vol, freq, q = 1, type = 'bandpass', sweepTo = null, dest = null) {
  if (!actx) return; const t = actx.currentTime + when;
  const s = actx.createBufferSource(); s.buffer = noiseBuf;
  const f = actx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  const g = actx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(dest || master); s.start(t, Math.random()); s.stop(t + dur + 0.05);
}
const sfx = {
  jump: () => tone(240, 0.28, 'triangle', 0.3, 620),
  land: () => tone(120, 0.18, 'sine', 0.35, 55),
  star: () => { tone(880, 0.14, 'sine', 0.25); tone(1320, 0.22, 'sine', 0.22, null, 0.09); },
  giggle: () => { for (let i = 0; i < 6; i++) tone(700 + Math.random() * 300, 0.08, 'triangle', 0.18, 900 + Math.random() * 300, i * 0.075); },
  pop: () => tone(520, 0.12, 'sine', 0.25, 980),
  whoosh: () => noise(0, 0.45, 0.35, 400, 2, 'bandpass', 3000),
  boing: () => { tone(180, 0.5, 'sine', 0.35, 420); tone(360, 0.4, 'triangle', 0.12, 700, 0.02); },
  tada: () => { [523, 659, 784].forEach((f, i) => tone(f, 0.18, 'triangle', 0.25, null, i * 0.09)); [523, 659, 784, 1047].forEach((f) => tone(f, 0.9, 'triangle', 0.16, null, 0.3)); },
  applause: () => { for (let i = 0; i < 80; i++) noise(Math.random() * 2, 0.05, 0.25 + Math.random() * 0.2, 1500 + Math.random() * 1500, 1.2); },
  drumroll: () => { for (let i = 0; i < 28; i++) noise(i * 0.05, 0.06, 0.12 + i * 0.012, 2500, 0.8); noise(1.45, 1.1, 0.4, 6000, 0.6, 'highpass'); tone(90, 0.4, 'sine', 0.5, 50, 1.45); },
};

// Background music: five built-in tunes made on the fly (free to use on YouTube), your own song, or silence.
const TRACKS = {
  happy: { name: 'Happy', bpm: 112, root: 523.25, lead: 'triangle', lv: 0.5, len: 0.35, bassW: 'sine',
    mel: [0, 4, 7, 12, 9, 7, 4, 7, 2, 5, 9, 12, 11, 9, 5, 9, 0, 4, 7, 12, 14, 12, 9, 7, 5, 4, 2, 4, 0, -1, 0, null],
    bass: [-12, -12, -8, -8, -10, -10, -5, -5] },
  adventure: { name: 'Adventure', bpm: 126, root: 440, lead: 'square', lv: 0.2, len: 0.22, bassW: 'triangle', drums: 'beat',
    mel: [0, null, 7, null, 5, 3, 2, 0, 3, null, 5, null, 7, 8, 7, 5, 0, null, 7, null, 12, 10, 8, 7, 5, 7, 8, 7, 5, 3, 2, null],
    bass: [-24, -24, -20, -20, -22, -22, -17, -19] },
  space: { name: 'Space', bpm: 76, root: 392, lead: 'sine', lv: 0.45, len: 0.9, bassW: 'sine', echo: true,
    mel: [0, 7, 12, 16, 19, 16, 12, 7, 2, 9, 14, 17, 21, 17, 14, 9, -3, 4, 9, 12, 16, 12, 9, 4, 0, 7, 12, 16, 19, 24, 19, null],
    bass: [-12, -12, -10, -10, -15, -15, -12, -12] },
  silly: { name: 'Silly', bpm: 150, root: 349.23, lead: 'square', lv: 0.16, len: 0.1, bassW: 'triangle', drums: 'tick', oompah: true,
    mel: [0, null, 4, null, 7, null, 4, null, 5, null, 9, null, 12, null, 9, null, 7, 7, 4, 4, 0, 0, null, null, 2, 4, 5, 7, 9, 11, 12, null],
    bass: [-24, -17, -24, -17, -19, -12, -19, -12] },
  calm: { name: 'Calm', bpm: 66, root: 784, lead: 'sine', lv: 0.4, len: 1.2, bassW: 'sine', echo: true,
    mel: [0, null, 4, null, 7, null, 4, null, 5, null, 4, null, 2, null, null, null, 0, null, 4, null, 7, null, 12, null, 11, null, 7, null, 9, null, null, null],
    bass: [-24, -24, -19, -19, -26, -26, -22, -22] },
};
let musicId = 'happy', musicVol = 0.6, musicTimer = null, nextNote = 0, step = 0, myMusic = null, myMusicNode = null, echoIn = null;
try { const m = JSON.parse(localStorage.getItem('doodle-alive:music') || '{}'); if (m.id && (TRACKS[m.id] || m.id === 'off')) musicId = m.id; if (typeof m.vol === 'number') musicVol = m.vol; } catch { /* defaults */ }
const mtof = (root, m) => root * Math.pow(2, m / 12);
function applyMusicVol() { if (musicGain) musicGain.gain.value = musicVol * (musicId === 'mine' ? 0.9 : 0.24); }
function ensureEcho() {
  if (echoIn || !actx) return echoIn;
  echoIn = actx.createDelay(1); echoIn.delayTime.value = 0.32;
  const fb = actx.createGain(); fb.gain.value = 0.35; const wet = actx.createGain(); wet.gain.value = 0.45;
  echoIn.connect(fb); fb.connect(echoIn); echoIn.connect(wet); wet.connect(musicGain);
  return echoIn;
}
function startMusic() {
  if (!actx || musicTimer || myMusicNode || musicId === 'off') return;
  applyMusicVol();
  if (musicId === 'mine') {
    if (!myMusic) return;
    myMusicNode = actx.createBufferSource(); myMusicNode.buffer = myMusic; myMusicNode.loop = true;
    myMusicNode.connect(musicGain); myMusicNode.start(); return;
  }
  const T = TRACKS[musicId]; const beat = 60 / T.bpm / 2;
  nextNote = actx.currentTime + 0.05; step = 0;
  musicTimer = setInterval(() => {
    while (nextNote < actx.currentTime + 0.15) {
      const w = nextNote - actx.currentTime, n = T.mel[step % T.mel.length];
      if (n !== null) {
        tone(mtof(T.root, n), T.len, T.lead, T.lv, null, w, musicGain);
        if (T.echo) tone(mtof(T.root, n), T.len, T.lead, T.lv * 0.6, null, w, ensureEcho());
      }
      if (T.oompah) tone(mtof(T.root, T.bass[step % T.bass.length]), 0.12, T.bassW, 0.7, null, w, musicGain);
      else if (step % 4 === 0) tone(mtof(T.root, T.bass[(step / 4) % T.bass.length]), beat * 3.6, T.bassW, 0.6, null, w, musicGain);
      if (T.drums === 'beat') {
        if (step % 4 === 0) tone(150, 0.16, 'sine', 0.9, 45, w, musicGain);
        if (step % 4 === 2) noise(w, 0.12, 0.5, 1800, 0.9, 'bandpass', null, musicGain);
        noise(w, 0.04, 0.18, 7000, 0.7, 'highpass', null, musicGain);
      } else if (T.drums === 'tick' && step % 2 === 1) noise(w, 0.03, 0.25, 6000, 0.8, 'highpass', null, musicGain);
      nextNote += beat; step++;
    }
  }, 40);
}
function stopMusic() {
  clearInterval(musicTimer); musicTimer = null;
  if (myMusicNode) { try { myMusicNode.stop(); } catch { /* done */ } myMusicNode = null; }
}
function setMusic(id) {
  if (id === 'mine' && !myMusic) { $('musicFile').click(); return; }
  musicId = id; stopMusic(); renderMusic();
  try { localStorage.setItem('doodle-alive:music', JSON.stringify({ id: id === 'mine' ? 'happy' : id, vol: musicVol })); } catch { /* fine */ }
  if (mode === 'studio' || recState !== 'idle') { ensureAudio(); startMusic(); }
}
function renderMusic() {
  const items = [...Object.entries(TRACKS).map(([k, v]) => [k, v.name]), ['mine', myMusic ? 'My song' : '+ My song'], ['off', 'No music']];
  chipGroup($('music'), items, musicId, setMusic);
}
$('musicVol').value = String(musicVol);
$('musicVol').oninput = (e) => { musicVol = +e.target.value; applyMusicVol(); try { localStorage.setItem('doodle-alive:music', JSON.stringify({ id: musicId === 'mine' ? 'happy' : musicId, vol: musicVol })); } catch { /* fine */ } };
$('musicFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  if (!ensureAudio()) return;
  try {
    const ab = await f.arrayBuffer();
    myMusic = await new Promise((res, rej) => { const pr = actx.decodeAudioData(ab, res, rej); if (pr && pr.then) pr.then(res, rej); });
    setMusic('mine'); toast('Your song is playing. Only use songs you made or have permission to use.', 5000);
  } catch { toast("That song couldn't be opened. Try an MP3."); }
};
let showNames = true;
$('namesBtn').onclick = (e) => { showNames = !showNames; e.currentTarget.setAttribute('aria-pressed', showNames); e.currentTarget.textContent = showNames ? 'Name tags on' : 'Name tags off'; };

// Microphone: the picked character's mouth moves with your voice, and the voice goes into the movie.
let micOn = false, micStream = null, micAnalyser = null, micToRec = null;
async function enableMic(quiet) {
  if (micOn) return true;
  if (!ensureAudio()) return false;
  if (!navigator.mediaDevices?.getUserMedia) { if (!quiet) toast("This browser can't use the microphone."); return false; }
  try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch { toast('The microphone is blocked. Allow it in the address bar to talk in your movie.', 5000); return false; }
  const src = actx.createMediaStreamSource(micStream);
  await loadPitch();
  fxIn = actx.createGain(); fxOut = actx.createGain(); src.connect(fxIn);
  micAnalyser = actx.createAnalyser(); micAnalyser.fftSize = 512; fxOut.connect(micAnalyser);
  micToRec = actx.createGain(); micToRec.gain.value = 1.3; fxOut.connect(micToRec); // into the movie
  monitorGain = actx.createGain(); monitorGain.gain.value = $('monitorChk').checked ? 1 : 0; fxOut.connect(monitorGain); monitorGain.connect(actx.destination);
  if (recDest) micToRec.connect(recDest);
  buildVoice(voiceOf(actors[sel]));
  micOn = true; $('micBtn').setAttribute('aria-pressed', 'true'); $('micLbl').textContent = 'Mic on';
  return true;
}
function disableMic() {
  if (!micOn) return;
  micStream.getTracks().forEach((t) => t.stop()); [micToRec, fxIn, fxOut, monitorGain].forEach((n) => { try { n.disconnect(); } catch { /* fine */ } });
  fxNodes.forEach((n) => { try { n.stop && n.stop(); } catch { /* fine */ } }); fxNodes = []; fxIn = fxOut = monitorGain = null;
  micOn = false; micStream = null; micAnalyser = null; micToRec = null;
  $('micBtn').setAttribute('aria-pressed', 'false'); $('micLbl').textContent = 'Mic off'; $('micLvl').style.width = '0';
}
$('micBtn').onclick = () => (micOn ? (recState === 'idle' ? disableMic() : toast('Keep the mic on while recording.')) : enableMic(false).then((ok) => ok && toast('Talk! Your picked character moves its mouth with your voice.')));
const micBuf = new Uint8Array(512);
function micLevel() {
  if (!micAnalyser) return 0;
  micAnalyser.getByteTimeDomainData(micBuf); let s = 0; for (const v of micBuf) { const d = (v - 128) / 128; s += d * d; }
  return Math.max(0, Math.min(1, Math.sqrt(s / micBuf.length) * 6 - 0.06));
}

/* =========================================================
   VOICE EFFECTS (live, on the microphone, recorded into the movie)
   ========================================================= */
const VOICES = [
  ['normal', 'Normal', '#8C96B8', 'N'], ['chipmunk', 'Chipmunk', '#F2552C', 'C'], ['giant', 'Giant', '#6A4BD8', 'G'],
  ['robot', 'Robot', '#5D6A8F', 'R'], ['alien', 'Alien', '#2BB673', 'A'], ['echo', 'Echo', '#2F80ED', 'E'],
  ['cave', 'Cave', '#8B5A2B', 'C'], ['radio', 'Radio', '#E09A00', 'R'], ['ghost', 'Ghost', '#9AA3B5', 'G'], ['underwater', 'Underwater', '#00B5B8', 'U'],
];
const PITCH_WORKLET = `
class PitchShift extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'pitch', defaultValue: 1, minValue: 0.25, maxValue: 4 }]; }
  constructor() { super(); this.N = 8192; this.buf = new Float32Array(this.N); this.w = 0; this.ph = 0; this.L = 2048; }
  read(pos) { const N = this.N; pos = ((pos % N) + N) % N; const i = Math.floor(pos), f = pos - i; return this.buf[i] * (1 - f) + this.buf[(i + 1) % N] * f; }
  process(inputs, outputs, params) {
    const inp = inputs[0] && inputs[0][0], outs = outputs[0]; if (!outs || !outs[0]) return true;
    const out = outs[0], pitch = params.pitch[0], L = this.L;
    for (let i = 0; i < out.length; i++) {
      this.buf[this.w] = inp ? inp[i] : 0;
      this.ph += (1 - pitch) / L; if (this.ph >= 1) this.ph -= 1; if (this.ph < 0) this.ph += 1;
      const p2 = (this.ph + 0.5) % 1;
      out[i] = this.read(this.w - this.ph * L) * Math.sin(Math.PI * this.ph) + this.read(this.w - p2 * L) * Math.sin(Math.PI * p2);
      this.w = (this.w + 1) % this.N;
    }
    for (let c = 1; c < outs.length; c++) outs[c].set(out);
    return true;
  }
}
registerProcessor('pitch-shift', PitchShift);`;
let fxIn = null, fxOut = null, pitchNode = null, fxNodes = [], monitorGain = null, voiceId = 'normal', workletTried = false;
async function loadPitch() {
  if (workletTried) return; workletTried = true;
  try {
    const url = URL.createObjectURL(new Blob([PITCH_WORKLET], { type: 'application/javascript' }));
    await actx.audioWorklet.addModule(url);
    pitchNode = new AudioWorkletNode(actx, 'pitch-shift', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  } catch { pitchNode = null; }
}
function makeImpulse(sec, decay) {
  const n = Math.floor(actx.sampleRate * sec), b = actx.createBuffer(2, n, actx.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay); }
  return b;
}
function fxNode(n) { fxNodes.push(n); return n; }
function g(v) { const n = fxNode(actx.createGain()); n.gain.value = v; return n; }
function biq(type, f, q = 0.8, gain = 0) { const n = fxNode(actx.createBiquadFilter()); n.type = type; n.frequency.value = f; n.Q.value = q; n.gain.value = gain; return n; }
function osc(freq, type = 'sine') { const o = fxNode(actx.createOscillator()); o.type = type; o.frequency.value = freq; o.start(); return o; }
function ringMod(freq) { const r = g(0); osc(freq).connect(r.gain); return r; }
function reverb(sec, decay) { const c = fxNode(actx.createConvolver()); c.buffer = makeImpulse(sec, decay); return c; }
function shaper(k) { const s = fxNode(actx.createWaveShaper()); const n = 1024, curve = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; curve[i] = (1 + k) * x / (1 + k * Math.abs(x)); } s.curve = curve; return s; }
function pitch(ratio) { if (!pitchNode) return null; pitchNode.parameters.get('pitch').value = ratio; return pitchNode; }

function buildVoice(id) {
  if (!fxIn) return;
  try { fxIn.disconnect(); } catch { /* fine */ }
  if (pitchNode) try { pitchNode.disconnect(); } catch { /* fine */ }
  fxNodes.forEach((n) => { try { n.disconnect(); } catch { /* fine */ } try { n.stop && n.stop(); } catch { /* fine */ } });
  fxNodes = [];
  voiceId = id;
  const chain = (...nodes) => { let prev = fxIn; for (const n of nodes) { if (!n) continue; prev.connect(n); prev = n; } return prev; };
  switch (id) {
    case 'chipmunk': chain(pitch(1.75) || biq('highpass', 900), biq('highshelf', 3000, 0.7, 4)).connect(fxOut); break;
    case 'giant': chain(pitch(0.62), biq('lowshelf', 220, 0.7, 9), biq('lowpass', 2600)).connect(fxOut); break;
    case 'robot': {
      const rm = ringMod(60); const comb = fxNode(actx.createDelay(0.05)); comb.delayTime.value = 0.011; const fb = g(0.5);
      fxIn.connect(rm); rm.connect(comb); comb.connect(fb); fb.connect(comb); const mix = g(1.4); rm.connect(mix); comb.connect(mix); mix.connect(fxOut); break;
    }
    case 'alien': {
      const p = chain(pitch(1.3)); const rm = ringMod(380); const dry = g(0.5), wet = g(0.9);
      p.connect(dry); p.connect(rm); rm.connect(wet); dry.connect(fxOut); wet.connect(fxOut);
      break;
    }
    case 'echo': {
      fxIn.connect(fxOut); const d = fxNode(actx.createDelay(1)); d.delayTime.value = 0.3; const fb = g(0.45), wet = g(0.65);
      fxIn.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); wet.connect(fxOut); break;
    }
    case 'cave': { const dry = g(0.7), wet = g(1.1), r = reverb(2.8, 2.2); fxIn.connect(dry); fxIn.connect(r); r.connect(wet); dry.connect(fxOut); wet.connect(fxOut); break; }
    case 'radio': chain(biq('highpass', 450, 0.9), biq('lowpass', 2800, 0.9), shaper(25), g(0.55)).connect(fxOut); break;
    case 'ghost': {
      const p = chain(pitch(0.84)); const trem = g(0.7); const lfo = osc(5.5); const depth = g(0.35); lfo.connect(depth); depth.connect(trem.gain);
      p.connect(trem); const dry = g(0.45), wet = g(1.3), r = reverb(3.6, 1.8); trem.connect(dry); trem.connect(r); r.connect(wet); dry.connect(fxOut); wet.connect(fxOut); break;
    }
    case 'underwater': {
      const lp = biq('lowpass', 650, 3); const l1 = osc(0.7); const d1 = g(280); l1.connect(d1); d1.connect(lp.frequency);
      const vib = fxNode(actx.createDelay(0.03)); vib.delayTime.value = 0.006; const l2 = osc(5); const d2 = g(0.003); l2.connect(d2); d2.connect(vib.delayTime);
      chain(lp, vib, g(1.4)).connect(fxOut); break;
    }
    default: fxIn.connect(fxOut);
  }
}
function voiceOf(A) { return A?.settings?.voice || 'normal'; }
function renderVoices() {
  const cur = voiceOf(actors[sel]);
  ['voices', 'voices2'].forEach((id) => {
    const el = $(id); el.innerHTML = '';
    VOICES.forEach(([v, label, col, letter]) => {
      const b = document.createElement('button'); b.className = 'vchip'; b.dataset.v = v; b.setAttribute('aria-pressed', v === cur);
      b.innerHTML = `<i style="background:${col}">${letter}</i>${label}`;
      b.onclick = () => setVoice(v); el.appendChild(b);
    });
  });
  $('voiceFor').textContent = actors[sel]?.settings.name || 'this character';
}
function setVoice(v) {
  const A = actors[sel]; if (!A) return;
  A.settings.voice = v; saveLocal(); renderVoices();
  if (micOn) buildVoice(v);
  else toast(`${VOICES.find((x) => x[0] === v)[1]} voice picked. Turn on the mic and talk!`);
}
$('monitorChk').onchange = (e) => {
  if (monitorGain) monitorGain.gain.value = e.target.checked ? 1 : 0;
  if (e.target.checked) { toast('Use headphones, or the speakers will squeal.', 4500); if (!micOn) enableMic(false); }
};

/* =========================================================
   PLACES (built-in scenes + your own pictures)
   ========================================================= */
const BG_KEY = 'doodle-alive:bgs';
let scene = 'meadow', prevScene = null, fadeT = 1, customBgs = [];
function bgImage(id) { return customBgs.find((b) => b.id === id)?.img || null; }
function paintScene(c, t, dt, id) {
  if (id && id.startsWith('bg:')) { const img = bgImage(id); if (img) return drawScene(c, t, dt, 'photo', img); return drawScene(c, t, dt, 'meadow'); }
  drawScene(c, t, dt, id);
}
function setScene(id) {
  if (!id || id === scene) return;
  if (id.startsWith('bg:') && !bgImage(id)) return;
  prevScene = scene; scene = id; fadeT = 0;
  setPressed($('scenes'), id); saveLocal();
}
function renderScenes() {
  const el = $('scenes'); el.innerHTML = '';
  const add = (id, label, thumb, removable) => {
    const b = document.createElement('button'); b.className = 'scn'; b.dataset.v = id; b.setAttribute('aria-pressed', id === scene); b.setAttribute('aria-label', label);
    b.append(thumb); const s = document.createElement('span'); s.textContent = label; b.append(s);
    b.onclick = () => setScene(id);
    if (removable) {
      const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove ' + label);
      let armed = false;
      x.onclick = (e) => {
        e.stopPropagation();
        if (!armed) { armed = true; x.textContent = 'Remove?'; setTimeout(() => { armed = false; x.textContent = '×'; }, 2500); return; }
        customBgs = customBgs.filter((q) => q.id !== id); if (scene === id) setScene('meadow');
        saveBgs(); renderScenes();
      };
      b.append(x);
    }
    el.appendChild(b);
  };
  SCENES.forEach(([id, label]) => {
    const c = document.createElement('canvas'); c.width = 192; c.height = 108;
    const x = c.getContext('2d'); x.scale(192 / W, 108 / H); drawScene(x, 1, 0, id);
    add(id, label, c, false);
  });
  customBgs.forEach((b, i) => { const im = new Image(); im.src = b.data; im.alt = ''; add(b.id, `My picture ${i + 1}`, im, true); });
  const up = document.createElement('button'); up.className = 'scn add'; up.textContent = '+ My picture';
  up.onclick = () => $('bgPhoto').click(); el.appendChild(up);
}
function saveBgs() { try { localStorage.setItem(BG_KEY, JSON.stringify(customBgs.map((b) => ({ id: b.id, data: b.data })))); return true; } catch { return false; } }
function loadBgs() {
  let list = []; try { list = JSON.parse(localStorage.getItem(BG_KEY) || '[]'); } catch { list = []; }
  customBgs = list.map((b) => { const img = new Image(); img.src = b.data; return { id: b.id, data: b.data, img }; });
}
$('bgPhoto').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const src = await fileToCanvas(f, 1800);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const k = Math.max(W / src.width, H / src.height), pw = src.width * k, ph = src.height * k;
    c.getContext('2d').drawImage(src, (W - pw) / 2, (H - ph) / 2, pw, ph);
    const data = c.toDataURL('image/jpeg', 0.82);
    const id = 'bg:' + Date.now();
    customBgs.push({ id, data, img: c });
    if (customBgs.length > 8) customBgs.shift();
    if (!saveBgs()) toast('Picture added. This device is out of space, so it will be gone after you close the page.', 5000);
    renderScenes(); setScene(id);
  } catch { toast("That picture couldn't be opened. Try a JPG or PNG."); }
};

/* =========================================================
   FUN: effects, sounds, star hunt
   ========================================================= */
let parts = [], starHunt = false, stars = [], score = 0;
const CONF = ['#F2552C', '#FFC83D', '#2BB673', '#2F80ED', '#FF8FB1', '#8E6CF0'];
function burst(kind, x, y, n) {
  for (let i = 0; i < n; i++) {
    if (kind === 'confetti') parts.push({ k: 'c', x: rnd(0, W), y: rnd(-200, -10), vx: rnd(-60, 60), vy: rnd(120, 260), r: rnd(0, 6), vr: rnd(-6, 6), l: 4, c: CONF[i % CONF.length] });
    else if (kind === 'hearts') parts.push({ k: 'h', x: x + rnd(-60, 60), y: y + rnd(-20, 20), vx: rnd(-40, 40), vy: rnd(-200, -110), r: rnd(14, 26), l: 2.2, c: ['#FF5C93', '#F2552C', '#FF8FB1'][i % 3] });
    else if (kind === 'sparkle') parts.push({ k: 's', x, y, vx: rnd(-420, 420), vy: rnd(-520, 120), r: rnd(8, 16), l: 1.3, c: ['#FFD84D', '#fff', '#FFC83D'][i % 3] });
    else if (kind === 'bubbles') parts.push({ k: 'b', x: rnd(0, W), y: H + rnd(0, 120), vx: rnd(-20, 20), vy: rnd(-180, -90), r: rnd(10, 34), l: 5, c: '#fff' });
  }
}
function drawParts(c, dt) {
  parts = parts.filter((p) => {
    p.l -= dt; if (p.l <= 0) return false;
    if (p.k === 's') p.vy += 900 * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; if (p.vr) p.r += p.vr * dt;
    c.save(); c.globalAlpha = Math.min(1, p.l * 1.5);
    if (p.k === 'c') { c.translate(p.x, p.y); c.rotate(p.r); c.fillStyle = p.c; c.fillRect(-8, -4, 16, 8); }
    else if (p.k === 'h') {
      c.translate(p.x, p.y); const r = p.r; c.fillStyle = p.c; c.beginPath();
      c.moveTo(0, r * 0.35); c.bezierCurveTo(-r, -r * 0.3, -r * 0.5, -r, 0, -r * 0.45); c.bezierCurveTo(r * 0.5, -r, r, -r * 0.3, 0, r * 0.35); c.fill();
    } else if (p.k === 's') { drawStar(c, p.x, p.y, p.r, p.l * 4, p.c, 'rgba(0,0,0,0)'); }
    else if (p.k === 't') { c.font = `800 ${p.r}px Grandstander, 'Comic Sans MS', sans-serif`; c.textAlign = 'center'; c.lineWidth = 8; c.strokeStyle = '#1F2A5C'; c.strokeText(p.text, p.x, p.y); c.fillStyle = p.c; c.fillText(p.text, p.x, p.y); }
    else if (p.k === 'p') { c.globalAlpha = Math.min(1, p.l * 1.6) * 0.85; c.fillStyle = p.c; c.beginPath(); c.arc(p.x, p.y, p.r * (1.6 - p.l), 0, Math.PI * 2); c.fill(); }
    else { c.strokeStyle = 'rgba(255,255,255,.8)'; c.lineWidth = 3; c.beginPath(); c.arc(p.x + Math.sin(p.l * 3) * 8, p.y, p.r, 0, Math.PI * 2); c.stroke(); }
    c.restore();
    return p.y < H + 200;
  });
}
function drawStar(c, x, y, r, rot, fill = '#FFD84D', stroke = '#E09A00') {
  c.save(); c.translate(x, y); c.rotate(rot); c.beginPath();
  for (let i = 0; i < 10; i++) { const rr = i % 2 ? r * 0.45 : r, a = i * Math.PI / 5 - Math.PI / 2; c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
  c.closePath(); c.fillStyle = fill; c.fill(); c.lineWidth = Math.max(2, r * 0.16); c.strokeStyle = stroke; c.stroke(); c.restore();
}
const headOf = (A) => (A?.box ? { x: A.box.x + A.box.w / 2, y: A.box.y } : { x: W / 2, y: H / 2 });
const FUN = [
  ['Confetti', () => { burst('confetti', 0, 0, 90); sfx.pop(); }],
  ['Hearts', () => { const h = headOf(actors[sel]); burst('hearts', h.x, h.y, 14); sfx.pop(); }],
  ['Sparkles', () => { const h = headOf(actors[sel]); burst('sparkle', h.x, h.y + 40, 30); tone(1200, 0.3, 'sine', 0.15, 2400); }],
  ['Bubbles', () => { burst('bubbles', 0, 0, 30); tone(400, 0.2, 'sine', 0.2, 900); }],
  ['Party!', () => { actors.forEach((A) => { A.act = 'Dance'; A.actUntil = clock + 5; }); burst('confetti', 0, 0, 120); sfx.tada(); }],
  ['Applause', () => sfx.applause()],
  ['Drum roll', () => sfx.drumroll()],
  ['Ta-da!', () => { sfx.tada(); const h = headOf(actors[sel]); burst('sparkle', h.x, h.y + 40, 20); }],
  ['Boing', () => sfx.boing()],
];
FUN.forEach(([label, fn]) => { const b = document.createElement('button'); b.className = 'chip'; b.textContent = label; b.onclick = () => { ensureAudio(); fn(); }; $('fun').appendChild(b); });
$('starsBtn').onclick = (e) => {
  starHunt = !starHunt; stars = []; score = 0;
  e.currentTarget.setAttribute('aria-pressed', starHunt); e.currentTarget.textContent = starHunt ? 'Star hunt on' : 'Star hunt off';
  if (starHunt) toast('Walk and jump into the stars to catch them!');
};
function runStars(c, dt, t) {
  if (!starHunt) return;
  while (stars.length < 3) stars.push({ x: rnd(110, W - 110), y: rnd(H * 0.2, H * 0.6), p: rnd(0, 6) });
  stars = stars.filter((st) => {
    const sy = st.y + Math.sin(t * 2 + st.p) * 12;
    const hit = actors.find((A) => A.box && st.x > A.box.x - 20 && st.x < A.box.x + A.box.w + 20 && sy > A.box.y - 20 && sy < A.box.y + A.box.h + 20);
    if (hit) { score++; sfx.star(); burst('sparkle', st.x, sy, 14); return false; }
    drawStar(c, st.x, sy, 30, Math.sin(t + st.p) * 0.3);
    return true;
  });
}
function drawScore(c) {
  if (!starHunt) return;
  drawStar(c, 108, 52, 24, 0);
  c.save(); c.font = "800 40px Grandstander, 'Comic Sans MS', sans-serif"; c.fillStyle = '#fff'; c.strokeStyle = '#1F2A5C'; c.lineWidth = 8; c.textBaseline = 'middle';
  c.strokeText(String(score), 142, 54); c.fillText(String(score), 142, 54); c.restore();
}

/* =========================================================
   STICKERS / PROPS (drawn by the app; some are interactive)
   ========================================================= */
const STK_KEY = 'doodle-alive:stickers';
const OL = '#2A1F5C';
const STICKERS = {
  tree: ['Tree', (c) => {
    c.fillStyle = '#8B5A2B'; c.strokeStyle = OL; c.lineWidth = 6; c.beginPath(); c.roundRect(-14, -70, 28, 70, 6); c.fill(); c.stroke();
    c.fillStyle = '#2BB673'; [[-38, -110, 44], [36, -112, 42], [0, -150, 52]].forEach(([x, y, r]) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); c.stroke(); });
    c.fillStyle = '#E0302B'; [[-30, -120], [20, -150], [40, -105]].forEach(([x, y]) => { c.beginPath(); c.arc(x, y, 7, 0, Math.PI * 2); c.fill(); });
  }],
  house: ['House', (c) => {
    c.strokeStyle = OL; c.lineWidth = 6; c.lineJoin = 'round';
    c.fillStyle = '#FFE1A8'; c.beginPath(); c.rect(-80, -110, 160, 110); c.fill(); c.stroke();
    c.fillStyle = '#E0302B'; c.beginPath(); c.moveTo(-98, -106); c.lineTo(0, -185); c.lineTo(98, -106); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = '#8B5A2B'; c.beginPath(); c.roundRect(-20, -62, 40, 62, 6); c.fill(); c.stroke();
    c.fillStyle = '#9CDCFF'; [[-62, -88], [30, -88]].forEach(([x, y]) => { c.beginPath(); c.rect(x, y, 32, 30); c.fill(); c.stroke(); });
  }],
  castle: ['Castle', (c, st, t) => {
    c.strokeStyle = OL; c.lineWidth = 6; c.lineJoin = 'round'; c.fillStyle = '#C7C3D9';
    c.beginPath(); c.rect(-90, -120, 180, 120); c.fill(); c.stroke();
    [-110, 70].forEach((x) => { c.beginPath(); c.rect(x, -170, 40, 170); c.fill(); c.stroke(); for (let i = 0; i < 3; i++) { c.beginPath(); c.rect(x + i * 15 - 2, -184, 10, 14); c.fill(); c.stroke(); } });
    c.fillStyle = '#6A4BD8'; c.beginPath(); c.arc(0, -40, 26, Math.PI, 0); c.lineTo(26, 0); c.lineTo(-26, 0); c.closePath(); c.fill(); c.stroke();
    c.strokeStyle = OL; c.lineWidth = 4; c.beginPath(); c.moveTo(-90, -184); c.lineTo(-90, -230); c.stroke();
    c.fillStyle = '#F2552C'; c.beginPath(); c.moveTo(-90, -230); c.quadraticCurveTo(-68, -224 + Math.sin(t * 6) * 5, -50, -222); c.lineTo(-90, -208); c.closePath(); c.fill();
  }],
  flower: ['Flower', (c, st, t) => {
    c.save(); c.rotate(Math.sin(t * 1.6 + st.x) * 0.06);
    c.strokeStyle = '#1E8C57'; c.lineWidth = 8; c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -90); c.stroke();
    c.fillStyle = '#2BB673'; c.beginPath(); c.ellipse(16, -40, 18, 8, -0.5, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#FF8FB1'; c.strokeStyle = OL; c.lineWidth = 4;
    for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; c.beginPath(); c.ellipse(Math.cos(a) * 22, -110 + Math.sin(a) * 22, 16, 11, a, 0, Math.PI * 2); c.fill(); c.stroke(); }
    c.fillStyle = '#FFC83D'; c.beginPath(); c.arc(0, -110, 14, 0, Math.PI * 2); c.fill(); c.stroke(); c.restore();
  }],
  rainbow: ['Rainbow', (c) => {
    ['#E0302B', '#F2552C', '#FFC83D', '#2BB673', '#2F80ED', '#8E6CF0'].forEach((col, i) => { c.strokeStyle = col; c.lineWidth = 16; c.beginPath(); c.arc(0, 0, 150 - i * 15, Math.PI, 0); c.stroke(); });
    c.fillStyle = '#fff'; [[-120, -6], [120, -6]].forEach(([x, y]) => { c.beginPath(); c.arc(x - 20, y, 22, 0, Math.PI * 2); c.arc(x + 4, y - 12, 26, 0, Math.PI * 2); c.arc(x + 26, y, 20, 0, Math.PI * 2); c.fill(); });
  }],
  ball: ['Ball', (c, st) => {
    c.save(); c.translate(0, -40); c.rotate(st.spin || 0);
    c.fillStyle = '#E0302B'; c.strokeStyle = OL; c.lineWidth = 6; c.beginPath(); c.arc(0, 0, 40, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(0, 0, 40, -0.5, 0.5); c.arc(0, 0, 40, Math.PI - 0.5, Math.PI + 0.5); c.fill();
    c.beginPath(); c.arc(0, 0, 40, 0, Math.PI * 2); c.stroke(); c.restore();
  }],
  balloon: ['Balloon', (c, st, t) => {
    c.save(); c.rotate(Math.sin(t * 1.4 + st.x) * 0.08);
    c.strokeStyle = OL; c.lineWidth = 3; c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(12, -50, 0, -100); c.stroke();
    c.fillStyle = st.color || '#2F80ED'; c.lineWidth = 5; c.beginPath(); c.ellipse(0, -150, 40, 50, 0, 0, Math.PI * 2); c.fill(); c.stroke();
    c.beginPath(); c.moveTo(-7, -98); c.lineTo(7, -98); c.lineTo(0, -106); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = 'rgba(255,255,255,.5)'; c.beginPath(); c.ellipse(-14, -168, 9, 16, -0.4, 0, Math.PI * 2); c.fill(); c.restore();
  }],
  car: ['Car', (c, st) => {
    c.strokeStyle = OL; c.lineWidth = 6; c.lineJoin = 'round';
    c.fillStyle = '#FFC83D'; c.beginPath(); c.moveTo(-100, -30); c.lineTo(-100, -70); c.lineTo(-50, -72); c.lineTo(-25, -110); c.lineTo(45, -110); c.lineTo(70, -72); c.lineTo(100, -66); c.lineTo(100, -30); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = '#9CDCFF'; c.beginPath(); c.moveTo(-15, -100); c.lineTo(8, -100); c.lineTo(8, -74); c.lineTo(-35, -74); c.closePath(); c.fill(); c.stroke();
    c.beginPath(); c.moveTo(18, -100); c.lineTo(40, -100); c.lineTo(58, -74); c.lineTo(18, -74); c.closePath(); c.fill(); c.stroke();
    [-58, 58].forEach((x) => { c.save(); c.translate(x, -26); c.rotate(st.spin || 0); c.fillStyle = '#1F2A5C'; c.beginPath(); c.arc(0, 0, 24, 0, Math.PI * 2); c.fill(); c.fillStyle = '#C7C3D9'; c.fillRect(-4, -14, 8, 28); c.restore(); });
  }],
  rocket: ['Rocket', (c, st, t) => {
    c.strokeStyle = OL; c.lineWidth = 6; c.lineJoin = 'round';
    if (st.launch) { c.fillStyle = '#FFC83D'; c.beginPath(); c.moveTo(-22, -20); c.lineTo(0, 40 + Math.random() * 30); c.lineTo(22, -20); c.fill(); c.fillStyle = '#F2552C'; c.beginPath(); c.moveTo(-12, -20); c.lineTo(0, 15 + Math.random() * 20); c.lineTo(12, -20); c.fill(); }
    c.fillStyle = '#E0302B'; c.beginPath(); c.moveTo(-30, -20); c.lineTo(-55, 0); c.lineTo(-30, -60); c.closePath(); c.fill(); c.stroke();
    c.beginPath(); c.moveTo(30, -20); c.lineTo(55, 0); c.lineTo(30, -60); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = '#F4F8FC'; c.beginPath(); c.moveTo(-30, -20); c.lineTo(-30, -130); c.quadraticCurveTo(0, -200, 30, -130); c.lineTo(30, -20); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = '#2F80ED'; c.beginPath(); c.arc(0, -110, 15, 0, Math.PI * 2); c.fill(); c.stroke();
  }],
  cake: ['Cake', (c, st, t) => {
    c.strokeStyle = OL; c.lineWidth = 6;
    c.fillStyle = '#FF8FB1'; c.beginPath(); c.roundRect(-80, -60, 160, 60, 10); c.fill(); c.stroke();
    c.fillStyle = '#FFE1A8'; c.beginPath(); c.roundRect(-60, -105, 120, 46, 10); c.fill(); c.stroke();
    c.fillStyle = '#fff'; c.beginPath(); c.moveTo(-60, -95); for (let i = 0; i <= 6; i++) c.quadraticCurveTo(-60 + i * 20 - 10, -78, -60 + i * 20, -95); c.lineTo(60, -105); c.lineTo(-60, -105); c.fill();
    [-30, 0, 30].forEach((x, i) => { c.fillStyle = ['#2F80ED', '#2BB673', '#8E6CF0'][i]; c.fillRect(x - 5, -135, 10, 30); c.fillStyle = '#FFC83D'; c.beginPath(); c.ellipse(x, -145 + Math.sin(t * 12 + i) * 2, 6, 10, 0, 0, Math.PI * 2); c.fill(); });
  }],
  sign: ['Sign', (c, st) => {
    c.strokeStyle = OL; c.lineWidth = 6; c.fillStyle = '#8B5A2B'; c.beginPath(); c.rect(-8, -80, 16, 80); c.fill(); c.stroke();
    c.fillStyle = '#FFE1A8'; c.beginPath(); c.roundRect(-110, -170, 220, 96, 12); c.fill(); c.stroke();
    c.fillStyle = '#1F2A5C'; c.font = "800 34px Grandstander, 'Comic Sans MS', sans-serif"; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText((st.text || 'Welcome!').slice(0, 14), 0, -122);
  }],
  sun: ['Smiley sun', (c, st, t) => {
    c.save(); c.translate(0, -90); c.rotate(t * 0.4); c.fillStyle = '#FFD84D';
    for (let i = 0; i < 10; i++) { c.rotate(Math.PI / 5); c.beginPath(); c.moveTo(56, -9); c.lineTo(84, 0); c.lineTo(56, 9); c.fill(); }
    c.restore(); c.strokeStyle = OL; c.lineWidth = 6; c.fillStyle = '#FFD84D'; c.beginPath(); c.arc(0, -90, 52, 0, Math.PI * 2); c.fill(); c.stroke();
    c.fillStyle = OL; c.beginPath(); c.arc(-17, -100, 6, 0, Math.PI * 2); c.arc(17, -100, 6, 0, Math.PI * 2); c.fill();
    c.lineWidth = 5; c.beginPath(); c.arc(0, -86, 22, 0.2 * Math.PI, 0.8 * Math.PI); c.stroke();
  }],
};
let stickers = [], selStk = null, stkSeq = 0;
function saveStickers() { try { localStorage.setItem(STK_KEY, JSON.stringify(stickers.map(({ kind, x, y, s, flip, color, text }) => ({ kind, x, y, s, flip, color, text })))); } catch { /* fine */ } }
function loadStickers() {
  try { stickers = (JSON.parse(localStorage.getItem(STK_KEY) || '[]') || []).filter((q) => STICKERS[q.kind]).map((q) => ({ ...q, id: ++stkSeq, vx: 0, vy: 0, spin: 0 })); } catch { stickers = []; }
}
function renderStickerLib() {
  const el = $('stickerLib'); el.innerHTML = '';
  Object.entries(STICKERS).forEach(([kind, [label, fn]]) => {
    const b = document.createElement('button'); b.className = 'stk'; b.setAttribute('aria-label', 'Add ' + label);
    const cv = document.createElement('canvas'); cv.width = 140; cv.height = 140; const x = cv.getContext('2d');
    x.translate(70, 128); x.scale(0.5, 0.5); fn(x, { x: 0, color: '#2F80ED' }, 0);
    const s = document.createElement('span'); s.textContent = label;
    b.append(cv, s); b.onclick = () => addSticker(kind); el.appendChild(b);
  });
}
function addSticker(kind) {
  ensureAudio();
  const st = { id: ++stkSeq, kind, x: rnd(W * 0.25, W * 0.75), y: GY + 6, s: kind === 'rainbow' || kind === 'castle' ? 1.1 : 0.9, flip: false, vx: 0, vy: 0, spin: 0 };
  if (kind === 'balloon') { st.color = ['#2F80ED', '#E0302B', '#2BB673', '#FFC83D', '#8E6CF0', '#FF5C93'][stkSeq % 6]; st.y = GY - 60; }
  if (kind === 'sun' || kind === 'rainbow') st.y = GY - 280;
  if (kind === 'sign') st.text = titleText().slice(0, 14) || 'Welcome!';
  stickers.push(st); selStk = st; saveStickers(); sfx.pop();
  burst('sparkle', st.x, st.y - 80, 14);
}
$('clearStickers').onclick = () => { stickers = []; selStk = null; saveStickers(); sfx.pop(); };
function stkBox(st) { const s = st.s; const w = { rainbow: 300, castle: 240, house: 200, car: 210, cake: 170, tree: 190, sign: 230 }[st.kind] || 120; const h = { rainbow: 160, castle: 240, house: 190, car: 115, rocket: 210, cake: 160, tree: 210, balloon: 205, ball: 80, sign: 175, sun: 180 }[st.kind] || 150; return { x: st.x - w * s / 2, y: st.y - h * s, w: w * s, h: h * s }; }

function updateStickers(dt, t) {
  for (const st of stickers) {
    if (st.drag) continue;
    if (st.kind === 'ball') {
      const r = 40 * st.s;
      st.vy += 2000 * dt; st.x += st.vx * dt; st.y += st.vy * dt;
      if (st.y > GY + 6) { st.y = GY + 6; if (st.vy > 250) { st.vy = -st.vy * 0.55; tone(160, 0.08, 'sine', 0.25, 90); } else st.vy = 0; st.vx *= 0.985; }
      if (st.x < r) { st.x = r; st.vx = Math.abs(st.vx) * 0.7; } if (st.x > W - r) { st.x = W - r; st.vx = -Math.abs(st.vx) * 0.7; }
      st.spin += st.vx * dt / r;
      for (const A of actors) {
        if (!A.box || A.hiddenUntil > clock) continue;
        const cx = Math.max(A.box.x, Math.min(st.x, A.box.x + A.box.w)), cy = Math.max(A.box.y, Math.min(st.y - r, A.box.y + A.box.h));
        if (Math.hypot(cx - st.x, cy - (st.y - r)) < r) {
          const dir = Math.sign(st.x - (A.box.x + A.box.w / 2)) || A.face;
          const kick = A.fx && A.fx.type === 'kick';
          st.vx = dir * (kick ? 1300 : 420 + Math.abs(st.vx) * 0.3); st.vy = kick ? -1100 : -320;
          st.x += dir * 6; if (kick) { sfx.boing(); burst('sparkle', st.x, st.y - r, 10); } else tone(220, 0.08, 'triangle', 0.2);
        }
      }
    } else if (st.kind === 'balloon') {
      const b = stkBox(st);
      if (actors.some((A) => A.box && !(A.hiddenUntil > clock) && A.box.x < b.x + b.w && A.box.x + A.box.w > b.x && A.box.y < b.y + b.h * 0.55 && A.box.y + A.box.h > b.y)) {
        st.popped = true; noise(0, 0.12, 0.9, 2000, 0.6); burst('confetti', 0, 0, 0);
        for (let i = 0; i < 18; i++) parts.push({ k: 's', x: st.x, y: b.y + b.h * 0.25, vx: rnd(-420, 420), vy: rnd(-420, 100), r: rnd(6, 12), l: 1, c: st.color });
        floatText('POP!', st.x, b.y + 30, '#fff', 50);
      }
    } else if (st.kind === 'car' && st.drive) {
      st.x += (st.flip ? -1 : 1) * 380 * dt; st.spin += (st.flip ? -1 : 1) * dt * 12;
      if (st.x > W + 150) st.x = -150; if (st.x < -150) st.x = W + 150;
    } else if (st.kind === 'rocket' && st.launch) {
      st.vy -= 900 * dt; st.y += st.vy * dt;
      if (Math.random() < dt * 30) parts.push({ k: 'p', x: st.x + rnd(-20, 20), y: st.y + 10, vx: rnd(-60, 60), vy: rnd(40, 120), r: rnd(12, 24), l: 0.7, c: '#ddd' });
      if (st.y < -300) { st.launch = false; st.vy = 0; st.y = GY + 6; floatText('Back again!', st.x, GY - 260, '#fff', 36); }
    }
  }
  stickers = stickers.filter((q) => !q.popped);
  if (selStk && !stickers.includes(selStk)) selStk = null;
}
function drawStickers(c, t) {
  for (const st of stickers) {
    c.save(); c.translate(st.x, st.y); c.scale((st.flip ? -1 : 1) * st.s, st.s);
    STICKERS[st.kind][1](c, st, t); c.restore();
    if (st === selStk && recState === 'idle') {
      const b = stkBox(st); c.save(); c.setLineDash([10, 8]); c.lineWidth = 3; c.strokeStyle = '#F2552C'; c.strokeRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12); c.restore();
    }
  }
}
function stickerAt(p) { return [...stickers].reverse().find((st) => { const b = stkBox(st); return p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h; }); }
function stickerTap(st) {
  if (st.kind === 'car') { st.drive = !st.drive; st.drive ? tone(110, 0.6, 'sawtooth', 0.15, 160) : tone(160, 0.3, 'sawtooth', 0.12, 90); }
  else if (st.kind === 'rocket' && !st.launch) { st.launch = true; st.vy = -200; noise(0, 1.6, 0.5, 300, 0.6, 'lowpass', 1500); }
  else if (st.kind === 'ball') { st.vy = -900; st.vx = rnd(-400, 400); sfx.boing(); }
  else if (st.kind === 'balloon') { st.y -= 40; tone(700, 0.15, 'sine', 0.15, 900); }
  else if (st.kind === 'sign') { const v = $('sayIn').value.trim(); if (v) { st.text = v.slice(0, 14); $('sayIn').value = ''; saveStickers(); } else toast('Type in the "What do they say?" box, then tap the sign to write on it.'); }
}
function placeStickerBar() {
  const bar = $('stbar');
  if (!selStk || mode !== 'studio') { bar.hidden = true; return; }
  const b = stkBox(selStk);
  const sx = (b.x + b.w / 2 - cam.x) * cam.z + W / 2, sy = (b.y - cam.y) * cam.z + H / 2;
  const r = stage.getBoundingClientRect(), k = r.width / W;
  bar.hidden = false;
  bar.style.left = Math.max(80, Math.min(r.width - 80, sx * k)) + 'px';
  bar.style.top = Math.max(48, sy * k - 8) + 'px';
}
document.querySelectorAll('#stbar button').forEach((b) => (b.onclick = (e) => {
  e.stopPropagation(); if (!selStk) return;
  const a = b.dataset.st;
  if (a === 'smaller') selStk.s = Math.max(0.35, selStk.s / 1.2);
  if (a === 'bigger') selStk.s = Math.min(2.6, selStk.s * 1.2);
  if (a === 'flip') selStk.flip = !selStk.flip;
  if (a === 'del') { const gone = selStk; stickers = stickers.filter((q) => q !== gone); selStk = null; puff(gone.x, gone.y - 80, 10); }
  sfx.pop(); saveStickers();
}));

/* =========================================================
   SCENE EFFECTS: slow motion, fast, spotlight, night, rain, snow, thunder
   ========================================================= */
const sceneFx = { slow: false, fast: false, spot: false, night: false, rain: false, snow: false };
let flashT = 0, simT = 0, rainSrc = null;
const drops = Array.from({ length: 160 }, () => ({ x: rnd(0, W), y: rnd(-H, H), s: rnd(900, 1300) }));
const flakesFx = Array.from({ length: 140 }, () => ({ x: rnd(0, W), y: rnd(-H, H), r: rnd(2.5, 6), s: rnd(40, 90), p: rnd(0, 6) }));
const nightStars = Array.from({ length: 70 }, () => ({ x: rnd(0, W), y: rnd(0, GY * 0.7), r: rnd(1, 2.6), p: rnd(0, 6) }));
function rainSound(on) {
  if (!actx) return;
  if (on && !rainSrc) {
    rainSrc = actx.createBufferSource(); rainSrc.buffer = noiseBuf; rainSrc.loop = true;
    const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400; const gn = actx.createGain(); gn.gain.value = 0.1;
    rainSrc.connect(f); f.connect(gn); gn.connect(master); rainSrc.start();
  } else if (!on && rainSrc) { try { rainSrc.stop(); } catch { /* fine */ } rainSrc = null; }
}
function sceneAction(kind) {
  switch (kind) {
    case 'slowmo': sceneFx.slow = !sceneFx.slow; sceneFx.fast = false; tone(sceneFx.slow ? 600 : 300, 0.6, 'sine', 0.2, sceneFx.slow ? 200 : 600); break;
    case 'fast': sceneFx.fast = !sceneFx.fast; sceneFx.slow = false; tone(400, 0.25, 'square', 0.1, 1200); break;
    case 'spot': sceneFx.spot = !sceneFx.spot; tone(300, 0.3, 'triangle', 0.15, 500); break;
    case 'night': sceneFx.night = !sceneFx.night; tone(sceneFx.night ? 500 : 900, 0.4, 'sine', 0.15, sceneFx.night ? 250 : 1200); break;
    case 'rain': sceneFx.rain = !sceneFx.rain; rainSound(sceneFx.rain); break;
    case 'snow': sceneFx.snow = !sceneFx.snow; tone(1200, 0.3, 'sine', 0.1, 1600); break;
    case 'thunder':
      flashT = 1; noise(0.05, 2.2, 0.9, 120, 0.7, 'lowpass'); tone(48, 1.8, 'sine', 0.6, 32, 0.05);
      quakeUntil = Math.max(quakeUntil, clock + 0.6);
      actors.forEach((B) => { if (!B.frozen) { B.fx = { type: 'shiver', t0: clock, dur: 1.2 }; if (B.lift < 8) B.vy = 350; } });
      break;
  }
}
function drawNightBase(c, t) {
  if (!sceneFx.night) return;
  c.save(); c.fillStyle = 'rgba(10,14,48,.58)'; c.fillRect(0, 0, W, H);
  nightStars.forEach((s) => { c.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(t * 1.5 + s.p)); c.fillStyle = '#fff'; c.beginPath(); c.arc(s.x, s.y, s.r, 0, Math.PI * 2); c.fill(); });
  c.globalAlpha = 1; c.fillStyle = '#FFF3C4'; c.beginPath(); c.arc(1080, 110, 46, 0, Math.PI * 2); c.fill();
  c.fillStyle = 'rgba(10,14,48,.58)'; c.beginPath(); c.arc(1100, 98, 40, 0, Math.PI * 2); c.fill();
  c.restore();
}
function drawWeather(c, dt, t) {
  if (sceneFx.night) { c.save(); c.fillStyle = 'rgba(20,30,90,.18)'; c.fillRect(0, 0, W, H); c.restore(); }
  if (sceneFx.rain) {
    c.save(); c.strokeStyle = 'rgba(200,225,255,.7)'; c.lineWidth = 2.5; c.beginPath();
    drops.forEach((d) => { d.y += d.s * dt; d.x -= d.s * 0.12 * dt; if (d.y > GY + 30) { d.y = rnd(-80, 0); d.x = rnd(0, W + 120); } c.moveTo(d.x, d.y); c.lineTo(d.x + 7, d.y - 30); });
    c.stroke(); c.fillStyle = 'rgba(40,60,110,.12)'; c.fillRect(0, 0, W, H); c.restore();
  }
  if (sceneFx.snow) {
    c.save(); c.fillStyle = '#fff';
    flakesFx.forEach((f) => { f.y += f.s * dt; if (f.y > GY + 40) { f.y = rnd(-40, 0); f.x = rnd(0, W); } c.beginPath(); c.arc(f.x + Math.sin(t + f.p) * 16, f.y, f.r, 0, Math.PI * 2); c.fill(); });
    c.restore();
  }
}
function drawScreenFx(c, dt) {
  if (sceneFx.spot) {
    const A = actors[sel];
    const cx = A?.box ? (A.box.x + A.box.w / 2 - cam.x) * cam.z + W / 2 : W / 2;
    const cy = A?.box ? (A.box.y + A.box.h / 2 - cam.y) * cam.z + H / 2 : H / 2;
    const r = Math.max(180, (A?.box ? Math.max(A.box.w, A.box.h) * 0.75 : 220) * cam.z);
    const gr = c.createRadialGradient(cx, cy, r * 0.75, cx, cy, r * 1.6);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(5,6,20,.82)');
    c.save(); c.fillStyle = gr; c.fillRect(0, 0, W, H); c.restore();
  }
  if (flashT > 0) { c.save(); c.globalAlpha = Math.min(1, flashT * (flashT > 0.7 ? 1 : 0.6)); c.fillStyle = '#fff'; c.fillRect(0, 0, W, H); c.restore(); flashT = Math.max(0, flashT - dt * 2.2); }
  if (sceneFx.slow || sceneFx.fast) {
    c.save(); c.font = "800 26px Grandstander, 'Comic Sans MS', sans-serif"; c.fillStyle = 'rgba(255,255,255,.9)'; c.strokeStyle = '#1F2A5C'; c.lineWidth = 6;
    const label = sceneFx.slow ? 'slow motion' : 'fast forward ▸▸'; c.textAlign = 'right';
    c.strokeText(label, W - 24, H - 22); c.fillText(label, W - 24, H - 22); c.restore();
  }
}

/* =========================================================
   CHARACTER CONTROL
   ========================================================= */
const keys = { l: false, r: false, u: false };
let clock = 0, animT = 0;
/* ---------- actions (grouped into pages on the action pad) ---------- */
const IC = {
  flip: '<path d="M22 9a9 9 0 1 0 2 8M22 3v6h-6" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>',
  spin: '<circle cx="15" cy="15" r="9" fill="none" stroke="currentColor" stroke-width="3.5" stroke-dasharray="40 17"/><path d="M22 4l2 6-6 1" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
  dance: '<path d="M11 23V7l12-3v16" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round"/><circle cx="8" cy="23" r="3.5" fill="currentColor"/><circle cx="20" cy="20" r="3.5" fill="currentColor"/>',
  wave: '<path d="M9 16V8a2 2 0 0 1 4 0v6M13 13V6a2 2 0 0 1 4 0v8M17 13V8a2 2 0 0 1 4 0v9c0 5-3 8-7 8s-6-2-8-6l-2-4a2 2 0 0 1 3-2l2 3" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  run: '<path d="M4 9h9M2 15h9M5 21h8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="21" cy="15" r="6" fill="none" stroke="currentColor" stroke-width="3"/>',
  fly: '<path d="M3 19c6-11 17-13 24-11-7 2-9 7-11 13-4-4-8-3-13-2z" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linejoin="round"/>',
  stomp: '<path d="M15 3v13M9 11l6 6 6-6M4 25h22" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>',
  kick: '<path d="M11 4v9l9 5M11 13l-4 12" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24" cy="22" r="4" fill="currentColor"/>',
  clap: '<path d="M10 22 13 7M20 22 17 7" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/><path d="M7 4 9 7M15 2v3M23 4l-2 3" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  bow: '<circle cx="10" cy="7" r="3.5" fill="currentColor"/><path d="M10 12q8 1 12 9M12 14l-3 12M21 21l2 5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>',
  laugh: '<circle cx="15" cy="15" r="11" fill="none" stroke="currentColor" stroke-width="2.8"/><path d="M9 11.5h4M17 11.5h4M9 17h12a6 6 0 0 1-12 0z" fill="currentColor" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/>',
  sneeze: '<circle cx="11" cy="15" r="8" fill="none" stroke="currentColor" stroke-width="2.8"/><path d="M21 9l5-2M22 15h6M21 21l5 2" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  sleep: '<path d="M5 9h8l-8 9h8M17 15h7l-7 8h7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
  shiver: '<path d="M8 4 4 9l4 5-4 5 4 5M22 4l4 5-4 5 4 5-4 5M15 6v18" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>',
  hug: '<path d="M15 25S4 18 4 11a5.5 5.5 0 0 1 11-1 5.5 5.5 0 0 1 11 1c0 7-11 14-11 14z" fill="currentColor"/>',
  poof: '<path d="M8 22a5 5 0 0 1 0-10 7 7 0 0 1 13-2 5 5 0 0 1 1 10z" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linejoin="round"/><path d="M4 26h2M12 27h2M20 26h2" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  grow: '<path d="M5 25 25 5M17 5h8v8M13 25H5v-8" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>',
  turn: '<path d="M6 11h17l-5-5M24 19H7l5 5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>',
  front: '<path d="M4 18l11 6 11-6M15 6 4 12l11 6 11-6z" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linejoin="round"/>',
  freeze: '<path d="M15 3v24M5 9l20 12M25 9 5 21M12 5l3 3 3-3M12 25l3-3 3 3" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  zoom: '<circle cx="13" cy="13" r="8" fill="none" stroke="currentColor" stroke-width="3.5"/><path d="m19 19 7 7M13 9v8M9 13h8" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/>',
  quake: '<path d="M2 16h5l3-9 4 17 4-13 3 5h7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
  party: '<path d="M5 26 11 8l11 11z" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linejoin="round"/><path d="M17 4v3M24 6l-2 2M26 13h-3" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  bounce: '<path d="M4 24c3-14 6-14 8 0 2-10 5-10 7 0 1-6 4-6 6 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
  slowmo: '<circle cx="15" cy="16" r="10" fill="none" stroke="currentColor" stroke-width="3"/><path d="M15 10v6l4 3M11 3h8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
  fast: '<path d="M4 7l9 8-9 8zM15 7l9 8-9 8z" fill="currentColor"/>',
  spot: '<path d="M11 3h8l-2 6h-4z" fill="currentColor"/><path d="M13 9 4 27h22L17 9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/>',
  night: '<path d="M20 4a11 11 0 1 0 6 16A9 9 0 0 1 20 4z" fill="currentColor"/>',
  rain: '<path d="M8 17a5 5 0 0 1 0-10 7 7 0 0 1 13-1 5 5 0 0 1 1 11z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/><path d="M9 21l-2 5M15 21l-2 5M21 21l-2 5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  snow: '<circle cx="8" cy="8" r="2.6" fill="currentColor"/><circle cx="21" cy="6" r="2" fill="currentColor"/><circle cx="14" cy="15" r="3" fill="currentColor"/><circle cx="6" cy="22" r="2" fill="currentColor"/><circle cx="23" cy="20" r="2.6" fill="currentColor"/>',
  thunder: '<path d="M17 2 6 17h8l-3 11 13-17h-8z" fill="currentColor"/>',
  reset: '<path d="M6 15a9 9 0 1 0 3-7M6 4v5h5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>',
};
// [id, label, page, keyboard key, toggle?]
const ACTIONS = [
  ['flip', 'Flip', 'moves', 'F'], ['spin', 'Spin', 'moves', 'S'], ['dance', 'Dance', 'moves', 'D'], ['wave', 'Wave', 'moves', 'W'],
  ['run', 'Run', 'moves', 'X', true], ['fly', 'Fly', 'moves', 'V', true], ['stomp', 'Stomp', 'moves', 'B'], ['kick', 'Kick', 'moves', 'K'],
  ['clap', 'Clap', 'act', 'C'], ['bow', 'Bow', 'act', 'O'], ['laugh', 'Laugh', 'act', 'L'], ['sneeze', 'Sneeze', 'act', 'N'],
  ['sleep', 'Sleep', 'act', 'Y', true], ['shiver', 'Shiver', 'act', 'H'], ['hug', 'Hug', 'act', 'U'], ['poof', 'Poof!', 'act', 'P'],
  ['grow', 'Grow', 'more', 'G'], ['turn', 'Turn', 'more', 'T'], ['front', 'To front', 'more', 'J'], ['freeze', 'Freeze', 'more', 'I', true],
  ['bounce', 'Bounce', 'more', '9'], ['quake', 'Quake', 'more', 'Q'], ['party', 'All dance', 'more', 'A'], ['reset', 'Reset', 'more', 'E'],
  ['zoom', 'Zoom', 'scene', 'Z', true], ['slowmo', 'Slow-mo', 'scene', ',', true], ['fast', 'Fast', 'scene', '.', true], ['spot', 'Spotlight', 'scene', '/', true],
  ['night', 'Night', 'scene', '[', true], ['rain', 'Rain', 'scene', ']', true], ['snow', 'Snow', 'scene', ';', true], ['thunder', 'Thunder', 'scene', "'"],
];
const KEYMAP = Object.fromEntries(ACTIONS.map(([id, , , k]) => [k.toLowerCase(), id]));
let padPage = 'moves';
function renderPad() {
  const g = $('padgrid'); g.innerHTML = '';
  ACTIONS.filter((a) => a[2] === padPage).forEach(([id, label, , key, toggle]) => {
    const b = document.createElement('button'); b.className = 'act'; b.dataset.act = id;
    if (toggle) b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `<svg viewBox="0 0 30 30" aria-hidden="true">${IC[id]}</svg><span>${label}</span><kbd>${key}</kbd>`;
    b.addEventListener('click', () => doAction(id));
    g.appendChild(b);
  });
  document.querySelectorAll('#padtabs button').forEach((t) => t.setAttribute('aria-selected', t.dataset.pg === padPage));
  syncPad();
}
document.querySelectorAll('#padtabs button').forEach((t) => (t.onclick = () => { padPage = t.dataset.pg; renderPad(); }));
function syncPad() {
  const A = actors[sel];
  const state = { run: A?.run, fly: A?.fly, sleep: A?.sleep, freeze: A?.frozen, zoom: zoomOn, slowmo: sceneFx.slow, fast: sceneFx.fast, spot: sceneFx.spot, night: sceneFx.night, rain: sceneFx.rain, snow: sceneFx.snow };
  document.querySelectorAll('#padgrid .act').forEach((b) => {
    const id = b.dataset.act;
    if (id in state) b.setAttribute('aria-pressed', !!state[id]);
    if (id === 'grow' && A) b.querySelector('span').textContent = ['Grow', 'Shrink', 'Normal'][A.bigStep];
  });
  const jb = document.querySelector('.act[data-act=jump] span'); if (jb) jb.textContent = A?.fly ? 'Up' : 'Jump';
}

let quakeUntil = 0, layerSeq = 0;
function floatText(text, x, y, color = '#fff', size = 46) { parts.push({ k: 't', text, x, y, vx: rnd(-20, 20), vy: -90, l: 1.6, c: color, r: size }); }
function puff(x, y, n = 18) { for (let i = 0; i < n; i++) parts.push({ k: 'p', x: x + rnd(-40, 40), y: y + rnd(-50, 30), vx: rnd(-120, 120), vy: rnd(-120, 40), r: rnd(18, 40), l: 0.8, c: '#fff' }); }
function dust(x, n = 12) { for (let i = 0; i < n; i++) parts.push({ k: 'p', x: x + rnd(-30, 30), y: GY + rnd(-6, 6), vx: rnd(-220, 220), vy: rnd(-90, -10), r: rnd(10, 22), l: 0.6, c: '#C9B79A' }); }
function headPt(A) { return A?.box ? { x: A.box.x + A.box.w / 2, y: A.box.y } : { x: W / 2, y: H / 3 }; }

function doAction(kind) {
  ensureAudio();
  if (['slowmo', 'fast', 'spot', 'night', 'rain', 'snow', 'thunder'].includes(kind)) { sceneAction(kind); syncPad(); return; }
  const A = actors[sel]; if (!A) return;
  const onGround = A.lift < 8;
  const fx = (type, dur) => { A.fx = { type, t0: clock, dur }; };
  switch (kind) {
    case 'jump': if (A.fly) break; if (onGround) { A.vy = A.run ? 1250 : 1150; sfx.jump(); } break;
    case 'flip': if (onGround || A.fly) { if (!A.fly) A.vy = 1250; A.flipT = 0; sfx.whoosh(); } break;
    case 'spin': A.spinT = 0; sfx.whoosh(); break;
    case 'dance': A.act = 'Dance'; A.actUntil = clock + 4; A.sleep = false; tone(660, 0.1, 'triangle', 0.15); break;
    case 'wave': A.act = 'Wave'; A.actUntil = clock + 3; A.sleep = false; break;
    case 'run': A.run = !A.run; tone(A.run ? 500 : 350, 0.15, 'square', 0.12, A.run ? 900 : 250); if (A.run) toast('Running! Hold the walk buttons to zoom across.'); break;
    case 'fly': A.fly = !A.fly; A.vy = 0; if (A.fly) { A.lift = Math.max(A.lift, 60); sfx.whoosh(); toast('Flying! Hold Up to rise, let go to float down.'); } break;
    case 'stomp': if (onGround && !A.fly) { A.vy = 1000; A.stomp = true; sfx.jump(); } break;
    case 'kick': fx('kick', 0.5); sfx.whoosh(); break;
    case 'clap': fx('clap', 1.4); for (let i = 0; i < 5; i++) noise(i * 0.26 + 0.05, 0.06, 0.6, 2200, 1.4); break;
    case 'bow': fx('bow', 1.8); setTimeout(() => sfx.applause(), 500); break;
    case 'laugh': { fx('laugh', 1.8); for (let i = 0; i < 7; i++) tone(520 - i * 18, 0.12, 'triangle', 0.2, 700 - i * 20, i * 0.2); const h = headPt(A); floatText('Ha ha!', h.x, h.y - 10, '#FFC83D'); break; }
    case 'sneeze': {
      fx('sneeze', 1.3); tone(300, 0.6, 'sine', 0.12, 700);
      setTimeout(() => { const h = headPt(A); floatText('ACHOO!', h.x + A.face * 60, h.y, '#fff', 54); noise(0, 0.5, 0.6, 2500, 0.7, 'bandpass', 600); A.home -= A.face * 40; if (A.lift < 8) A.vy = 380; }, 720);
      break;
    }
    case 'sleep': A.sleep = !A.sleep; if (A.sleep) { A.act = null; A.zT = 0; tone(400, 0.6, 'sine', 0.15, 200); } break;
    case 'shiver': fx('shiver', 2); for (let i = 0; i < 16; i++) tone(900 + rnd(-80, 80), 0.04, 'square', 0.05, null, i * 0.11); break;
    case 'hug': {
      const others = actors.filter((B) => B !== A);
      if (!others.length) { toast('Draw a second character to hug!'); break; }
      const B = others.reduce((a, b) => (Math.abs(b.home - A.home) < Math.abs(a.home - A.home) ? b : a));
      A.hugWith = B; A.sleep = false; A.targetX = null; break;
    }
    case 'poof': {
      const h = headPt(A); puff(h.x, h.y + (A.box ? A.box.h / 2 : 0)); noise(0, 0.4, 0.5, 900, 0.8, 'bandpass', 200);
      A.hiddenUntil = clock + 0.7;
      const nx = A.home < W / 2 ? rnd(W * 0.6, W - 120) : rnd(120, W * 0.4);
      setTimeout(() => { A.home = nx; A.targetX = null; puff(nx, GY - 120); tone(700, 0.2, 'sine', 0.25, 1400); }, 650);
      break;
    }
    case 'grow': A.bigStep = (A.bigStep + 1) % 3; A.big = [1, 1.5, 0.6][A.bigStep]; A.bigStep === 1 ? tone(300, 0.4, 'triangle', 0.25, 700) : tone(700, 0.35, 'triangle', 0.25, 300); break;
    case 'bounce': A.act = 'Hop'; A.actUntil = clock + 3.5; A.sleep = false; sfx.boing(); break;
    case 'turn': A.face *= -1; tone(600, 0.1, 'sine', 0.15, 800); break;
    case 'front': A.layer = ++layerSeq; sfx.pop(); break;
    case 'freeze': A.frozen = !A.frozen; tone(A.frozen ? 1500 : 800, 0.4, 'sine', 0.15, A.frozen ? 2400 : 400); break;
    case 'zoom': zoomOn = !zoomOn; tone(zoomOn ? 500 : 800, 0.25, 'sine', 0.2, zoomOn ? 800 : 500); break;
    case 'quake': quakeUntil = clock + 1.3; noise(0, 1.3, 0.8, 90, 0.7, 'lowpass'); tone(55, 1.2, 'sine', 0.5, 40); actors.forEach((B) => { if (B.lift < 8 && !B.frozen) B.vy = rnd(250, 450); }); break;
    case 'party': actors.forEach((B) => { B.act = 'Dance'; B.actUntil = clock + 5; B.sleep = false; }); burst('confetti', 0, 0, 120); sfx.tada(); break;
    case 'reset':
      Object.assign(A, { run: false, fly: false, sleep: false, frozen: false, fx: null, act: null, mood: '', big: 1, bigStep: 0, hugWith: null, layer: 0, flipT: -1, spinT: -1 });
      document.querySelectorAll('#feelings .feel').forEach((f) => f.setAttribute('aria-pressed', 'false'));
      sfx.pop(); break;
  }
  syncPad();
}

// walk buttons (hold) and the jump / fly-up button (hold while flying)
document.querySelectorAll('.pad-move .act').forEach((b) => {
  const k = b.dataset.act;
  const key = k === 'left' ? 'l' : k === 'right' ? 'r' : 'u';
  const on = (e) => {
    e.preventDefault(); ensureAudio(); keys[key] = true; b.classList.add('on');
    if (actors[sel]) actors[sel].targetX = null;
    if (k === 'jump') doAction('jump');
  };
  const off = () => { keys[key] = false; b.classList.remove('on'); };
  b.addEventListener('pointerdown', on); ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => b.addEventListener(t, off));
  b.addEventListener('contextmenu', (e) => e.preventDefault());
});

const FEELINGS = [
  ['happy', 'Happy', '<circle cx="16" cy="16" r="13" fill="#FFC83D" stroke="#1F2A5C" stroke-width="2"/><circle cx="11.5" cy="13" r="2" fill="#1F2A5C"/><circle cx="20.5" cy="13" r="2" fill="#1F2A5C"/><path d="M10 19q6 6 12 0" fill="none" stroke="#1F2A5C" stroke-width="2.4" stroke-linecap="round"/>'],
  ['surprised', 'Surprised', '<circle cx="16" cy="16" r="13" fill="#FFC83D" stroke="#1F2A5C" stroke-width="2"/><path d="M8.5 8.5q3-2 6 0M17.5 8.5q3-2 6 0" fill="none" stroke="#1F2A5C" stroke-width="2" stroke-linecap="round"/><circle cx="11.5" cy="13" r="2.4" fill="#1F2A5C"/><circle cx="20.5" cy="13" r="2.4" fill="#1F2A5C"/><ellipse cx="16" cy="21.5" rx="3" ry="4" fill="#1F2A5C"/>'],
  ['sad', 'Sad', '<circle cx="16" cy="16" r="13" fill="#9CC9F5" stroke="#1F2A5C" stroke-width="2"/><path d="M8.5 10l5-2M23.5 10l-5-2" fill="none" stroke="#1F2A5C" stroke-width="2" stroke-linecap="round"/><circle cx="11.5" cy="13.5" r="2" fill="#1F2A5C"/><circle cx="20.5" cy="13.5" r="2" fill="#1F2A5C"/><path d="M11 23q5-5 10 0" fill="none" stroke="#1F2A5C" stroke-width="2.4" stroke-linecap="round"/>'],
  ['angry', 'Angry', '<circle cx="16" cy="16" r="13" fill="#FF8A6B" stroke="#1F2A5C" stroke-width="2"/><path d="M8.5 8.5l5 3M23.5 8.5l-5 3" fill="none" stroke="#1F2A5C" stroke-width="2.2" stroke-linecap="round"/><circle cx="11.5" cy="14" r="2" fill="#1F2A5C"/><circle cx="20.5" cy="14" r="2" fill="#1F2A5C"/><path d="M10 22l3-2 3 2 3-2 3 2" fill="none" stroke="#1F2A5C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'],
];
FEELINGS.forEach(([v, label, svg]) => {
  const b = document.createElement('button'); b.className = 'feel'; b.dataset.v = v; b.setAttribute('aria-label', label); b.title = label; b.setAttribute('aria-pressed', 'false');
  b.innerHTML = `<svg viewBox="0 0 32 32" aria-hidden="true">${svg}</svg>`;
  b.onclick = () => setMood(v);
  $('feelings').appendChild(b);
});
function setMood(v) {
  const A = actors[sel]; if (!A) return; ensureAudio();
  if (!A.eyes.length) toast('Give this character googly eyes (on the Draw page) to show feelings on its face.', 4500);
  A.mood = A.mood === v ? '' : v;
  if (A.mood === 'surprised' && A.lift < 8) { A.vy = 520; tone(500, 0.2, 'sine', 0.25, 1100); }
  else if (A.mood === 'happy') tone(660, 0.15, 'triangle', 0.2, 990);
  else if (A.mood === 'sad') tone(440, 0.5, 'sine', 0.2, 300);
  else if (A.mood === 'angry') noise(0, 0.25, 0.25, 300, 1.5);
  document.querySelectorAll('#feelings .feel').forEach((f) => f.setAttribute('aria-pressed', f.dataset.v === A.mood));
}
let zoomOn = false;
const cam = { z: 1, x: W / 2, y: H / 2 };
document.addEventListener('keydown', (e) => {
  if (mode !== 'studio' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'arrowleft') { keys.l = true; e.preventDefault(); if (actors[sel]) actors[sel].targetX = null; }
  else if (k === 'arrowright') { keys.r = true; e.preventDefault(); if (actors[sel]) actors[sel].targetX = null; }
  else if (k === ' ' || k === 'arrowup') { e.preventDefault(); keys.u = true; if (!e.repeat) doAction('jump'); }
  else if (e.repeat) return;
  else if (/^[1-9]$/.test(k) && actors[+k - 1]) selectActor(+k - 1);
  else if (k === 'r') $('recBtn').click();
  else if (k === 'm') $('micBtn').click();
  else if (KEYMAP[k]) doAction(KEYMAP[k]);
});
document.addEventListener('keyup', (e) => { if (e.key === 'ArrowLeft') keys.l = false; if (e.key === 'ArrowRight') keys.r = false; if (e.key === ' ' || e.key === 'ArrowUp') keys.u = false; });

function say() {
  const A = actors[sel], text = $('sayIn').value.trim(); if (!A || !text) return;
  A.bubble = { text, until: clock + Math.max(2.5, text.length * 0.08 + 1.2) };
  $('sayIn').value = ''; tone(880, 0.08, 'sine', 0.15);
}
$('sayBtn').onclick = say;
$('sayIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); say(); } });

// tap to pick, drag to move, tap an empty spot to walk there
const stage = $('stage'), sctx = stage.getContext('2d');
function stagePt(e) {
  const r = stage.getBoundingClientRect(); const sx = (e.clientX - r.left) * W / r.width, sy = (e.clientY - r.top) * H / r.height;
  return { x: (sx - W / 2) / cam.z + cam.x, y: (sy - H / 2) / cam.z + cam.y };
}
stage.addEventListener('pointerdown', (e) => {
  if (mode !== 'studio') return; ensureAudio();
  const p = stagePt(e);
  const hit = [...drawOrder].reverse().find((A) => A.box && p.x > A.box.x && p.x < A.box.x + A.box.w && p.y > A.box.y && p.y < A.box.y + A.box.h);
  if (hit) {
    selectActor(actors.indexOf(hit));
    const footY = GY - hit.lift;
    hit.drag = { id: e.pointerId, ox: p.x - hit.home, oy: footY - p.y, sx: p.x, sy: p.y, moved: false };
    hit.targetX = null;
    stage.setPointerCapture(e.pointerId);
  } else {
    const st = stickerAt(p);
    if (st) {
      selStk = st; st.drag = { id: e.pointerId, ox: p.x - st.x, oy: p.y - st.y, sx: p.x, sy: p.y, moved: false };
      stage.setPointerCapture(e.pointerId);
    } else if (selStk) selStk = null;
    else if (actors[sel]) actors[sel].targetX = Math.max(60, Math.min(W - 60, p.x));
  }
});
stage.addEventListener('pointermove', (e) => {
  const st = stickers.find((q) => q.drag && q.drag.id === e.pointerId); if (!st) return;
  const p = stagePt(e), d = st.drag;
  if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) > 8) d.moved = true;
  if (!d.moved) return;
  st.x = Math.max(0, Math.min(W, p.x - d.ox)); st.y = Math.max(60, Math.min(H + 20, p.y - d.oy)); st.vx = st.vy = 0;
});
function endStickerDrag(e) {
  const st = stickers.find((q) => q.drag && q.drag.id === e.pointerId); if (!st) return;
  const moved = st.drag.moved; st.drag = null;
  if (!moved) stickerTap(st); else { sfx.pop(); saveStickers(); }
}
stage.addEventListener('pointerup', endStickerDrag); stage.addEventListener('pointercancel', endStickerDrag);
stage.addEventListener('pointermove', (e) => {
  const A = actors.find((q) => q.drag && q.drag.id === e.pointerId); if (!A) return;
  const p = stagePt(e), d = A.drag;
  if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) > 10) { d.moved = true; sfx.pop(); }
  if (!d.moved) return;
  A.home = Math.max(40, Math.min(W - 40, p.x - d.ox));
  A.lift = Math.max(0, Math.min(H * 0.7, GY - (p.y + d.oy))); A.vy = 0; A.mix = 0;
});
function endDrag(e) {
  const A = actors.find((q) => q.drag && q.drag.id === e.pointerId); if (!A) return;
  if (!A.drag.moved) { if (A.tickle <= 0) { A.tickle = 1; sfx.giggle(); } }
  A.drag = null;
}
stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);

function blinkOf(A, t) { if (t > A.blinkAt) { A.blinkT = t; A.blinkAt = t + rnd(2, 5); } const d = t - A.blinkT; return d < 0.16 ? Math.sin(d / 0.16 * Math.PI) : 0; }
function shadow(c, x, lift, width) { const k = Math.max(0.3, 1 - lift / 360); c.fillStyle = 'rgba(0,0,0,.18)'; c.beginPath(); c.ellipse(x, GY + 6, width * 0.42 * k, 16 * k, 0, 0, Math.PI * 2); c.fill(); }
function nameTag(c, name, x) {
  if (!name) return;
  c.save(); c.font = "600 22px Lexend, system-ui, sans-serif"; const w = c.measureText(name).width + 28;
  const bx = Math.max(6, Math.min(W - w - 6, x - w / 2));
  c.fillStyle = 'rgba(255,255,255,.88)'; c.beginPath(); c.roundRect(bx, GY + 30, w, 34, 17); c.fill();
  c.fillStyle = '#1F2A5C'; c.textBaseline = 'middle'; c.fillText(name, bx + 14, GY + 48); c.restore();
}

function updateActor(A, dt, t, isSel) {
  if (A.replaying && A.settings.part) { const r = replayFrame(A); if (r) return r; }
  const out = updateActorLive(A, dt, t, isSel);
  if (A.newFrames && recState === 'rec') capturePartFrame(A, out);
  return out;
}
function updateActorLive(A, dt, t, isSel) {
  const P = A.persona;
  A.autoT += dt;
  const frozen = A.frozen;
  let steer = 0;
  if (!frozen) {
    if (isSel && !A.drag) steer = (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
    if (!steer && A.hugWith) {
      const B = A.hugWith, sA = A.scale * A.bigNow, sB = B.scale * B.bigNow;
      const side = Math.sign(A.home - B.home) || -1;
      A.targetX = B.home + side * (A.w * sA / 2 + B.w * sB / 2) * 0.72;
      if (Math.abs(A.targetX - A.home) < 14) {
        A.hugUntil = B.hugUntil = clock + 2.2; A.hugDir = -side; B.hugDir = side; A.face = -side; B.face = side;
        burst('hearts', (A.home + B.home) / 2, GY - Math.max(A.h * sA, B.h * sB) * 0.8, 16); sfx.tada();
        A.hugWith = null; A.targetX = null;
      }
    }
    if (!steer && A.targetX != null && !A.drag) {
      const d = A.targetX - A.home;
      if (Math.abs(d) < 12) A.targetX = null; else steer = Math.sign(d);
    }
  }
  const speed = A.run ? 820 : 430;
  if (steer) {
    A.home = Math.max(50, Math.min(W - 50, A.home + steer * speed * dt)); A.face = steer; A.walk += dt * (A.run ? 18 : 11); A.sleep = false;
    if (A.run && A.lift < 4 && Math.random() < dt * 14) dust(A.home - steer * 30, 2);
  }
  // vertical motion: flying, or jumping with gravity
  if (A.fly && !A.drag && !frozen) {
    const up = isSel && keys.u;
    A.lift = Math.max(0, Math.min(H * 0.72, A.lift + (up ? 420 : -70) * dt)); A.vy = 0;
  } else if (!A.drag && !frozen && (A.lift > 0 || A.vy > 0)) {
    A.vy -= 2600 * dt; A.lift += A.vy * dt;
    if (A.lift <= 0) {
      if (A.stomp) { A.stomp = false; quakeUntil = Math.max(quakeUntil, clock + 0.5); dust(A.home, 22); tone(70, 0.5, 'sine', 0.7, 35); noise(0, 0.35, 0.6, 200, 0.8, 'lowpass'); A.squash = 1.4; }
      else if (A.vy < -500) { A.squash = 1; sfx.land(); }
      A.lift = 0; A.vy = 0; A.flipT = -1;
    }
  }
  A.squash = Math.max(0, A.squash - dt * 4);
  A.bigNow += (A.big - A.bigNow) * Math.min(1, dt * 6);
  const free = !steer && !A.drag && A.lift <= 0 && !A.fly;
  A.mix = free ? Math.min(1, A.mix + dt * 0.8) : Math.max(0, A.mix - dt * 4);

  let m = A.settings.move;
  if (m === 'Auto') m = ((A.autoT + P.offset) % 10) < 6.5 ? P.signature : P.second;
  if (A.sleep) m = 'Idle';
  if (A.act && clock < A.actUntil) { m = A.act; A.mix = Math.max(A.mix, 0.999); } else A.act = null;
  const pz = pose(m, animT * P.tempo + P.offset, P, A.home, range, A.rig);
  let o = pz.o;
  if (steer) {
    const st = Math.sin(A.walk), k = A.run ? 1.4 : 1;
    o = { flip: A.face < 0, wave: 0.3, phase: t * 10, rot: (A.run ? 0.14 * A.face : 0) + 0.06 * st, legL: 0.4 * k * st, legR: -0.4 * k * st, armL: -0.5 * k * st, armR: 0.5 * k * st, sx: 1, sy: 1 };
  } else if (A.drag) {
    o = { wave: 0.5, phase: t * 8, rot: 0.12 * Math.sin(t * 6), armL: 1.2 + 0.3 * Math.sin(t * 12), armR: 1.2 + 0.3 * Math.sin(t * 12 + 1), legL: 0.35 * Math.sin(t * 9), legR: -0.35 * Math.sin(t * 9), sx: 1, sy: 1 };
  } else if (A.fly) {
    const f = Math.sin(t * (keys.u && isSel ? 22 : 12));
    o = { flip: A.face < 0, wave: 0.3, phase: t * 6, rot: 0.06 * Math.sin(t * 2), armL: 0.9 + 0.8 * f, armR: 0.9 + 0.8 * f, legL: 0.25, legR: -0.25, sx: 1, sy: 1 + 0.04 * f };
  } else if (A.lift > 6) {
    o.armL = o.armR = 1.25; o.legL = -0.35; o.legR = 0.35;
  }
  if (o.flip === undefined) o.flip = A.face < 0;
  let x = A.home + (pz.x - A.home) * A.mix;
  const lift = pz.lift * A.mix + A.lift + (steer ? Math.abs(Math.sin(A.walk)) * (A.run ? 16 : 10) : 0) + (A.fly ? Math.sin(t * 2.5) * 8 : 0);

  // one-shot acts
  if (A.fx) {
    const p = (clock - A.fx.t0) / A.fx.dur, f = A.face;
    if (p >= 1) A.fx = null;
    else switch (A.fx.type) {
      case 'kick': { const k = Math.sin(p * Math.PI); if (A.rig.legs.length) { if (f > 0) o.legR = -1.3 * k; else o.legL = 1.3 * k; } o.rot = (o.rot || 0) - f * 0.12 * k; break; }
      case 'clap': { const k = Math.abs(Math.sin(p * Math.PI * 5)); o.armL = o.armR = 1.0 + 0.6 * k; o.sy = (o.sy || 1) * (1 + 0.02 * k); break; }
      case 'bow': { const k = Math.sin(Math.min(1, p * 1.3) * Math.PI); o.rot = f * 0.55 * k; o.armL = o.armR = -0.2 * k; o.legL = o.legR = 0; break; }
      case 'laugh': o.sy = (o.sy || 1) * (1 + 0.07 * Math.sin(p * 70)); o.rot = (o.rot || 0) + 0.08 * Math.sin(p * 44); o.squint = true; o.forceTalk = 0.5 + 0.4 * Math.abs(Math.sin(p * 30)); o.armL = o.armR = 0.6; break;
      case 'sneeze':
        if (p < 0.55) { const k = p / 0.55; o.rot = -f * 0.28 * k; o.sy = (o.sy || 1) * (1 + 0.06 * k); o.squint = true; }
        else { const k = 1 - (p - 0.55) / 0.45; o.rot = f * 0.32 * k; o.forceTalk = 0.9 * k; }
        break;
      case 'shiver': x += Math.sin(t * 70) * 7; o.sx = (o.sx || 1) * 0.97; o.armL = o.armR = -0.3; break;
    }
  }
  if (A.hugUntil > clock) { o.rot = (o.rot || 0) + 0.2 * (A.hugDir || 1); o.armL = o.armR = 0.7; o.flip = (A.hugDir || 1) < 0; }
  if (A.flipT >= 0) { A.flipT = Math.min(1, A.flipT + dt / 0.8); o.rot = (o.rot || 0) - A.face * A.flipT * Math.PI * 2; o.pivotMid = true; if (A.flipT >= 1) A.flipT = -1; }
  if (A.spinT >= 0) { A.spinT += dt / 0.7; o.rot = (o.rot || 0) + Math.min(1, A.spinT) * Math.PI * 2; o.pivotMid = true; if (A.spinT >= 1) A.spinT = -1; }
  if (A.tickle > 0) { A.tickle = Math.max(0, A.tickle - dt * 1.1); o.rot = (o.rot || 0) + (1 - A.tickle) * Math.PI * 2; o.pivotMid = true; }
  o.sy = (o.sy || 1) * (1 - A.squash * 0.18) * (1 + 0.02 * Math.sin(animT * 2 + P.offset));
  o.sx = (o.sx || 1) * (1 + A.squash * 0.15);
  if (A.sleep) {
    o.sy *= 1 + 0.045 * Math.sin(t * 1.6); o.rot = (o.rot || 0) + 0.1 * A.face; o.armL = o.armR = -0.1; o.wave = 0.05;
    A.zT = (A.zT || 0) + dt;
    if (A.zT > 1.1 && A.box) { A.zT = 0; floatText('Z', A.box.x + A.box.w * (A.face > 0 ? 0.8 : 0.2), A.box.y + 10, '#fff', rnd(30, 48)); tone(180, 0.5, 'sine', 0.06, 140); }
  }
  const speaking = A.bubble && clock < A.bubble.until;
  if (isSel && micOn) A.vol = A.vol * 0.5 + micLevel() * 0.5;
  else if (speaking) A.vol = 0.25 + 0.3 * Math.abs(Math.sin(t * 13));
  else A.vol *= 0.8;
  o.talk = Math.max(A.vol, o.forceTalk || 0); o.sy *= 1 + A.vol * 0.08;
  o.hat = A.settings.hat; o.mood = A.mood;
  if (A.mood === 'sad') { o.sy *= 0.95; o.rot = (o.rot || 0) + 0.05; }
  if (A.mood === 'angry') o.rot = (o.rot || 0) + Math.sin(t * 40) * 0.025;
  o.blink = A.sleep ? 1 : o.squint ? 0.7 : A.tickle > 0 ? 0.85 : blinkOf(A, t);
  if (o.lx === undefined) { o.lx = A.face * 0.4 + Math.sin(t * 0.9 + P.offset) * 0.6; o.ly = Math.cos(t * 1.3 + P.offset) * 0.5; }
  if (frozen) {
    // a statue: hold the last pose
    if (A.frozenPose) return { ...A.frozenPose, A };
  }
  const s = A.scale * A.bigNow;
  const hw = A.w * s / 2;
  const out = { A, x: Math.max(hw + 6, Math.min(W - hw - 6, x)), lift: Math.max(0, lift), o, s };
  A.frozenPose = frozen ? out : null;
  return out;
}

let drawOrder = [];
function renderStudio(c, rdt) {
  const ts = sceneFx.slow ? 0.35 : sceneFx.fast ? 1.9 : 1;
  const dt = rdt * ts; simT += dt; const t = simT;
  clock += dt; animT += dt;
  const A0 = actors[sel];
  const tz = zoomOn && A0?.box ? 1.75 : 1;
  const tx = zoomOn && A0?.box ? A0.box.x + A0.box.w / 2 : W / 2, ty = zoomOn && A0?.box ? A0.box.y + A0.box.h * 0.45 : H / 2;
  const k = Math.min(1, dt * 4);
  cam.z += (tz - cam.z) * k; cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
  const hw = W / 2 / cam.z, hh = H / 2 / cam.z;
  cam.x = Math.max(hw, Math.min(W - hw, cam.x)); cam.y = Math.max(hh, Math.min(H - hh, cam.y));
  const q = quakeUntil > clock ? Math.min(1, quakeUntil - clock) * 16 : 0;
  c.save(); c.translate(W / 2 + rnd(-q, q), H / 2 + rnd(-q, q)); c.scale(cam.z, cam.z); c.translate(-cam.x, -cam.y);
  if (q) { c.translate(W / 2, H / 2); c.rotate(rnd(-0.01, 0.01) * q / 16); c.translate(-W / 2, -H / 2); c.scale(1.03, 1.03); c.translate(-W * 0.015, -H * 0.015); }
  if (fadeT < 1) {
    fadeT = Math.min(1, fadeT + dt * 2.2);
    paintScene(c, t, dt, prevScene); c.save(); c.globalAlpha = fadeT; paintScene(c, t, dt, scene); c.restore();
  } else paintScene(c, t, dt, scene);
  drawNightBase(c, t);
  updateStickers(dt, t);
  drawStickers(c, t);
  const frames = actors.map((A, i) => updateActor(A, dt, t, i === sel)).filter((f) => !(f.A.hiddenUntil > clock));
  actors.forEach((A) => { if (A.hiddenUntil > clock) A.box = null; });
  frames.sort((a, b) => ((a.A.layer || 0) - (b.A.layer || 0)) || (a.lift - b.lift));
  drawOrder = frames.map((f) => f.A);
  frames.forEach((f) => shadow(c, f.x, f.lift, f.A.w * f.s));
  frames.forEach((f) => {
    if (f.A.frozen) { c.save(); c.filter = 'saturate(0.25) brightness(1.12) contrast(0.95)'; }
    drawActor(c, f.A, f.x, GY - f.lift, f.s, f.o);
    if (f.A.frozen) {
      c.restore();
      c.save(); c.globalAlpha = 0.5 + 0.2 * Math.sin(t * 6); drawStar(c, f.x + f.A.w * f.s * 0.3, GY - f.lift - f.A.h * f.s * 0.8, 14, t, '#E6F6FF', '#9CC9F5'); c.restore();
    }
    f.A.box = { x: f.x - f.A.w * f.s / 2, y: GY - f.lift - f.A.h * f.s, w: f.A.w * f.s, h: f.A.h * f.s };
  });
  if (showNames) frames.forEach((f) => nameTag(c, f.A.settings.name, f.x));
  runStars(c, dt, t);
  drawParts(c, dt);
  drawWeather(c, dt, t);
  if (recState === 'idle' && actors.length > 1) {
    const A = actors[sel];
    if (A?.box) { const x = A.box.x + A.box.w / 2, y = A.box.y - 22 + Math.sin(t * 5) * 6; c.fillStyle = '#F2552C'; c.strokeStyle = '#fff'; c.lineWidth = 4; c.beginPath(); c.moveTo(x - 16, y - 18); c.lineTo(x + 16, y - 18); c.lineTo(x, y); c.closePath(); c.stroke(); c.fill(); }
  }
  c.restore();
  frames.forEach((f) => {
    if (!f.A.bubble || clock >= f.A.bubble.until) return;
    const hx = (f.x - cam.x) * cam.z + W / 2, hy = (f.A.box.y - cam.y) * cam.z + H / 2;
    drawBubble(c, f.A.bubble.text, hx, Math.max(60, hy), W);
  });
  drawScreenFx(c, rdt);
  drawScore(c);
  if (micOn) { const lv = micLevel(); $('micLvl').style.width = Math.round(lv * 100) + '%'; }
  placeStickerBar();
  drawOverlays(c, rdt);
}

/* =========================================================
   RECORDING: scenes (video clips) and parts (one character's acting, replayed later)
   ========================================================= */
let recState = 'idle', cdT = 0, recT = 0, recorder = null, recDest = null, recChunks = [], recMime = '';
let recKind = 'scene', partTarget = null, partAudioRec = null, partAudioChunks = [], partDest = null, replayNodes = [];
let movieBlob = null, movieUrl = null, movieExt = 'webm', thumbBlob = null, thumbSnap = null, movieFormat = 'wide', titleEdited = false;
let scenes = [], sceneSnap = null, recPlace = 'meadow', chapters = [];
let format = 'wide';
document.querySelectorAll('#format button').forEach((b) => (b.onclick = () => {
  if (building) return;
  format = b.dataset.v; document.querySelectorAll('#format button').forEach((x) => x.setAttribute('aria-pressed', x === b));
}));
document.querySelectorAll('#recMode button').forEach((b) => (b.onclick = () => {
  if (recState !== 'idle') return;
  recKind = b.dataset.v; document.querySelectorAll('#recMode button').forEach((x) => x.setAttribute('aria-pressed', x === b));
  setRecUI();
  if (recKind === 'part') toast(`One part: record just ${actors[sel]?.settings.name || 'this character'}. Then pick another character and record again, and the first one acts out their part at the same time.`, 6500);
}));

function autoTitle() {
  const n = actors.map((A) => A.settings.name.trim()).filter(Boolean);
  if (!n.length) return 'My doodles come to life!';
  if (n.length === 1) return `${n[0]} comes to life!`;
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  return `${n[0]}, ${n[1]} and friends`;
}
function refreshTitle() { if (!titleEdited) $('movieTitle').value = autoTitle(); }
$('movieTitle').addEventListener('input', () => { titleEdited = true; saveLocal(); });
const titleText = () => $('movieTitle').value.trim();

function pickMime() {
  if (!window.MediaRecorder) return null;
  for (const m of ['video/mp4;codecs=avc1,mp4a', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}
function pickAudioMime() {
  if (!window.MediaRecorder) return null;
  return ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
}
function setRecUI() {
  const b = $('recBtn'), label = b.querySelector('span');
  b.classList.toggle('stop', recState === 'rec');
  label.textContent = recState === 'idle' ? (recKind === 'part' ? 'Record part' : 'Record') : recState === 'countdown' ? 'Cancel' : recState === 'rec' ? 'Stop' : 'Saving…';
  b.disabled = recState === 'stopping' || building;
  $('recBadge').hidden = recState !== 'rec';
  document.querySelectorAll('.tab').forEach((t) => (t.disabled = recState !== 'idle'));
  document.querySelectorAll('#recMode button').forEach((t) => (t.disabled = recState !== 'idle'));
}
$('recBtn').onclick = async () => {
  if (recState === 'countdown') { recState = 'idle'; setRecUI(); return; }
  if (recState === 'rec') { stopRecording(); return; }
  if (recState !== 'idle' || building) return;
  if (!ensureAudio()) return toast("This browser can't record sound.");
  if (recKind === 'scene' && (pickMime() === null || !stage.captureStream)) return toast("This browser can't record video. Try Chrome, Edge or Safari.");
  await actx.resume();
  await enableMic(true);
  if (recKind === 'part') {
    partTarget = actors[sel]; if (!partTarget) return;
  } else {
    // if the picked character has a recorded part, move the live controls to one that doesn't
    if (actors[sel]?.settings.part) { const i = actors.findIndex((A) => !A.settings.part); if (i >= 0) selectActor(i); }
  }
  $('movieCard').hidden = true;
  recState = 'countdown'; cdT = 3.0; setRecUI(); tone(660, 0.12, 'sine', 0.3);
  startMusic();
};

function startRecording() {
  recT = 0; $('timer').textContent = '0:00';
  startReplays();
  if (recKind === 'scene') {
    const mime = pickMime();
    recDest = actx.createMediaStreamDestination();
    master.connect(recDest); if (micToRec) micToRec.connect(recDest);
    const stream = new MediaStream([...stage.captureStream(30).getVideoTracks(), ...recDest.stream.getAudioTracks()]);
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 5e6, audioBitsPerSecond: 128000 } : {});
    recMime = recorder.mimeType || mime || 'video/webm';
    recChunks = []; recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = finishScene;
    recorder.start(250);
    sceneSnap = null; recPlace = scene;
  } else {
    partTarget.newFrames = [];
    partAudioRec = null; partAudioChunks = [];
    const am = pickAudioMime();
    if (micOn && fxOut && am !== null) {
      partDest = actx.createMediaStreamDestination(); fxOut.connect(partDest);
      partAudioRec = new MediaRecorder(partDest.stream, am ? { mimeType: am } : {});
      partAudioRec.ondataavailable = (e) => { if (e.data.size) partAudioChunks.push(e.data); };
      partAudioRec.start(200);
    }
  }
  startCaptions();
  recState = 'rec'; setRecUI();
}
function startReplays() {
  stopReplays();
  for (const A of actors) {
    const P = A.settings.part;
    if (!P || (recKind === 'part' && A === partTarget)) continue;
    A.replaying = true; A.repIdx = 0;
    if (P.audio) { const n = actx.createBufferSource(); n.buffer = P.audio; n.connect(master); n.start(); replayNodes.push(n); }
  }
}
function stopReplays() {
  replayNodes.forEach((n) => { try { n.stop(); } catch { /* done */ } }); replayNodes = [];
  actors.forEach((A) => { A.replaying = false; if (A.bubble?.fromReplay) A.bubble = null; });
}
function stopRecording() {
  if (recState !== 'rec') return;
  stopCaptions(); stopReplays();
  if (recKind === 'scene') { if (!sceneSnap) sceneSnap = snap(); recState = 'stopping'; setRecUI(); recorder.stop(); }
  else finishPart();
}
async function finishPart() {
  const A = partTarget, frames = A.newFrames || [], dur = recT;
  A.newFrames = null; recState = 'stopping'; setRecUI();
  let audio = null;
  if (partAudioRec) {
    await new Promise((res) => { partAudioRec.onstop = res; try { partAudioRec.stop(); } catch { res(); } });
    try { fxOut.disconnect(partDest); } catch { /* fine */ }
    try { const ab = await new Blob(partAudioChunks).arrayBuffer(); audio = await new Promise((res, rej) => { const p = actx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); }); } catch { audio = null; }
  }
  partAudioRec = null; partDest = null;
  if (frames.length > 5) {
    A.settings.part = { frames, audio, dur, captions: capCues.slice() };
    toast(`${A.settings.name || 'This character'}'s part is saved. Now pick another character and record, and they'll act it out with you.`, 6000);
  }
  recState = 'idle'; setRecUI(); renderSelected(); renderCast();
}
function snap() { const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').drawImage(stage, 0, 0); return c; }

/** Called from updateActor: a replaying character follows its recorded part. */
function replayFrame(A) {
  const fr = A.settings.part.frames;
  let i = A.repIdx || 0;
  while (i + 1 < fr.length && fr[i + 1].t <= recT) i++;
  A.repIdx = i;
  const f = fr[i]; if (!f) return null;
  A.home = f.x;
  if (f.b) A.bubble = { text: f.b, until: clock + 0.1, fromReplay: true }; else if (A.bubble?.fromReplay) A.bubble = null;
  if (f.hid) A.hiddenUntil = clock + 0.05;
  return { A, x: f.x, lift: f.lift, o: { ...f.o }, s: f.s };
}
function capturePartFrame(A, out) {
  A.newFrames.push({
    t: recT, x: out.x, lift: out.lift, s: out.s, o: { ...out.o },
    b: A.bubble && clock < A.bubble.until ? A.bubble.text : null, hid: A.hiddenUntil > clock,
  });
  if (recT > 120) stopRecording();
}

function drawOverlays(c, dt) {
  if (recState === 'countdown') {
    const prev = Math.ceil(cdT); cdT -= dt; const now = Math.ceil(cdT);
    if (cdT <= 0) { startRecording(); return; }
    if (now !== prev) tone(660, 0.12, 'sine', 0.3);
    const k = cdT - Math.floor(cdT);
    c.save(); c.fillStyle = 'rgba(17,22,58,.35)'; c.fillRect(0, 0, W, H);
    c.translate(W / 2, H / 2); c.scale(0.8 + k * 0.4, 0.8 + k * 0.4);
    c.fillStyle = recKind === 'part' ? '#2F80ED' : '#F2552C'; c.beginPath(); c.arc(0, 0, 120, 0, Math.PI * 2); c.fill();
    c.lineWidth = 10; c.strokeStyle = '#fff'; c.stroke();
    c.fillStyle = '#fff'; c.font = "800 150px Grandstander, 'Comic Sans MS', sans-serif"; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String(now), 0, 12);
    c.restore();
    if (recKind === 'part' && partTarget) {
      c.save(); c.font = "700 34px Lexend, system-ui, sans-serif"; c.textAlign = 'center'; c.fillStyle = '#fff'; c.strokeStyle = '#11163A'; c.lineWidth = 7;
      const l = `Acting as ${partTarget.settings.name || 'this character'}`; c.strokeText(l, W / 2, H / 2 + 190); c.fillText(l, W / 2, H / 2 + 190); c.restore();
    }
  }
  if (recState === 'rec') {
    recT += dt;
    if (recKind === 'scene' && recT >= 2.5 && !sceneSnap) sceneSnap = snap();
    if (recKind === 'scene' && recT >= 180) stopRecording();
    const s = Math.floor(recT), txt = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    $('timer').textContent = txt; $('recBadge').textContent = (recKind === 'part' ? 'PART ' : 'REC ') + txt;
  }
}

/* ---------- captions (speech to text while recording) ---------- */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let capOn = false, recog = null, capCues = [], capStart = null, capLive = '';
try { capOn = localStorage.getItem('doodle-alive:captions') === '1'; } catch { /* default off */ }
$('capOn').checked = capOn;
if (!SpeechRec) { $('capOn').disabled = true; $('capHint').textContent = "This browser can't write captions. Use Chrome or Edge, or type captions on each scene."; }
$('capOn').onchange = (e) => { capOn = e.target.checked; try { localStorage.setItem('doodle-alive:captions', capOn ? '1' : '0'); } catch { /* fine */ } };
function pushCue(start, end, text) {
  const words = text.split(/\s+/).filter(Boolean); if (!words.length) return;
  const n = Math.ceil(words.length / 7), span = Math.max(end - start, 0.9 * n);
  for (let k = 0; k < n; k++) capCues.push({ start: +(start + span * k / n).toFixed(2), end: +(start + span * (k + 1) / n).toFixed(2), text: words.slice(k * 7, k * 7 + 7).join(' ') });
}
function showLiveCap() { const el = $('liveCap'); el.textContent = capLive; el.hidden = !capLive; }
function startCaptions() {
  capCues = []; capStart = null; capLive = '';
  if (!capOn || !SpeechRec) return;
  try {
    const r = new SpeechRec(); recog = r;
    r.lang = navigator.language || 'en-US'; r.continuous = true; r.interimResults = true;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i], txt = res[0].transcript.trim(); if (!txt) continue;
        if (capStart === null) capStart = Math.max(0, recT - 0.8);
        if (res.isFinal) { pushCue(capStart, recT, txt); capStart = null; capLive = ''; } else capLive = txt;
      }
      showLiveCap();
    };
    r.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { recog = null; toast('Captions are blocked in this browser. You can type them on each scene instead.', 5000); } };
    r.onend = () => { if (recog === r && recState === 'rec') { try { r.start(); } catch { /* fine */ } } };
    r.start();
  } catch { recog = null; }
}
function stopCaptions() {
  if (recog) { const r = recog; recog = null; try { r.stop(); } catch { /* fine */ } }
  if (capLive) pushCue(capStart ?? Math.max(0, recT - 1.5), recT, capLive);
  capLive = ''; capStart = null; showLiveCap();
}

/* ---------- scenes ---------- */
const PLACE_NAMES = Object.fromEntries(SCENES);
async function finishScene() {
  try { master.disconnect(recDest); } catch { /* fine */ }
  try { micToRec?.disconnect(recDest); } catch { /* fine */ }
  recDest = null;
  const blob = new Blob(recChunks, { type: recMime.split(';')[0] });
  const dur = recT;
  // parts were replayed from the start of the scene, so their captions belong in it too
  let caps = capCues.slice();
  actors.forEach((A) => { if (A.settings.part?.captions) caps = caps.concat(A.settings.part.captions.filter((q) => q.start < dur)); });
  caps.sort((a, b) => a.start - b.start);
  const thumbCv = sceneSnap || snap();
  const small = document.createElement('canvas'); small.width = 320; small.height = 180; small.getContext('2d').drawImage(thumbCv, 0, 0, 320, 180);
  const S = { id: 's' + Date.now(), blob, ext: recMime.includes('mp4') ? 'mp4' : 'webm', url: URL.createObjectURL(blob), dur, thumb: small.toDataURL('image/jpeg', 0.8), snap: thumbCv, captions: caps, place: recPlace, order: scenes.length };
  scenes.push(S);
  persistScene(S);
  recState = 'idle'; setRecUI();
  renderSceneList(); showPage('movie');
  toast(`Scene ${scenes.length} saved! Record another scene, or press "Make my movie".`, 4500);
}
function persistScene(S) {
  const { url, snap: _s, ...rest } = S;
  idbPut('scenes', rest).catch(() => toast('This device is out of space, so scenes will be gone if you close the page.', 5000));
}
async function loadScenes() {
  try {
    const list = (await idbAll('scenes')).sort((a, b) => a.order - b.order);
    scenes = list.map((S) => ({ ...S, url: URL.createObjectURL(S.blob), snap: null }));
  } catch { scenes = []; }
  renderSceneList();
}
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
function renderSceneList() {
  const el = $('sceneList'); el.innerHTML = '';
  $('sceneEmpty').hidden = scenes.length > 0; $('buildBox').hidden = !scenes.length;
  const total = scenes.reduce((a, S) => a + S.dur, 0);
  $('sceneCount').textContent = scenes.length ? `· ${scenes.length} · ${fmtTime(total)}` : '';
  scenes.forEach((S, i) => {
    const card = document.createElement('div'); card.className = 'scard';
    const img = document.createElement('img'); img.src = S.thumb; img.alt = `Scene ${i + 1}`; img.title = 'Watch';
    img.onclick = () => { const v = $('scenePrev'); v.hidden = false; v.src = S.url; v.play().catch(() => {}); v.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
    const meta = document.createElement('div'); meta.className = 'meta';
    const b = document.createElement('b'); b.textContent = `Scene ${i + 1}`;
    const sm = document.createElement('small'); sm.textContent = `${fmtTime(S.dur)} · ${PLACE_NAMES[S.place] || 'My picture'}`;
    const acts = document.createElement('div'); acts.className = 'acts';
    const mk = (label, aria, fn, dis) => { const x = document.createElement('button'); x.textContent = label; x.setAttribute('aria-label', aria); x.disabled = !!dis; x.onclick = fn; acts.appendChild(x); return x; };
    mk('Watch', `Watch scene ${i + 1}`, () => img.onclick());
    mk('↑', `Move scene ${i + 1} earlier`, () => moveScene(i, -1), i === 0);
    mk('↓', `Move scene ${i + 1} later`, () => moveScene(i, 1), i === scenes.length - 1);
    const del = mk('Delete', `Delete scene ${i + 1}`, () => {
      if (del.dataset.armed) { deleteScene(i); return; }
      del.dataset.armed = '1'; del.textContent = 'Sure?'; setTimeout(() => { delete del.dataset.armed; del.textContent = 'Delete'; }, 2500);
    });
    meta.append(b, sm, acts);
    const det = document.createElement('details');
    const sum = document.createElement('summary'); sum.textContent = `Captions (${S.captions.length})`;
    det.appendChild(sum);
    const renderCues = () => {
      det.querySelectorAll('.cue,.addcue').forEach((n) => n.remove());
      sum.textContent = `Captions (${S.captions.length})`;
      S.captions.forEach((q, k) => {
        const row = document.createElement('div'); row.className = 'cue';
        const t = document.createElement('small'); t.textContent = fmtTime(q.start);
        const inp = document.createElement('input'); inp.type = 'text'; inp.value = q.text; inp.maxLength = 80; inp.setAttribute('aria-label', `Caption at ${fmtTime(q.start)}`);
        inp.onchange = () => { q.text = inp.value.trim(); if (!q.text) S.captions.splice(k, 1); persistScene(S); renderCues(); };
        const x = document.createElement('button'); x.textContent = '×'; x.setAttribute('aria-label', 'Remove caption');
        x.onclick = () => { S.captions.splice(k, 1); persistScene(S); renderCues(); };
        row.append(t, inp, x); det.appendChild(row);
      });
      const add = document.createElement('div'); add.className = 'cue addcue';
      const t = document.createElement('small'); t.textContent = 'New';
      const inp = document.createElement('input'); inp.type = 'text'; inp.maxLength = 80; inp.placeholder = 'Type a caption, it shows at the time you watch in the video';
      const ok = document.createElement('button'); ok.textContent = 'Add';
      ok.onclick = () => {
        const v = inp.value.trim(); if (!v) return;
        const pv = $('scenePrev'); const at = !pv.hidden && pv.src === S.url && isFinite(pv.currentTime) ? pv.currentTime : 0;
        S.captions.push({ start: +at.toFixed(2), end: +(at + Math.max(2, v.split(/\s+/).length * 0.45)).toFixed(2), text: v });
        S.captions.sort((a, b2) => a.start - b2.start); persistScene(S); renderCues();
      };
      add.append(t, inp, ok); det.appendChild(add);
    };
    renderCues();
    card.append(img, meta, det); el.appendChild(card);
  });
}
function moveScene(i, d) {
  const j = i + d; if (j < 0 || j >= scenes.length) return;
  [scenes[i], scenes[j]] = [scenes[j], scenes[i]];
  scenes.forEach((S, k) => { S.order = k; persistScene(S); });
  renderSceneList();
}
function deleteScene(i) {
  const [S] = scenes.splice(i, 1);
  URL.revokeObjectURL(S.url); idbDel('scenes', S.id).catch(() => {});
  scenes.forEach((q, k) => { q.order = k; persistScene(q); });
  $('scenePrev').hidden = true;
  renderSceneList();
}

/* =========================================================
   MOVIE BUILDER: title card, scenes with transitions, captions, credits
   ========================================================= */
const TRANSITIONS = [['fade', 'Fade'], ['slide', 'Slide'], ['circle', 'Circle'], ['star', 'Star'], ['none', 'Cut']];
let transition = 'fade', building = false, exportVid = null, exportSrc = null;
chipGroup($('transChips'), TRANSITIONS, transition, (v) => (transition = v));
const nextFrame = () => new Promise((r) => (document.hidden ? setTimeout(r, 33) : requestAnimationFrame(r)));

function wrapLines(c, text, maxW, maxLines) {
  const words = String(text).split(/\s+/), lines = []; let line = '';
  for (const w of words) { const t = line ? line + ' ' + w : w; if (c.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] += '…'; }
  return lines;
}
function bgGradient(c, w, h, t) {
  const g = c.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#1F2A5C'); g.addColorStop(1, '#4B2E83'); c.fillStyle = g; c.fillRect(0, 0, w, h);
  for (let i = 0; i < 40; i++) {
    const x = (i * 197 + t * 30 * ((i % 3) + 1)) % (w + 40) - 20, y = (i * 131) % h, r = 2 + (i % 4);
    c.globalAlpha = 0.25 + 0.25 * Math.sin(t * 2 + i); c.fillStyle = ['#FFC83D', '#FF8FB1', '#fff', '#2BB673'][i % 4]; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }
  c.globalAlpha = 1;
}
function castRow(c, w, y, size, t) {
  const n = actors.length; if (!n) return;
  const sizes = actors.map((A) => Math.min(size * 1.4, (A.w / A.h) * size));
  const gap = size * 0.25; let total = sizes.reduce((a, b) => a + b, 0) + gap * (n - 1);
  const k = total > w * 0.9 ? (w * 0.9) / total : 1; total *= k;
  let x = (w - total) / 2;
  actors.forEach((A, i) => {
    const sw = sizes[i] * k, sh = sw * A.h / A.w, bob = Math.abs(Math.sin(t * 4 + i)) * 14 * k;
    c.drawImage(A.cv, x, y - sh - bob, sw, sh); x += sw + gap * k;
  });
}
function drawTitleCard(c, w, h, t, opts) {
  bgGradient(c, w, h, t);
  const tall = h > w, ease = Math.min(1, t / 0.6), sc = 0.6 + 0.4 * (1 - Math.pow(1 - ease, 3));
  c.save(); c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = `600 ${tall ? 30 : 30}px Lexend, system-ui, sans-serif`; c.fillStyle = 'rgba(255,255,255,.8)';
  c.fillText('Doodle Alive presents', w / 2, tall ? 230 : 90);
  if (opts.episode) { c.font = "800 34px Grandstander, 'Comic Sans MS', sans-serif"; c.fillStyle = '#FF8FB1'; c.fillText(`Episode ${opts.episode}`, w / 2, tall ? 290 : 140); }
  c.translate(w / 2, tall ? 450 : 270); c.scale(sc, sc);
  c.font = `800 ${tall ? 76 : 92}px Grandstander, 'Comic Sans MS', sans-serif`;
  const lines = wrapLines(c, opts.title, w * 0.84, 3);
  lines.forEach((l, i) => { const y = (i - (lines.length - 1) / 2) * (tall ? 88 : 104); c.lineWidth = 16; c.strokeStyle = '#11163A'; c.lineJoin = 'round'; c.strokeText(l, 0, y); c.fillStyle = '#FFC83D'; c.fillText(l, 0, y); });
  c.restore();
  castRow(c, w, tall ? h - 260 : h - 50, tall ? 260 : 230, t);
}
function drawCredits(c, w, h, t, dur, opts) {
  bgGradient(c, w, h, t);
  const rows = [['h', 'Starring']];
  actors.forEach((A) => { const v = VOICES.find((q) => q[0] === (A.settings.voice || 'normal')); rows.push(['a', A, (A.settings.name || 'A mystery star') + (v && v[0] !== 'normal' ? `  ·  ${v[1]} voice` : '')]); });
  if (opts.madeBy) { rows.push(['g']); rows.push(['h', 'Drawn, voiced and directed by']); rows.push(['t', opts.madeBy]); }
  rows.push(['g']); rows.push(['t', 'Made with Doodle Alive']); rows.push(['g']); rows.push(['h', 'Thanks for watching!']);
  const rowH = (r) => (r[0] === 'a' ? 150 : r[0] === 'g' ? 50 : 70);
  const totalH = rows.reduce((a, r) => a + rowH(r), 0);
  const y0 = h - (h + totalH) * Math.min(1, t / (dur * 0.92)) + h * 0.12;
  let y = Math.max(y0, (h - totalH) / 2 > 0 ? Math.min(y0, (h - totalH) / 2) : y0);
  if (totalH < h * 0.8) y = (h - totalH) / 2; // short list: just show it
  c.save(); c.textAlign = 'center'; c.textBaseline = 'middle';
  for (const r of rows) {
    const rh = rowH(r);
    if (r[0] === 'h') { c.font = "600 30px Lexend, system-ui, sans-serif"; c.fillStyle = 'rgba(255,255,255,.75)'; c.fillText(r[1], w / 2, y + rh / 2); }
    else if (r[0] === 't') { c.font = "800 52px Grandstander, 'Comic Sans MS', sans-serif"; c.fillStyle = '#FFC83D'; c.fillText(r[1], w / 2, y + rh / 2); }
    else if (r[0] === 'a') {
      const A = r[1], ih = 120, iw = Math.min(170, A.w * ih / A.h);
      c.font = "800 44px Grandstander, 'Comic Sans MS', sans-serif"; const tw = Math.min(c.measureText(r[2]).width, w * 0.7);
      const x0 = w / 2 - (iw + 24 + tw) / 2;
      c.drawImage(A.cv, x0, y + (rh - ih) / 2, iw, ih); c.fillStyle = '#fff'; c.textAlign = 'left'; c.fillText(r[2], x0 + iw + 24, y + rh / 2, w * 0.7); c.textAlign = 'center';
    }
    y += rh;
  }
  c.restore();
}
function drawCaptionText(c, text, cx, bottom, maxW, size) {
  c.save(); c.font = `700 ${size}px Lexend, system-ui, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
  const lines = wrapLines(c, text, maxW, 2), lh = size * 1.3;
  const bw = Math.min(maxW, Math.max(...lines.map((l) => c.measureText(l).width))) + size * 1.1, bh = lines.length * lh + size * 0.5;
  c.fillStyle = 'rgba(10,12,32,.76)'; c.beginPath(); c.roundRect(cx - bw / 2, bottom - bh, bw, bh, size * 0.45); c.fill();
  c.fillStyle = '#fff'; lines.forEach((l, i) => c.fillText(l, cx, bottom - bh + size * 0.25 + lh * (i + 0.5)));
  c.restore();
}
/** Lays out a 16:9 frame (scene video) for the chosen shape, with captions. */
function drawSceneFrame(c, w, h, src, caption, opts, t) {
  if (w > h) {
    c.drawImage(src, 0, 0, w, h);
    if (caption) drawCaptionText(c, caption, w / 2, h - 96, w * 0.8, 34);
    return;
  }
  bgGradient(c, w, h, t);
  c.save(); c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = "800 58px Grandstander, 'Comic Sans MS', sans-serif";
  const lines = wrapLines(c, opts.title, w - 80, 3);
  lines.forEach((l, i) => { const y = 250 - (lines.length - 1) * 34 + i * 68; c.lineWidth = 10; c.strokeStyle = '#11163A'; c.strokeText(l, w / 2, y); c.fillStyle = '#FFC83D'; c.fillText(l, w / 2, y); });
  c.restore();
  const bx = 10, by = 430, bw = w - 20, bh = bw * 9 / 16;
  c.save(); c.beginPath(); c.roundRect(bx, by, bw, bh, 24); c.clip(); c.drawImage(src, bx, by, bw, bh); c.restore();
  c.lineWidth = 6; c.strokeStyle = '#fff'; c.beginPath(); c.roundRect(bx, by, bw, bh, 24); c.stroke();
  if (caption) drawCaptionText(c, caption, w / 2, by + bh + 120, w - 60, 38);
  else castRow(c, w, by + bh + 220, 150, t);
  c.save(); c.textAlign = 'center'; c.fillStyle = 'rgba(255,255,255,.8)'; c.font = "600 30px Lexend, system-ui, sans-serif"; c.fillText('Drawn by a kid · brought to life with Doodle Alive', w / 2, h - 90, w - 60); c.restore();
}
function starPath(c, cx, cy, r) { c.beginPath(); for (let i = 0; i < 10; i++) { const rr = i % 2 ? r * 0.45 : r, a = i * Math.PI / 5 - Math.PI / 2; c.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } c.closePath(); }
/** Draws the new frame (fcv) over the previous segment's last frame (old) with a transition at progress p (0..1). */
function composite(c, w, h, fcv, old, p, kind) {
  if (!old || p >= 1 || kind === 'none') { c.drawImage(fcv, 0, 0); return; }
  const e = p * p * (3 - 2 * p);
  if (kind === 'fade') { c.drawImage(fcv, 0, 0); c.globalAlpha = 1 - e; c.drawImage(old, 0, 0); c.globalAlpha = 1; }
  else if (kind === 'slide') { c.drawImage(old, -w * e, 0); c.drawImage(fcv, w * (1 - e), 0); }
  else {
    c.drawImage(old, 0, 0);
    c.save(); const R = Math.hypot(w, h) * (kind === 'star' ? 1.25 : 0.6) * e;
    if (kind === 'star') starPath(c, w / 2, h / 2, R); else { c.beginPath(); c.arc(w / 2, h / 2, R, 0, Math.PI * 2); }
    c.clip(); c.drawImage(fcv, 0, 0); c.restore();
  }
}
function jingle(bus, kind) {
  if (kind === 'intro') { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 'triangle', 0.22, null, i * 0.12, bus)); tone(1047, 0.9, 'sine', 0.15, null, 0.5, bus); }
  else { [784, 659, 523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 'triangle', 0.18, null, i * 0.22, bus)); [262, 330, 392].forEach((f) => tone(f, 1.6, 'sine', 0.12, null, 1.3, bus)); }
}

async function buildMovie() {
  if (!scenes.length) return toast('Record a scene first.');
  if (building || recState !== 'idle') return;
  if (pickMime() === null) return toast("This browser can't make videos. Try Chrome, Edge or Safari.");
  ensureAudio(); await actx.resume();
  building = true; setRecUI(); stopMusic();
  const fmt = format, OW = fmt === 'shorts' ? 720 : 1280, OH = fmt === 'shorts' ? 1280 : 720;
  const out = $('buildCv'); out.width = OW; out.height = OH; const c = out.getContext('2d');
  const fcv = document.createElement('canvas'); fcv.width = OW; fcv.height = OH; const fc = fcv.getContext('2d');
  const oldCv = document.createElement('canvas'); oldCv.width = OW; oldCv.height = OH; const oc = oldCv.getContext('2d');
  $('buildProg').hidden = false; $('buildBtn').disabled = true; $('buildBtn').textContent = 'Making your movie…';
  const bar = $('buildProg').querySelector('.prog i'); bar.style.width = '0';
  const opts = {
    title: titleText() || autoTitle(), episode: $('epNum').value.trim().slice(0, 6), madeBy: $('madeBy').value.trim(),
    caps: $('capInMovie').checked, titleCard: $('titleCardChk').checked, credits: $('creditsChk').checked,
  };
  const TR = transition === 'none' ? 0 : 0.6;
  const cardT = fmt === 'shorts' ? 2.2 : 3.2, credT = fmt === 'shorts' ? 3.2 : 5.5;
  const budget = 58 - (opts.titleCard ? cardT : 0) - (opts.credits ? credT : 0);
  const per = fmt === 'shorts' ? Math.max(3, budget / scenes.length) : Infinity;
  const plan = scenes.map((S) => Math.min(S.dur, per));
  const totalT = plan.reduce((a, b) => a + b, 0) + (opts.titleCard ? cardT : 0) + (opts.credits ? credT : 0);

  const dest = actx.createMediaStreamDestination();
  const bus = actx.createGain(); bus.connect(dest); bus.connect(actx.destination);
  if (!exportVid) { exportVid = document.createElement('video'); exportVid.playsInline = true; exportVid.preload = 'auto'; exportSrc = actx.createMediaElementSource(exportVid); }
  try { exportSrc.disconnect(); } catch { /* fine */ }
  exportSrc.connect(bus);
  const mime = pickMime();
  const rec = new MediaRecorder(new MediaStream([...out.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]), mime ? { mimeType: mime, videoBitsPerSecond: 6e6, audioBitsPerSecond: 128000 } : {});
  const chunks = []; rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.start(250);
  const t0 = performance.now();
  const elapsed = () => (performance.now() - t0) / 1000;
  let hasOld = false;
  chapters = [];
  const segment = async (dur, drawFn) => {
    const s0 = performance.now();
    for (;;) {
      const t = (performance.now() - s0) / 1000;
      const done = drawFn(fc, t);
      composite(c, OW, OH, fcv, hasOld ? oldCv : null, TR ? t / TR : 1, transition);
      bar.style.width = Math.min(100, elapsed() / totalT * 100) + '%';
      $('buildMsg').textContent = `Making your movie… ${fmtTime(elapsed())} of ${fmtTime(totalT)}. Keep this page open.`;
      if (done || (dur && t >= dur)) break;
      await nextFrame();
    }
    oc.clearRect(0, 0, OW, OH); oc.drawImage(fcv, 0, 0); hasOld = true;
  };
  try {
    if (opts.titleCard) { jingle(bus, 'intro'); await segment(cardT, (x, t) => { drawTitleCard(x, OW, OH, t, opts); return false; }); }
    for (let i = 0; i < scenes.length; i++) {
      const S = scenes[i], limit = plan[i];
      chapters.push({ at: elapsed(), name: `Scene ${i + 1}${PLACE_NAMES[S.place] ? ': ' + PLACE_NAMES[S.place] : ''}` });
      exportVid.src = S.url;
      await new Promise((r) => { exportVid.onloadeddata = r; exportVid.onerror = r; setTimeout(r, 4000); });
      await exportVid.play().catch(() => {});
      const s0 = performance.now();
      await segment(0, (x, t) => {
        const vt = isFinite(exportVid.currentTime) && exportVid.currentTime > 0 ? exportVid.currentTime : (performance.now() - s0) / 1000;
        const cue = opts.caps ? S.captions.find((q) => vt >= q.start && vt < q.end + 0.25) : null;
        if (exportVid.readyState >= 2) drawSceneFrame(x, OW, OH, exportVid, cue ? cue.text : '', opts, t);
        return exportVid.ended || vt >= limit || t > limit + 1.5;
      });
      exportVid.pause();
    }
    if (opts.credits) { jingle(bus, 'outro'); await segment(credT, (x, t) => { drawCredits(x, OW, OH, t, credT, opts); return false; }); }
  } catch { /* finish with what we have */ }
  await nextFrame();
  rec.stop(); await stopped;
  try { exportSrc.disconnect(); bus.disconnect(); } catch { /* fine */ }
  building = false; setRecUI();
  $('buildBtn').disabled = false; $('buildBtn').textContent = 'Make my movie'; $('buildProg').hidden = true;
  if (mode === 'studio') startMusic();
  const recMimeOut = rec.mimeType || mime || 'video/webm';
  await showMovie(new Blob(chunks, { type: recMimeOut.split(';')[0] }), recMimeOut.includes('mp4') ? 'mp4' : 'webm', fmt, true);
}
$('buildBtn').onclick = buildMovie;

/* ---------- finished movie: preview, YouTube details, library ---------- */
const SCENE_WORDS = { meadow: ['Sunny Meadow Adventure', 'meadow'], ocean: ['Under the Sea Adventure', 'ocean'], space: ['Space Adventure', 'space'], snow: ['Snow Day', 'snow'], party: ['Party', 'party'] };
let tagList = [];
function castLabel() {
  const n = actors.map((A) => A.settings.name.trim()).filter(Boolean);
  return n.length === 0 ? 'My Drawings' : n.length === 1 ? n[0] : n.length === 2 ? `${n[0]} & ${n[1]}` : `${n[0]} & Friends`;
}
function chapterText() {
  if (movieFormat !== 'wide' || chapters.length < 3) return '';
  const list = chapters.map((q, i) => ({ ...q, at: i === 0 ? 0 : q.at }));
  const ends = list.map((q, i) => (i + 1 < list.length ? list[i + 1].at : Infinity));
  if (list.some((q, i) => ends[i] - q.at < 10)) return '';
  return list.map((q) => `${fmtTime(q.at)} ${q.name}`).join('\n');
}
function makeMeta() {
  const names = actors.map((A) => A.settings.name.trim()).filter(Boolean);
  const place = scenes[0]?.place || scene;
  const sw = SCENE_WORDS[place] || ['Big Adventure', 'adventure'];
  const who = castLabel();
  const ep = $('epNum').value.trim();
  const own = titleEdited && titleText() ? titleText() : '';
  const shorts = movieFormat === 'shorts';
  const base = (own || `${who}'s ${sw[0]}!`) + (ep ? ` (Episode ${ep})` : '');
  let title = `${base} | Kid's Drawing Comes to Life${shorts ? ' #Shorts' : ''}`;
  if (title.length > 100) title = `${base}${shorts ? ' #Shorts' : ''}`.slice(0, 100);
  const ch = chapterText();
  const desc = [
    `${who} started as a drawing on paper and came to life! ✏️➡️🎬`,
    '',
    'Drawn by a kid, then animated, voiced and filmed with Doodle Alive.',
    names.length ? `Starring: ${names.join(', ')}` : '',
    ch ? '\nChapters:\n' + ch : '',
    '',
    'Subscribe for more drawings that come to life!',
    '',
    `#kidsart #drawing #animation #cartoon #kidsdrawing${shorts ? ' #shorts' : ''}`,
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  const tags = ['kids drawing', 'drawing comes to life', 'kids animation', 'cartoon for kids', 'kids art', 'animated drawing', 'children drawing', 'doodle animation', 'drawing to animation', `${sw[1]} cartoon`, ...names.map((n) => n.toLowerCase())];
  if (shorts) tags.push('shorts');
  return { title, desc, tags: [...new Set(tags)] };
}
function renderTags() {
  const el = $('tags'); el.innerHTML = '';
  tagList.forEach((t, i) => {
    const s = document.createElement('span'); s.className = 'tag2'; s.textContent = t;
    const x = document.createElement('button'); x.textContent = '×'; x.setAttribute('aria-label', 'Remove keyword ' + t);
    x.onclick = () => { tagList.splice(i, 1); renderTags(); };
    s.append(x); el.appendChild(s);
  });
}
function addTag() { const v = $('tagIn').value.trim().replace(/[<>,]/g, ''); if (v && !tagList.includes(v)) { tagList.push(v); renderTags(); } $('tagIn').value = ''; }
$('tagAdd').onclick = addTag;
$('tagIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });

function makeThumbnail(src) {
  return new Promise((res) => {
    if (!src) return res(null);
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const x = c.getContext('2d');
    x.drawImage(src, 0, 0, 1280, 720);
    const g = x.createLinearGradient(0, 0, 900, 0); g.addColorStop(0, 'rgba(17,22,58,.75)'); g.addColorStop(1, 'rgba(17,22,58,0)');
    x.fillStyle = g; x.fillRect(0, 0, 1280, 720);
    x.save(); x.translate(60, 70); x.rotate(-0.04); x.textBaseline = 'top';
    x.font = "800 104px Grandstander, 'Comic Sans MS', sans-serif";
    const lines = wrapLines(x, castLabel().toUpperCase(), 760, 2);
    lines.forEach((l, i) => { x.lineWidth = 18; x.strokeStyle = '#11163A'; x.lineJoin = 'round'; x.strokeText(l, 0, i * 110); x.fillStyle = '#FFC83D'; x.fillText(l, 0, i * 110); });
    x.font = "800 70px Grandstander, 'Comic Sans MS', sans-serif"; const y2 = lines.length * 110 + 10;
    x.lineWidth = 14; x.strokeStyle = '#11163A'; x.strokeText('COME TO LIFE!', 0, y2); x.fillStyle = '#fff'; x.fillText('COME TO LIFE!', 0, y2);
    x.restore();
    x.save(); x.fillStyle = '#F2552C'; x.beginPath(); x.roundRect(48, 610, 420, 68, 34); x.fill();
    x.fillStyle = '#fff'; x.font = "700 34px Lexend, system-ui, sans-serif"; x.textBaseline = 'middle'; x.fillText('Drawn by a kid ✏️', 76, 645); x.restore();
    c.toBlob((b) => res(b), 'image/jpeg', 0.88);
  });
}
function loadImg(src) { return new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = src; }); }
async function showMovie(blob, ext, fmt, isNew, meta) {
  movieBlob = blob; movieExt = ext; movieFormat = fmt;
  if (movieUrl) URL.revokeObjectURL(movieUrl);
  movieUrl = URL.createObjectURL(blob);
  $('preview').src = movieUrl;
  const m = meta || makeMeta();
  $('ytTitle').value = m.title; $('ytDesc').value = m.desc; tagList = m.tags.slice(); renderTags();
  $('ytMsg').textContent = 'A grown-up signs in with Google once. Title, keywords and thumbnail are filled in for you.';
  $('ytBtn').disabled = false; $('ytBtn').textContent = 'Post to YouTube';
  const file = new File([blob], `${safeName()}.${ext}`, { type: blob.type });
  $('shareBtn').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  const first = scenes[0];
  thumbSnap = first?.snap || (first ? await loadImg(first.thumb) : null);
  thumbBlob = fmt === 'wide' ? await makeThumbnail(thumbSnap) : null;
  $('movieCard').hidden = false; showPage('movie');
  $('movieCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (isNew) {
    toast("That's a wrap! Your movie is ready.");
    const item = { id: 'm' + Date.now(), title: titleText() || autoTitle(), blob, ext, fmt, created: Date.now(), thumb: first?.thumb || '', meta: m };
    idbPut('movies', item).then(renderMovieList).catch(() => toast('This device is out of space, so the movie was not kept. Save it before closing.', 5000));
  }
}
async function renderMovieList() {
  let list = [];
  try { list = (await idbAll('movies')).sort((a, b) => b.created - a.created); } catch { list = []; }
  const el = $('movieList'); el.innerHTML = '';
  $('movieEmpty').textContent = list.length ? 'Kept on this device. Open one to post it or save it.' : 'Movies you make are kept on this device.';
  list.forEach((M) => {
    const row = document.createElement('div'); row.className = 'mcard';
    const img = document.createElement('img'); img.alt = ''; if (M.thumb) img.src = M.thumb;
    const info = document.createElement('div'); const b = document.createElement('b'); b.textContent = M.title;
    const sm = document.createElement('small'); sm.textContent = `${new Date(M.created).toLocaleDateString()} · ${M.fmt === 'shorts' ? 'Shorts' : 'Wide'} · ${(M.blob.size / 1048576).toFixed(1)} MB`;
    info.append(b, sm);
    const acts = document.createElement('div'); acts.className = 'acts';
    const open = document.createElement('button'); open.textContent = 'Open'; open.onclick = () => showMovie(M.blob, M.ext, M.fmt, false, M.meta);
    const del = document.createElement('button'); del.textContent = 'Delete';
    del.onclick = async () => {
      if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Sure?'; setTimeout(() => { delete del.dataset.armed; del.textContent = 'Delete'; }, 2500); return; }
      await idbDel('movies', M.id).catch(() => {}); renderMovieList();
    };
    acts.append(open, del); row.append(img, info, acts); el.appendChild(row);
  });
}
const safeName = () => (titleText() || 'my-doodle-movie').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 60) || 'my-doodle-movie';
$('saveBtn').onclick = () => {
  if (!movieBlob) return;
  const a = document.createElement('a'); a.href = movieUrl; a.download = `${safeName()}.${movieExt}`;
  document.body.appendChild(a); a.click(); a.remove();
};
$('shareBtn').onclick = async () => {
  if (!movieBlob) return;
  try { await navigator.share({ files: [new File([movieBlob], `${safeName()}.${movieExt}`, { type: movieBlob.type })], title: $('ytTitle').value }); }
  catch (e) { if (e?.name !== 'AbortError') toast("Couldn't open sharing. Use Save video instead."); }
};
$('againBtn').onclick = () => { $('movieCard').hidden = true; $('preview').pause(); };

let ytPrivacy = 'public';
document.querySelectorAll('#ytPrivacy .chip').forEach((b) => (b.onclick = () => { ytPrivacy = b.dataset.v; document.querySelectorAll('#ytPrivacy .chip').forEach((x) => x.setAttribute('aria-pressed', x === b)); }));
$('ytBtn').onclick = () => parentGate(postToYouTube);
async function postToYouTube() {
  if (!movieBlob) return;
  const msg = $('ytMsg'), btn = $('ytBtn');
  const playlist = $('ytPlaylist').value.trim();
  let publishAt = null;
  if ($('ytWhen').value) {
    const d = new Date($('ytWhen').value);
    if (isNaN(d) || d.getTime() < Date.now() + 5 * 60 * 1000) { msg.textContent = 'Pick a "go live" time at least a few minutes from now, or clear it.'; return; }
    publishAt = d.toISOString();
  }
  let token;
  try { token = await getYouTubeToken(!!playlist); } // first thing in the click, so Google's window can open
  catch (e) { const m = friendlyAuthError(e); if (m) msg.textContent = m + ' You can still press Save video and upload it on YouTube yourself.'; return; }
  btn.disabled = true; btn.textContent = 'Posting…'; $('ytProg').hidden = false;
  const bar = $('ytProg').firstElementChild; bar.style.width = '0';
  try {
    const res = await uploadToYouTube({
      token, blob: movieBlob, title: $('ytTitle').value.trim() || 'My Doodle Alive movie', description: $('ytDesc').value, tags: tagList,
      privacy: ytPrivacy, madeForKids: $('ytKids').checked, publishAt, onProgress: (p) => (bar.style.width = Math.round(p * 100) + '%'),
    });
    const notes = [];
    if (res.id && thumbBlob) { msg.textContent = 'Adding the thumbnail…'; const n = await setThumbnail(token, res.id, thumbBlob); if (n) notes.push(n); }
    if (res.id && playlist) { msg.textContent = 'Adding it to the playlist…'; const n = await addToPlaylist(token, res.id, playlist, ytPrivacy); notes.push(n || `Added to "${playlist}".`); }
    msg.textContent = '';
    if (res.id) {
      const a = document.createElement('a'); a.href = `https://youtu.be/${res.id}`; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Watch it on YouTube';
      const ok = document.createElement('span'); ok.className = 'ok'; ok.textContent = publishAt ? 'Scheduled! ' : 'Posted! ';
      msg.append(ok, publishAt ? `It goes live ${new Date(publishAt).toLocaleString()}. ` : 'YouTube needs a few minutes to finish it. ', a, notes.length ? ' ' + notes.join(' ') : '');
      if (!publishAt && res.status?.privacyStatus && res.status.privacyStatus !== ytPrivacy) msg.append(' YouTube kept it private for now (see README about app verification).');
    } else msg.textContent = 'Posted! Check YouTube Studio in a few minutes.';
    btn.textContent = 'Posted';
  } catch (e) {
    msg.textContent = e.message + ' You can still press Save video and upload it on YouTube yourself.';
    btn.disabled = false; btn.textContent = 'Post to YouTube';
  } finally {
    $('ytProg').hidden = true;
  }
}


/* =========================================================
   MY CHARACTERS (saved characters you can bring into any movie)
   ========================================================= */
let library = [], guests = [], pendingGuestIds = null;
function paintShift(paint, dx, dy) {
  if (!paint) return paint;
  const out = {};
  for (const k of Object.keys(paint)) out[k] = paint[k].map((st) => ({ r: st.r, pts: st.pts.map((v, i) => +(v + (i % 2 ? dy : dx)).toFixed(1)) }));
  return out;
}
/** A character's painted arms and legs, in its own (cut-out) coordinates. */
const localPaint = (A) => (A.settings.rigPaint ? paintShift(A.settings.rigPaint, -A.x0, -A.y0) : null);
async function loadLibrary() {
  let local = [];
  try { local = await idbAll('library'); } catch { local = []; }
  let cloud = [];
  if (user) { try { cloud = await listLibrary(user.uid); } catch { cloud = []; } }
  const byId = new Map();
  [...cloud, ...local].forEach((it) => byId.set(it.id, it));
  library = [...byId.values()].sort((a, b) => (b.saved || 0) - (a.saved || 0));
  renderLibrary();
}
function renderLibrary() {
  const el = $('libGrid'); el.innerHTML = '';
  $('libHint').textContent = library.length ? 'Tap Add to bring a character onto the stage.' : 'Save a character to use it again in any movie, even with a new drawing.';
  library.forEach((it) => {
    const card = document.createElement('div'); card.className = 'libcard';
    const img = document.createElement('img'); img.src = it.png; img.alt = '';
    const nm = document.createElement('span'); nm.textContent = it.name || 'Character';
    const add = document.createElement('button'); add.className = 'add'; add.textContent = 'Add';
    add.setAttribute('aria-label', 'Add ' + (it.name || 'character') + ' to the stage');
    add.onclick = () => addGuest(it);
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Delete ' + (it.name || 'character') + ' from My characters');
    x.onclick = async () => {
      if (!x.dataset.armed) { x.dataset.armed = '1'; x.textContent = 'Delete?'; setTimeout(() => { delete x.dataset.armed; x.textContent = '×'; }, 2500); return; }
      library = library.filter((q) => q.id !== it.id); renderLibrary();
      idbDel('library', it.id).catch(() => {});
      if (user) deleteLibraryChar(user.uid, it.id).catch(() => {});
    };
    card.append(img, nm, add, x); el.appendChild(card);
  });
}
async function saveToLibrary() {
  const A = actors[sel]; if (!A) return;
  let png = A.cv.toDataURL('image/png');
  let k = 1;
  if (png.length > 800000) {
    k = Math.sqrt(800000 / png.length) * 0.9;
    const c = document.createElement('canvas'); c.width = Math.round(A.w * k); c.height = Math.round(A.h * k);
    c.getContext('2d').drawImage(A.cv, 0, 0, c.width, c.height); png = c.toDataURL('image/png');
  }
  const sc = (p) => (p ? Object.fromEntries(Object.entries(p).map(([key, list]) => [key, list.map((st) => ({ r: st.r * k, pts: st.pts.map((v) => +(v * k).toFixed(1)) }))])) : null);
  const item = {
    id: A.libId || 'c' + Date.now(), name: A.settings.name || 'My character', png, saved: Date.now(),
    eyes: A.eyes.map((e) => ({ x: +(e.x * k).toFixed(1), y: +(e.y * k).toFixed(1) })),
    settings: { hat: A.settings.hat, voice: A.settings.voice || 'normal', move: A.settings.move },
    rigPaint: sc(A.guest ? A.settings.rigPaint : localPaint(A)),
  };
  A.libId = item.id;
  library = [item, ...library.filter((q) => q.id !== item.id)]; renderLibrary();
  try { await idbPut('library', item); } catch { toast('This device is out of space for saved characters.'); }
  if (user) { try { await saveLibraryChar(user.uid, item); } catch { /* kept on this device */ } }
  toast(`${item.name} is saved in My characters${user ? ' (on all your devices)' : ''}.`);
  sfx.tada();
}
$('libSave').onclick = saveToLibrary;
async function addGuest(it, quiet) {
  const img = await loadImg(it.png); if (!img) return;
  const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  cv.getContext('2d').drawImage(img, 0, 0);
  const A = actorFromCanvas(cv, it.eyes, guests.length + 20);
  if (it.rigPaint) finishRig(A, it.rigPaint);
  A.libId = it.id;
  A.settings = { name: it.name || 'Guest', move: it.settings?.move || 'Auto', hat: it.settings?.hat || 'none', voice: it.settings?.voice || 'normal', rigPaint: it.rigPaint || null };
  initRuntime(A);
  A.scale = Math.min((H * 0.38) / A.h, (W * 0.3) / A.w);
  // put the newcomer where there is the most room
  const xs = actors.map((B) => B.home).sort((a, b) => a - b);
  let bestX = W * 0.5, bestGap = -1, prev = 60;
  for (const x of [...xs, W - 60]) { if (x - prev > bestGap) { bestGap = x - prev; bestX = (x + prev) / 2; } prev = x; }
  A.home = bestX;
  guests.push(A); actors.push(A);
  renderCast(); selectActor(actors.length - 1); saveLocal();
  if (!quiet) { puff(A.home, GY - 120, 14); sfx.pop(); toast(`${A.settings.name} joined the cast!`); }
}
function removeGuest() {
  const A = actors[sel]; if (!A?.guest) return;
  guests = guests.filter((g) => g !== A); actors = actors.filter((g) => g !== A);
  sel = Math.max(0, Math.min(sel, actors.length - 1));
  renderCast(); renderSelected(); saveLocal();
}
$('guestRemove').onclick = removeGuest;

/* =========================================================
   BODY EDITOR: color over the arms and legs to fix them
   ========================================================= */
const PART_COLORS = { armL: '#F2552C', armR: '#2F80ED', legL: '#2BB673', legR: '#8E6CF0' };
const PART_LABELS = [['armL', 'Arm on the left'], ['armR', 'Arm on the right'], ['legL', 'Leg on the left'], ['legR', 'Leg on the right'], ['erase', 'Eraser']];
let bodyEdit = null;
function openBodyEditor() {
  const A = actors[sel]; if (!A) return;
  const cur = A.guest ? A.settings.rigPaint : localPaint(A);
  bodyEdit = { A, paint: cur ? JSON.parse(JSON.stringify(cur)) : null, part: 'armL', hist: [], stroke: null };
  $('bodyTitle').textContent = `Fix ${A.settings.name || 'this character'}'s arms and legs`;
  chipGroup($('bodyParts'), PART_LABELS, 'armL', (v) => (bodyEdit.part = v));
  [...$('bodyParts').children].forEach((b) => { const col = PART_COLORS[b.dataset.v]; if (col) { const i = document.createElement('i'); i.className = 'sw2'; i.style.background = col; b.prepend(i); } });
  const cv = $('bodyCv'), k = Math.min(600 / A.w, 440 / A.h);
  cv.width = Math.round(A.w * k); cv.height = Math.round(A.h * k); bodyEdit.k = k;
  $('bodyModal').hidden = false; drawBodyEditor();
}
function drawBodyEditor() {
  const { A, paint, k } = bodyEdit, cv = $('bodyCv'), c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  c.save(); c.scale(k, k); c.drawImage(A.cv, 0, 0);
  if (!paint) {
    // show the automatic guess, tinted
    for (const L of [...A.rig.arms, ...A.rig.legs]) {
      const key = (L.kind === 'arm' ? 'arm' : 'leg') + (L.side < 0 ? 'L' : 'R');
      for (const part of [L.up, L.lo]) {
        const t = document.createElement('canvas'); t.width = part.width; t.height = part.height; const x = t.getContext('2d');
        x.drawImage(part, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = PART_COLORS[key]; x.fillRect(0, 0, t.width, t.height);
        c.globalAlpha = 0.55; c.drawImage(t, L.bx, L.by); c.globalAlpha = 1;
      }
    }
  } else {
    c.lineCap = 'round'; c.lineJoin = 'round'; c.globalAlpha = 0.5;
    for (const [key, list] of Object.entries(paint)) {
      c.strokeStyle = c.fillStyle = PART_COLORS[key];
      for (const st of list) {
        c.lineWidth = st.r * 2; c.beginPath();
        if (st.pts.length === 2) { c.arc(st.pts[0], st.pts[1], st.r, 0, Math.PI * 2); c.fill(); continue; }
        c.moveTo(st.pts[0], st.pts[1]); for (let i = 2; i < st.pts.length; i += 2) c.lineTo(st.pts[i], st.pts[i + 1]); c.stroke();
      }
    }
    c.globalAlpha = 1;
  }
  c.restore();
  const n = paint ? Object.values(paint).reduce((a, l) => a + l.length, 0) : 0;
  $('bodyNote').textContent = !paint ? "Showing the app's own guess. Color over a part to fix it yourself."
    : n ? 'Press Done to try it. Parts you leave uncolored stay attached to the body.' : 'Nothing colored: the character moves as one piece.';
}
function bodyPt(e) { const r = $('bodyCv').getBoundingClientRect(), k = bodyEdit.k; return { x: (e.clientX - r.left) * ($('bodyCv').width / r.width) / k, y: (e.clientY - r.top) * ($('bodyCv').height / r.height) / k }; }
$('bodyCv').addEventListener('pointerdown', (e) => {
  if (!bodyEdit) return; e.preventDefault();
  const p = bodyPt(e), r = 16 / bodyEdit.k * ($('bodyCv').width / $('bodyCv').getBoundingClientRect().width);
  if (!bodyEdit.paint) bodyEdit.paint = {};
  bodyEdit.hist.push(JSON.stringify(bodyEdit.paint));
  if (bodyEdit.part === 'erase') { eraseAt(p, r * 1.6); bodyEdit.erasing = true; }
  else { bodyEdit.stroke = { pts: [+p.x.toFixed(1), +p.y.toFixed(1)], r }; (bodyEdit.paint[bodyEdit.part] ||= []).push(bodyEdit.stroke); }
  $('bodyCv').setPointerCapture(e.pointerId); drawBodyEditor();
});
$('bodyCv').addEventListener('pointermove', (e) => {
  if (!bodyEdit) return;
  const p = bodyPt(e);
  if (bodyEdit.erasing) { eraseAt(p, 26 / bodyEdit.k); drawBodyEditor(); return; }
  if (!bodyEdit.stroke) return;
  bodyEdit.stroke.pts.push(+p.x.toFixed(1), +p.y.toFixed(1)); drawBodyEditor();
});
['pointerup', 'pointercancel'].forEach((t) => $('bodyCv').addEventListener(t, () => { if (bodyEdit) { bodyEdit.stroke = null; bodyEdit.erasing = false; } }));
function eraseAt(p, r) {
  for (const key of Object.keys(bodyEdit.paint)) {
    bodyEdit.paint[key] = bodyEdit.paint[key].filter((st) => { for (let i = 0; i < st.pts.length; i += 2) if (Math.hypot(st.pts[i] - p.x, st.pts[i + 1] - p.y) < r + st.r) return false; return true; });
    if (!bodyEdit.paint[key].length) delete bodyEdit.paint[key];
  }
}
$('bodyUndo').onclick = () => { if (!bodyEdit?.hist.length) return; bodyEdit.paint = JSON.parse(bodyEdit.hist.pop()); drawBodyEditor(); };
$('bodyAuto').onclick = () => { bodyEdit.hist.push(JSON.stringify(bodyEdit.paint)); bodyEdit.paint = null; drawBodyEditor(); };
$('bodyNone').onclick = () => { bodyEdit.hist.push(JSON.stringify(bodyEdit.paint)); bodyEdit.paint = {}; drawBodyEditor(); };
$('bodyCancel').onclick = () => { $('bodyModal').hidden = true; bodyEdit = null; };
$('bodyModal').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('bodyCancel').click(); });
$('bodyDone').onclick = () => {
  const { A, paint } = bodyEdit;
  finishRig(A, paint);
  A.settings.rigPaint = A.guest ? paint : (paint ? paintShift(paint, A.x0, A.y0) : null);
  $('bodyModal').hidden = true; bodyEdit = null;
  A.act = 'Dance'; A.actUntil = clock + 3; A.mix = 1;
  renderSelected(); saveLocal(); sfx.tada();
};
$('bodyBtn').onclick = openBodyEditor;

/* =========================================================
   SOUND BOARD: record your own sound effects
   ========================================================= */
let sounds = [], sndRec = null, sndTimer = null;
async function loadSounds() {
  try { sounds = (await idbAll('sounds')).sort((a, b) => a.created - b.created); } catch { sounds = []; }
  renderPads();
}
async function soundBuf(sd) {
  if (sd.buf || !ensureAudio()) return sd.buf;
  try { const ab = await sd.blob.arrayBuffer(); sd.buf = await new Promise((res, rej) => { const p = actx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); }); } catch { sd.buf = null; }
  return sd.buf;
}
function renderPads() {
  const el = $('sndPads'); el.innerHTML = '';
  sounds.forEach((sd) => {
    const b = document.createElement('div'); b.className = 'pad'; b.tabIndex = 0; b.setAttribute('role', 'button'); b.setAttribute('aria-label', 'Play ' + sd.name);
    const s = document.createElement('span'); s.textContent = sd.name;
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Delete sound ' + sd.name);
    x.onclick = async (e) => {
      e.stopPropagation();
      if (!x.dataset.armed) { x.dataset.armed = '1'; x.textContent = 'Delete?'; setTimeout(() => { delete x.dataset.armed; x.textContent = '×'; }, 2500); return; }
      sounds = sounds.filter((q) => q !== sd); renderPads(); idbDel('sounds', sd.id).catch(() => {});
    };
    const play = async () => {
      const buf = await soundBuf(sd); if (!buf) return toast("That sound couldn't be played.");
      const n = actx.createBufferSource(); n.buffer = buf; n.connect(master); n.start();
      b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 160);
    };
    b.addEventListener('pointerdown', (e) => { if (e.target === x) return; e.preventDefault(); play(); });
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); } });
    b.append(s, x); el.appendChild(b);
  });
}
$('sndRec').onclick = async () => {
  if (sndRec) { sndRec.stop(); return; }
  if (!(await enableMic(false))) return;
  const am = pickAudioMime(); if (am === null) return toast("This browser can't record sounds.");
  const dst = actx.createMediaStreamDestination(); fxOut.connect(dst);
  const rec = new MediaRecorder(dst.stream, am ? { mimeType: am } : {}); const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    clearInterval(sndTimer); sndRec = null; try { fxOut.disconnect(dst); } catch { /* fine */ }
    $('sndRec').classList.remove('recording'); $('sndRec').textContent = 'Record';
    if (!chunks.length) return;
    const sd = { id: 'snd' + Date.now(), name: $('sndName').value.trim() || `Sound ${sounds.length + 1}`, blob: new Blob(chunks, { type: (rec.mimeType || am || 'audio/webm').split(';')[0] }), created: Date.now() };
    $('sndName').value = '';
    await soundBuf(sd);
    sounds.push(sd); renderPads();
    const { buf, ...keep } = sd; idbPut('sounds', keep).catch(() => {});
    toast(`"${sd.name}" is on your sound board. Tap it any time, even while filming.`);
  };
  sndRec = rec; rec.start(100);
  const t0 = Date.now();
  $('sndRec').classList.add('recording'); $('sndRec').textContent = 'Stop (0s)';
  sndTimer = setInterval(() => { const s = (Date.now() - t0) / 1000; $('sndRec').textContent = `Stop (${Math.floor(s)}s)`; if (s >= 8) sndRec?.stop(); }, 200);
};

function showPage(k) {
  document.querySelectorAll('#ptabs button').forEach((b) => { b.setAttribute('aria-selected', b.dataset.page === k); if (b.dataset.page === k) b.classList.remove('dot'); });
  document.querySelectorAll('#p-studio .ppage').forEach((p) => (p.hidden = p.dataset.page !== k));
}
document.querySelectorAll('#ptabs button').forEach((b) => (b.onclick = () => showPage(b.dataset.page)));

/* =========================================================
   LOOP + TABS
   ========================================================= */
let mode = 'draw', lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now; const t = now / 1000;
  if (mode === 'studio' || recState !== 'idle') {
    renderStudio(sctx, dt);
  }
  requestAnimationFrame(frame);
}
function setTab(name) {
  if (recState !== 'idle') return;
  if (name === 'studio' && !buildActors() && !guests.length) { toast('Draw something first!'); name = 'draw'; }
  if (name === 'studio' && pendingGuestIds) {
    const ids = pendingGuestIds; pendingGuestIds = null;
    ids.forEach((id) => { const it = library.find((q) => q.id === id); if (it && !guests.some((g) => g.libId === id)) addGuest(it, true); });
  }
  mode = name;
  document.querySelector('.app').classList.toggle('studio', name === 'studio');
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', t.dataset.tab === name));
  $('p-draw').hidden = name !== 'draw'; $('p-studio').hidden = name !== 'studio';
  $('drawView').hidden = name !== 'draw'; $('studioWrap').hidden = name !== 'studio';
  if (name === 'studio') { ensureAudio(); startMusic(); } else stopMusic();
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => setTab(t.dataset.tab)));
document.querySelectorAll('[data-goto]').forEach((b) => (b.onclick = () => { setTab(b.dataset.goto); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
const canFS = document.fullscreenEnabled || document.webkitFullscreenEnabled;
$('fsBtn').hidden = !canFS;
$('fsBtn').onclick = () => {
  const el = $('studioWrap');
  if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
};

/* =========================================================
   ACCOUNT + SAVED DRAWINGS
   ========================================================= */
let user = null;
function signIn(after) {
  parentGate(async () => {
    try { await signInGoogle(); after && after(); }
    catch (e) { const m = friendlyAuthError(e); if (m) toast(m, 6000); }
  });
}
$('signInBtn').onclick = () => signIn();
$('signOutBtn').onclick = () => signOutUser();
onUser((u) => {
  user = u;
  $('signInBtn').hidden = !!u; $('userBox').hidden = !u;
  if (u) {
    $('userName').textContent = u.displayName || u.email || 'Signed in';
    if (u.photoURL) $('userPic').src = u.photoURL; else $('userPic').removeAttribute('src');
    refreshGallery(); loadLibrary();
  } else {
    $('gallery').innerHTML = '';
    $('galleryHint').textContent = 'A grown-up can sign in to save drawings and open them on any device.';
  }
});
function drawingDataUrl() {
  let url = draw.toDataURL('image/png');
  if (url.length > 850000) {
    const c = document.createElement('canvas'); c.width = DW / 2; c.height = DH / 2;
    c.getContext('2d').drawImage(draw, 0, 0, c.width, c.height); url = c.toDataURL('image/png');
  }
  return url;
}
async function saveDrawing() {
  if (!user) return signIn(saveDrawing);
  buildActors();
  const btn = $('saveCharBtn'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await saveCharacter(user.uid, { name: titleText() || autoTitle(), drawing: drawingDataUrl(), eyes, settings: settingsSnapshot(), scene: scene.startsWith('bg:') ? 'meadow' : scene });
    toast('Drawing saved!'); refreshGallery();
  } catch (e) {
    toast(e?.code === 'permission-denied' ? 'Saving is blocked. Publish the Firestore rules (see README).' : "Couldn't save. Check the internet and try again.", 5000);
  } finally { btn.disabled = false; btn.textContent = 'Save this drawing'; }
}
$('saveCharBtn').onclick = saveDrawing;
async function refreshGallery() {
  if (!user) return;
  const g = $('gallery');
  try {
    const items = await listCharacters(user.uid);
    g.innerHTML = '';
    $('galleryHint').textContent = items.length ? 'Tap a drawing to open it.' : 'No saved drawings yet. Draw something and press Save.';
    items.forEach((it) => {
      const card = document.createElement('div'); card.className = 'gcard'; card.tabIndex = 0; card.setAttribute('role', 'button');
      card.setAttribute('aria-label', 'Open ' + (it.name || 'drawing'));
      const img = document.createElement('img'); img.src = it.drawing; img.alt = '';
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = it.name || 'Drawing';
      const del = document.createElement('button'); del.className = 'del'; del.textContent = 'Remove'; del.setAttribute('aria-label', 'Remove ' + (it.name || 'drawing'));
      let armed = false, armT;
      del.onclick = async (ev) => {
        ev.stopPropagation();
        if (!armed) { armed = true; del.textContent = 'Sure?'; armT = setTimeout(() => { armed = false; del.textContent = 'Remove'; }, 3000); return; }
        clearTimeout(armT); try { await deleteCharacter(user.uid, it.id); refreshGallery(); } catch { toast("Couldn't remove it. Try again."); }
      };
      const open = () => loadSaved(it);
      card.onclick = open; card.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } };
      card.append(img, nm, del); g.appendChild(card);
    });
  } catch (e) {
    $('galleryHint').textContent = e?.code === 'permission-denied' ? 'Saved drawings are blocked. Publish the Firestore rules (see README).' : "Couldn't load saved drawings.";
  }
}
function loadSaved(it) {
  const img = new Image();
  img.onload = () => {
    pushUndo(); touched(); hidePhotoBox();
    dctx.clearRect(0, 0, DW, DH); dctx.drawImage(img, 0, 0, DW, DH);
    eyes = (it.eyes || []).map((e) => ({ x: e.x, y: e.y })); renderEyesOv();
    actors = []; pendingSettings = it.settings || null;
    if (it.scene) setScene(it.scene);
    titleEdited = false;
    changed(); setTab('draw'); toast(`${it.name || 'Your drawing'} is back!`);
  };
  img.src = it.drawing;
}

/* =========================================================
   START
   ========================================================= */
chipGroup($('moves'), MOVES, 'Auto', (v) => { const A = actors[sel]; if (A) { A.settings.move = v; A.autoT = 0; saveLocal(); } });
chipGroup($('hats'), HATS, 'none', (v) => { const S = cur(); if (S) { S.hat = v; saveLocal(); } });
loadBgs();
renderScenes();
renderMusic();
renderPad();
loadStickers();
renderStickerLib();
renderVoices();
loadScenes();
renderMovieList();
loadLibrary();
loadSounds();
restoreLocal();
setRecUI();
requestAnimationFrame(frame);
if (document.fonts) document.fonts.load('800 40px Grandstander').then(() => renderScenes()).catch(() => {});
