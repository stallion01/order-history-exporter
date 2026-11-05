// Draws the toolbar icon (a receipt on a green tile) with no image dependencies.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const GREEN = [31, 111, 84, 255];
const WHITE = [255, 255, 255, 255];
const LINE = [31, 111, 84, 255];
const CLEAR = [0, 0, 0, 0];

// Colour at a point in a unit square, for one sub-sample of a pixel.
function sample(x, y) {
  const r = 0.18;
  const dx = Math.max(r - x, x - (1 - r), 0);
  const dy = Math.max(r - y, y - (1 - r), 0);
  if (dx * dx + dy * dy > r * r) return CLEAR;
  const inPaper = x > 0.26 && x < 0.74 && y > 0.16 && y < 0.84;
  if (!inPaper) return GREEN;
  const onLine = x > 0.34 && x < 0.66 && [0.3, 0.44, 0.58].some((l) => y > l && y < l + 0.07);
  const onTotal = x > 0.5 && x < 0.66 && y > 0.7 && y < 0.77;
  return onLine || onTotal ? LINE : WHITE;
}

function png(size) {
  const samples = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    const rowStart = py * (size * 4 + 1);
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const c = sample((px + (sx + 0.5) / samples) / size, (py + (sy + 0.5) / samples) / size);
          for (let i = 0; i < 3; i++) sum[i] += c[i] * c[3];
          sum[3] += c[3];
        }
      }
      const alpha = sum[3] / (samples * samples);
      const offset = rowStart + 1 + px * 4;
      for (let i = 0; i < 3; i++) raw[offset + i] = sum[3] ? Math.round(sum[i] / sum[3]) : 0;
      raw[offset + 3] = Math.round(alpha);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) fs.writeFileSync(path.join(dir, `icon${size}.png`), png(size));
