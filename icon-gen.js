// StreamFusion icon generator — single source of truth for every icon
// surface in the app.
//
// Why a shared module: main.js renders the live tray / window icon at
// runtime, while scripts/gen-icon.js (wired as the prebuild npm hook)
// emits assets/icon.ico + assets/icon.png for electron-builder to
// embed in the .exe (which in turn drives the Windows taskbar +
// desktop shortcuts). Both call the same buildRawIcon() so the tray /
// taskbar / shortcut can never silently drift apart.
//
// 1.7.x rebrand: switched from the blue/teal mark to the aquilo.gg
// rounded brand — dark radial background, violet→green gradient
// lightning bolt with a soft violet halo, gradient ring. Geometry
// transposed from assets/logo.svg (1024-space) into a 256-space
// canvas that scales linearly via K = W / 256.
//
// Pure JS, zero dependencies — same constraint as the rest of the app.

'use strict';

// ──────────────────────────────────────────────────────────────────────
// Brand palette. Mirrors the aquilo.gg tokens used by the renderer
// stylesheets so the icon and the UI sit in the same color family:
//   primary       #7c5cff   → VIOLET
//   primary-bright#9a82ff   → VIOLET_LIGHT / RING_START
//   brand-green   #5bff95   → GREEN / RING_END
//   surface       #11131c   → BG_MID
// The pre-1.7 palette names (BLUE/TEAL/WHITE/DARK) are retained as
// aliases so any drive-by callers still resolve.
// ──────────────────────────────────────────────────────────────────────
const BRAND = {
  VIOLET_LIGHT: [169, 143, 255],  // #a98fff — bolt top-gradient stop
  VIOLET:       [124,  92, 255],  // #7c5cff — primary
  GREEN_MID:    [110, 224, 192],  // #6ee0c0 — bolt mid stop
  GREEN:        [ 91, 255, 149],  // #5bff95 — brand-green
  RING_START:   [154, 130, 255],  // #9a82ff — ring start
  RING_MID:     [124,  92, 255],  // #7c5cff — ring midpoint
  RING_END:     [ 91, 255, 149],  // #5bff95 — ring end
  BG_LIGHT:     [ 30,  34,  54],  // #1e2236 — radial bg center
  BG_MID:       [ 17,  19,  28],  // #11131c — surface
  BG_DARK:      [  8,   9,  16],  // #080910 — radial bg edge
  GLOW:         [124,  92, 255],  // #7c5cff — soft inner glow
  HIGHLIGHT:    [255, 255, 255],  // bolt edge + faint inner ring
  // legacy aliases — keep old call sites working if anything still
  // references BLUE/TEAL/WHITE/DARK directly.
  BLUE:         [124,  92, 255],
  TEAL:         [ 91, 255, 149],
  WHITE:        [255, 255, 255],
  DARK:         [ 17,  19,  28]
};

// PALETTES export shape kept for back-compat with main.js and
// scripts/gen-icon.js. The 1.7.x rebrand collapses per-tier
// palette differentiation: stable / beta / tier2 all render the
// same aquilo mark. tier3 keeps a slightly brighter highlight stop
// so that callers which still pass the tier3 palette get a (subtle)
// visible cue, but the brand reads as identical for end users.
const PALETTES = (function() {
  const tier3 = Object.assign({}, BRAND, {
    VIOLET_LIGHT: [192, 174, 255],
    RING_START:   [180, 158, 255]
  });
  return {
    stable: BRAND,
    beta:   BRAND,
    tier2:  BRAND,
    tier3:  tier3,
    aquilo: BRAND
  };
})();

function resolvePalette(p) {
  if (!p) return PALETTES.stable;
  if (typeof p === 'string') return PALETTES[p] || PALETTES.stable;
  if (p && (p.VIOLET || p.BLUE)) return p;
  return PALETTES.stable;
}

function lerp(a, b, t) { return a + (b - a) * t; }
function lerpRGB(c1, c2, t) {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t))
  ];
}
function lerpRGB3(c1, c2, c3, t) {
  if (t <= 0.5) return lerpRGB(c1, c2, t * 2);
  return lerpRGB(c2, c3, (t - 0.5) * 2);
}

