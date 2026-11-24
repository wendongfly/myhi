#!/usr/bin/env bash
# myhi Linux 一键安装器（对应 Windows 的 install-myhi.ps1）
# 作用：装成 systemd 服务（开机自启、以当前用户身份运行），一条命令完成：
#   1) 检测/安装 Node ≥18（apt/dnf 优先 NodeSource，退回发行版源；Alpine/Arch 直装）；
#   2) 停掉可能在跑的 myhi（升级路径，顺手释放文件）；
#   3) npm 装/更新 myhi（--allow-scripts 放行 node-pty 原生模块）；
#   4) 装 Claude CLI（myhi 的 AI 引擎）并校验，坏了自动补装平台原生二进制包；
#   5) 若本目录随附 gateway.json（管理员预置），部署到 ~/.myhi/，AI 开箱即用；
#   6) sudo myhi service install 注册 systemd 服务（sudoers 自动配好网页端自升级）；
#   7) 防火墙放行端口（ufw/firewalld，仅在活跃时动）；
#   8) 打印访问地址与首次密码位置。
# 用法：普通用户运行（需要 sudo 权限）：bash install-myhi.sh
#   环境变量：MYHI_VERSION=1.3.213 指定版本（默认 latest）；PORT=13000 换端口；SKIP_CLAUDE=1 跳过 Claude CLI。
# 幂等：重复运行 = 升级（先停服务再 npm i -g 再拉起）。
set -u

MYHI_PKG="@wendongfly/myhi@${MYHI_VERSION:-latest}"
PORT="${PORT:-12300}"
SKIP_CLAUDE="${SKIP_CLAUDE:-0}"

c_info=$'\033[36m'; c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_end=$'\033[0m'
[[ -t 1 ]] || { c_info=''; c_ok=''; c_warn=''; c_end=''; }
info() { printf '%s[myhi]%s %s\n' "$c_info" "$c_end" "$*"; }
ok()   { printf '%s[OK]%s  %s\n' "$c_ok" "$c_end" "$*"; }
warn() { printf '%s[!]%s   %s\n' "$c_warn" "$c_end" "$*"; }
die()  { warn "安装失败：$*"; exit 1; }

# ---------- 0) 环境：Linux / sudo / 真实用户 ----------
[[ "$(uname -s)" == "Linux" ]] || die "本安装器仅支持 Linux（Windows 请用 installer/ 里的 .bat）"
REAL_USER="${SUDO_USER:-$(id -un)}"
REAL_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6 || true)"
[[ -n "$REAL_HOME" ]] || REAL_HOME="/home/$REAL_USER"
SUDO=""
if [[ "$(id -u)" != "0" ]]; then
  command -v sudo >/dev/null 2>&1 || die "需要 root 权限，且系统没有 sudo——请用 root 运行"
  SUDO="sudo"
fi
as_root() { if [[ -n "$SUDO" ]]; then $SUDO "$@"; else "$@"; fi; }

