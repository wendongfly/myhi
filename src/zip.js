// ---------------------------------------------------------------------------
// 流式 ZIP 打包（文件面板「下载文件夹 / 多选打包下载」用）
//   为什么 zip 不用 tar.gz：Windows / Mac / 手机都能直接双击打开，不用装软件。
//   自己写不引依赖：local header 先写 0、数据后跟 data descriptor（flag bit 3），CRC / 大小边读边算，
//   一个文件一个文件 deflate 着往响应里写，不进内存。文件名 UTF-8（flag bit 11），中文名不乱码。
//   不支持 ZIP64：总大小 < 4GB、文件数 < 65535（超了在打包前就拦，提示分批）。
// ---------------------------------------------------------------------------

import { createReadStream, readdirSync, lstatSync } from 'fs';
import { join } from 'path';
import { createDeflateRaw } from 'zlib';
import { once } from 'events';

export const ZIP_SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);
export const ZIP_MAX_BYTES = 4 * 1024 ** 3 - 64 * 1024 ** 2;   // 留点余量给头部
export const ZIP_MAX_FILES = 65000;

// 已经压缩过的格式再 deflate 白费 CPU：用最低级别
const PACKED = /\.(zip|gz|tgz|7z|rar|xz|bz2|jpe?g|png|gif|webp|mp4|mov|avi|mkv|mp3|m4a|aac|pdf|docx|xlsx|pptx|myhipack)$/i;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return ~crc >>> 0;
}
function dosTime(ms) {
  const d = new Date(ms);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * 收集要打包的文件。items：[{ abs, name }]，name 是它在 zip 里的顶层名字（文件夹会展开成 name/子路径）
 * → { files: [{ abs, name, size, mtime, mode }], bytes, skipped: [跳过的目录名] }
 */
export function collectZipFiles(items) {
  const files = []; const skipped = new Set(); let bytes = 0;
  const walk = (dir, prefix, depth) => {
    if (depth > 40 || files.length > ZIP_MAX_FILES) return;
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (ZIP_SKIP_DIRS.has(e.name)) { skipped.add(e.name); continue; }
        walk(abs, prefix + '/' + e.name, depth + 1);
      } else if (e.isFile()) addFile(abs, prefix + '/' + e.name);
    }
  };
  const addFile = (abs, name) => {
    let st; try { st = lstatSync(abs); } catch { return; }
    files.push({ abs, name, size: st.size, mtime: st.mtimeMs, mode: st.mode & 0o777 });
    bytes += st.size;
  };
  for (const it of items) {
    let st; try { st = lstatSync(it.abs); } catch { continue; }
    if (st.isDirectory()) walk(it.abs, it.name, 0);
    else if (st.isFile()) addFile(it.abs, it.name);
  }
  return { files, bytes, skipped: [...skipped] };
}

async function put(out, buf) { if (!out.write(buf)) await once(out, 'drain'); }

/** 把 files 打成 zip 流式写进 out（HTTP 响应），不结束 out 以外的东西 */
export async function writeZip(out, files) {
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const { time, date } = dosTime(f.mtime || Date.now());
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0808, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
    lh.writeUInt16LE(name.length, 26);
    await put(out, lh); await put(out, name);
    const start = offset; offset += 30 + name.length;

    let crc = 0, usize = 0, csize = 0;
    const deflate = createDeflateRaw({ level: PACKED.test(f.name) ? 1 : 6 });
    const feed = (async () => {
      try {
        for await (const c of createReadStream(f.abs)) {
          crc = crc32(c, crc); usize += c.length;
          if (!deflate.write(c)) await once(deflate, 'drain');
        }
      } finally { deflate.end(); }   // 读到一半文件没了：后面的部分就是空的，zip 结构仍完整
    })();
    for await (const c of deflate) { csize += c.length; await put(out, c); }
    await feed.catch(() => {});
    offset += csize;

    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(usize, 12);
    await put(out, dd); offset += 16;
    central.push({ name, time, date, crc, csize, usize, start, mode: f.mode || 0o644 });
  }
  const cdStart = offset;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE((3 << 8) | 20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0808, 8);
    h.writeUInt16LE(8, 10); h.writeUInt16LE(c.time, 12); h.writeUInt16LE(c.date, 14);
    h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.usize, 24);
    h.writeUInt16LE(c.name.length, 28);
    h.writeUInt32LE(((0o100000 | c.mode) << 16) >>> 0, 38);   // Unix 权限（保留可执行位；Windows 解压忽略）
    h.writeUInt32LE(c.start, 42);
    await put(out, h); await put(out, c.name);
    offset += 46 + c.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
  await put(out, end);
}