// ──────────────────────────────────────────────────────────────────────
// Draw a StreamFusion icon at the requested size into a raw RGBA
// buffer. Returns { W, H, px: Buffer }. `palette` is an optional
// palette name ('stable' | 'beta' | 'tier2' | 'tier3' | 'aquilo') or a
// palette object literal. Defaults to the brand palette.
// ──────────────────────────────────────────────────────────────────────
function buildRawIcon(size, palette) {
  const W = size || 256;
  const H = size || 256;
  const px = Buffer.alloc(W * H * 4, 0);
  const P  = resolvePalette(palette);
  const K  = W / 256;
  const cx = W / 2;
  const cy = H / 2;

  // Alpha-compositing pixel setter
  function sp(x, y, r, g, b, a) {
    if (a <= 0) return;
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = ((y | 0) * W + (x | 0)) * 4;
    const fa = a / 255, ba = px[i+3] / 255, oa = fa + ba * (1 - fa);
    if (oa <= 0) return;
    px[i]   = Math.round((r * fa + px[i]   * ba * (1-fa)) / oa);
    px[i+1] = Math.round((g * fa + px[i+1] * ba * (1-fa)) / oa);
    px[i+2] = Math.round((b * fa + px[i+2] * ba * (1-fa)) / oa);
    px[i+3] = Math.round(oa * 255);
  }

  // Fill a disk with a per-pixel color callback. cfn receives (x, y)
  // and returns [r, g, b, a].
  function fillDisk(centerX, centerY, radius, cfn) {
    const y0 = Math.max(0, Math.floor(centerY - radius - 1));
    const y1 = Math.min(H - 1, Math.ceil(centerY + radius + 1));
    const x0 = Math.max(0, Math.floor(centerX - radius - 1));
    const x1 = Math.min(W - 1, Math.ceil(centerX + radius + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - centerX, dy = y - centerY, d = Math.sqrt(dx*dx + dy*dy);
        if (d > radius + 0.5) continue;
        const cov = Math.max(0, Math.min(1, radius + 0.5 - d));
        const c = cfn(x, y);
        const a = (c[3] != null ? c[3] : 255) * cov;
        sp(x, y, c[0], c[1], c[2], Math.round(a));
      }
    }
  }

  // Draw an annular ring between two radii, anti-aliased at the edges.
  function drawRing(centerX, centerY, r1, r2, cfn) {
    const y0 = Math.max(0, Math.floor(centerY - r2 - 1));
    const y1 = Math.min(H - 1, Math.ceil(centerY + r2 + 1));
    const x0 = Math.max(0, Math.floor(centerX - r2 - 1));
    const x1 = Math.min(W - 1, Math.ceil(centerX + r2 + 1));
    const span = Math.max(0.0001, r2 - r1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - centerX, dy = y - centerY, d = Math.sqrt(dx*dx + dy*dy);
        if (d < r1 - 1 || d > r2 + 1) continue;
        let cov;
        if (d < r1)      cov = Math.max(0, 1 - (r1 - d));
        else if (d > r2) cov = Math.max(0, 1 - (d - r2));
        else             cov = 1;
        const t = Math.max(0, Math.min(1, (d - r1) / span));
        const c = cfn(x, y, t);
        const a = (c[3] != null ? c[3] : 255) * cov;
        sp(x, y, c[0], c[1], c[2], Math.round(a));
      }
    }
  }

  // Scanline polygon fill — same approach as the pre-rebrand version.
  function fillPoly(verts, cfn) {
    const ys = verts.map(v => v[1]);
    const y0 = Math.max(0, Math.floor(Math.min.apply(null, ys)));
    const y1 = Math.min(H - 1, Math.ceil(Math.max.apply(null, ys)));
    for (let y = y0; y <= y1; y++) {
      const xs = [];
      for (let i = 0; i < verts.length; i++) {
        const ax = verts[i][0], ay = verts[i][1];
        const bx = verts[(i+1) % verts.length][0], by = verts[(i+1) % verts.length][1];
        if ((ay <= y && by > y) || (by <= y && ay > y))
          xs.push(ax + (y - ay) * (bx - ax) / (by - ay));
      }
      xs.sort(function(a, b) { return a - b; });
      for (let j = 0; j < xs.length - 1; j += 2) {
        const lo = Math.ceil(xs[j]), hi = Math.floor(xs[j+1]);
        for (let x = lo; x <= hi; x++) {
          const c = cfn(x, y);
          const a = c[3] != null ? c[3] : 255;
          sp(x, y, c[0], c[1], c[2], a);
        }
      }
    }
  }

  // Outer ring runs from r=124 to r=128 (4px wide @ 256 — matches the
  // SVG's stroke-width=16 over r=504 in 1024-space).
  const RING_OUT = 128 * K;
  const RING_IN  = 124 * K;

  // 1. Background disk — radial gradient. Center pulled upward
  // (cy = 0.38 in SVG objectBoundingBox space) so the mark reads
  // "lit from above". Disk fills the whole canvas at full brand size.
  const bgCx = 128 * K;
  const bgCy = 97.28 * K;   // 0.38 * 256
  const bgR  = 235 * K;     // 0.92 * 256 (gradient extent)
  fillDisk(cx, cy, RING_OUT - 0.5, function(x, y) {
    const d = Math.hypot(x - bgCx, y - bgCy);
    const t = Math.max(0, Math.min(1, d / bgR));
    let c;
    if (t < 0.55) c = lerpRGB(P.BG_LIGHT, P.BG_MID,  t / 0.55);
    else          c = lerpRGB(P.BG_MID,   P.BG_DARK, (t - 0.55) / 0.45);
    return [c[0], c[1], c[2], 255];
  });

  // 2. Soft violet glow centered just below the geometric center —
  // approximates the SVG <radialGradient id="glow"> at r=330/1024.
  const glowR = 82 * K;
  const glowCx = cx, glowCy = cy + 2 * K;
  for (let y = Math.max(0, Math.floor(glowCy - glowR - 1));
           y <= Math.min(H - 1, Math.ceil(glowCy + glowR + 1)); y++) {
    for (let x = Math.max(0, Math.floor(glowCx - glowR - 1));
             x <= Math.min(W - 1, Math.ceil(glowCx + glowR + 1)); x++) {
      const d = Math.hypot(x - glowCx, y - glowCy);
      if (d > glowR) continue;
      const t = d / glowR;
      let a;
      if (t < 0.62) a = lerp(0.62, 0.16, t / 0.62);
      else          a = lerp(0.16, 0,    (t - 0.62) / 0.38);
      sp(x, y, P.GLOW[0], P.GLOW[1], P.GLOW[2], Math.round(a * 255));
    }
  }

  // Lightning-bolt geometry — derived from the SVG path
  //   M624 150 L360 562 L516 562 L404 876 L664 462 L508 462 Z
  // (1024-space), then scaled 0.9 around the canvas center to leave
  // breathing room inside the ring, then renormalized to 256-space.
  const bolt = [
    [153.2 * K,  46.55 * K],
    [ 93.8 * K, 139.25 * K],
    [128.9 * K, 139.25 * K],
    [103.7 * K, 209.90 * K],
    [162.2 * K, 116.75 * K],
    [127.1 * K, 116.75 * K]
  ];

  // 3. Soft violet halo behind the bolt. Approximates the SVG's
  // feGaussianBlur copy: two expanded passes at low alpha, scaled
  // outward from the bolt centroid. Cheap, dependency-free, and
  // disappears cleanly at small sizes (16-32px) where it would only
  // muddy the silhouette.
  if (W >= 48) {
    const boltCx = 128 * K, boltCy = 128 * K;
    function expand(verts, factor) {
      return verts.map(function(v) {
        return [boltCx + (v[0] - boltCx) * factor,
                boltCy + (v[1] - boltCy) * factor];
      });
    }
    const haloAlpha = [36, 22];
    const haloScale = [1.20, 1.10];
    for (let i = 0; i < haloAlpha.length; i++) {
      const verts = expand(bolt, haloScale[i]);
      fillPoly(verts, function() {
        return [P.VIOLET[0], P.VIOLET[1], P.VIOLET[2], haloAlpha[i]];
      });
    }
  }

  // 4. Lightning bolt — violet→green linear gradient along the
  // diagonal axis (300,150) → (700,880) from the SVG (1024-space),
  // mapped into 256-space.
  const gx0 = 75 * K, gy0 = 37.5 * K;
  const gx1 = 175 * K, gy1 = 220 * K;
  const gdx = gx1 - gx0, gdy = gy1 - gy0;
  const glenSq = Math.max(0.0001, gdx * gdx + gdy * gdy);
  function boltColor(x, y) {
    const t = Math.max(0, Math.min(1, ((x - gx0) * gdx + (y - gy0) * gdy) / glenSq));
    let c;
    if      (t < 0.42) c = lerpRGB(P.VIOLET_LIGHT, P.VIOLET,    t / 0.42);
    else if (t < 0.78) c = lerpRGB(P.VIOLET,        P.GREEN_MID, (t - 0.42) / 0.36);
    else               c = lerpRGB(P.GREEN_MID,     P.GREEN,     (t - 0.78) / 0.22);
    return [c[0], c[1], c[2], 255];
  }
  fillPoly(bolt, boltColor);

  // 5. Upper highlight — the SVG paints the top sub-triangle at 16%
  // white to give the bolt a lit edge. Skip at very small sizes where
  // it'd just be one or two pixels and read as noise.
  if (W >= 32) {
    const boltTop = [bolt[0], bolt[1], bolt[2], bolt[5]];
    fillPoly(boltTop, function() {
      return [P.HIGHLIGHT[0], P.HIGHLIGHT[1], P.HIGHLIGHT[2], Math.round(0.16 * 255)];
    });
  }

  // 6. Main outer ring — diagonal gradient through RING_START → RING_MID
  // → RING_END (matches SVG <linearGradient id="ring"> from (0,0) to (1024,1024)).
  drawRing(cx, cy, RING_IN, RING_OUT, function(x, y) {
    const t = Math.max(0, Math.min(1, (x + y) / (W + H)));
    const c = lerpRGB3(P.RING_START, P.RING_MID, P.RING_END, t);
    return [c[0], c[1], c[2], 255];
  });

  // 7. Faint inner ring hairline (SVG's 2px white at 6%). Skip at
  // very small sizes — would just clip into the main ring.
  if (W >= 64) {
    drawRing(cx, cy, RING_IN - 3 * K, RING_IN - 2 * K, function() {
      return [P.HIGHLIGHT[0], P.HIGHLIGHT[1], P.HIGHLIGHT[2], Math.round(0.18 * 255)];
    });
  }

  return { W: W, H: H, px: px };
}

