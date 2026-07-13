import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function root(...parts) {
  return join(ROOT, ...parts);
}

function ensureDir(filePath) {
  mkdirSync(join(filePath, '..'), { recursive: true });
}

function crc32(buf) {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
  return Buffer.concat([len, typeB, data, crcBuf]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilterRow(filter, row, prev, bpp) {
  const out = Buffer.from(row);
  switch (filter) {
    case 0: break;
    case 1: for (let i = bpp; i < out.length; i++) out[i] = (out[i] + out[i - bpp]) & 0xff; break;
    case 2: for (let i = 0; i < out.length; i++) out[i] = (out[i] + (prev ? prev[i] : 0)) & 0xff; break;
    case 3:
      for (let i = 0; i < bpp; i++) out[i] = (out[i] + (prev ? prev[i] >> 1 : 0)) & 0xff;
      for (let i = bpp; i < out.length; i++) out[i] = (out[i] + ((out[i - bpp] + (prev ? prev[i] : 0)) >> 1)) & 0xff;
      break;
    case 4:
      for (let i = 0; i < bpp; i++) out[i] = (out[i] + (prev ? prev[i] : 0)) & 0xff;
      for (let i = bpp; i < out.length; i++) out[i] = (out[i] + paethPredictor(out[i - bpp], prev ? prev[i] : 0, prev ? prev[i - bpp] : 0)) & 0xff;
      break;
  }
  return out;
}

function parsePNG(buf) {
  let offset = 8;
  let width = 0, height = 0, colorType = 6;
  let idatChunks = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.slice(offset + 4, offset + 8).toString('ascii');
    const data = buf.slice(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    }
    offset += 12 + len;
  }
  const compressed = inflateSync(Buffer.concat(idatChunks));
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const rowBytes = 1 + width * bpp;
  const pixels = Buffer.alloc(width * height * 4);
  let prev = null;
  for (let y = 0; y < height; y++) {
    const filter = compressed[y * rowBytes];
    const row = compressed.slice(y * rowBytes + 1, (y + 1) * rowBytes);
    const unfiltered = unfilterRow(filter, row, prev, bpp);
    prev = unfiltered;
    for (let x = 0; x < width; x++) {
      const si = x * bpp;
      const di = (y * width + x) * 4;
      if (colorType === 6) {
        pixels[di] = unfiltered[si];
        pixels[di + 1] = unfiltered[si + 1];
        pixels[di + 2] = unfiltered[si + 2];
        pixels[di + 3] = unfiltered[si + 3];
      } else if (colorType === 2) {
        pixels[di] = unfiltered[si];
        pixels[di + 1] = unfiltered[si + 1];
        pixels[di + 2] = unfiltered[si + 2];
        pixels[di + 3] = 255;
      } else {
        pixels[di] = pixels[di + 1] = pixels[di + 2] = unfiltered[si];
        pixels[di + 3] = colorType === 4 ? unfiltered[si + 1] : 255;
      }
    }
  }
  return { width, height, pixels };
}

function removeBackground(pixels, width, height) {
  const corners = [
    0,
    (width - 1) * 4,
    (height - 1) * width * 4,
    ((height - 1) * width + (width - 1)) * 4,
  ];
  let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
  for (const off of corners) {
    rSum += pixels[off];
    gSum += pixels[off + 1];
    bSum += pixels[off + 2];
    aSum += pixels[off + 3];
  }
  const bgR = Math.round(rSum / 4);
  const bgG = Math.round(gSum / 4);
  const bgB = Math.round(bSum / 4);
  const bgA = Math.round(aSum / 4);

  if (bgA === 0) return pixels;

  const tolerance = 30;
  const out = Buffer.from(pixels);
  for (let i = 0; i < out.length; i += 4) {
    const dr = out[i] - bgR;
    const dg = out[i + 1] - bgG;
    const db = out[i + 2] - bgB;
    if (dr * dr + dg * dg + db * db <= tolerance * tolerance * 3) {
      out[i + 3] = 0;
    }
  }
  return out;
}

function resizePNG(srcBuf, targetW, targetH) {
  const src = parsePNG(srcBuf);
  const dstRowBytes = 1 + targetW * 4;
  const raw = Buffer.alloc(dstRowBytes * targetH);
  for (let ty = 0; ty < targetH; ty++) {
    raw[ty * dstRowBytes] = 0;
    const sy = Math.min(Math.floor(ty * src.height / targetH), src.height - 1);
    for (let tx = 0; tx < targetW; tx++) {
      const sx = Math.min(Math.floor(tx * src.width / targetW), src.width - 1);
      const srcOff = (sy * src.width + sx) * 4;
      const dstOff = ty * dstRowBytes + 1 + tx * 4;
      raw[dstOff] = src.pixels[srcOff];
      raw[dstOff + 1] = src.pixels[srcOff + 1];
      raw[dstOff + 2] = src.pixels[srcOff + 2];
      raw[dstOff + 3] = src.pixels[srcOff + 3];
    }
  }
  const pixelsFlat = Buffer.alloc(targetW * targetH * 4);
  for (let y = 0; y < targetH; y++) {
    raw.copy(pixelsFlat, y * targetW * 4, y * dstRowBytes + 1, y * dstRowBytes + 1 + targetW * 4);
  }
  const cleaned = removeBackground(pixelsFlat, targetW, targetH);
  for (let y = 0; y < targetH; y++) {
    cleaned.copy(raw, y * dstRowBytes + 1, y * targetW * 4, y * targetW * 4 + targetW * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(targetW, 0);
  ihdr.writeUInt32BE(targetH, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', deflateSync(raw)),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createICO(pngBuffers) {
  const header = Buffer.alloc(6 + pngBuffers.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngBuffers.length, 4);
  let dataOffset = 6 + pngBuffers.length * 16;
  for (let i = 0; i < pngBuffers.length; i++) {
    const { size, png } = pngBuffers[i];
    const entry = 6 + i * 16;
    header[entry] = size >= 256 ? 0 : size;
    header[entry + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(0, entry + 2);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(dataOffset, entry + 12);
    dataOffset += png.length;
  }
  return Buffer.concat([header, ...pngBuffers.map((p) => p.png)]);
}

function createICNS(entries) {
  let totalSize = 8;
  for (const { data } of entries) totalSize += 8 + data.length;
  const buf = Buffer.alloc(totalSize);
  buf.write('icns', 0);
  buf.writeUInt32BE(totalSize, 4);
  let off = 8;
  for (const { type, data } of entries) {
    buf.write(type, off);
    buf.writeUInt32BE(8 + data.length, off + 4);
    data.copy(buf, off + 8);
    off += 8 + data.length;
  }
  return buf;
}

function writeFile(relPath, data) {
  const abs = root(relPath);
  ensureDir(abs);
  writeFileSync(abs, data);
  console.log(`  ${relPath} (${data.length} bytes)`);
}

const HIRES_SOURCE = root('branding/source/icon-hires.png');
const SOURCE_PNG = root('branding/source/app-icon.png');
const sourceBuf = existsSync(HIRES_SOURCE) ? readFileSync(HIRES_SOURCE) : existsSync(SOURCE_PNG) ? readFileSync(SOURCE_PNG) : null;
if (!sourceBuf) {
  console.error('ERROR: no branding source found. Copy real logos first.');
  process.exit(1);
}
const sourceName = existsSync(HIRES_SOURCE) ? 'icon-hires.png (1254x1254)' : 'app-icon.png (512x512)';
console.log(`Using source: ${sourceName}`);

const icoSizes = [16, 24, 32, 48, 64, 128, 256];

console.log('Generating ICO files...');
writeFile('public/favicon.ico', createICO(icoSizes.map((size) => ({ size, png: resizePNG(sourceBuf, size, size) }))));
writeFile('public/icon.ico', createICO(icoSizes.map((size) => ({ size, png: resizePNG(sourceBuf, size, size) }))));
writeFile('src-tauri/icons/icon.ico', createICO(icoSizes.map((size) => ({ size, png: resizePNG(sourceBuf, size, size) }))));
writeFile('browser-extension/public/icons/icon.ico', createICO([16, 32, 48, 128].map((size) => ({ size, png: resizePNG(sourceBuf, size, size) }))));

console.log('Generating ICNS...');
writeFile('src-tauri/icons/icon.icns', createICNS([
  { type: 'icp4', data: resizePNG(sourceBuf, 16, 16) },
  { type: 'icp5', data: resizePNG(sourceBuf, 32, 32) },
  { type: 'icp6', data: resizePNG(sourceBuf, 64, 64) },
  { type: 'ic07', data: resizePNG(sourceBuf, 128, 128) },
  { type: 'ic08', data: resizePNG(sourceBuf, 256, 256) },
  { type: 'ic09', data: resizePNG(sourceBuf, 512, 512) },
  { type: 'ic10', data: resizePNG(sourceBuf, 1024, 1024) },
]));

console.log('Generating public PNG icons...');
writeFile('public/favicon-16x16.png', resizePNG(sourceBuf, 16, 16));
writeFile('public/favicon-32x32.png', resizePNG(sourceBuf, 32, 32));
writeFile('public/apple-touch-icon.png', resizePNG(sourceBuf, 180, 180));
writeFile('public/android-chrome-192x192.png', resizePNG(sourceBuf, 192, 192));
writeFile('public/android-chrome-512x512.png', resizePNG(sourceBuf, 512, 512));

console.log('Generating Tauri size icons...');
writeFile('src-tauri/icons/32x32.png', resizePNG(sourceBuf, 32, 32));
writeFile('src-tauri/icons/64x64.png', resizePNG(sourceBuf, 64, 64));
writeFile('src-tauri/icons/128x128.png', resizePNG(sourceBuf, 128, 128));
writeFile('src-tauri/icons/128x128@2x.png', resizePNG(sourceBuf, 256, 256));
writeFile('src-tauri/icons/icon.png', resizePNG(sourceBuf, 1024, 1024));

console.log('Generating browser extension icons...');
writeFile('browser-extension/public/icons/icon-16.png', resizePNG(sourceBuf, 16, 16));
writeFile('browser-extension/public/icons/icon-32.png', resizePNG(sourceBuf, 32, 32));
writeFile('browser-extension/public/icons/icon-48.png', resizePNG(sourceBuf, 48, 48));
writeFile('browser-extension/public/icons/icon-128.png', resizePNG(sourceBuf, 128, 128));
writeFile('browser-extension/public/icons/icon.png', resizePNG(sourceBuf, 512, 512));
writeFile('browser-extension/public/icons/logo.png', resizePNG(sourceBuf, 512, 512));

console.log('Generating src/assets logo...');
writeFile('src/assets/logo.png', resizePNG(sourceBuf, 512, 512));

console.log('\nDone. All icons regenerated from same source with transparent background.');
