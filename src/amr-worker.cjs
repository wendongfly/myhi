// 在 worker 线程里把 .amr（AMR-NB）录音转成浏览器能播的 WAV（8kHz 16bit 单声道）。
// 浏览器都不支持播 AMR；解码约 800 倍速（1 小时录音约 4 秒），放 worker 里不卡主线程。
// 由 src/minutes.js playableAudio() 拉起；构建时与 vendor/amrnb.cjs 一起拷进 dist/。
const { workerData, parentPort } = require('worker_threads');
const { readFileSync, writeFileSync, renameSync, rmSync } = require('fs');

const { src, dst } = workerData;
const tmp = dst + '.tmp';
try {
  const AMR = require('./vendor/amrnb.cjs');
  const wav = AMR.toWAV(new Uint8Array(readFileSync(src)));
  if (!wav || wav.length <= 44) throw new Error('不是 AMR-NB 格式（可能是 AMR-WB 宽带录音），暂时转不了');
  writeFileSync(tmp, Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength));
  renameSync(tmp, dst);
  parentPort.postMessage({ ok: true });
} catch (e) {
  try { rmSync(tmp, { force: true }); } catch {}
  parentPort.postMessage({ ok: false, error: e.message || String(e) });
}
