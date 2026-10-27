#!/usr/bin/env bash
#
# 打包并部署到远端服务器。
#
# 个人参数（服务器地址、站点目录、属主）不放在这个文件里，
# 而是读同目录下的 deploy.conf（已 gitignore）。首次使用：
#
#     cp deploy.conf.example deploy.conf   # 然后按需修改
#
# 页脚注入：index.html 里有一个 <!--ICP--> 锚点，打包时会被
# deploy.conf 指定的 FOOTER_FILE 内容替换。所以备案号只存在于
# 本地被忽略的文件和服务器上，仓库里查不到。
#
# 用法：
#   ./deploy.sh stage   只生成本地 .stage/，用于上传前自检
#   ./deploy.sh push    打包 + 上传 + 远端授权
#
set -euo pipefail

cd "$(dirname "$0")"

CONF="${CONF:-deploy.conf}"
STAGE=".stage"
ANCHOR="<!--ICP-->"

if [ ! -f "$CONF" ]; then
  echo "错误：找不到 $CONF" >&2
  echo "" >&2
  echo "个人部署参数不放在仓库里。请先复制模板再填写：" >&2
  echo "" >&2
  echo "    cp deploy.conf.example deploy.conf" >&2
  exit 1
fi

# shellcheck source=/dev/null
. "$CONF"

: "${REMOTE:?deploy.conf 里必须设置 REMOTE}"
: "${REMOTE_DIR:?deploy.conf 里必须设置 REMOTE_DIR}"
OWNER="${OWNER:-}"
FOOTER_FILE="${FOOTER_FILE:-}"
REQUIRE_FOOTER="${REQUIRE_FOOTER:-0}"

MODE="${1:-push}"

echo "==> 构建暂存目录 $STAGE/"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# 只带运行需要的：测试页和 README 不上去
cp index.html favicon.svg "$STAGE/"
cp -r assets vendor "$STAGE/"

if [ -n "$FOOTER_FILE" ] && [ -f "$FOOTER_FILE" ]; then
  echo "==> 注入页脚（$FOOTER_FILE）"
  python3 - "$STAGE/index.html" "$FOOTER_FILE" "$ANCHOR" <<PY
import sys
path, footer_path, anchor = sys.argv[1], sys.argv[2], sys.argv[3]
html = open(path, encoding="utf-8").read()
footer = open(footer_path, encoding="utf-8").read().strip()
if html.count(anchor) != 1:
    sys.exit("锚点 %s 在 %s 中出现 %d 次，应为 1 次" % (anchor, path, html.count(anchor)))
open(path, "w", encoding="utf-8").write(html.replace(anchor, footer))
print("    已替换锚点，页脚 %d 字节" % len(footer))
PY
elif [ -n "$FOOTER_FILE" ] && [ "$REQUIRE_FOOTER" = "1" ]; then
  echo "错误：找不到页脚文件 $FOOTER_FILE" >&2
  echo "REQUIRE_FOOTER=1 表示页脚是必需的（例如 ICP 备案号是法定展示项）。" >&2
  echo "确实要跳过，把 deploy.conf 里的 REQUIRE_FOOTER 改成 0。" >&2
  exit 1
else
  if [ -n "$FOOTER_FILE" ]; then
    echo "==> 警告：找不到 $FOOTER_FILE，本次不带页脚"
  fi
  python3 - "$STAGE/index.html" "$ANCHOR" <<PY
import sys
path, anchor = sys.argv[1], sys.argv[2]
html = open(path, encoding="utf-8").read()
open(path, "w", encoding="utf-8").write(html.replace(anchor, ""))
PY
fi

# 保险：锚点必须被处理干净，不能让占位符上线
if grep -q "$ANCHOR" "$STAGE/index.html"; then
  echo "错误：锚点未被处理干净，中止" >&2
  exit 1
fi

if [ "$MODE" = "stage" ]; then
  echo "==> 已生成 $STAGE/，未上传"
  echo "    本地自检：cd $STAGE && python3 -m http.server 8767"
  exit 0
fi

if [ "$MODE" != "push" ]; then
  echo "未知模式：$MODE（可用：stage / push）" >&2
  exit 1
fi

echo "==> 打包"
TARBALL="$(mktemp -t pdf2png.XXXXXX.tar.gz)"
TAR_NAME="$(basename "$TARBALL")"
tar czf "$TARBALL" -C "$STAGE" .
trap "rm -f $TARBALL" EXIT

echo "==> 上传到 $REMOTE"
scp -q -o BatchMode=yes "$TARBALL" "$REMOTE:/tmp/"

echo "==> 远端解包"
REMOTE_CMD="sudo tar xzf /tmp/$TAR_NAME -C $REMOTE_DIR"
if [ -n "$OWNER" ]; then
  REMOTE_CMD="$REMOTE_CMD && sudo chown -R $OWNER $REMOTE_DIR"
fi
REMOTE_CMD="$REMOTE_CMD && sudo chmod -R u=rwX,go=rX $REMOTE_DIR && rm -f /tmp/$TAR_NAME"
ssh -o BatchMode=yes "$REMOTE" "$REMOTE_CMD"

echo "==> 完成"
echo "    注意：解包只覆盖同名文件，远端若删过文件需手工清理残留"
