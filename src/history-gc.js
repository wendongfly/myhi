// 出图 / 语音（会议纪要）历史的删除与过期清理（两边目录结构相同：<root>/<YYYY-MM-DD>/<任务id>/job.json）。
// 安全边界：只删 <root>/<日期>/<id> 这一层、名字都合规的目录；正在进行的任务一律不动。
import { readdirSync, readFileSync, rmSync, rmdirSync, statSync } from 'fs';
import { join, resolve, sep } from 'path';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[\w-]{1,64}$/;

/** 任务目录（校验过，不合规返回 null） */
export function jobDirOf(root, job) {
  if (!job || !DAY_RE.test(String(job.day)) || !ID_RE.test(String(job.id))) return null;
  const base = resolve(root);
  const p = resolve(base, job.day, job.id);
  return p.startsWith(base + sep) ? p : null;
}

/** 删一个任务目录（连同图片 / 录音）；日期目录空了顺手删掉 */
export function removeJobDir(root, job) {
  const p = jobDirOf(root, job);
  if (!p) return false;
  rmSync(p, { recursive: true, force: true });
  try { rmdirSync(join(resolve(root), job.day)); } catch { /* 不空就留着 */ }
  return true;
}

/**
 * 删掉超过 days 天的任务。days <= 0 / 非数字 = 一直保留。
 * @param {(job:object)=>boolean} isBusy 进行中的任务返回 true（跳过）
 * @param {(id:string)=>void} [forget] 删掉后通知模块清内存缓存
 * @returns {number} 删除的任务数
 */
export function purgeOlderThan(root, days, isBusy, forget) {
  if (!(days > 0)) return 0;
  const cutoff = Date.now() - days * 86400_000;
  let removed = 0;
  let dayDirs;
  try { dayDirs = readdirSync(root).filter((d) => DAY_RE.test(d)); } catch { return 0; }
  for (const d of dayDirs) {
    let ids;
    try { ids = readdirSync(join(root, d)).filter((x) => ID_RE.test(x)); } catch { continue; }
    for (const id of ids) {
      const dir = join(root, d, id);
      let job = null;
      try { job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')); } catch {}
      // 时间以 createdAt 为准；job.json 坏了就看目录修改时间
      let t = Date.parse(job?.createdAt || '');
      if (!Number.isFinite(t)) { try { t = statSync(dir).mtimeMs; } catch { continue; } }
      if (t >= cutoff) continue;
      if (job && isBusy(job)) continue;
      if (removeJobDir(root, { day: d, id })) { removed++; forget?.(id); }
    }
  }
  return removed;
}
