// StreamFusion icon generator — single source of truth for every icon
// surface in the app.
//
// Why a shared module: before 1.4.6 this code lived inline in main.js and
// was only called at runtime to render the tray / window icons, which
// meant `assets/icon.ico` (used by electron-builder to embed the icon in
// the .exe, which in turn drives the Windows taskbar + desktop shortcuts)
// silently drifted out of sync every time the drawing code was updated.
// Now main.js AND scripts/gen-icon.js both require this module, and the
// prebuild npm hook regenerates icon.ico + icon.png before every build.
// Tray / dock / shortcut icons are guaranteed to match.
//
// Pure JS, zero dependencies — same constraint as the rest of the app.

'use strict';

// ──────────────────────────────────────────────────────────────────────
// Palettes — exported so build scripts + main.js can pick between
// the stable (blue/teal) and beta (amber/orange) look. Same shape:
// { BLUE, TEAL, WHITE, DARK } because the drawing code references
// those named slots regardless of which palette is active.
//
// STABLE: production, matches the aquilo.gg banner branding.
// BETA:   amber-to-orange ring over a warm cream bolt — unmistakably
//         different from stable at a glance (taskbar, tray, shortcut).
//         Lets the user tell at-a-glance which variant they're using.
// ──────────────────────────────────────────────────────────────────────
const PALETTES = {
  stable: {
    BLUE:  [ 58, 134, 255],  // primary ring accent
    TEAL:  [ 42, 212, 185],  // secondary gradient stop
    WHITE: [239, 239, 241],  // bolt highlight
    DARK:  [ 14,  14,  16]   // interior fill
  },
  beta: {
    BLUE:  [245, 158,  11],  // amber-500 (replaces stable BLUE)
    TEAL:  [249, 115,  22],  // orange-500 (replaces stable TEAL)
    WHITE: [254, 243, 199],  // warm amber-50 (replaces stable WHITE)
    DARK:  [ 20,  14,   4]   // warm near-black (still reads as "app bg")
  }
};

// ──────────────────────────────────────────────────────────────────────
// Draw a StreamFusion icon at the requested size into a raw RGBA
// buffer. Returns { W, H, px: Buffer }. `palette` is an optional
// palette name ('stable' | 'beta') or a palette object literal.
// Defaults to the stable palette so existing callers don't break.
// ──────────────────────────────────────────────────────────────────────
function resolvePalette(p) {
  if (!p) return PALETTES.stable;
  if (typeof p === 'string') return PALETTES[p] || PALETTES.stable;
  if (p.BLUE && p.TEAL && p.WHITE && p.DARK) return p;
  return PALETTES.stable;
}

