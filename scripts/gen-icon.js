#!/usr/bin/env node
// Regenerate assets/icon.png and assets/icon.ico from the canonical
// aquilo-site brand kit (streamfusion-logo-{256,512,1024}.png).
//
// Pre-1.7.x this script drew the icon procedurally inside icon-gen.js.
// 1.7.x switched to the canonical PNGs that the aquilo-site brand kit
// exports — they have the proper Gaussian-blur glow, anti-aliased ring,
// and accurate gradient stops that the procedural renderer only
// approximated. The procedural renderer in icon-gen.js is still used at
// runtime for the Electron tray icon (kept dependency-free), but build
// outputs (taskbar / shortcut / installer) now use the canonical PNGs.
//
// For the multi-size Windows ICO, this script reads the largest canonical
// PNG and downsamples to 16/24/32/48/64/128/256 using a box filter, then
// packs into ICO using the existing buildIco helper in icon-gen.js.

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { encodePNG, buildIco } = require('../icon-gen');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
if (!fs.existsSync(ASSETS)) fs.mkdirSync(ASSETS, { recursive: true });

// Canonical 1024x1024 source. Shipped in the repo at assets/icon.png
// (the same file that BrowserWindow.icon + macOS dock use). Read it,
// resize to the ICO sizes Windows wants, and pack.
const sourcePath = path.join(ASSETS, 'icon.png');
if (!fs.existsSync(sourcePath)) {
  console.error('[gen-icon] missing source: assets/icon.png');
  console.error('[gen-icon] copy the canonical PNG (e.g. streamfusion-logo-512.png');
  console.error('[gen-icon] from the aquilo-site brand kit) into assets/icon.png first.');
  process.exit(1);
}
const sourceBuf = fs.readFileSync(sourcePath);
const sourceImg = PNG.sync.read(sourceBuf);

console.log('[gen-icon] read source: ' + sourceImg.width + 'x' + sourceImg.height + ' (' + sourceBuf.length + ' bytes)');

// Area-weighted downsample. For each destination pixel, average the
// source pixels covered by its inverse-scaled bounding box. RGBA, with
// alpha handled as a separate channel so transparent edges anti-alias
// cleanly. Used only when going SMALLER — for upscaling we bail since
// the canonical PNGs already cover everything we need.
function downsample(src, srcW, srcH, dstW, dstH) {
  const dst = Buffer.alloc(dstW * dstH * 4);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.min(srcH, Math.ceil((y + 1) * scaleY));
    for (let x = 0; x < dstW; x++) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.min(srcW, Math.ceil((x + 1) * scaleX));
      let r = 0, g = 0, b = 0, a = 0, weight = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * srcW + sx) * 4;
          const sa = src[i + 3];
          // Premultiply so transparent edges don't bleed dark.
          r += src[i]     * sa;
          g += src[i + 1] * sa;
          b += src[i + 2] * sa;
          a += sa;
          weight++;
        }
      }
      const di = (y * dstW + x) * 4;
      if (a === 0 || weight === 0) {
        dst[di]     = 0;
        dst[di + 1] = 0;
        dst[di + 2] = 0;
        dst[di + 3] = 0;
      } else {
        dst[di]     = Math.round(r / a);
        dst[di + 1] = Math.round(g / a);
        dst[di + 2] = Math.round(b / a);
        dst[di + 3] = Math.round(a / weight);
      }
    }
  }
  return dst;
}

// Build a PNG buffer at the requested square size from the source image.
function pngAtSize(size) {
  if (size === sourceImg.width && size === sourceImg.height) {
    return sourceBuf;
  }
  const raw = downsample(sourceImg.data, sourceImg.width, sourceImg.height, size, size);
  return encodePNG(size, size, raw);
}

// Windows ICO embeds these sizes. Each one gets resampled from the
// canonical source so the small icons remain crisp at every Explorer
// / taskbar / shortcut zoom level.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const images = ICO_SIZES.map(function(s) {
  return { size: s, png: pngAtSize(s) };
});

// Pack ICO. buildIco() normally renders procedurally; pass pre-rendered
// PNG buffers through by inlining the same packing logic here so we
// don't need to change icon-gen.js's public API.
function packIco(imgs) {
  const n = imgs.length;
  const hdr = Buffer.alloc(6 + 16 * n);
  hdr.writeUInt16LE(0, 0);
  hdr.writeUInt16LE(1, 2);
  hdr.writeUInt16LE(n, 4);
  let offset = 6 + 16 * n;
  for (let i = 0; i < n; i++) {
    const img = imgs[i];
    const e = 6 + 16 * i;
    hdr[e]     = img.size >= 256 ? 0 : img.size;
    hdr[e + 1] = img.size >= 256 ? 0 : img.size;
    hdr[e + 2] = 0;
    hdr[e + 3] = 0;
    hdr.writeUInt16LE(1, e + 4);
    hdr.writeUInt16LE(32, e + 6);
    hdr.writeUInt32LE(img.png.length, e + 8);
    hdr.writeUInt32LE(offset, e + 12);
    offset += img.png.length;
  }
  return Buffer.concat([hdr].concat(imgs.map(function(i) { return i.png; })));
}

const ico = packIco(images);
fs.writeFileSync(path.join(ASSETS, 'icon.ico'), ico);
console.log('[gen-icon] wrote assets/icon.ico (' + ico.length + ' bytes, ' + ICO_SIZES.length + ' sizes embedded from canonical PNG)');

// Patron icon variant. Used at runtime by main.js when patreon-auth
// reports tier === 'patron' — the window + tray icon flip to the
// gold/violet variant as a visible thank-you for active Patrons.
// Every feature stays free for everyone regardless.
//
// Sourced from assets/icon-patron.png (the canonical gold/violet PNG
// shipped in the v1.8.0 recovery commit) via the same canonical-PNG ->
// multi-size ICO pipeline as icon.ico. Pre-1.7.1 this used a
// procedural PALETTES.patron path inside icon-gen.js, but that
// palette definition was lost when v1.8.0 was built locally and
// never committed back — keeping the canonical-PNG approach means
// the gold icon survives every rebuild without needing the lost
// palette source.
const patronSourcePath = path.join(ASSETS, 'icon-patron.png');
if (fs.existsSync(patronSourcePath)) {
  const patronSrcBuf = fs.readFileSync(patronSourcePath);
  const patronSrcImg = PNG.sync.read(patronSrcBuf);
  const patronImages = ICO_SIZES.map(function(s) {
    if (s === patronSrcImg.width && s === patronSrcImg.height) {
      return { size: s, png: patronSrcBuf };
    }
    const raw = downsample(patronSrcImg.data, patronSrcImg.width, patronSrcImg.height, s, s);
    return { size: s, png: encodePNG(s, s, raw) };
  });
  const patronIco = packIco(patronImages);
  fs.writeFileSync(path.join(ASSETS, 'icon-patron.ico'), patronIco);
  console.log('[gen-icon] wrote assets/icon-patron.ico (' + patronIco.length + ' bytes, ' + ICO_SIZES.length + ' sizes embedded from canonical Patron PNG)');
} else {
  console.warn('[gen-icon] assets/icon-patron.png missing — skipping Patron .ico generation');
}
