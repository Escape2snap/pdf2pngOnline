# PDF 工坊

纯前端的 PDF → PNG 工具。PDF 只在浏览器内解析和渲染，不会上传服务器。

视觉风格参考 Fuwari / overdose.chat：hue 315、1rem 圆角、Roboto + JetBrains Mono、卡片式布局、深浅色主题。

## 快速开始

```bash
cd ~/pdf2pngOnline
python3 -m http.server 8765
# 打开 http://127.0.0.1:8765/
```

必须通过 HTTP(S) 访问，不能直接双击 `index.html`：PDF.js 的 worker 和 WASM/CMap 资源需要正常的 HTTP 环境。

## 功能

- 拖拽 / 点击选择 PDF，读取文件头校验，最多 100 MB
- PDF.js 渲染预览，支持加密 PDF 的密码输入
- DPI 可调，默认 **300**；预设 72 / 96 / 150 / 200 / 300 / 600
- 全部页面或自定义页码范围
- 逐页渲染 PNG，显示尺寸、文件大小，单页下载
- 一键打包 ZIP（PNG 已压缩，ZIP 采用 store 模式，不再重复压缩）
- 预估单页输出尺寸和 RGBA 内存，超过安全上限时提示
- 深色 / 浅色主题，记忆选择
- 全程无后端、无上传；静态资源同源加载

## 文件结构

```text
pdf2pngOnline/
├── index.html
├── favicon.svg
├── .gitignore
├── assets/
│   ├── style.css        Fuwari 设计令牌 + 应用样式
│   └── app.js           PDF 加载、预览、转换、ZIP、主题
├── vendor/
│   ├── pdfjs/           pdfjs-dist 6.4.299（含 worker、cmaps、字体、wasm、icc）
│   ├── fflate/          fflate 0.8.2，浏览器 ZIP
│   └── fonts/           Roboto / JetBrains Mono woff2
```

没有构建步骤；改完刷新即可。`vendor/pdfjs` 和 `vendor/fflate` 的许可证已放在各自目录。

## 资源限制

| 限制 | 值 |
|---|---:|
| 单个 PDF | 100 MB |
| 文档页数 | 300 |
| 单次导出页数 | 100 |
| 单页输出像素 | 60 MP |
| 单次导出总像素 | 300 MP |

这是为了在移动端/低内存设备上尽量不把页面拖死。超过限制时界面会提示降低 DPI 或缩小页面范围。

## 部署

纯静态目录，把 `index.html`、`favicon.svg`、`assets/`、`vendor/` 放进 web 根目录即可。

nginx 至少需要正确的 MIME 和缓存：

```nginx
types {
    application/javascript mjs;
    application/wasm wasm;
}

location ~* \.(mjs|wasm)$ {
    add_header Cache-Control "public, max-age=31536000, immutable";
}
```

如果站点部署在子路径下，`assets/app.js` 里的资源路径使用 `import.meta.url`，会跟随文件位置；不需要改死路径。

### 关于 UA

这个页面是纯静态前端，**没有做 User-Agent 访问控制**。前端无法可靠地强制 UA；如果部署层（nginx / Cloudflare / 网关）要求携带 UA，应在那一层校验，而不是在 JS 里做。

## 隐私

- 选择文件后只在浏览器内存中读取；
- 没有上传接口、没有第三方请求、没有统计脚本；
- 关闭/清空页面后，生成的 Blob URL 会被回收；
- 浏览器刷新后不会保留 PDF 或导出结果。

## 技术栈

- [PDF.js](https://mozilla.github.io/pdf.js/) `6.4.299`（Apache-2.0）
- [fflate](https://github.com/101arrowz/fflate) `0.8.2`（MIT）
- 字体：Roboto（Apache-2.0）、JetBrains Mono（OFL-1.1）
