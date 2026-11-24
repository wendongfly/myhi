# 大模型网关 / 语音服务接口约定

myhi 的核心功能（任务、聊天、问一问）只需要 **Claude Code CLI**：直连 Anthropic，或者经任何兼容 Anthropic Messages API 的网关（`ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`）。

下面这些是**可选功能**用到的接口。没有对应服务时，相关功能会自动降级或在页面上提示，不影响其它功能。

| 功能 | 需要 | 没有时 |
|---|---|---|
| 设置里按场景选模型、显示积分 | 网关 `GET /v1/models` | 不提供模型选择，全部用 Claude Code 默认模型 |
| 看图（图片先转文字） | 网关上一个能看图的模型 | 图片原样发给主模型 |
| 出图（`/studio`） | 网关 `POST /v1/images/generations`（或能返回图片 URL 的对话模型） | 出图页提示先配网关 |
| 出图文字质检 | 网关 `POST /v1/ocr` | 跳过 OCR，只用看图模型复核 |
| 语音输入、会议纪要（`/minutes`） | 语音服务 `POST /transcribe` | 语音入口提示先配语音服务 |

网关请求统一带 `x-api-key: <key>` 和 `Authorization: Bearer <key>`。

---

## 1. 模型目录 `GET /v1/models?scope=token`

返回 OpenAI 风格的列表。myhi 只读取下面这些字段，都可选：

```json
{
  "scope": "token",
  "data": [
    {
      "id": "some-model",
      "display_name": "Some Model",
      "kind": "model",
      "target": "",
      "capabilities": ["function_calling", "vision", "image_generation"],
      "protocols": ["anthropic", "openai"],
      "tags": ["cheap"],
      "price_multiplier": 1.0,
      "image": {
        "sizes": ["1024x1024"],
        "aspect_ratios": ["1:1", "16:9"],
        "max_n": 4,
        "prompt_max_chars": 1000,
        "reference_image": false
      },
      "per_call_price": { "cny": 0.1, "credits": 10 }
    }
  ],
  "token": { "daily_credit_limit": 5000, "daily_credits_used": 0, "monthly_credit_limit": null, "monthly_credits_used": null }
}
```

- `scope: "token"` 表示列表已按当前 key 过滤。
- `capabilities` 用于判断模型适合哪个场景：主任务 / 子代理需要 `function_calling`，看图需要 `vision`，出图需要 `image_generation`。
- `protocols` 不含 `anthropic` 的模型不能作为 Claude Code 的主模型；myhi 调它时走 `/v1/chat/completions`。

## 2. 出图 `POST /v1/images/generations`

兼容 OpenAI 图片接口：

```json
{ "model": "some-image-model", "prompt": "…", "n": 1, "response_format": "b64_json",
  "size": "1024x1024", "aspect_ratio": "1:1", "user": "myhi:<用户名>",
  "image": "data:image/png;base64,…", "extra": {} }
```

- `size` 和 `aspect_ratio` 二选一；`image` 是参考图，只发给目录里标了 `reference_image: true` 的模型。
- 响应：`{ "data": [{ "b64_json": "…", "mime_type": "image/png" }], "usage": { "credits": 10 } }`。也可以返回 `url`。
- 失败：`{ "failed": [{ "code": "content_policy_violation", "message": "…" }] }`，或者 HTTP 4xx/5xx 带 `error.code`。429 会按 `Retry-After` 退避重试。

网关没有这个接口（404/405）时，myhi 改用 `/v1/chat/completions` 调出图模型，从回复里取图片 URL 或 `b64_json`。

## 3. OCR `POST /v1/ocr`（可选）

请求 `{ "image": "data:image/png;base64,…" }`，响应以下任一格式：

```json
{ "text": "全部文字", "lines": [{ "text": "一行", "confidence": 0.98 }] }
{ "full_text": "全部文字", "lines": [{ "text": "一行", "score": 0.98, "box": [] }] }
```

## 4. 语音服务 `POST /transcribe`

地址在 `/admin` › 全局设置 › 语音识别地址，或环境变量 `ASR_URL`。

`multipart/form-data` 请求，字段如下：

- `audio`：音频文件；
- `diarize`：`true` 时区分发言人，可选；
- `spk_num`：发言人数，可选。

响应：

```json
{ "text": "整段文字",
  "segments": [{ "text": "一句话", "start": 0, "end": 3200, "spk": 0 }] }
```

- `start` / `end` 的单位是**毫秒**，`spk` 是发言人编号。
- 不支持区分发言人的服务只返回 `text` 即可。

示例实现见 [`docs/asr/sensevoice_server.py`](asr/sensevoice_server.py)（FunASR / SenseVoice；模型有各自的许可证，部署前请自行确认）。

可选的异步会议接口 `POST /meeting/jobs` + `GET /meeting/jobs/:id`：适合长录音。不提供时（返回 404）自动改用 `/transcribe`。
