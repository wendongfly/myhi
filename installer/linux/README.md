# myhi Linux 一键安装（让员工省心）

给普通员工/服务器用的一键安装：**拷过去跑一条命令，装好后 systemd 开机自启、以当前用户身份后台运行**。

## 怎么用

1. 把整个文件夹（或压缩包解压后的文件夹）拷到 Linux 机器，例如：

   ```
   scp -r myhi-linux-installer/ user@目标机:~/
   ```

2. 在目标机上运行（**普通用户**即可，需要 sudo 权限）：

   ```
   bash ~/myhi-linux-installer/install-myhi.sh
   ```

   脚本会自动：没装 Node 就装 Node ≥18 → 装/更新 myhi 与 Claude CLI（坏了自动补平台二进制）→ 部署随附的网关配置 → 注册 systemd 服务（开机自启、网页端可自升级）→ 放行防火墙 → 打印访问地址。
3. 浏览器打开打印的地址（如 `https://192.168.x.x:12300`，首次有自签证书警告，点「高级 → 继续前往」）。**首次登录密码见 `~/.myhi/password`**。
4. 手机/平板在同一局域网直接访问同一地址。

可调参数（环境变量）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `MYHI_VERSION` | `latest` | 指定版本，如 `MYHI_VERSION=1.3.213 bash install-myhi.sh` |
| `PORT` | `12300` | 换端口，服务与防火墙一起跟着变 |
| `SKIP_CLAUDE` | `0` | `SKIP_CLAUDE=1` 跳过 Claude CLI 安装 |

## 批量部署（一次配好、台台开箱即用）

安装器已经把依赖一起装了：Node（缺则装）+ Claude CLI + myhi。要让新机**连 AI 都免配**，管理员只需：

1. 把 `gateway.json.example` 复制成 **`gateway.json`**（与 install-myhi.sh 同目录），填入你的 AI 网关 `baseUrl` 和 `apiKey`。
2. 把整个文件夹打包发到各机，逐台跑 `bash install-myhi.sh` → 自动装好 node/claude/myhi + 把 gateway.json 部署到 `~/.myhi/` → AI 直接能用。

> 🔒 `gateway.json` 含密钥，**绝不进 git**，只在你的部署包/各机本地之间流转。不预置也行——各机装完在网页里配或手填 `~/.myhi/gateway.json`。

## 升级怎么做

- **网页点「更新」**（最省事）：仪表盘有新版会显示横幅，点一下自动升级并重启。安装时已自动配好 sudoers 免密（`/etc/sudoers.d/myhi-<用户>`），普通用户身份即可完成。
- **重跑安装器**（最可靠）：再执行一次 `bash install-myhi.sh`，幂等——先停服务释放文件 → `npm i -g @latest` → 重新拉起。

运维批量升级：各机 `npm i -g @wendongfly/myhi@latest` 后 `sudo systemctl restart myhi`。

## 服务管理（systemd）

```
systemctl status myhi        # 状态
journalctl -u myhi -f        # 日志
sudo systemctl stop myhi     # 停止 / restart 重启
sudo myhi service uninstall  # 撤销服务（保留程序与数据）
```

服务以**安装时的真实用户**身份运行（`sudo` 安装时通过 SUDO_USER 识别），myhi 里开的终端就是普通用户权限，不开 root 后门。

## 卸载

```
bash uninstall-myhi.sh            # 撤销 systemd 服务/自启（保留 myhi 本体与 ~/.myhi 数据）
bash uninstall-myhi.sh --purge    # 连全局包一起卸（数据仍在 ~/.myhi，要删自己 rm -rf）
```

## 局限（如实说明）

- 需要机器能访问 npm（装/升级）。纯内网机请先配 npm 镜像（`npm config set registry`）。
- Node 自动安装优先走 NodeSource 源（deb.nodesource.com / rpm.nodesource.com），不可达时退回发行版源；发行版源 Node 太旧（<18）会明确报错，需手动装 Node 18+。
- **本安装器尚未在真实 Linux 机器上端到端实测**（Windows 版实测过）。首次在目标机上使用时留意输出；有问题把终端输出反馈给管理员。
- 容器/无 systemd 环境：退化为后台直接启动，无开机自启。
