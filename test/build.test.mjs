/**
 * build() 集成测试：临时目录样例文档 → 断言输出自包含 HTML 的关键语义。
 * 覆盖：文档渲染、代码高亮、mermaid 占位还原、跨文档链接重写、跳过规则。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { build, findMds } from '../lib/index.mjs';

/** 样例文档树 */
const FILES = {
  'README.md': [
    '# 项目说明',
    '',
    '内部链接：[子文档](docs/child.md) 与 [带锚点](docs/child.md#小节)。',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    '```mermaid',
    'graph TD; A-->B;',
    '```',
  ].join('\n'),
  'docs/child.md': [
    '# 子文档',
    '',
    '## 小节',
    '',
    '引用 [README](../README.md)。',
  ].join('\n'),
  'node_modules/ignored.md': '# 不应被扫描',
  '.hidden.md': '# 隐藏文件不应被扫描',
};

async function makeFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdv-test-'));
  for (const [rel, content] of Object.entries(FILES)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return dir;
}

test('findMds：递归收集、跳过隐藏与依赖目录', async () => {
  const dir = await makeFixture();
  try {
    const rels = await findMds(dir);
    assert.deepEqual(rels.sort(), ['README.md', 'docs/child.md']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** 从产物解析出 SNAPSHOT（文档快照）与 META，断言针对解码后的真实数据 */
function parsePayloads(html) {
  const snap = /var SNAPSHOT = ([\s\S]*?);\s*var SITE_TITLE/.exec(html);
  const meta = /var META = ([\s\S]*?);\s*var SNAPSHOT/.exec(html);
  assert.ok(snap, '产物应包含 SNAPSHOT');
  assert.ok(meta, '产物应包含 META');
  return { docs: JSON.parse(snap[1]), meta: JSON.parse(meta[1]) };
}

test('build：生成自包含 HTML，渲染/高亮/mermaid/链接重写正确', async () => {
  const dir = await makeFixture();
  const outFile = path.join(dir, 'out', 'md-viewer.html');
  try {
    await build({ srcDir: dir, outFile, title: '测试站点' });

    const html = await fs.readFile(outFile, 'utf8');
    assert.ok(html.length > 100_000, '产物应包含内嵌依赖 bundle');

    // 标题注入（<title> 与 brand）
    assert.match(html, /<title>测试站点<\/title>/);
    assert.match(html, /<div class="brand">/);
    assert.match(html, /<span class="brand-name">测试站点<\/span>/);

    // 快照数据：2 篇文档，跳过 node_modules 与隐藏文件
    const { docs, meta } = parsePayloads(html);
    assert.equal(docs.length, 2);
    assert.equal(meta.fileCount, 2);
    assert.equal(meta.buildCmd, 'md-viewer');

    const readme = docs.find((d) => d.path === 'README.md');
    const child = docs.find((d) => d.path === 'docs/child.md');
    assert.ok(readme && child, 'README 与 docs/child.md 都应存在');

    // marked GFM 渲染 + 标题 id
    assert.match(readme.html, /<h1 id="项目说明">项目说明<\/h1>/);
    assert.match(child.html, /<h1 id="子文档">子文档<\/h1>/);
    // 代码高亮（hljs class 注入）
    assert.match(readme.html, /class="language-js hljs"/);
    assert.match(readme.html, /hljs-keyword/);
    // mermaid 块还原为 pre.mermaid（未渲染的原代码）
    assert.match(readme.html, /<pre class="mermaid">graph TD; A--&gt;B;<\/pre>/);
    // 跨文档链接重写（README → docs/child.md）
    assert.match(readme.html, /<a href="#doc-docs-child">子文档<\/a>/);
    assert.match(readme.html, /<a href="#doc-docs-child" data-anchor="小节">带锚点<\/a>/);
    // 子文档的 ../ 相对链接：按所在文档目录解析命中快照中的 README.md
    assert.match(child.html, /<a href="#doc-README">README<\/a>/);
    // slug 生成正确
    assert.equal(readme.slug, 'README');
    assert.equal(child.slug, 'docs-child');
    assert.equal(child.group, 'docs');

    // 浏览器共享核心与查看器都已内联
    assert.ok(html.includes('MDV_CORE'), 'viewer-core 应内联');
    assert.ok(html.includes('MDV.escHtml'), 'viewer.js 应引用 MDV_CORE');

    // 侧边栏折叠：桌面端折叠样式/状态持久化 + ⌘/Ctrl+B 快捷键
    assert.ok(html.includes('sidebar-collapsed'), '应内联桌面端侧边栏折叠逻辑');
    assert.ok(html.includes('mdv-sidebar'), '应内联折叠偏好持久化键');
    assert.ok(html.includes('metaKey || ev.ctrlKey'), '快捷键应同时支持 ⌘ 与 Ctrl');
    assert.match(html, /⌘\/Ctrl\+B/, '按钮提示应包含快捷键说明');
    // 折叠时 #app 必须改单列：侧边栏 display:none 后不再是网格项，
    // 若保留 0 宽第一列，#main 会落入其中被挤成竖条
    assert.ok(html.includes('body.sidebar-collapsed #app{grid-template-columns:minmax(0,1fr)}'), '折叠态网格应为单列');

    // UI 重设计资产：SVG 图标 sprite、代码复制、焦点可达性、单源双主题、窄屏目录
    assert.ok(html.includes('<symbol id="i-menu"'), '应内嵌 SVG 图标 sprite');
    assert.ok(html.includes('code-copy'), '应有代码块复制按钮');
    assert.ok(html.includes(':focus-visible'), '应有键盘焦点样式');
    assert.ok(html.includes('light-dark('), '主题令牌应使用 light-dark() 单源定义');
    assert.ok(html.includes('outline-pop'), '窄屏应有本页目录弹层');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('build：空文档目录也能生成（0 篇）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdv-empty-'));
  const outFile = path.join(dir, 'md-viewer.html');
  try {
    await build({ srcDir: dir, outFile, title: '空站点' });
    const html = await fs.readFile(outFile, 'utf8');
    assert.match(html, /<title>空站点<\/title>/);
    const { docs, meta } = parsePayloads(html);
    assert.equal(docs.length, 0);
    assert.equal(meta.fileCount, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('build：中文路径 slug 保留原字符；自然 slug 冲突时追加序号去重', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdv-slug-'));
  try {
    // a/b.md 与 a-b.md 的自然 slug 同为 a-b；两个中文路径文档此前会塌缩为同一 slug
    await fs.mkdir(path.join(dir, 'a'), { recursive: true });
    await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(dir, 'a/b.md'), '链接 [dash](../a-b.md)', 'utf8');
    await fs.writeFile(path.join(dir, 'a-b.md'), '# Dash', 'utf8');
    await fs.writeFile(path.join(dir, 'docs/BusinessContext分析框架.md'), '# 框架', 'utf8');
    await fs.writeFile(path.join(dir, 'docs/BusinessContext待确认字段清单.md'), '# 清单', 'utf8');

    const outFile = path.join(dir, 'md-viewer.html');
    await build({ srcDir: dir, outFile, title: 'slug 站点' });
    const { docs } = parsePayloads(await fs.readFile(outFile, 'utf8'));

    const slugs = docs.map((d) => d.slug);
    assert.equal(new Set(slugs).size, slugs.length, '所有文档 slug 应唯一');

    const dash = docs.find((d) => d.path === 'a-b.md');
    const b = docs.find((d) => d.path === 'a/b.md');
    assert.notEqual(dash.slug, b.slug, 'a/b.md 与 a-b.md 不应共享 slug');
    assert.match(b.html, new RegExp('<a href="#doc-' + dash.slug + '">dash</a>'));

    const cn1 = docs.find((d) => d.path === 'docs/BusinessContext分析框架.md');
    const cn2 = docs.find((d) => d.path === 'docs/BusinessContext待确认字段清单.md');
    assert.equal(cn1.slug, 'docs-BusinessContext分析框架');
    assert.equal(cn2.slug, 'docs-BusinessContext待确认字段清单');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
