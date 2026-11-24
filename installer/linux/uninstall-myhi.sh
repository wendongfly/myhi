#!/usr/bin/env bash
# myhi Linux 卸载器：撤销 systemd 服务/自启（保留 myhi 本体与 ~/.myhi 数据）。
# 加 --purge 连全局包一起卸（数据仍在 ~/.myhi，要删自己 rm -rf）。
set -u

c_info=$'\033[36m'; c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_end=$'\033[0m'
[[ -t 1 ]] || { c_info=''; c_ok=''; c_warn=''; c_end=''; }
info() { printf '%s[myhi]%s %s\n' "$c_info" "$c_end" "$*"; }
ok()   { printf '%s[OK]%s  %s\n' "$c_ok" "$c_end" "$*"; }
warn() { printf '%s[!]%s   %s\n' "$c_warn" "$c_end" "$*"; }

[[ "$(uname -s)" == "Linux" ]] || { warn "本脚本仅支持 Linux"; exit 1; }
SUDO=""
if [[ "$(id -u)" != "0" ]]; then
  command -v sudo >/dev/null 2>&1 || { warn "需要 root 权限，且系统没有 sudo"; exit 1; }
  SUDO="sudo"
fi
as_root() { if [[ -n "$SUDO" ]]; then $SUDO "$@"; else "$@"; fi; }

MYHI_BIN="$(command -v myhi || true)"
if [[ -n "$MYHI_BIN" ]]; then
  as_root "$MYHI_BIN" service uninstall || true
else
  # myhi 已不在：手动清 systemd（幂等）
  as_root systemctl stop myhi.service >/dev/null 2>&1 || true
  as_root systemctl disable myhi.service >/dev/null 2>&1 || true
  as_root rm -f /etc/systemd/system/myhi.service
  as_root systemctl daemon-reload >/dev/null 2>&1 || true
  ok "已手动清理 systemd 服务"
fi

if [[ "${1:-}" == "--purge" ]]; then
  info "卸载全局包..."
  npm uninstall -g @wendongfly/myhi >/dev/null 2>&1 \
    || $SUDO npm uninstall -g @wendongfly/myhi >/dev/null 2>&1 || true
  npm uninstall -g @anthropic-ai/claude-code >/dev/null 2>&1 \
    || $SUDO npm uninstall -g @anthropic-ai/claude-code >/dev/null 2>&1 || true
  ok "全局包已卸载"
fi

ok "卸载完成（~/.myhi 数据保留：会话/配置/密钥；要全删请手动 rm -rf ~/.myhi）"
