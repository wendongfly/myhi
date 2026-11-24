# 安全说明 / Security Policy

## 报告漏洞 / Reporting a vulnerability

请**不要**在公开的 issue 里报告安全漏洞。请使用 GitHub 仓库的 **Security → Report a vulnerability**（私密漏洞报告），写清楚受影响的版本、复现步骤和影响。我们会尽快确认，修复后发布新版本，并在 CHANGELOG 中致谢（如你愿意）。

Please do **not** open public issues for security problems. Use GitHub's private vulnerability reporting (**Security → Report a vulnerability**) on this repository, with the affected version, reproduction steps and impact.

只有最新的发布版本会收到安全修复。

## 威胁模型 / Threat model

myhi 的定位是**自托管、在可信网络内使用**的工具：它能在服务器上执行任意命令，Claude Code 也默认以 `bypassPermissions` 模式运行（无人值守时不能停下来等审批）。请据此评估风险。

**设计上的前提**

- **只在局域网 / Tailscale 等可信网络内使用，不要直接暴露到公网。** 如果一定要公网访问，请放在带认证的反向代理或 VPN 后面。
- 任何能登录、且拥有 operator 及以上角色的人，**等同于运行 myhi 的那个系统用户**：可以执行命令、读写该用户能访问的所有文件。
- **多用户模式是协作分区，不是安全隔离。** 所有成员的终端和 AI 任务都以同一个系统用户运行。myhi 在应用层限制了成员互相访问任务、记忆和历史，但成员的 AI 或终端仍能读到该系统用户名下的任何文件（包括其他成员的项目和 `~/.myhi` 下的配置）。需要真正隔离时，请给每个人单独的系统用户、虚拟机或容器，各跑一份 myhi。
- viewer（只读）角色只能旁观，不能执行写操作。

**部署建议**

- 首次启动会生成一个 4 位数字的管理密码（`~/.myhi/password`），并有登录限速；**请立即改成足够长的随机密码**。
- 默认使用自签名证书的 HTTPS。手机上使用麦克风 / 摄像头需要 HTTPS。
- `~/.myhi/token` 是永久访问令牌，二维码链接会带上它，请像密码一样保管。
- 文件预览链接（`/view/<token>`）在有效期内可以只读访问该任务的工作目录，不要转发给他人。
- `sudo myhi service install`（Linux）只会给服务用户放行 `systemctl restart|stop myhi.service`。网关 Key、代理等环境变量写在只有 root 可读的 `/etc/myhi/myhi.env`。

**隐私护栏（Layer C）的边界**

隐私护栏只保护**用户在对话框里提交的内容**：发给模型前把敏感实体替换成占位符，回来再还原，映射表只存在本机。AI 用 Read / Bash 等工具直接读取磁盘文件时，文件内容在 Claude Code 进程内直接发给模型，myhi 拦不到。需要保护的数据请贴进对话框，不要让 AI 去读原始文件。
