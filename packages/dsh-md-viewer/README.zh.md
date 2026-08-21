# dsh-md-viewer — Markdown 工作区文档查看器（DSH 插件）

[English](README.md) | 中文

在 DeepSeek Harness Web GUI 里直接浏览任意工作区的 Markdown——由 **md-viewer 引擎**
（marked + highlight.js + mermaid → 自包含离线快照）渲染。Host 半区进程内复用
`@bluemeat0724/md-viewer` 程序化 API，不 spawn 子进程、不依赖外部服务。

本包是 **md-viewer 项目的 DSH 插件封装**，与引擎同仓库维护（`packages/dsh-md-viewer`）。

## 能力

- **一键构建快照**：选择工作区（或手动输入任意目录路径），点「构建并预览」；
  Host 把目录下所有 `*.md`（GFM / 代码高亮 / Mermaid 图表）渲染进
  `<目录>/.agents/md-viewer.html` 并缓存在内存。
- **内嵌预览**：全屏覆盖层通过 iframe（`/mdv/<目录>` 路由）展示渲染结果——
  文件树、全文搜索、Mermaid 缩放、主题切换全部可用，支持「新标签打开」。
- **双入口**：会话标题栏按钮（📚 MD 文档）+ 侧边栏底部按钮（设置齿轮旁）。
- **Agent 工具**：`mdv_build [dir]` 渲染指定目录（缺省会话工作区）；
  `mdv_status` 列出已构建快照。

## 安全模型

- 构建**由用户在 GUI 触发**或 **Agent 显式调用**（`mdv_build`）；Host 只写
  用户所选目录下一个文件 `<目录>/.agents/md-viewer.html`，使用宿主进程权限。
- 全部 `/api/mdv/*` 与 `/mdv/*` 路由带 **loopback-only 信任栅栏**（同源标记）；
  局域网暴露的 DSH 部署不会提供这些端点。
- 快照只存在宿主内存；磁盘上除构建出的 HTML 文件外不落任何持久数据。

## 安装

```sh
# npm 安装（推荐）
dsh plugin --profile web add @bluemeat0724/dsh-md-viewer

# 开发调试（本地目录）
dsh plugin --profile web add link:/Users/g-air/projects/research/md-viewer/packages/dsh-md-viewer
```

## 开发

```sh
cd packages/dsh-md-viewer
pnpm install
pnpm typecheck
pnpm test       # 引擎扫描/构建/提供测试
pnpm build
```

渲染管线在 `@bluemeat0724/md-viewer` 依赖（本仓库根目录）；本包在其上添加
DSH 表面（路由 / 工具 / UI）。构建预设 `build/tsdown.client.ts` 是自包含的
vendored 副本（源自 dsh-web-ui 的 shared 预设），升级 DSH SDK 时同步。

## 已知限制

- 渲染快照是构建时副本：编辑 `.md` 后需重新构建（GUI 按钮或 `mdv_build`）
  才会出现在预览中。
- 查看器覆盖层浮在整个 GUI 之上，用关闭按钮退出。
