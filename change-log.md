# Change Log

## 0.5.1

### 修复

- **内部链接按所在文档目录解析**：`rewriteLinks` 新增 `fromPath` 参数，子文档中的相对链接（`../README.md`、`./sub/deep.md` 等）按 Markdown 标准语义以「所在文档目录 + 链接」归一解析，命中后重写为页内 `#doc-<slug>` 跳转；未命中时退回扫描根相对查表（兼容根相对写法），越界（`../..` 超出扫描根）或缺失目标原样保留。
  - 构建端（`lib/build.mjs`）与浏览器实时渲染端（`viewer.js` 的 `renderMarkdown`）均已接入。
  - 新增纯函数 `normalizeRelPath`（posix 风格路径归一，不依赖 `node:path`，Node/浏览器双端共用），并随 `MDV_CORE` 导出。

### 新增

- **桌面端侧边栏折叠**：≥1024px 下可通过工具栏 ☰、侧边栏头部 × 或快捷键 **⌘/Ctrl+B** 折叠整栏，折叠偏好经 `localStorage`（键 `mdv-sidebar`）持久化并在下次打开时恢复；按钮提示与 `aria-label` 随状态同步。
  - 折叠时 `#app` 网格改为单列，避免侧边栏 `display:none` 后正文落入 0 宽列被挤成竖条。
  - 移动端不受影响，沿用原有抽屉遮罩（`sidebar-open`）交互。

### 测试

- `core.test.mjs`：新增 `rewriteLinks` 文档相对解析 / 根相对兜底 / 越界保留用例，新增 `normalizeRelPath` 用例。
- `build.test.mjs`：更新子文档 `../README.md` 链接断言为重写命中；新增折叠样式、持久化键、快捷键与单列网格的产物断言。

### 其他

- README 增加 change log 入口。

## 0.5.0

- 首个公开版本：扫描目录构建自包含、离线可用的 `md-viewer.html`。