// ──────────────────────────────────────────────────────────────────────
// PNG encoder — matches the runtime tray path. Stores without true
// compression (deflate-raw) to keep the module dependency-free.
// ──────────────────────────────────────────────────────────────────────
function encodePNG(W, H, px) {
  const T = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c=i; for (let j=0;j<8;j++) c=(c&1)?0xEDB88320^(c>>>1):c>>>1; T[i]=c; }
  function crc32(b) { let c=0xFFFFFFFF; for (let i=0;i<b.length;i++) c=T[(c^b[i])&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }
  function adler32(b) { let s1=1,s2=0; for (let i=0;i<b.length;i++){s1=(s1+b[i])%65521;s2=(s2+s1)%65521;} return ((s2 * 65536 + s1) >>> 0); }
  function mkChunk(type, data) {
    const tb=Buffer.from(type,'ascii'), lb=Buffer.alloc(4), cb=Buffer.alloc(4);
    lb.writeUInt32BE(data.length,0); cb.writeUInt32BE(crc32(Buffer.concat([tb,data])),0);
    return Buffer.concat([lb,tb,data,cb]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W,0); ihdr.writeUInt32BE(H,4); ihdr[8]=8; ihdr[9]=6;
  const rowLen = W*4, raw = Buffer.alloc(H*(rowLen+1));
  for (let y=0;y<H;y++) { raw[y*(rowLen+1)]=0; px.copy(raw, y*(rowLen+1)+1, y*rowLen, (y+1)*rowLen); }
  const BLOCK = 65535;
  const numBlocks = Math.ceil(raw.length / BLOCK);
  const blocks = [];
  for (let b = 0; b < numBlocks; b++) {
    const chunk = raw.slice(b * BLOCK, Math.min((b+1) * BLOCK, raw.length));
    const isLast = b === numBlocks - 1;
    const hdr = Buffer.alloc(5);
    hdr[0] = isLast ? 0x01 : 0x00;
    hdr.writeUInt16LE(chunk.length, 1);
    hdr.writeUInt16LE((~chunk.length) & 0xFFFF, 3);
    blocks.push(hdr, chunk);
  }
  const adBuf = Buffer.alloc(4); adBuf.writeUInt32BE(adler32(raw), 0);
  const idat = Buffer.concat([Buffer.from([0x78, 0x01]), ...blocks, adBuf]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),mkChunk('IHDR',ihdr),mkChunk('IDAT',idat),mkChunk('IEND',Buffer.alloc(0))]);
}

