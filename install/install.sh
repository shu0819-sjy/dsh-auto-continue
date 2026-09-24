#!/usr/bin/env bash
# 安装 auto-continue + anti-repetition 到本机 DSH 数据目录（macOS / Linux）。
# 用法：
#   ./install/install.sh
#   ./install/install.sh /path/to/dsh/data
# 数据目录探测：$1 → $DSH_HOME → ~/.dsh/data（尽力而为；Windows 请用 install.ps1）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGINS_SRC="$REPO_ROOT/plugins"
SNIPPET_PATH="$REPO_ROOT/examples/cordis-patch.snippet.yml"

die() { echo "错误: $*" >&2; exit 1; }

resolve_data_dir() {
  local override="${1:-}"
  if [[ -n "$override" ]]; then
    [[ -d "$override" ]] || die "指定的数据目录不存在: $override"
    (cd "$override" && pwd)
    return
  fi
  local candidates=()
  [[ -n "${DSH_HOME:-}" ]] && candidates+=("$DSH_HOME")
  candidates+=("$HOME/.dsh/data")

  local c
  for c in "${candidates[@]}"; do
    if [[ -n "$c" && -d "$c" ]]; then
      (cd "$c" && pwd)
      return
    fi
  done
  cat >&2 <<EOF
未能定位 DSH 数据目录。请手动指定，例如：
  ./install/install.sh "\$HOME/.dsh/data"
探测顺序：环境变量 DSH_HOME → ~/.dsh/data
（Windows 请使用 install/install.ps1）
EOF
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}

DATA_DIR="$(resolve_data_dir "${1:-}")"
WEB_DIR="$DATA_DIR/profiles/web"
PLUGINS_DST="$WEB_DIR/plugins"
PATCH_PATH="$WEB_DIR/cordis.patch.yml"

echo "数据目录: $DATA_DIR"
echo "仓库根:   $REPO_ROOT"

[[ -d "$PLUGINS_SRC" ]] || die "找不到仓库 plugins/: $PLUGINS_SRC"
[[ -f "$SNIPPET_PATH" ]] || die "找不到 examples/cordis-patch.snippet.yml: $SNIPPET_PATH"

# 1) 确保插件目录
mkdir -p "$PLUGINS_DST"

# 2) 复制插件并校验
shopt -s nullglob
mjs_files=("$PLUGINS_SRC"/*.mjs)
((${#mjs_files[@]} > 0)) || die "仓库 plugins/ 下没有 .mjs 文件"

for src in "${mjs_files[@]}"; do
  name="$(basename "$src")"
  dst="$PLUGINS_DST/$name"
  cp -f "$src" "$dst"
  src_hash="$(sha256_file "$src")"
  dst_hash="$(sha256_file "$dst")"
  [[ "$src_hash" == "$dst_hash" ]] || die "复制校验失败: $name SHA256 不一致"
  echo "已复制 plugins/$name  (SHA256=$src_hash)"
done

# 3) 处理 cordis.patch.yml（幂等：已有 id: auto-continue 则跳过）
if [[ ! -f "$PATCH_PATH" ]]; then
  {
    printf '%s\n' "# profile patch layer — 由 dsh-auto-continue 安装脚本创建"
    printf '%s\n' "# 修改在 DSH 重启后生效。"
    printf '\n'
    cat "$SNIPPET_PATH"
    # 确保以换行结尾
    [[ "$(tail -c1 "$SNIPPET_PATH" | wc -l)" -gt 0 ]] || printf '\n'
  } > "$PATCH_PATH"
  echo "已创建 cordis.patch.yml 并写入 anti-repetition + auto-continue 挂载段"
else
  if grep -Eq '^[[:space:]]*-[[:space:]]*id:[[:space:]]*auto-continue[[:space:]]*$' "$PATCH_PATH"; then
    echo "cordis.patch.yml 已包含 id: auto-continue — 跳过挂载段追加（幂等）"
  else
    # 追加前确保原文件以换行结尾，不破坏已有内容
    if [[ -s "$PATCH_PATH" ]] && [[ "$(tail -c1 "$PATCH_PATH" | wc -l)" -eq 0 ]]; then
      printf '\n' >> "$PATCH_PATH"
    fi
    printf '\n' >> "$PATCH_PATH"
    cat "$SNIPPET_PATH" >> "$PATCH_PATH"
    [[ "$(tail -c1 "$PATCH_PATH" | wc -l)" -gt 0 ]] || printf '\n' >> "$PATCH_PATH"
    echo "已在 cordis.patch.yml 末尾追加 anti-repetition + auto-continue 挂载段"
  fi
fi

echo ""
echo "=== 安装完成 ==="
echo "重启 DSH 生效（托盘退出才算真重启）"
echo "验证方法："
echo "  1) node test/check.mjs          # 静态自检 11/11"
echo "  2) 重启后聊天发送长输出任务，失败/复读熔断时应自动出现来源 auto-continue 的「继续」"
echo "  3) 上游超时建议合并 examples/settings-retry.snippet.yml 到 settings.yaml"