function buildRawIcon(size, palette) {
  const W = size || 256;
  const H = size || 256;
  const px = Buffer.alloc(W * H * 4, 0);
  const P = resolvePalette(palette);
  // Scale factor so the geometry (bolt path, ring radii) authored for a
  // 256px canvas still reads cleanly at other resolutions.
  const K = W / 256;

  // Alpha-compositing pixel setter
  function sp(x, y, r, g, b, a) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4, fa = a / 255, ba = px[i+3] / 255, oa = fa + ba * (1 - fa);
    if (oa <= 0) return;
    px[i]   = Math.round((r * fa + px[i]   * ba * (1-fa)) / oa);
    px[i+1] = Math.round((g * fa + px[i+1] * ba * (1-fa)) / oa);
    px[i+2] = Math.round((b * fa + px[i+2] * ba * (1-fa)) / oa);
    px[i+3] = Math.round(oa * 255);
  }

  function drawCircle(cx, cy, radius, r, g, b, a) {
    for (let y = cy - radius - 1; y <= cy + radius + 1; y++) {
      for (let x = cx - radius - 1; x <= cx + radius + 1; x++) {
        const dx = x - cx, dy = y - cy, dist2 = dx*dx + dy*dy;
        if (dist2 > (radius+1)*(radius+1)) continue;
        const alpha = Math.max(0, Math.min(1, radius + .5 - Math.sqrt(dist2)));
        sp(x, y, r, g, b, Math.round(a * alpha));
      }
    }
  }

  function fillPoly(verts, cfn) {
    const ys = verts.map(v=>v[1]);
    const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
    for (let y = y0; y <= y1; y++) {
      const xs = [];
      for (let i = 0; i < verts.length; i++) {
        const [ax,ay] = verts[i], [bx,by] = verts[(i+1)%verts.length];
        if ((ay <= y && by > y) || (by <= y && ay > y))
          xs.push(ax + (y-ay)*(bx-ax)/(by-ay));
      }
      xs.sort((a,b) => a-b);
      for (let j = 0; j < xs.length-1; j += 2) {
        const [r,g,b] = typeof cfn === 'function' ? cfn(y) : cfn;
        for (let x = Math.ceil(xs[j]); x <= Math.floor(xs[j+1]); x++) sp(x, y, r, g, b, 255);
      }
    }
  }

  function drawRing(cx, cy, r1, r2, cfn) {
    for (let y = cy - r2 - 1; y <= cy + r2 + 1; y++) {
      for (let x = cx - r2 - 1; x <= cx + r2 + 1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d < r1 || d > r2 + 1) continue;
        const t = (d - r1) / (r2 - r1);
        const alpha = Math.max(0, Math.min(1, 1 - Math.max(0, d - r2)));
        const [r,g,b] = cfn(x, y, t);
        sp(x, y, r, g, b, Math.round(alpha * 255));
      }
    }
  }

  // Resolved-palette slots. Keep the internal variable names BLUE /
  // TEAL / WHITE / DARK so the drawing geometry below stays identical
  // across palettes — only the colors change.
  const BLUE  = P.BLUE;
  const TEAL  = P.TEAL;
  const WHITE = P.WHITE;
  const DARK  = P.DARK;

  const cx = W/2, cy = H/2;

  // 1. Subtle blue glow outside the ring.
  for (let r = Math.round(140 * K); r >= Math.round(128 * K); r--) {
    const glow = Math.round(((Math.round(140*K) - r) / (12 * K || 1)) * 14);
    drawCircle(cx, cy, r, BLUE[0], BLUE[1], BLUE[2], glow);
  }

  // 2. Dark interior fill.
  drawCircle(cx, cy, Math.round(119 * K), DARK[0], DARK[1], DARK[2], 255);

  // 3. Main ring — diagonal blue→teal gradient.
  drawRing(cx, cy, Math.round(119 * K), Math.round(127 * K), function(x, y) {
    const t = Math.max(0, Math.min(1, (x + y) / (W + H)));
    return [
      Math.round(BLUE[0] + (TEAL[0] - BLUE[0]) * t),
      Math.round(BLUE[1] + (TEAL[1] - BLUE[1]) * t),
      Math.round(BLUE[2] + (TEAL[2] - BLUE[2]) * t)
    ];
  });

  // 4. Subtle inner ring (40% opacity over dark fill).
  drawRing(cx, cy, Math.round(113 * K), Math.round(115 * K), function(x, y) {
    const t = Math.max(0, Math.min(1, (x + y) / (W + H)));
    const r = BLUE[0] + (TEAL[0] - BLUE[0]) * t;
    const g = BLUE[1] + (TEAL[1] - BLUE[1]) * t;
    const b = BLUE[2] + (TEAL[2] - BLUE[2]) * t;
    return [
      Math.round(r * 0.4 + DARK[0] * 0.6),
      Math.round(g * 0.4 + DARK[1] * 0.6),
      Math.round(b * 0.4 + DARK[2] * 0.6)
    ];
  });

  // 5. Lightning bolt — scaled from the canonical 256-coord path.
  function boltColor(y) {
    if (y <= 105 * K) {
      const t = Math.max(0, Math.min(1, (y - 51 * K) / (54 * K)));
      return [
        Math.round(WHITE[0] + (BLUE[0] - WHITE[0]) * t),
        Math.round(WHITE[1] + (BLUE[1] - WHITE[1]) * t),
        Math.round(WHITE[2] + (BLUE[2] - WHITE[2]) * t)
      ];
    }
    const t = Math.max(0, Math.min(1, (y - 105 * K) / (100 * K)));
    return [
      Math.round(BLUE[0] + (TEAL[0] - BLUE[0]) * t),
      Math.round(BLUE[1] + (TEAL[1] - BLUE[1]) * t),
      Math.round(BLUE[2] + (TEAL[2] - BLUE[2]) * t)
    ];
  }

  fillPoly([
    [Math.round(141 * K), Math.round( 51 * K)],
    [Math.round( 82 * K), Math.round(133 * K)],
    [Math.round(118 * K), Math.round(133 * K)],
    [Math.round(108 * K), Math.round(205 * K)],
    [Math.round(169 * K), Math.round(118 * K)],
    [Math.round(133 * K), Math.round(118 * K)]
  ], boltColor);

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
