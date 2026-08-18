# md-viewer

扫描目录下所有 Markdown 文件，构建一个**自包含、离线可用**的 `md-viewer.html`——`file://` 双击直开，无需任何服务。

## 特性

- 递归扫描 `*.md`（自动跳过 `node_modules`、`.git`、`dist`、`build`、`.venv` 及隐藏目录）
- GFM 渲染（marked）+ 代码高亮（highlight.js）+ Mermaid 图表渲染
- 文件树侧边栏：文件夹在前、文件在后，目录默认折叠，深链自动展开祖先
- 全文搜索（标题 + 路径 + 正文，`/` 键聚焦）
- 深浅主题三态循环（auto / light / dark），Mermaid 随主题重渲染
- 上一篇 / 下一篇导航、页内大纲（右侧 outline，滚动高亮）
- 跨文档 `.md` 链接自动重写为页内锚点跳转
- Mermaid 独立缩放容器：滚轮缩放、拖拽平移、100%–400%、全屏
- `--watch` 监听 md 变动自动重建
- 构建秒级完成：依赖随安装预置，运行零等待

## 安装

```bash
npm install -g @bluemeat0724/md-viewer
```

或在项目目录本地挂载（开发调试用）：

```bash
npm install
npm link
```

## 使用

在任意目录执行，即以**执行目录**为根目录扫描：

```bash
cd /path/to/any/docs-dir
md-viewer              # 扫描当前目录，生成 ./md-viewer.html
md-viewer --watch      # 常驻监听，md 变动自动重建
md-viewer docs         # 指定扫描目录（位置参数）
md-viewer --out x.html # 自定义输出文件
md-viewer --title "我的文档"  # 自定义站点标题
```

打开生成的 HTML：双击文件，或 `open md-viewer.html`。md 有变动时重新运行命令（或保持 `--watch` 常驻），刷新浏览器即可。

## 参数

| 选项 | 说明 |
|---|---|
| `[目录]` | 扫描根目录，默认当前执行目录 |
| `-w, --watch` | 构建后持续监听，md 变动自动重建 |
| `--out <file>` | 输出文件路径，默认 `<目录>/md-viewer.html` |
| `--title <text>` | 站点标题，默认为扫描目录名 |
| `-h, --help` | 显示帮助 |
| `-v, --version` | 显示版本号 |

## 环境变量

| 变量 | 说明 |
|---|---|
| `MD_VIEWER_OUT` | 输出文件路径（`--out` 优先） |
| `MD_VIEWER_TITLE` | 站点标题（`--title` 优先） |

优先级：CLI 参数 > 环境变量 > 默认值。

## 注意事项

- `--watch` 基于 `fs.watch(recursive)`。macOS / Windows / 较新 Linux 内核均支持；部分旧 Linux 发行版（< 5.x 内核）对递归监听支持有限，如不生效可退回「改动后手动重跑 `md-viewer`」。
- 生成的 HTML 内嵌 marked / highlight.js / mermaid 浏览器 bundle（约 3–4 MB），文档越多文件越大。
- 构建失败时退出码为 1，并输出可读错误信息。

## 许可

MIT
