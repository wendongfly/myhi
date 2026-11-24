# 更新日志 / Changelog

最新版本在上。This project follows the npm package versions of `@wendongfly/myhi`.

## 1.3.230 — 安全更新 / Security update

- **依赖漏洞修复**：升级 express 4.22.3、socket.io / socket.io-client 4.8.4、multer 2.5.0 及其间接依赖（engine.io、ws、socket.io-parser、body-parser、proxy-addr、qs、node-forge），`npm audit` 0 个漏洞。其中最要紧的是 Socket.IO 底层**无需登录**即可触发的拒绝服务；这些包虽列在 devDependencies，但会被打包进 `dist/` 随 npm 包发布，**建议所有用户升级**。
- **错误信息不再泄露服务器路径**：畸形或超大的请求体以前会返回带完整堆栈和服务器绝对路径的错误页，现在只返回简短说明，细节写服务端日志。

Dependency security fixes (Socket.IO / express / multer and transitive deps, including an unauthenticated Socket.IO denial of service) and no more stack traces in error responses. All users should upgrade.

（1.3.229 为内部构建调整，内容已包含在 1.3.228 的公开版本中。）

## 1.3.228 — 首次开源 / First public release

myhi 此前在内部使用和迭代，这是第一个公开版本。主要功能：

- **终端共享**：xterm.js 全功能终端 + 聊天式界面，多设备同时观看，一台设备独占输入，可接管 / 释放控制权。
- **Claude Code 集成**：网页 / 手机上和 AI 对话干活，审批方案和文件改动，插话、草稿排队自动接力，死循环熔断；可经兼容 Anthropic API 的网关使用其它模型，并按场景（主任务 / 计划 / 子代理 / 问一问 / 看图…）选模型。
- **敏感信息三层防护**：密钥以环境变量注入、输出兜底脱敏；隐私护栏把对话框里的敏感实体可逆地假名化后再发给模型，映射表只留本机，审计可导出。
- **多用户**：admin / operator / viewer 三级角色、成员绑定工作目录、独占模式、SSH 开发账号；管理后台 `/admin`。
- **工作台**：电脑端任务栏 + 分屏、文件面板（预览 / 编辑 / 上传 / 打包下载）、Git 一键提交推送、项目记忆管理、技能（命令）管理与分享、任务迁移打包。
- **可选功能**：出图（云端出图 + 文字比对 + 看图复核）、会议纪要（转写 + 区分发言人，按要求多次整理、按版本保存；AMR 录音可在浏览器播放）。需要兼容的网关 / 语音服务，见 [docs/gateway-api.md](docs/gateway-api.md)。
- **部署**：`npm i -g @wendongfly/myhi`；Windows / Linux 一键安装器，系统服务（开机自启），网页一键升级。

安全相关说明见 [SECURITY.md](SECURITY.md)。
