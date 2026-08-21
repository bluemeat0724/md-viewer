/**
 * viewer-core 共享渲染工具单测。
 * 与 lib/build.mjs 相同的方式加载：副作用导入后读 globalThis.MDV_CORE。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import '../lib/assets/viewer-core.js';
const C = globalThis.MDV_CORE;
const require = createRequire(import.meta.url);

test('MDV_CORE 已通过副作用导入挂载', () => {
  assert.ok(C, 'globalThis.MDV_CORE 应为对象');
  for (const name of [
    'escHtml', 'escAttr', 'unescHtml', 'slugifyHeading', 'slugForPath', 'normalizeRelPath',
    'extractMermaid', 'addHeaderIds', 'highlightCode', 'rewriteLinks',
    'titleFromRaw', 'renderMarkdown', 'prettifyJson', 'prettyJsonHtml',
  ]) {
    assert.equal(typeof C[name], 'function', `${name} 应为函数`);
  }
});

test('escHtml / unescHtml 往返', () => {
  const raw = '<a href="x&y">\'q\'</a>';
  assert.equal(C.unescHtml(C.escHtml(raw)), raw);
  assert.equal(C.escHtml('<b>&'), '&lt;b&gt;&amp;');
});

test('escAttr：完整编码双引号属性中的敏感字符', () => {
  assert.equal(C.escAttr('<a "x" \'y\' &>'), '&lt;a &quot;x&quot; &#39;y&#39; &amp;&gt;');
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

test('slugForPath：.json 同样剥后缀，不残留 -json 尾巴', () => {
  assert.equal(C.slugForPath('data/config.json'), 'data-config');
  assert.equal(C.slugForPath('中文/配置.JSON'), '中文-配置');
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
  const docByPath = new Map([['docs/a.md', { slug: 'docs-a' }], ['data/config.json', { slug: 'data-config' }]]);
  const html = [
    '<a href="docs/a.md">A</a>',
    '<a href="docs/a.md#sec-1">A2</a>',
    '<a href="data/config.json">配置</a>',
    '<a href="https://example.com/x.md">外部</a>',
    '<a href="missing.md">缺失</a>',
    '<a href="#local">本地锚</a>',
    '<a href="./images/pic.png">非文档资源</a>',
  ].join('');
  const out = C.rewriteLinks(html, docByPath);
  assert.match(out, /<a href="#doc-docs-a">A<\/a>/);
  assert.match(out, /<a href="#doc-docs-a" data-anchor="sec-1">A2<\/a>/);
  assert.match(out, /<a href="#doc-data-config">配置<\/a>/);
  assert.match(out, /<a href="https:\/\/example\.com\/x\.md">外部<\/a>/);
  assert.match(out, /<a href="missing\.md">缺失<\/a>/);
  assert.match(out, /<a href="#local">本地锚<\/a>/);
  assert.match(out, /<a href="\.\/images\/pic\.png">非文档资源<\/a>/);
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

test('rewriteLinks：编码跨文档锚点属性', () => {
  const out = C.rewriteLinks(
    '<a href="a.md#%22%20data-bad%3D%22x">A</a>',
    new Map([['a.md', { slug: 'a' }]]),
  );
  assert.equal(out, '<a href="#doc-a" data-anchor="&quot; data-bad=&quot;x">A</a>');
  assert.ok(!out.includes('data-anchor=""'), '编码后的引号不应逃逸 data-anchor');
});

test('normalizeRelPath：折叠 ./ 与 ..，越界返回 null', () => {
  assert.equal(C.normalizeRelPath('a/./b//c'), 'a/b/c');
  assert.equal(C.normalizeRelPath('a/b/../c'), 'a/c');
  assert.equal(C.normalizeRelPath('../a'), null);
  assert.equal(C.normalizeRelPath('a\\b'), 'a/b');
});

test('titleFromRaw：md 取围栏外首个 H1、剥行内记号、无 H1 用 fallback', () => {
  assert.equal(C.titleFromRaw('md', '# 标题\n正文', 'f'), '标题');
  assert.equal(C.titleFromRaw('md', '前置说明\n\n# **加粗** 标题\n', 'f'), '加粗 标题');
  // 围栏内的 # 不是标题
  assert.equal(
    C.titleFromRaw('md', '```js\n# 注释不是标题\n```\n\n# 真·标题\n', 'f'),
    '真·标题',
  );
  assert.equal(C.titleFromRaw('md', '没有一级标题\n\n## 二级', 'fallback.md'), 'fallback.md');
});

test('titleFromRaw：json 取去后缀文件名', () => {
  assert.equal(C.titleFromRaw('json', '{"a":1}', '配置.JSON'), '配置');
  assert.equal(C.titleFromRaw('json', '', 'config.json'), 'config');
});

test('renderMarkdown：marked 渲染 + hljs 高亮 + 锚点 + mermaid 还原 + 链接重写', () => {
  const marked = require('marked');
  const hljs = require('highlight.js');
  const docByPath = new Map([['docs/child.md', { slug: 'docs-child' }], ['data/config.json', { slug: 'data-config' }]]);
  const raw = [
    '# 项目说明',
    '',
    '[子文档](docs/child.md) 与 [配置](data/config.json)',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    '```mermaid',
    'graph TD; A-->B;',
    '```',
  ].join('\n');
  const html = C.renderMarkdown(raw, { marked, hljs, docByPath, fromPath: 'README.md' });
  assert.match(html, /<h1 id="项目说明">项目说明<\/h1>/);
  assert.match(html, /class="language-js hljs"/);
  assert.match(html, /hljs-keyword/);
  assert.match(html, /<pre class="mermaid">graph TD; A--&gt;B;<\/pre>/);
  assert.match(html, /<a href="#doc-docs-child">子文档<\/a>/);
  assert.match(html, /<a href="#doc-data-config">配置<\/a>/);
});

test('prettifyJson：成功返回解析值，失败返回错误信息', () => {
  const ok = C.prettifyJson('{"b":1,"a":[1,2]}');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { b: 1, a: [1, 2] });
  const bad = C.prettifyJson('{oops}');
  assert.equal(bad.ok, false);
  assert.ok(typeof bad.error === 'string' && bad.error.length > 0);
});

test('prettyJsonHtml：pretty 文本 + 类型着色 + 深度 ≥ expand 折叠为 { ⋯ N }', () => {
  // 深度：root=0；b(数组)=1；b 内对象=2。expand=2 时仅最深层折叠
  const value = { a: 1, b: [1, { d: true }], e: {}, f: null, s: 'x"y' };
  const html = C.prettyJsonHtml(value, 2);

  // 展开层：键与值内联着色、2 空格缩进、逗号分隔
  assert.match(html, /<span class="jt-key">"a"<\/span><span class="jf-punc">: <\/span><span class="jt-val jt-number">1<\/span>/);
  assert.match(html, /jt-string">"x"y"<\/span>/);
  assert.match(html, /\n  <span class="jt-key">"a"<\/span>/, '一级子项应缩进 2 空格');
  // 空容器内联 {}，不产生折叠节点
  assert.match(html, /jt-object">\{\}<\/span>/);
  // 深度 2 的 { d: true } 折叠：data-folded + 隐藏 body + 标记（伪元素显示，不进复制文本）
  const folded = html.match(/<span class="jf-node" data-folded="1">/g) || [];
  assert.equal(folded.length, 1);
  assert.match(html, /class="jf-mark" data-label="1 个键" title="展开"><\/span>/);
  assert.match(html, /<span class="jf-body" hidden>/);
  // 展开容器的标记存在但隐藏
  assert.match(html, /class="jf-mark" data-label="2 项" title="展开" hidden>/);
});

test('prettyJsonHtml：expand=0 连根折叠；缺省 expand 默认 3；负数回退 3', () => {
  const value = { a: { b: { c: 1 } } };
  const root0 = C.prettyJsonHtml(value, 0);
  assert.match(root0, /^<span class="jf-node" data-folded="1">/);
  assert.match(root0, /data-label="1 个键"/);

  // 默认 3：深度 0-2 展开，深度 3 的叶子 c:1 直接是值，无折叠节点
  const def = C.prettyJsonHtml(value);
  assert.equal((def.match(/data-folded="1"/g) || []).length, 0);
  assert.match(def, /jt-number">1<\/span>/);

  assert.equal((C.prettyJsonHtml(value, -1).match(/data-folded="1"/g) || []).length, 0);
});
