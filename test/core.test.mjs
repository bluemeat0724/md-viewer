/**
 * viewer-core 共享渲染工具单测。
 * 与 lib/build.mjs 相同的方式加载：副作用导入后读 globalThis.MDV_CORE。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../lib/assets/viewer-core.js';
const C = globalThis.MDV_CORE;

test('MDV_CORE 已通过副作用导入挂载', () => {
  assert.ok(C, 'globalThis.MDV_CORE 应为对象');
  for (const name of ['escHtml', 'unescHtml', 'slugifyHeading', 'slugForPath', 'normalizeRelPath', 'extractMermaid', 'addHeaderIds', 'highlightCode', 'rewriteLinks', 'titleFromHtml']) {
    assert.equal(typeof C[name], 'function', `${name} 应为函数`);
  }
});

test('escHtml / unescHtml 往返', () => {
  const raw = '<a href="x&y">\'q\'</a>';
  assert.equal(C.unescHtml(C.escHtml(raw)), raw);
  assert.equal(C.escHtml('<b>&'), '&lt;b&gt;&amp;');
});

test('slugifyHeading：小写、去符号、空白转连字符', () => {
  assert.equal(C.slugifyHeading('Hello World'), 'hello-world');
  assert.equal(C.slugifyHeading('A&B（中文）'), 'ab中文');
  assert.equal(C.slugifyHeading('  spaced  '), 'spaced');
});

test('slugForPath：去 .md 后缀、非字母数字转连字符', () => {
  assert.equal(C.slugForPath('docs/README.md'), 'docs-README');
  assert.equal(C.slugForPath('a.b/c-d.md'), 'a-b-c-d');
});

test('slugForPath：保留中文等 Unicode 字符，中文文档不塌缩为同一 slug', () => {
  assert.equal(C.slugForPath('docs/BusinessContext自动构建任务指南.md'), 'docs-BusinessContext自动构建任务指南');
  assert.equal(C.slugForPath('docs/场景模拟.md'), 'docs-场景模拟');
  assert.notEqual(
    C.slugForPath('docs/BusinessContext自动构建任务指南.md'),
    C.slugForPath('docs/BusinessContext待确认字段清单.md'),
  );
});

test('extractMermaid：抽取 mermaid 块、保留其他围栏', () => {
  const md = [
    '# T',
    '```js',
    'const x = 1;',
    '```',
    '```mermaid',
    'graph TD; A-->B;',
    '```',
    'text',
  ].join('\n');
  const { md: out, blocks } = C.extractMermaid(md, 'TAG');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0], 'graph TD; A-->B;');
  assert.ok(out.includes('[[TAG0]]'), 'mermaid 块应替换为占位符');
  assert.ok(out.includes('```js'), '普通代码围栏原样保留');
  assert.ok(out.includes('const x = 1;'), '普通代码内容保留');
  assert.ok(out.includes('text'));
});

test('extractMermaid：未闭合 mermaid 围栏原样保留', () => {
  const md = '```mermaid\ngraph TD; A-->B;\n';
  const { md: out, blocks } = C.extractMermaid(md, 'TAG');
  assert.equal(blocks.length, 0);
  assert.ok(out.includes('graph TD; A-->B;'));
  assert.ok(out.includes('```mermaid'));
});

test('addHeaderIds：GitHub 风格 id、文档内去重', () => {
  const html = '<h1>Hello World</h1>\n<h2>Hello World</h2>\n<h2>Other</h2>';
  const out = C.addHeaderIds(html);
  assert.match(out, /<h1 id="hello-world">Hello World<\/h1>/);
  assert.match(out, /<h2 id="hello-world-2">Hello World<\/h2>/);
  assert.match(out, /<h2 id="other">Other<\/h2>/);
});

test('highlightCode：已知语言高亮、未知语言自动检测、异常回退原文', () => {
  const fakeHljs = {
    getLanguage: (l) => l === 'js',
    highlight: (_c, o) => ({ value: '<span>HIGHLIGHTED</span>' }),
    highlightAuto: (c) => ({ value: c }),
  };
  const html = '<pre><code class="language-js">const x = 1;</code></pre>';
  const out = C.highlightCode(html, fakeHljs);
  assert.match(out, /<span>HIGHLIGHTED<\/span>/);
  assert.match(out, /language-js hljs/);
  // 无 hljs 时原样返回
  assert.equal(C.highlightCode(html, null), html);
});

test('rewriteLinks：内部 .md 链接重写、外部与缺失目标保留', () => {
  const docByPath = new Map([['docs/a.md', { slug: 'docs-a' }]]);
  const html = [
    '<a href="docs/a.md">A</a>',
    '<a href="docs/a.md#sec-1">A2</a>',
    '<a href="https://example.com/x.md">外部</a>',
    '<a href="missing.md">缺失</a>',
    '<a href="#local">本地锚</a>',
  ].join('');
  const out = C.rewriteLinks(html, docByPath);
  assert.match(out, /<a href="#doc-docs-a">A<\/a>/);
  assert.match(out, /<a href="#doc-docs-a" data-anchor="sec-1">A2<\/a>/);
  assert.match(out, /<a href="https:\/\/example\.com\/x\.md">外部<\/a>/);
  assert.match(out, /<a href="missing\.md">缺失<\/a>/);
  assert.match(out, /<a href="#local">本地锚<\/a>/);
});

test('rewriteLinks：按所在文档目录解析相对链接，根相对写法兜底', () => {
  const docByPath = new Map([
    ['README.md', { slug: 'README' }],
    ['docs/child.md', { slug: 'docs-child' }],
    ['docs/sub/deep.md', { slug: 'docs-sub-deep' }],
  ]);
  const html = [
    '<a href="sub/deep.md">同目录子级</a>',
    '<a href="./sub/deep.md">点斜线</a>',
    '<a href="../README.md">上级</a>',
    '<a href="../README.md#小节">上级锚点</a>',
    '<a href="docs/child.md">根相对兜底</a>',
    '<a href="../../outside.md">越界</a>',
    '<a href="nope.md">缺失</a>',
  ].join('');
  const out = C.rewriteLinks(html, docByPath, 'docs/child.md');
  assert.match(out, /<a href="#doc-docs-sub-deep">同目录子级<\/a>/);
  assert.match(out, /<a href="#doc-docs-sub-deep">点斜线<\/a>/);
  assert.match(out, /<a href="#doc-README">上级<\/a>/);
  assert.match(out, /<a href="#doc-README" data-anchor="小节">上级锚点<\/a>/);
  assert.match(out, /<a href="#doc-docs-child">根相对兜底<\/a>/);
  assert.match(out, /<a href="\.\.\/\.\.\/outside\.md">越界<\/a>/);
  assert.match(out, /<a href="nope\.md">缺失<\/a>/);
});

test('normalizeRelPath：折叠 ./ 与 ..，越界返回 null', () => {
  assert.equal(C.normalizeRelPath('a/./b//c'), 'a/b/c');
  assert.equal(C.normalizeRelPath('a/b/../c'), 'a/c');
  assert.equal(C.normalizeRelPath('../a'), null);
  assert.equal(C.normalizeRelPath('a\\b'), 'a/b');
});

test('titleFromHtml：取首个 H1 纯文本，无 H1 用 fallback', () => {
  assert.equal(C.titleFromHtml('<h1> 标题 <em>x</em></h1><p>p</p>', 'f'), '标题 x');
  assert.equal(C.titleFromHtml('<p>no h1</p>', 'fallback'), 'fallback');
});
