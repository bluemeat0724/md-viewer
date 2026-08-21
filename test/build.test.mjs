/**
 * build() 集成测试：临时目录样例文档 → 断言输出自包含 HTML 的关键语义。
 * 0.7.0 起快照存原始文本（raw/type），渲染断言移至 core.test.mjs 的
 * renderMarkdown；此处聚焦：扫描规则、快照形状、按需 bundle、注入方式。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { build, findDocs, findMds } from '../lib/index.mjs';

/** 样例文档树 */
const FILES = {
  'README.md': [
    '# 项目说明',
    '',
    '内部链接：[子文档](docs/child.md) 与 [配置](data/config.json)。',
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
  'data/config.json': '{"name":"md-viewer","version":[1,2,3],"on":true,"meta":null}',
  'data/broken.json': '{oops}',
  'node_modules/ignored.md': '# 不应被扫描',
  'node_modules/ignored.json': '{}',
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

test('findDocs：递归收集 md/json、跳过隐藏与依赖目录；findMds 为同语义别名', async () => {
  const dir = await makeFixture();
  try {
    const rels = await findDocs(dir);
    assert.deepEqual(rels.sort(), ['README.md', 'data/broken.json', 'data/config.json', 'docs/child.md']);
    const alias = await findMds(dir);
    assert.deepEqual(alias.sort(), rels.sort());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** 从产物解析出快照（mdv-data JSON script）与 META，断言针对解码后的真实数据 */
function parsePayloads(html) {
  const snap = /<script type="application\/json" id="mdv-data">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(snap, '产物应包含 mdv-data JSON script');
  const meta = /var META = (\{.*\});/.exec(html);
  assert.ok(meta, '产物应包含 META');
  return { docs: JSON.parse(snap[1]), meta: JSON.parse(meta[1]) };
}

test('build：快照存原始文本与类型；marked/hljs/mermaid 按需内嵌；UI 资产齐全', async () => {
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

    // 快照数据：2 md + 2 json，跳过 node_modules 与隐藏文件
    const { docs, meta } = parsePayloads(html);
    assert.equal(docs.length, 4);
    assert.equal(meta.fileCount, 2);
    assert.equal(meta.jsonCount, 2);
    assert.equal(meta.buildCmd, 'md-viewer');

    const readme = docs.find((d) => d.path === 'README.md');
    const child = docs.find((d) => d.path === 'docs/child.md');
    const config = docs.find((d) => d.path === 'data/config.json');
    const broken = docs.find((d) => d.path === 'data/broken.json');
    assert.ok(readme && child && config && broken, 'md 与 json 文档都应存在');

    // 快照存原始文本（渲染移至浏览器端），不再有 html 字段
    for (const d of docs) assert.equal(d.html, undefined, '快照不应再存预渲染 html');
    assert.match(readme.raw, /^# 项目说明/);
    assert.equal(readme.type, 'md');
    assert.equal(readme.title, '项目说明');
    assert.equal(child.title, '子文档');
    assert.equal(child.group, 'docs');
    // json：type/title/slug（无 -json 尾巴）；损坏的 json 也照样嵌入（浏览器端降级展示）
    assert.equal(config.type, 'json');
    assert.equal(config.title, 'config');
    assert.equal(config.raw, FILES['data/config.json']);
    assert.equal(broken.type, 'json');
    assert.equal(broken.title, 'broken');

    // slug 生成正确
    assert.equal(readme.slug, 'README');
    assert.equal(child.slug, 'docs-child');
    assert.equal(config.slug, 'data-config');

    // 依赖 bundle 按需内嵌：有 md → marked；有任何文档 → hljs；有 mermaid → 惰性 script
    assert.match(html, /window\.marked\s*=/);
    assert.match(html, /window\.hljs\s*=/);
    assert.match(html, /<script type="text\/plain" id="mermaid-src">/);

    // 浏览器共享核心与查看器都已内联
    assert.ok(html.includes('MDV_CORE'), 'viewer-core 应内联');
    assert.ok(html.includes('MDV.escHtml'), 'viewer.js 应引用 MDV_CORE');
    assert.ok(html.includes('MDV.escAttr'), '动态属性应使用共享属性编码');

    // 侧边栏折叠：桌面端折叠样式/状态持久化 + ⌘/Ctrl+B 快捷键
    assert.ok(html.includes('sidebar-collapsed'), '应内联桌面端侧边栏折叠逻辑');
    assert.ok(html.includes('mdv-sidebar'), '应内联折叠偏好持久化键');
    assert.ok(html.includes('metaKey || ev.ctrlKey'), '快捷键应同时支持 ⌘ 与 Ctrl');
    assert.match(html, /⌘\/Ctrl\+B/, '按钮提示应包含快捷键说明');
    // 折叠时 #app 必须改单列：侧边栏 display:none 后不再是网格项，
    // 若保留 0 宽第一列，#main 会落入其中被挤成竖条
    assert.ok(html.includes('body.sidebar-collapsed #app{grid-template-columns:minmax(0,1fr)}'), '折叠态网格应为单列');

    // UI 资产：SVG 图标 sprite（含 JSON 开关的 braces）、代码复制、焦点可达性、
    // 单源双主题、窄屏目录、JSON 可见性开关
    assert.ok(html.includes('<symbol id="i-menu"'), '应内嵌 SVG 图标 sprite');
    assert.ok(html.includes('<symbol id="i-braces"'), '应内嵌 braces 图标');
    assert.ok(html.includes('id="btn-json"'), '应有 JSON 可见性切换按钮');
    assert.ok(html.includes('mdv-show-json'), '应持久化 JSON 可见性偏好');
    assert.ok(html.includes('code-copy'), '应有代码块复制按钮');
    assert.ok(html.includes(':focus-visible'), '应有键盘焦点样式');
    assert.ok(html.includes('light-dark('), '主题令牌应使用 light-dark() 单源定义');
    assert.ok(html.includes('outline-pop'), '窄屏应有本页目录弹层');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('build：空文档目录也能生成（0 篇、无 bundle）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdv-empty-'));
  const outFile = path.join(dir, 'md-viewer.html');
  try {
    await build({ srcDir: dir, outFile, title: '空站点' });
    const html = await fs.readFile(outFile, 'utf8');
    assert.match(html, /<title>空站点<\/title>/);
    const { docs, meta } = parsePayloads(html);
    assert.equal(docs.length, 0);
    assert.equal(meta.fileCount, 0);
    assert.equal(meta.jsonCount, 0);
    // 无文档：marked/hljs/mermaid 全部省略，产物不再依赖 bundle
    //（viewer.js 源码里也有 window.marked / mermaid-src 引用，
    // 须以「赋值」「完整标签」形态判定 bundle 存在）
    assert.ok(!/window\.marked\s*=/.test(html), '无 md 不应内嵌 marked');
    assert.ok(!/window\.hljs\s*=/.test(html), '无文档不应内嵌 hljs');
    assert.ok(!html.includes('<script type="text/plain" id="mermaid-src">'), '无 mermaid 图不应内嵌 mermaid');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('build：仅 json（无 md、无 mermaid）时省略 marked 与 mermaid，保留 hljs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdv-jsononly-'));
  const outFile = path.join(dir, 'md-viewer.html');
  try {
    await fs.mkdir(path.join(dir, 'data'), { recursive: true });
    await fs.writeFile(path.join(dir, 'data', 'only.json'), '{"a":1}', 'utf8');
    await build({ srcDir: dir, outFile, title: 'json 站点' });
    const html = await fs.readFile(outFile, 'utf8');
    const { docs, meta } = parsePayloads(html);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].type, 'json');
    assert.equal(meta.fileCount, 0);
    assert.equal(meta.jsonCount, 1);
    assert.ok(!/window\.marked\s*=/.test(html), '无 md 不应内嵌 marked');
    assert.ok(/window\.hljs\s*=/.test(html), 'json 原文视图需要 hljs');
    assert.ok(!html.includes('<script type="text/plain" id="mermaid-src">'), '无 mermaid 图不应内嵌 mermaid');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('build：maxRawKB 超限文件不嵌入，保留目录项与大小信息', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdv-big-'));
  const outFile = path.join(dir, 'md-viewer.html');
  try {
    await fs.writeFile(path.join(dir, 'small.md'), '# 小', 'utf8');
    await fs.writeFile(path.join(dir, 'big.json'), '{"pad":"' + 'x'.repeat(3 * 1024) + '"}', 'utf8');
    await build({ srcDir: dir, outFile, title: '阈值站点', maxRawKB: 1 });
    const { docs } = parsePayloads(await fs.readFile(outFile, 'utf8'));

    const small = docs.find((d) => d.path === 'small.md');
    const big = docs.find((d) => d.path === 'big.json');
    assert.ok(small.raw, '1KB 以内的文件正常嵌入');
    assert.equal(big.raw, null, '超限文件不应嵌入原文');
    assert.equal(big.omitted, 'size');
    assert.ok(big.size > 3 * 1024, '应记录原始大小');
    assert.equal(big.title, 'big', '标题仍可提取（目录项保留）');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('build：默认完整嵌入超过 1MB 的正文', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdv-unlimited-'));
  const outFile = path.join(dir, 'md-viewer.html');
  const raw = '# 大文档\n\n' + 'x'.repeat(1024 * 1024 + 1);
  try {
    await fs.writeFile(path.join(dir, 'big.md'), raw, 'utf8');
    await build({ srcDir: dir, outFile, title: '完整正文站点' });
    const { docs } = parsePayloads(await fs.readFile(outFile, 'utf8'));

    assert.equal(docs[0].raw, raw);
    assert.equal(docs[0].omitted, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('build：中文路径 slug 保留原字符；md/json 同名自然 slug 冲突时去重', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdv-slug-'));
  try {
    // a/b.md 与 a-b.md 的自然 slug 同为 a-b；a.md 与 a.json 同为 a
    await fs.mkdir(path.join(dir, 'a'), { recursive: true });
    await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(dir, 'a/b.md'), '链接 [dash](../a-b.md)', 'utf8');
    await fs.writeFile(path.join(dir, 'a-b.md'), '# Dash', 'utf8');
    await fs.writeFile(path.join(dir, 'a.md'), '# A', 'utf8');
    await fs.writeFile(path.join(dir, 'a.json'), '{}', 'utf8');
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

    const am = docs.find((d) => d.path === 'a.md');
    const aj = docs.find((d) => d.path === 'a.json');
    assert.notEqual(am.slug, aj.slug, 'a.md 与 a.json 不应共享 slug');

    const cn1 = docs.find((d) => d.path === 'docs/BusinessContext分析框架.md');
    const cn2 = docs.find((d) => d.path === 'docs/BusinessContext待确认字段清单.md');
    assert.equal(cn1.slug, 'docs-BusinessContext分析框架');
    assert.equal(cn2.slug, 'docs-BusinessContext待确认字段清单');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