# ---------- 1) Node ≥ 18 ----------
node_major() { node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' | grep -E '^[0-9]+$' || echo 0; }
fetch() { # fetch <url> —— curl/wget 自动选择
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1";
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1";
  else echo ""; fi
}
ensure_node() {
  if command -v node >/dev/null 2>&1; then return 0; fi
  warn "未检测到 Node.js，尝试自动安装（apt/dnf 优先 NodeSource 22.x，退回发行版源）..."
  if command -v apt-get >/dev/null 2>&1; then
    fetch https://deb.nodesource.com/setup_22.x | as_root bash - >/dev/null 2>&1 \
      && as_root apt-get install -y nodejs >/dev/null 2>&1
    if ! command -v node >/dev/null 2>&1; then
      as_root apt-get update -qq >/dev/null 2>&1
      as_root apt-get install -y nodejs npm >/dev/null 2>&1 || true
    fi
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    local pm; command -v dnf >/dev/null 2>&1 && pm=dnf || pm=yum
    fetch https://rpm.nodesource.com/setup_22.x | as_root bash - >/dev/null 2>&1 \
      && as_root "$pm" install -y nodejs >/dev/null 2>&1
    command -v node >/dev/null 2>&1 || as_root "$pm" install -y nodejs npm >/dev/null 2>&1 || true
  elif command -v apk >/dev/null 2>&1; then
    as_root apk add --no-cache nodejs npm >/dev/null 2>&1 || true
  elif command -v pacman >/dev/null 2>&1; then
    as_root pacman -S --noconfirm nodejs npm >/dev/null 2>&1 || true
  fi
  command -v node >/dev/null 2>&1 \
    || die "无法自动安装 Node.js。请手动装 Node 18+（https://nodejs.org 或发行版源）后重跑本脚本"
}
ensure_node
[[ "$(node_major)" -ge 18 ]] || die "Node 版本太旧（$(node -v)，需 ≥18）。请升级后重跑"
ok "Node: $(node -v)  ($(command -v node))"

# ---------- 2) 停掉可能在跑的 myhi（升级路径）----------
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^myhi\.service'; then
  info "停止正在运行的 myhi 服务..."
  as_root systemctl stop myhi.service >/dev/null 2>&1 || true
fi
DAEMON_PID_FILE="$REAL_HOME/.myhi/daemon.pid"
if [[ -f "$DAEMON_PID_FILE" ]]; then
  DPID="$(tr -dc '0-9' < "$DAEMON_PID_FILE")"
  if [[ -n "$DPID" ]] && kill -0 "$DPID" 2>/dev/null; then
    info "停掉手动启动的 daemon (PID $DPID)..."
    kill "$DPID" 2>/dev/null || true; sleep 2
    kill -0 "$DPID" 2>/dev/null && kill -9 "$DPID" 2>/dev/null || true
  fi
fi

# ---------- 3) npm 装/更新 myhi ----------
# 先按当前用户装（nvm/用户级 prefix 直接成功）；失败（系统级 prefix 无写权限）再用 sudo 重试。
# --allow-scripts：新版 npm 默认拦「包安装脚本」，node-pty 靠它放置原生 pty.node（终端核心）；
# 老版本 npm 不认此值只当普通 config、脚本本就默认执行，两种 npm 都 OK。
npmi() { # $1=包名
  npm install -g "$1" --allow-scripts=@wendongfly/myhi,node-pty 2>&1 \
    || npm install -g "$1" 2>&1
}
info "安装/更新 myhi（npm i -g $MYHI_PKG，稍候）..."
if ! npmi "$MYHI_PKG"; then
  if [[ -z "$SUDO" ]]; then die "npm 安装失败"; fi
  warn "普通用户安装失败（多半是系统级 prefix 无写权限），改用 sudo 重试..."
  $SUDO npm install -g "$MYHI_PKG" --allow-scripts=@wendongfly/myhi,node-pty 2>&1 \
    || $SUDO npm install -g "$MYHI_PKG" 2>&1 \
    || die "npm 安装失败"
fi

# ---------- 3b) Claude CLI（myhi 的 AI 引擎）----------
claude_ver() { claude --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true; }
if [[ "$SKIP_CLAUDE" != "1" ]]; then
  info "安装/更新 Claude CLI（npm i -g @anthropic-ai/claude-code@latest，稍候）..."
  if ! npmi "@anthropic-ai/claude-code@latest"; then
    if [[ -n "$SUDO" ]]; then $SUDO npm install -g "@anthropic-ai/claude-code@latest" >/dev/null 2>&1 || true; fi
  fi
  # 校验 claude 真能跑：claude-code 2.x 是平台原生二进制，其平台包(optionalDependencies，
  # 如 @anthropic-ai/claude-code-linux-x64)可能在安装时【静默失败】没装上 → bin/claude 只剩
  # 500B 报错占位 → 用时才发现坏。故装完立即验证，坏了【自动补装对应平台包】自愈。
  CV="$(claude_ver)"
  if [[ -z "$CV" ]]; then
    warn "Claude 原生二进制缺失（平台包静默失败），补装平台包..."
    NPM_ROOT="$(npm root -g 2>/dev/null)"
    CC_PKG_JSON="$NPM_ROOT/@anthropic-ai/claude-code/package.json"
    if [[ -f "$CC_PKG_JSON" ]]; then
      PLATFORM_PKG="$(node -e '
        const os = require("os"), fs = require("fs"), cp = require("child_process");
        const arch = { x64: "x64", arm64: "arm64" }[os.arch()] || os.arch();
        let ldd = "";
        try { ldd = cp.execSync("ldd --version 2>&1 || true", { encoding: "utf8" }); } catch (e) { ldd = "" + (e.stdout || ""); }
        const musl = ldd.includes("musl") || fs.existsSync("/etc/alpine-release");
        const deps = require(process.argv[1]).optionalDependencies || {};
        const names = Object.keys(deps);
        const pick = (musl && names.find(n => n.includes("-musl-"))) || names.find(n => n.endsWith(os.platform() + "-" + arch)) || "";
        console.log(pick);
      ' "$CC_PKG_JSON" 2>/dev/null || true)"
      CC_VER="$(node -p "require(process.argv[1]).version" "$CC_PKG_JSON" 2>/dev/null || echo latest)"
      if [[ -n "$PLATFORM_PKG" ]]; then
        info "补装 $PLATFORM_PKG@$CC_VER ..."
        npm install -g "$PLATFORM_PKG@$CC_VER" 2>&1 >/dev/null \
          || { [[ -n "$SUDO" ]] && $SUDO npm install -g "$PLATFORM_PKG@$CC_VER" >/dev/null 2>&1; } \
          || true
        CV="$(claude_ver)"
      else
        warn "未能从 optionalDependencies 里定位平台包，请手动补装（claude --version 验证）"
      fi
    fi
  fi
  # 不因 claude 装失败而中断整体部署（可事后手动补）
  if [[ -n "$CV" ]]; then ok "Claude CLI 可用：v$CV"; else warn "Claude CLI 仍不可用，请事后排查：claude --version"; fi
fi

# ---------- 4) 定位 myhi 可执行文件 ----------
MYHI_BIN="$(command -v myhi || true)"
[[ -n "$MYHI_BIN" ]] || MYHI_BIN="/usr/local/bin/myhi"
[[ -x "$MYHI_BIN" ]] || die "未找到 myhi 可执行文件（$MYHI_BIN）"
ok "myhi: $("$MYHI_BIN" -v 2>/dev/null || echo "$MYHI_BIN")  ($MYHI_BIN)"

# ---------- 5) AI 网关配置（批量部署预置）----------
# gateway.json 含密钥：只在部署包/本机之间流转，绝不进 git（见 README）。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/gateway.json" ]]; then
  if [[ "$(id -u)" == "0" ]]; then
    install -d -o "$REAL_USER" -m 700 "$REAL_HOME/.myhi" 2>/dev/null || mkdir -p "$REAL_HOME/.myhi"
    cp "$SCRIPT_DIR/gateway.json" "$REAL_HOME/.myhi/gateway.json"
    chown "$REAL_USER" "$REAL_HOME/.myhi/gateway.json" 2>/dev/null || true
  else
    mkdir -p "$REAL_HOME/.myhi"
    cp "$SCRIPT_DIR/gateway.json" "$REAL_HOME/.myhi/gateway.json"
  fi
  chmod 600 "$REAL_HOME/.myhi/gateway.json" 2>/dev/null || true
  ok "已部署 AI 网关配置（gateway.json → $REAL_HOME/.myhi/，AI 开箱即用）"
else
  warn "未随附 gateway.json：AI 需在 $REAL_HOME/.myhi/gateway.json 填 {\"baseUrl\":...,\"apiKey\":...}（或网页里配）才能用"
fi

# ---------- 6) systemd 服务（开机自启，以真实用户身份运行）----------
# myhi service install 用 SUDO_USER 定服务用户；PORT 透传写进 unit。
if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  info "注册 systemd 服务（myhi.service，开机自启）..."
  if [[ -n "$SUDO" ]]; then $SUDO env PORT="$PORT" "$MYHI_BIN" service install;
  else env PORT="$PORT" "$MYHI_BIN" service install; fi
  if [[ $? -eq 0 ]]; then
    ok "服务已启动并设为开机自启（systemctl status myhi / journalctl -u myhi -f）"
  else
    warn "myhi service install 未成功，尝试直接拉起..."
    as_root "$MYHI_BIN" -d >/dev/null 2>&1 || true
  fi
else
  # 容器 / 无 systemd 环境：以真实用户身份后台拉起，无开机自启（局限，如实告知）
  warn "本机无 systemd：只后台启动，不设开机自启（容器环境通常也没关系）"
  if [[ "$(id -u)" == "0" && "$REAL_USER" != "root" ]]; then
    command -v runuser >/dev/null 2>&1 && runuser -u "$REAL_USER" -- "$MYHI_BIN" -d >/dev/null 2>&1 &
  else
    "$MYHI_BIN" -d >/dev/null 2>&1 &
  fi
fi

# ---------- 7) 防火墙 best-effort（仅在活跃时动，端口 = PORT 与 PORT+1）----------
P2="$((PORT + 1))"
if command -v ufw >/dev/null 2>&1; then
  if $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
    $SUDO ufw allow "$PORT/tcp" >/dev/null 2>&1 && $SUDO ufw allow "$P2/tcp" >/dev/null 2>&1 \
      && ok "ufw 已放行 $PORT/$P2（局域网手机/平板可访问）"
  fi
elif command -v firewall-cmd >/dev/null 2>&1; then
  if $SUDO firewall-cmd --state >/dev/null 2>&1; then
    $SUDO firewall-cmd --permanent --add-port="$PORT/tcp" --add-port="$P2/tcp" >/dev/null 2>&1 \
      && $SUDO firewall-cmd --reload >/dev/null 2>&1 \
      && ok "firewalld 已放行 $PORT/$P2（局域网手机/平板可访问）"
  fi
fi

# ---------- 8) 收尾 ----------
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[[ -n "$LAN_IP" ]] && URL="https://$LAN_IP:$PORT" || URL="https://localhost:$PORT"
echo ""
info "访问地址：$URL   （首次有自签证书警告，浏览器点『高级 → 继续前往』）"
info "首次密码见：$REAL_HOME/.myhi/password"
info "升级：网页点「更新」横幅，或重跑本脚本（幂等 = 干净升级）"
ok  "安装完成！"
