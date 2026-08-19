/**
 * dsh-md-viewer 字典（zh 为 key 源，en 键集完整对照）。
 */

/** 字典键集：zh 的键字面量联合（LocaleNamespaceMap 值形态）。 */
export type MdvKey = keyof typeof zh

/** 简体中文（key 源，字典键集的事实源）。 */
export const zh = {
  'entry.open.title': '打开 MD 文档查看器（基于 md-viewer 渲染工作区 Markdown）',
  'entry.open.label': 'MD 文档',
  'overlay.title': 'MD 文档查看器',
  'overlay.close': '关闭',
  'overlay.buildAndPreview': '构建并预览',
  'overlay.building': '构建中…',
  'overlay.openInTab': '新标签打开',
  'overlay.workspaces': '工作区',
  'overlay.noWorkspaces': '（无工作区）',
  'overlay.customDirPlaceholder': '或输入任意目录路径…',
  'overlay.loading': '加载中…',
  'overlay.emptyHint': '选择工作区并「构建并预览」，渲染结果将显示在这里',
  'overlay.badgeReady': 'md-viewer ✓',
  'overlay.badgeMissing': 'md-viewer ✗',
  'overlay.buildingHint': '正在构建：{dir} …（扫描 + marked/highlight.js/mermaid 打包）',
  'overlay.buildOk': '构建完成：{count} 篇文档，{size} MB，生成于 {time} → {file}',
  'overlay.buildFail': '构建失败：{error}',
  'overlay.scanning': '…',
}

/** English (key-set complete mirror of zh). */
export const en: Record<MdvKey, string> = {
  'entry.open.title': 'Open the MD document viewer (renders workspace Markdown via md-viewer)',
  'entry.open.label': 'MD Docs',
  'overlay.title': 'MD Document Viewer',
  'overlay.close': 'Close',
  'overlay.buildAndPreview': 'Build & preview',
  'overlay.building': 'Building…',
  'overlay.openInTab': 'Open in tab',
  'overlay.workspaces': 'Workspaces',
  'overlay.noWorkspaces': '(no workspaces)',
  'overlay.customDirPlaceholder': 'Or type any directory path…',
  'overlay.loading': 'Loading…',
  'overlay.emptyHint': 'Pick a workspace and click "Build & preview" — the rendered result appears here',
  'overlay.badgeReady': 'md-viewer ready',
  'overlay.badgeMissing': 'md-viewer missing',
  'overlay.buildingHint': 'Building {dir} … (scan + marked/highlight.js/mermaid bundling)',
  'overlay.buildOk': 'Built {count} docs, {size} MB at {time} → {file}',
  'overlay.buildFail': 'Build failed: {error}',
  'overlay.scanning': '…',
}

