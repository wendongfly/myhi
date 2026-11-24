// 上传文件过期清理：图片在 <项目cwd>/upload/、其他文件在 ~/.myhi/uploads/，原先从不清理。
// 图片发出那一轮内容就已进 claude transcript（base64），聊天回放也不读原图，过期原文件只占盘。
// 安全边界：只删 myhi 自己命名的文件（`<13位毫秒时间戳>-<6位hex>…`），按文件名里的时间戳判龄；
// 草稿箱里还引用着的（未发出）一律跳过。
import { readdirSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { loadDrafts } from './inbox.js';

const MYHI_NAME = /^(\d{13})-[0-9a-f]{6}/;
const norm = (p) => resolve(p).replace(/\\/g, '/');

/**
 * @param {string[]} dirs  要扫的目录（不存在的自动跳过）
 * @param {number} days    保留天数；<=0 不清理
 * @returns {number} 删除的文件数
 */
export function sweepUploads(dirs, days) {
  if (!(days > 0)) return 0;
  const cutoff = Date.now() - days * 86400_000;
  const keep = new Set();
  for (const d of loadDrafts()) {
    for (const a of [...(d.images || []), ...(d.files || [])]) if (a?.path) keep.add(norm(a.path));
  }
  let removed = 0;
  for (const dir of new Set(dirs)) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const m = MYHI_NAME.exec(name);
      if (!m || Number(m[1]) >= cutoff) continue;
      const p = join(dir, name);
      if (keep.has(norm(p))) continue;
      try { unlinkSync(p); removed++; } catch {}
    }
  }
  return removed;
}