// Shorthand used at runtime by main.js — draws at 256x256 and returns
// the PNG buffer directly. Kept so callers don't have to know about
// the raw/encode split.
function buildSFIcon(size, palette) {
  const raw = buildRawIcon(size || 256, palette);
  return encodePNG(raw.W, raw.H, raw.px);
}

// ──────────────────────────────────────────────────────────────────────
// ICO builder. Windows's ICO format is a tiny container wrapping
// multiple sub-images (PNG or BMP) at different resolutions. Vista+
// supports PNG-compressed entries so we can embed the buildRawIcon
// output directly without converting to BMP. One ICO file per call —
// takes an array of sizes (e.g. [16, 32, 48, 128, 256]) and returns
// a Buffer ready to write to disk.
//
// Why multiple sizes: Windows picks the closest-size entry when it
// renders at different zooms (taskbar is typically 24-32px, shortcut
// icons 32-48px, alt-tab preview 32-256px, Explorer large icons
// 48-256px). Embedding only a 256 source produces fuzzy small icons.
// ──────────────────────────────────────────────────────────────────────
function buildIco(sizes, palette) {
  sizes = sizes || [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map(function(s) {
    const raw = buildRawIcon(s, palette);
    return { size: s, png: encodePNG(raw.W, raw.H, raw.px) };
  });
  const n = images.length;
  const hdr = Buffer.alloc(6 + 16 * n);
  hdr.writeUInt16LE(0, 0);       // reserved
  hdr.writeUInt16LE(1, 2);       // type = icon
  hdr.writeUInt16LE(n, 4);       // image count
  let offset = 6 + 16 * n;
  for (let i = 0; i < n; i++) {
    const img = images[i];
    const e = 6 + 16 * i;
    // Width/height: 0 means 256. Any size > 255 must be encoded as 0.
    hdr[e]     = img.size >= 256 ? 0 : img.size;
    hdr[e + 1] = img.size >= 256 ? 0 : img.size;
    hdr[e + 2] = 0;                    // color count (0 = truecolor)
    hdr[e + 3] = 0;                    // reserved
    hdr.writeUInt16LE(1, e + 4);       // color planes
    hdr.writeUInt16LE(32, e + 6);      // bits per pixel
    hdr.writeUInt32LE(img.png.length, e + 8);
    hdr.writeUInt32LE(offset, e + 12);
    offset += img.png.length;
  }
  return Buffer.concat([hdr].concat(images.map(function(i) { return i.png; })));
}

module.exports = {
  buildRawIcon:  buildRawIcon,
  encodePNG:     encodePNG,
  buildSFIcon:   buildSFIcon,
  buildIco:      buildIco,
  PALETTES:      PALETTES
};
