# myhi 语音服务（SenseVoice 语音输入 + 会议录音转写区分发言人）
#
# 接口（myhi 约定）：
#   POST /transcribe            语音输入（几秒~几分钟）：multipart 字段 audio → {"text": "..."}       ← 原接口，不变
#   POST /meeting/jobs          会议录音（可到 2~3 小时）：multipart 字段 audio → {"id": "..."}       ← 异步任务
#   GET  /meeting/jobs/{id}     查进度 / 取结果：
#        {"status": "queued|running|done|error", "progress": 0~1, "error": "...",
#         "result": {"duration": 秒, "segments": [{"start": 秒, "end": 秒, "speaker": 0, "text": "..."}]}}
#   GET  /health
#
# 模型：语音输入用 SenseVoiceSmall（快、带标点）；会议用 FunASR 会议流水线
#   paraformer-zh（中文识别 + 时间戳）+ fsmn-vad（按停顿切段）+ ct-punc（标点）+ cam++（说话人聚类）
#   —— SenseVoice 不出逐字时间戳，接不了说话人识别，所以会议另用 paraformer。会议模型第一次有任务时才加载。
#
# 依赖：pip install funasr modelscope torch torchaudio fastapi uvicorn python-multipart
#       系统要有 ffmpeg（解码浏览器录音 webm/mp4、录音笔 mp3/m4a 等）：mac 用 brew install ffmpeg，Linux 用 apt install ffmpeg
# 启动：uvicorn sensevoice_server:app --host 0.0.0.0 --port 8765 --workers 1
#       （必须单进程：会议任务存在内存里，多进程查不到）
import os, subprocess, tempfile, threading, queue, time, uuid
import torch
from fastapi import FastAPI, UploadFile, File
from funasr import AutoModel
from funasr.utils.postprocess_utils import rich_transcription_postprocess

DEVICE = os.environ.get("ASR_DEVICE", "cpu")          # 和看图模型共用一台机器时用 cpu，不抢 GPU
torch.set_num_threads(int(os.environ.get("ASR_THREADS", "4")))
KEEP_SECONDS = 24 * 3600                              # 会议结果保留 24 小时

app = FastAPI()

# ── 语音输入（原接口）────────────────────────────────────────────────────────
voice = AutoModel(model="iic/SenseVoiceSmall", vad_model="fsmn-vad",
                  vad_kwargs={"max_single_segment_time": 30000}, device=DEVICE, disable_update=True)

def to_wav(src, wav):
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-ar", "16000", "-ac", "1", wav], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("音频解码失败：" + r.stderr.decode(errors="ignore")[:200])

@app.get("/health")
def health():
    return {"ok": True, "voice": "SenseVoiceSmall", "meeting": "paraformer-zh+cam++", "device": DEVICE,
            "meeting_queue": _q.qsize()}

@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    data = await audio.read()
    if not data:
        return {"text": "", "error": "空音频"}
    suffix = os.path.splitext(audio.filename or "")[1] or ".webm"
    with tempfile.TemporaryDirectory() as d:
        src, wav = os.path.join(d, "in" + suffix), os.path.join(d, "in.wav")
        open(src, "wb").write(data)
        try:
            to_wav(src, wav)
        except RuntimeError as e:
            return {"text": "", "error": str(e)}
        res = voice.generate(input=wav, language="zh", use_itn=True, batch_size_s=60, merge_vad=True, merge_length_s=15)
    return {"text": "".join(rich_transcription_postprocess(x["text"]) for x in res).strip()}

# ── 会议录音（异步任务，一次跑一个，排队）──────────────────────────────────────
_meeting = None
_jobs = {}
_q = queue.Queue()
_lock = threading.Lock()

def meeting_model():
    global _meeting
    if _meeting is None:
        _meeting = AutoModel(model="paraformer-zh", vad_model="fsmn-vad", punc_model="ct-punc", spk_model="cam++",
                             device=DEVICE, disable_update=True)
    return _meeting

def worker():
    while True:
        jid = _q.get()
        job = _jobs.get(jid)
        if not job:
            continue
        job["status"], job["progress"] = "running", 0.05
        try:
            wav = job["dir"] + "/in.wav"
            to_wav(job["src"], wav)
            dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav],
                                       capture_output=True, text=True).stdout.strip() or 0)
            job["progress"] = 0.15
            res = meeting_model().generate(input=wav, batch_size_s=300)
            segs = []
            for s in (res[0].get("sentence_info") or []):
                text = (s.get("text") or "").strip()
                if text:
                    segs.append({"start": round(s["start"] / 1000, 2), "end": round(s["end"] / 1000, 2),
                                 "speaker": int(s.get("spk", 0)), "text": text})
            if not segs and res and res[0].get("text"):   # 没有分句信息时兜底：整段一条
                segs = [{"start": 0, "end": dur, "speaker": 0, "text": res[0]["text"]}]
            job["result"] = {"duration": dur, "segments": segs}
            job["status"], job["progress"] = "done", 1
        except Exception as e:
            job["status"], job["error"] = "error", str(e)[:500]
        finally:
            for f in ("src", ):
                try: os.remove(job[f])
                except Exception: pass
            job["done_at"] = time.time()

threading.Thread(target=worker, daemon=True).start()

@app.post("/meeting/jobs")
async def meeting_submit(audio: UploadFile = File(...)):
    jid = uuid.uuid4().hex[:12]
    d = tempfile.mkdtemp(prefix="meeting-")
    src = os.path.join(d, "in" + (os.path.splitext(audio.filename or "")[1] or ".m4a"))
    with open(src, "wb") as f:                          # 大文件分块写，不整个读进内存
        while chunk := await audio.read(1 << 20):
            f.write(chunk)
    with _lock:   # 清掉过期结果
        for k in [k for k, j in _jobs.items() if j.get("done_at") and time.time() - j["done_at"] > KEEP_SECONDS]:
            _jobs.pop(k, None)
        _jobs[jid] = {"status": "queued", "progress": 0, "dir": d, "src": src, "created": time.time()}
    _q.put(jid)
    return {"id": jid, "position": _q.qsize()}

@app.get("/meeting/jobs/{jid}")
def meeting_status(jid: str):
    job = _jobs.get(jid)
    if not job:
        return {"status": "error", "error": "任务不存在或已过期"}
    out = {"status": job["status"], "progress": job.get("progress", 0)}
    if job["status"] == "done":
        out["result"] = job["result"]
    if job["status"] == "error":
        out["error"] = job.get("error")
    return out
