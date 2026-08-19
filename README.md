# md-viewer

[![npm version](https://img.shields.io/npm/v/%40bluemeat0724%2Fmd-viewer)](https://www.npmjs.com/package/@bluemeat0724/md-viewer)

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

或免安装直接运行（npx）：

```bash
npx @bluemeat0724/md-viewer
```

开发调试时也可在项目目录本地挂载：

```bash
npm install
npm link
```

## 使用

在任意目录执行，即以**执行目录**为根目录扫描：

```bash
cd /path/to/any/docs-dir
md-viewer              # 扫描当前目录，生成 ./md-viewer.html
md-viewer --open       # 构建后自动用浏览器打开
md-viewer --watch      # 常驻监听，md 变动自动重建
md-viewer docs         # 指定扫描目录（位置参数）
md-viewer --out x.html # 自定义输出文件
md-viewer --title "我的文档"  # 自定义站点标题
md-viewer --harness   # 生成文档到.agent 目录下并开启watch
```

打开生成的 HTML：使用 `--open`，或双击文件，或 `open md-viewer.html`。md 有变动时重新运行命令（或保持 `--watch` 常驻），刷新浏览器即可。

## 参数

| 选项 | 说明 |
|---|---|
| `[目录]` | 扫描根目录，默认当前执行目录 |
| `-w, --watch` | 构建后持续监听，md 变动自动重建 |
| `-o, --open` | 构建后用系统默认浏览器打开生成的 HTML |
| `--harness` | 输出到 `<目录>/.agent/md-viewer.html` 并强制开启 watch（供 Agent 环境常驻） |
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

## DSH 插件（dsh-md-viewer）

`packages/dsh-md-viewer/` 是本引擎的 DSH 插件封装（独立 npm 包
`@bluemeat0724/dsh-md-viewer`）：在 DeepSeek Harness Web GUI 中浏览任意工作区
的 Markdown——进程内复用本引擎的渲染管线，提供会话标题栏/侧边栏入口、全屏
iframe 预览与 `mdv_build` / `mdv_status` Agent 工具。详见
[packages/dsh-md-viewer/README.zh.md](packages/dsh-md-viewer/README.zh.md)。

## 程序化 API

除 CLI 外，`@bluemeat0724/md-viewer` 提供 Node 程序化入口（`lib/index.mjs`，含
`lib/index.d.ts` 类型声明），供其他工具（如 dsh 插件）直接复用渲染能力：

```js
import { build, startWatch, findMds } from '@bluemeat0724/md-viewer';

await build({ srcDir: '/path/to/docs', outFile: '/tmp/md-viewer.html', title: '我的文档' });
const mds = await findMds('/path/to/docs'); // 相对路径列表（跳过隐藏项与依赖目录）
startWatch('/path/to/docs', () => build({ srcDir: '/path/to/docs', outFile: '/tmp/md-viewer.html', title: '我的文档' }));
```

依赖（marked / highlight.js / mermaid / esbuild）随包安装预置，调用零等待。

## 开发与测试

- 资产文件（页面样式 / 共享渲染核心 / 浏览器查看器）位于 `lib/assets/`：
  Node 构建侧与浏览器查看器共用 `viewer-core.js` 一份源码，不要在别处复制
  这些函数（`npm test` 有行为一致性护栏）。
- 测试：`npm test`（node:test 单测 + 集成测试，覆盖渲染 / 高亮 / mermaid /
  链接重写 / 跳过规则）。

## 注意事项

- `--watch` 基于 `fs.watch(recursive)`，是 OS 级事件监听（macOS 走 FSEvents，非轮询）：空闲时近零 CPU，仅 md 变动时触发重建；事件带 300ms 防抖与重建串行锁，连续保存不会连环重建。macOS / Windows / 较新 Linux 内核均支持；部分旧 Linux 发行版（< 5.x 内核）对递归监听支持有限，如不生效可退回「改动后手动重跑 `md-viewer`」。
- 生成的 HTML 内嵌 marked / highlight.js / mermaid 浏览器 bundle（约 3–4 MB），文档越多文件越大。
- 构建失败时退出码为 1，并输出可读错误信息。

## 许可

MIT
