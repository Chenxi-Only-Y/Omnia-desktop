/**
 * 为惊鸿重新生成职业图标（原表缺陷的补丁）。
 *
 * 背景（已回原表逐行核对）：
 *   原表「下滑预选」行7 = 妙音，行8 = 惊鸿，两行的 D 列 DISPIMG 公式 ID **完全相同**
 *   （ID_84D5CADB8E384BF98F4AA78E568B1854），都指向 xl/media/image3.png。
 *   即：原表里这两个职业本来就共用同一张图，界面上看起来就是"图标一样"。
 *   原表没有多余素材可用（26 张图各被引用一次，另有 1 个空目录条目）。
 *
 * 做法：取 image3.png 的形状（alpha 通道）与明暗层次，按惊鸿自己的色板
 *   F0BC06（原表 下滑预选 C8）重新着色，输出 jinghong.png。
 *   形状沿用原素材（不发明新图形），颜色用惊鸿的色板值 —— 同风格且一眼可分。
 *
 * 将来若拿到官方惊鸿图标，直接替换 public/class-icons/jinghong.png 即可，
 * 不需要改代码（CLASS_ICON_FILE 已经指向这个名字）。
 *
 * 用法：node scripts/make-jinghong-icon.mjs
 *   依赖 class-icons/image3.png 存在；只读 PNG，不引入第三方库。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src', 'renderer', 'public', 'class-icons', 'image3.png');
const DST = path.join(ROOT, 'src', 'renderer', 'public', 'class-icons', 'jinghong.png');
/** 惊鸿色板：原表「下滑预选」C8 = F0BC06 */
const RGB = [0xf0, 0xbc, 0x06];

function readPng(file) {
  const data = fs.readFileSync(file);
  if (data.subarray(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n') {
    throw new Error(`不是 PNG：${file}`);
  }
  let pos = 8;
  let idat = Buffer.alloc(0);
  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = 0;
  while (pos < data.length) {
    const len = data.readUInt32BE(pos);
    const type = data.subarray(pos + 4, pos + 8).toString('ascii');
    const body = data.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
    } else if (type === 'IDAT') {
      idat = Buffer.concat([idat, body]);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`只支持 8 位深，实际 ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的 colorType=${colorType}`);

  const raw = zlib.inflateSync(idat);
  const stride = w * channels;
  const out = Buffer.alloc(w * h * channels);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p];
    p += 1;
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    if (filter === 1) {
      for (let i = channels; i < stride; i++) line[i] = (line[i] + line[i - channels]) & 255;
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 255;
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? line[i - channels] : 0;
        line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255;
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? line[i - channels] : 0;
        const b = prev[i];
        const c = i >= channels ? prev[i - channels] : 0;
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
        line[i] = (line[i] + pr) & 255;
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { w, h, channels, pix: out };
}

function writePng(file, w, h, channels, pix) {
  const colorType = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
  const stride = w * channels;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    pix.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

function main() {
  if (!fs.existsSync(SRC)) throw new Error(`找不到源图：${SRC}`);
  const { w, h, channels, pix } = readPng(SRC);
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const alpha = channels === 4 ? pix[i * 4 + 3] : (channels === 2 ? pix[i * 2 + 1] : 255);
    const lum = channels >= 3
      ? (pix[i * channels] * 299 + pix[i * channels + 1] * 587 + pix[i * channels + 2] * 114) / 1000
      : pix[i * channels];
    // 保留原图明暗层次（0.72~1.0），避免整块死板的纯色
    const k = 0.72 + 0.28 * (lum / 255);
    out[i * 4 + 0] = Math.min(255, Math.round(RGB[0] * k));
    out[i * 4 + 1] = Math.min(255, Math.round(RGB[1] * k));
    out[i * 4 + 2] = Math.min(255, Math.round(RGB[2] * k));
    out[i * 4 + 3] = alpha;
  }
  writePng(DST, w, h, 4, out);
  console.log(`[icon] 已生成 ${path.relative(ROOT, DST)}  ${w}x${h}  色=#${RGB.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`);
}

main();
