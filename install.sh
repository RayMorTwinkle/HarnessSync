#!/usr/bin/env bash
# HarnessSync 用户级安装器；支持 macOS 与 Linux（Bash 3.2+）。
set -euo pipefail

repo="${HSYNC_REPO:-https://github.com/RayMorTwinkle/HarnessSync.git}"
ref="${HSYNC_REF:-v0.5.0}"
install_dir="${HSYNC_INSTALL_DIR:-${HOME}/.local/share/harness-sync}"
bin_dir="${HSYNC_BIN_DIR:-${HOME}/.local/bin}"
stage=""
launcher_tmp=""
link_tmp=""
locked=0

usage() {
  cat <<'HELP'
HarnessSync 安装器

用法：bash install.sh [选项]
  --ref <tag或分支>       安装版本，默认 v0.5.0
  --install-dir <目录>    程序目录，默认 ~/.local/share/harness-sync
  --bin-dir <目录>        hsync 启动器目录，默认 ~/.local/bin
  --repo <Git地址>        源仓库，也可使用本地 Git 仓库进行验证
  -h, --help             查看帮助

环境变量：HSYNC_REF、HSYNC_INSTALL_DIR、HSYNC_BIN_DIR、HSYNC_REPO。
需要 Node.js 22.12+、npm、Git。无需 sudo，不修改 shell 配置。
仅安装程序，不扫描、不改写已有 Harness 配置，不自动启动后台服务。
HELP
}
die() { printf '安装失败：%s\n' "$*" >&2; exit 1; }
value() { [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 缺少参数"; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) value "$@"; ref="$2"; shift 2 ;;
    --install-dir) value "$@"; install_dir="$2"; shift 2 ;;
    --bin-dir) value "$@"; bin_dir="$2"; shift 2 ;;
    --repo) value "$@"; repo="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知选项：$1（使用 --help 查看帮助）" ;;
  esac
done

case "$(uname -s)" in Darwin|Linux) ;; *) die '仅支持 macOS、Linux；Windows 请使用 WSL。' ;; esac
for tool in node npm git; do command -v "$tool" >/dev/null 2>&1 || die "缺少 $tool，请先安装。"; done
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=12) ? 0 : 1)' || die '需要 Node.js 22.12 或更高版本。'
[ -n "$repo" ] && [ -n "$ref" ] || die '仓库与版本不能为空。'
case "$ref" in -*) die '版本不能以 - 开头。' ;; esac
install_dir="$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$install_dir")"
bin_dir="$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$bin_dir")"
case "$install_dir$bin_dir" in *$'\n'*|*$'\r'*) die '安装路径不能包含换行符。' ;; esac
launcher="$bin_dir/hsync"
marker="$install_dir/.harness-sync-install"
[ "$install_dir" != / ] && [ "$install_dir" != "$HOME" ] || die '程序目录不能是根目录或用户主目录。'
[ ! -L "$install_dir" ] && [ ! -L "$bin_dir" ] || die '程序目录和启动器目录不能是符号链接。'
if [ -e "$install_dir" ]; then
  [ -d "$install_dir" ] || die "程序路径不是目录：$install_dir"
  if [ -n "$(ls -A "$install_dir")" ]; then
    [ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(cat "$marker")" = 'HarnessSync installer v1' ] || die "目录已有其他内容，拒绝覆盖：$install_dir"
  fi
fi
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
  [ -f "$launcher" ] && [ ! -L "$launcher" ] && grep -qxF "# HarnessSync launcher: $install_dir" "$launcher" || die "已有其他 hsync 启动器，拒绝覆盖：$launcher；请另选 --bin-dir。"
fi
if [ -e "$install_dir/current" ] || [ -L "$install_dir/current" ]; then
  [ -L "$install_dir/current" ] || die 'current 不是安装器创建的版本链接。'
  case "$(readlink "$install_dir/current")" in releases/*) ;; *) die 'current 指向程序目录之外，拒绝替换。' ;; esac
fi

cleanup() {
  [ -z "$stage" ] || rm -rf -- "$stage"
  [ -z "$launcher_tmp" ] || rm -f -- "$launcher_tmp"
  [ -z "$link_tmp" ] || rm -f -- "$link_tmp"
  if [ "$locked" -eq 1 ]; then rmdir "$install_dir/.install-lock" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$install_dir" "$bin_dir"
mkdir "$install_dir/.install-lock" 2>/dev/null || die '已有安装过程或遗留安装锁；确认没有安装器运行后再处理 .install-lock。'
locked=1
printf '%s\n' 'HarnessSync installer v1' > "$marker"
mkdir -p "$install_dir/releases"
stage="$(mktemp -d "$install_dir/.staging.XXXXXX")"
printf '正在下载 %s（%s）…\n' "$repo" "$ref"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$ref" -- "$repo" "$stage"
printf '正在安装依赖并构建 CLI 与 GUI…\n'
(
  cd "$stage"
  npm ci --include=dev --no-audit --no-fund
  npm run build
  node dist/cli.js --version
  node dist/cli.js --help >/dev/null
  [ -f dist/ui/index.html ] || die '构建未生成 GUI。'
  [ -f harnesses/codex.json ] && [ -f schema/harness.schema.json ] || die '缺少 Harness 清单或 JSON Schema。'
)
commit="$(git -C "$stage" rev-parse HEAD)"
release="${commit}-$(date +%Y%m%d%H%M%S)-$$"
mv "$stage" "$install_dir/releases/$release"
stage=""
# printf %q 生成 Bash 可安全执行的绝对路径，支持空格和引号。
launcher_tmp="$(mktemp "$bin_dir/.hsync.XXXXXX")"
{
  printf '#!/usr/bin/env bash\n# HarnessSync launcher: %s\n' "$install_dir"
  printf 'exec node %q "$@"\n' "$install_dir/current/dist/cli.js"
} > "$launcher_tmp"
chmod 755 "$launcher_tmp"
link_tmp="$install_dir/.current.$$"
ln -s "releases/$release" "$link_tmp"
# rename 替换链接本身，避免 mv 将新链接移进旧链接指向的目录。
node -e 'const fs=require("node:fs"); fs.renameSync(process.argv[1],process.argv[2]); fs.renameSync(process.argv[3],process.argv[4])' "$launcher_tmp" "$launcher" "$link_tmp" "$install_dir/current"
launcher_tmp=""
link_tmp=""
printf '\nHarnessSync 安装完成。\n程序：%s\n命令：%s\n' "$install_dir/current" "$launcher"
printf '下一步（按需运行）：\n  %q onboard prepare\n  %q open\n' "$launcher" "$launcher"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) printf '\n当前 PATH 未包含启动器目录。可使用上面的完整路径，或在 shell 中执行：\n  export PATH=%q:"$PATH"\n' "$bin_dir" ;;
esac
resolved="$(command -v hsync || true)"
if [ -n "$resolved" ] && [ "$resolved" != "$launcher" ]; then
  printf '\n当前 PATH 中另有 hsync：%s。请先使用新安装的完整路径，或调整 PATH 顺序。\n' "$resolved"
fi
printf '安装器保留旧程序版本；配置库 ~/.harness-sync 独立保存。本次未改写 Harness 配置。\n'
