/**
 * lib/build.mjs — md-viewer CLI 构建主体
 *
 * 扫描指定目录（默认执行目录）下所有 *.md，用 marked 渲染、highlight.js 高亮
 * 代码、抽取 mermaid 代码块，组装成一个自包含的 md-viewer.html。
 * 打开生成的 HTML 无需任何服务（file:// 双击即可）。
 *
 * 依赖（marked / highlight.js / mermaid / esbuild）随 npm 安装预置在包自身
 * node_modules，运行零等待；生成物只有输出 HTML 一个文件。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build as esbuildRun } from 'esbuild';

const require = createRequire(import.meta.url);

/** CLI 语义：扫描目录跳过依赖/产物类目录，避免把依赖包里的 md 扫进来 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv']);

/* ------------------------------------------------------------------ */
/* 工具函数（构建期）                                                    */
/* ------------------------------------------------------------------ */

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unescHtml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function slugifyHeading(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[\x60*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

async function findMds(dir, base = '') {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...(await findMds(full, rel)));
    } else if (e.name.toLowerCase().endsWith('.md')) {
      out.push(rel);
    }
  }
  return out;
}

/** 行级扫描：把 ```mermaid / ~~~mermaid 代码块抽取出来，其余原样保留 */
function extractMermaid(md, tag) {
  const blocks = [];
  const lines = md.split('\n');
  const out = [];
  let fence = null; // backtick | tilde
  let fenceLen = 0;
  let marker = '';
  let buf = [];
  let lang = '';

  for (const line of lines) {
    if (fence) {
      const close = /^ {0,3}(\x60{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence && close[1].length >= fenceLen) {
        if (lang === 'mermaid') {
          const idx = blocks.length;
          blocks.push(buf.join('\n'));
          out.push('[[' + tag + idx + ']]');
        } else {
          out.push(marker + lang);
          out.push(...buf);
          out.push(marker);
        }
        fence = null;
        buf = [];
        lang = '';
      } else {
        buf.push(line);
      }
    } else {
      const open = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
      if (open) {
        marker = open[1];
        fence = marker[0];
        fenceLen = marker.length;
        lang = open[2].trim().split(/\s+/)[0].toLowerCase();
      } else {
        out.push(line);
      }
    }
  }
  if (fence) {
    // 未闭合围栏：原样保留
    out.push(marker + lang);
    out.push(...buf);
    out.push(marker);
  }
  return { md: out.join('\n'), blocks };
}

/** 给渲染后的 HTML 的所有标题补 id（GitHub 风格，文档内去重） */
function addHeaderIds(html) {
  const used = new Map();
  return html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g, (m, level, attrs, inner) => {
    if (/id="/.test(attrs)) return m;
    const text = inner.replace(/<[^>]+>/g, '');
    let base = slugifyHeading(text) || 'section';
    let id = base;
    let i = 2;
    while (used.has(id)) id = base + '-' + i++;
    used.set(id, true);
    return '<h' + level + ' id="' + id + '"' + attrs + '>' + inner + '</h' + level + '>';
  });
}

/** 高亮 <pre><code class="language-x"> 代码块 */
function highlightCode(html, hljs) {
  return html.replace(
    /<pre><code class="language-([^"]+)">([\s\S]*?)<\/code><\/pre>/g,
    (m, lang, codeHtml) => {
      const code = unescHtml(codeHtml);
      let out;
      try {
        if (hljs.getLanguage(lang)) out = hljs.highlight(code, { language: lang }).value;
        else out = hljs.highlightAuto(code).value;
      } catch (e) {
        out = escHtml(code);
      }
      return '<pre><code class="language-' + lang + ' hljs">' + out + '</code></pre>';
    }
  );
}

/** 重写内部 .md 链接为页内 hash 跳转 */
function rewriteLinks(html, docByPath) {
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  return html.replace(/<a href="([^"]+)"/g, (m, href) => {
    if (/^(https?:|mailto:|tel:|javascript:|#)/i.test(href)) return m;
    // 先剥离 query 与锚点再判 .md 后缀（marked 会把 href 百分号编码，
    // 不先剥锚点则带 # 的链接过不了 endsWith 检查）
    let clean = href.split('?')[0];
    let anchor = '';
    const hIdx = clean.indexOf('#');
    if (hIdx >= 0) { anchor = clean.slice(hIdx + 1); clean = clean.slice(0, hIdx); }
    clean = safeDecode(clean);
    if (!clean.toLowerCase().endsWith('.md')) return m;
    const target = docByPath.get(clean);
    if (!target) return m; // 目标不在集合内：保留原相对链接
    const anchorAttr = anchor ? ' data-anchor="' + safeDecode(anchor) + '"' : '';
    return '<a href="#doc-' + target.slug + '"' + anchorAttr;
  });
}

function slugForPath(rel) {
  return rel.replace(/\.md$/i, '').replace(/[^A-Za-z0-9]+/g, '-');
}

/* ------------------------------------------------------------------ */
/* 页面模板（使用 %%TOKEN%% 占位，不含插值）                              */
/* ------------------------------------------------------------------ */

const CSS = `
:root{
  --bg:#ffffff; --fg:#1f2328; --muted:#59636e; --border:#d1d9e0; --accent:#0969da;
  --sidebar-bg:#f6f8fa; --hover:#eaeef2; --active-bg:#ddf4ff; --active-fg:#0969da;
  --code-bg:#f6f8fa; --pre-bg:#f6f8fa; --pre-border:#d1d9e0;
  --quote-border:#d1d9e0; --quote-bg:#f6f8fa; --th-bg:#f6f8fa;
  --link:#0969da; --scrollbar:#d0d7de; --shadow:rgba(31,35,40,.08);
  --hl-keyword:#cf222e; --hl-string:#0a3069; --hl-number:#0550ae; --hl-comment:#6e7781;
  --hl-title:#953800; --hl-attr:#0550ae; --hl-builtin:#8250df; --hl-literal:#0550ae; --hl-meta:#0550ae;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --border:#30363d; --accent:#4493f8;
    --sidebar-bg:#161b22; --hover:#21262d; --active-bg:#1f6feb33; --active-fg:#58a6ff;
    --code-bg:#161b22; --pre-bg:#161b22; --pre-border:#30363d;
    --quote-border:#30363d; --quote-bg:#161b22; --th-bg:#161b22;
    --link:#58a6ff; --scrollbar:#30363d; --shadow:rgba(1,4,9,.5);
    --hl-keyword:#ff7b72; --hl-string:#a5d6ff; --hl-number:#79c0ff; --hl-comment:#8b949e;
    --hl-title:#ffa657; --hl-attr:#79c0ff; --hl-builtin:#d2a8ff; --hl-literal:#79c0ff; --hl-meta:#79c0ff;
  }
}
html[data-theme="dark"]{
  --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --border:#30363d; --accent:#4493f8;
  --sidebar-bg:#161b22; --hover:#21262d; --active-bg:#1f6feb33; --active-fg:#58a6ff;
  --code-bg:#161b22; --pre-bg:#161b22; --pre-border:#30363d;
  --quote-border:#30363d; --quote-bg:#161b22; --th-bg:#161b22;
  --link:#58a6ff; --scrollbar:#30363d; --shadow:rgba(1,4,9,.5);
  --hl-keyword:#ff7b72; --hl-string:#a5d6ff; --hl-number:#79c0ff; --hl-comment:#8b949e;
  --hl-title:#ffa657; --hl-attr:#79c0ff; --hl-builtin:#d2a8ff; --hl-literal:#79c0ff; --hl-meta:#79c0ff;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;
  background:var(--bg); color:var(--fg); line-height:1.7; font-size:15px;
}
a{color:var(--link); text-decoration:none}
a:hover{text-decoration:underline}
#app{display:grid; grid-template-columns:300px minmax(0,1fr); min-height:100vh}
/* ---------------- 侧边栏 ---------------- */
#sidebar{
  position:sticky; top:0; height:100vh; display:flex; flex-direction:column;
  background:var(--sidebar-bg); border-right:1px solid var(--border); z-index:20; overflow:hidden;
}
.sidebar-head{display:flex; align-items:center; justify-content:space-between; padding:14px 14px 10px; gap:8px}
.brand{font-weight:700; font-size:15px; line-height:1.35}
#sidebar-close{display:none; border:0; background:none; color:var(--muted); font-size:20px; cursor:pointer}
#search{
  margin:0 12px 8px; padding:8px 10px; border:1px solid var(--border); border-radius:8px;
  background:var(--bg); color:var(--fg); font-size:13px; outline:none; width:calc(100% - 24px);
}
#search:focus{border-color:var(--accent); box-shadow:0 0 0 3px var(--active-bg)}
#search-count{font-size:12px; color:var(--muted); padding:0 14px 6px; min-height:1em}
#toc{flex:1; overflow-y:auto; padding:0 8px 12px; scrollbar-width:thin; scrollbar-color:var(--scrollbar) transparent}
#toc::-webkit-scrollbar{width:8px}
#toc::-webkit-scrollbar-thumb{background:var(--scrollbar); border-radius:4px}
.toc-group-title{
  display:flex; align-items:center; gap:6px; width:100%; text-align:left;
  border:0; background:none; cursor:pointer; font-family:inherit;
  font-size:12.5px; font-weight:600; color:var(--muted);
  padding:8px 8px 4px;
}
button.toc-group-title:hover{color:var(--fg); background:var(--hover); border-radius:6px}
.toc-caret{display:inline-block; font-size:9px; transition:transform .15s ease}
.toc-group:not(.collapsed) .toc-caret{transform:rotate(90deg)}
.toc-count{margin-left:auto; font-size:10.5px; font-weight:500; color:var(--muted)}
.toc-group.collapsed .toc-group-body{display:none}
/* 嵌套子树的浅色树线，增强层级感 */
.toc-group-body .toc-group-body{border-left:1px solid var(--border); margin-left:12px}
/* 搜索时强制展开所有分组，避免命中项藏在折叠里 */
#toc.filtering .toc-group.collapsed .toc-group-body{display:block}
.toc-item{
  display:block; width:100%; text-align:left; border:0; background:none; cursor:pointer;
  padding:7px 10px; margin:1px 0; border-radius:8px; color:var(--fg); font-size:13.5px; font-family:inherit;
}
.toc-item:hover{background:var(--hover)}
.toc-item.active{background:var(--active-bg); color:var(--active-fg)}
.toc-item.active .toc-path{color:var(--active-fg)}
.toc-title{display:block; font-weight:500; line-height:1.4}
.toc-path{display:block; font-size:11.5px; color:var(--muted); line-height:1.4; word-break:break-all}
.side-foot{
  padding:10px 14px; border-top:1px solid var(--border); font-size:11.5px; color:var(--muted); line-height:1.6; white-space:pre-line;
}
#scrim{display:none}
/* ---------------- 主区 ---------------- */
#main{display:flex; flex-direction:column; min-width:0; min-height:100vh}
.toolbar{
  position:sticky; top:0; z-index:15; display:flex; align-items:center; gap:10px;
  padding:10px 16px; background:color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter:blur(6px);
  border-bottom:1px solid var(--border);
}
#sidebar-toggle{display:none; border:1px solid var(--border); background:none; color:var(--fg); border-radius:8px; padding:4px 10px; font-size:15px; cursor:pointer}
.crumbs{flex:1; min-width:0; font-size:13px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.crumb-root{color:var(--muted)}
#crumb-doc{color:var(--fg); font-weight:600}
.toolbar-actions{display:flex; gap:6px; flex-shrink:0}
.tbtn{
  border:1px solid var(--border); background:none; color:var(--fg); border-radius:8px;
  padding:4px 10px; font-size:12.5px; cursor:pointer; font-family:inherit;
}
.tbtn:hover{background:var(--hover)}
.tbtn:disabled{opacity:.4; cursor:default}
.tbtn[hidden]{display:none}
#content-wrap{display:grid; grid-template-columns:minmax(0,1fr); flex:1}
#outline{display:none}
@media (min-width:1280px){
  #content-wrap{grid-template-columns:minmax(0,1fr) 250px}
  #outline{
    display:block; position:sticky; top:57px; align-self:start; max-height:calc(100vh - 70px);
    overflow-y:auto; padding:18px 16px 30px 6px; border-left:1px solid var(--border); margin-left:8px;
    scrollbar-width:thin;
  }
}
.outline-title{font-size:11.5px; font-weight:700; letter-spacing:.06em; color:var(--muted); margin-bottom:8px}
.outline-item{
  display:block; font-size:12.5px; color:var(--muted); padding:3px 8px; border-left:2px solid transparent;
  border-radius:0 6px 6px 0; line-height:1.5; word-break:break-all;
}
.outline-item:hover{color:var(--fg); background:var(--hover)}
.outline-item.active{color:var(--active-fg); border-left-color:var(--accent); background:var(--active-bg)}
.outline-item.lvl3{padding-left:20px}
.outline-item.lvl4{padding-left:32px}
.outline-empty{font-size:12.5px; color:var(--muted); padding:4px 8px}
#docs{max-width:900px; margin:0 auto; padding:0 22px; width:100%}
article.doc{display:block; padding:22px 0 60px}
/* ---------------- 文档排版 ---------------- */
.doc h1{font-size:1.7em; border-bottom:1px solid var(--border); padding-bottom:.35em; margin:.6em 0 .8em}
.doc h2{font-size:1.35em; border-bottom:1px solid var(--border); padding-bottom:.3em; margin:1.6em 0 .7em}
.doc h3{font-size:1.15em; margin:1.4em 0 .5em}
.doc h4{font-size:1.02em; margin:1.2em 0 .4em}
.doc h1,.doc h2,.doc h3,.doc h4,.doc h5,.doc h6{scroll-margin-top:80px; line-height:1.4}
.doc p{margin:.7em 0}
.doc ul,.doc ol{margin:.6em 0; padding-left:1.6em}
.doc li{margin:.25em 0}
.doc li > ul,.doc li > ol{margin:.2em 0}
.doc blockquote{
  margin:.8em 0; padding:.4em 1em; border-left:4px solid var(--quote-border);
  background:var(--quote-bg); border-radius:0 8px 8px 0; color:var(--muted);
}
.doc blockquote p{margin:.3em 0}
.doc code{
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  font-size:13px; background:var(--code-bg); border-radius:4px; padding:.15em .4em;
}
.doc pre{
  background:var(--pre-bg); border:1px solid var(--pre-border); border-radius:8px;
  padding:12px 14px; overflow-x:auto; line-height:1.55; font-size:13px; margin:.9em 0;
  scrollbar-width:thin;
}
.doc pre code{background:none; padding:0; font-size:13px}
.doc table{border-collapse:collapse; margin:.9em 0; display:block; overflow-x:auto; max-width:100%; font-size:13.5px}
.doc th,.doc td{border:1px solid var(--border); padding:7px 12px; text-align:left}
.doc th{background:var(--th-bg); font-weight:600; white-space:nowrap}
.doc tr:nth-child(2n) td{background:color-mix(in srgb, var(--bg) 97%, var(--muted))}
.doc hr{border:0; border-top:1px solid var(--border); margin:1.6em 0}
.doc img{max-width:100%}
.doc .mermaid-svg{text-align:center; background:none; border:0}
.doc .mermaid-svg svg{max-width:100%; height:auto}
.doc .mermaid-err{border-color:color-mix(in srgb, var(--hl-keyword) 40%, var(--border))}
.mermaid-err-tip{font-size:12px; color:var(--hl-keyword); margin-bottom:6px}
/* ---------------- Mermaid 缩放容器（缩放范围 100%~400%） ---------------- */
.doc .mmd-zoom-wrap{
  border:1px solid var(--border); border-radius:8px; overflow:hidden; margin:.9em 0;
  background:var(--pre-bg);
}
.mmd-zoom-bar{
  display:flex; align-items:center; gap:6px; padding:6px 8px;
  border-bottom:1px solid var(--border); background:var(--bg);
}
.mmd-zbtn{
  border:1px solid var(--border); background:none; color:var(--fg); border-radius:6px;
  padding:2px 9px; font-size:12.5px; cursor:pointer; font-family:inherit; line-height:1.6;
}
.mmd-zbtn:hover{background:var(--hover)}
.mmd-zoom-pct{font-size:12px; color:var(--muted); min-width:42px; text-align:center; font-variant-numeric:tabular-nums}
.mmd-zoom-tip{margin-left:auto; font-size:11px; color:var(--muted)}
.mmd-viewport{
  height:520px; overflow:hidden; display:flex; align-items:center; justify-content:center;
  cursor:grab; touch-action:none; user-select:none;
}
.mmd-viewport.mmd-dragging{cursor:grabbing}
/* mermaid 输出的 svg 带 width="100%"（永远撑满容器），若保留它，
   外层 transform 放大时 svg 会反向缩回容器宽，两者抵消导致“放不大”；
   所以 JS 里会把 svg 钉成 viewBox 对应的固定像素尺寸，stage 只负责居 中，
   缩放完全由 transform 控制。100% 定义为初始铺满可用区域的适配尺寸。 */
.mmd-stage{
  width:100%; height:100%; display:flex; align-items:center; justify-content:center;
  transform-origin:center center;
  /* 不要加 will-change:transform：提前提升的合成图层按 1 倍分辨率光栅化，
     transform 放大时会拉伸位图导致文字发虚，去掉后浏览器按当前缩放重新矢量渲染 */
}
.mmd-stage svg{flex:none}
.mmd-zoom-wrap.mmd-full{
  position:fixed; inset:16px; z-index:10000; margin:0; background:var(--bg);
  display:flex; flex-direction:column; box-shadow:0 10px 44px rgba(0,0,0,.4);
}
.mmd-zoom-wrap.mmd-full .mmd-viewport{flex:1; height:auto}
.doc-meta{
  margin-top:2.2em; padding-top:1em; border-top:1px solid var(--border);
  font-size:12px; color:var(--muted);
}
.doc-meta a{color:var(--muted); text-decoration:underline}
/* ---------------- hljs 配色（双主题变量） ---------------- */
.hljs-keyword,.hljs-selector-tag,.hljs-doctag,.hljs-strong,.hljs-name{color:var(--hl-keyword); font-weight:600}
.hljs-string,.hljs-regexp,.hljs-addition,.hljs-selector-pseudo,.hljs-selector-attr{color:var(--hl-string)}
.hljs-number,.hljs-literal,.hljs-symbol,.hljs-bullet,.hljs-char{color:var(--hl-number)}
.hljs-comment,.hljs-quote{color:var(--hl-comment); font-style:italic}
.hljs-title,.hljs-section,.hljs-selector-id,.hljs-type,.hljs-class .hljs-title{color:var(--hl-title)}
.hljs-attr,.hljs-attribute,.hljs-variable,.hljs-template-variable,.hljs-selector-class{color:var(--hl-attr)}
.hljs-built_in,.hljs-builtin-name{color:var(--hl-builtin)}
.hljs-meta,.hljs-params,.hljs-title.function_{color:var(--hl-meta)}
.hljs-emphasis{font-style:italic}
.hljs-deletion{color:var(--hl-keyword)}
/* ---------------- 移动端 ---------------- */
@media (max-width:1023px){
  #app{grid-template-columns:minmax(0,1fr)}
  #sidebar{
    position:fixed; left:0; top:0; width:300px; transform:translateX(-105%);
    transition:transform .2s ease; box-shadow:0 0 24px var(--shadow);
  }
  body.sidebar-open #sidebar{transform:none}
  body.sidebar-open #scrim{display:block; position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:10; border:0}
  #sidebar-close{display:block}
  #sidebar-toggle{display:block}
}
@media print{
  #sidebar,#outline,.toolbar,#scrim{display:none !important}
  #app{display:block}
  #content-wrap{display:block}
  #docs{max-width:none; padding:0}
  article.doc{display:block !important; padding:0}
  .doc pre{white-space:pre-wrap}
}
`;

const HTML_TMPL = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%%TITLE%%</title>
<style>
%%CSS%%
</style>
<script>
(function(){try{var t=localStorage.getItem('mdv-theme')||'auto';var d=t==='dark'||(t==='auto'&&window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light');}catch(e){document.documentElement.setAttribute('data-theme','light');}})();
</script>
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <div class="sidebar-head">
      <div class="brand">📚 %%TITLE%%</div>
      <button id="sidebar-close" title="关闭目录" aria-label="关闭目录">×</button>
    </div>
    <input id="search" type="search" placeholder="搜索文件名 / 正文… ( / )" autocomplete="off">
    <div id="search-count"></div>
    <nav id="toc" aria-label="文档目录"></nav>
    <div id="side-foot" class="side-foot"></div>
  </aside>
  <div id="scrim" role="presentation"></div>
  <main id="main">
    <header class="toolbar">
      <button id="sidebar-toggle" title="目录" aria-label="打开目录">☰</button>
      <div class="crumbs"><span class="crumb-root">%%TITLE%%</span>&nbsp;/&nbsp;<span id="crumb-doc">…</span></div>
      <div class="toolbar-actions">
        <button class="tbtn" id="btn-prev" title="上一篇 ( [ )">← 上一篇</button>
        <button class="tbtn" id="btn-next" title="下一篇 ( ] )">下一篇 →</button>
        <button class="tbtn" id="btn-theme" title="主题：自动 / 浅色 / 深色">🌗</button>
        <button class="tbtn" id="btn-print" title="打印当前文档">🖨</button>
      </div>
    </header>
    <div id="content-wrap">
      <div id="docs">
        <article class="doc" id="doc-content"></article>
      </div>
      <nav id="outline" aria-label="本页目录">
        <div class="outline-title">本页目录</div>
        <div id="outline-list"></div>
      </nav>
    </div>
  </main>
</div>
<script>
%%MARKED_BUNDLE%%
</script>
<script>
%%HLJS_BUNDLE%%
</script>
<script>
%%MERMAID_BUNDLE%%
</script>
<script>
%%APP_JS%%
</script>
</body>
</html>
`;

const APP_JS = `(function () {
  'use strict';
  var META = %%META_JSON%%;
  var SNAPSHOT = %%DOCS_JSON%%;
  var SITE_TITLE = %%TITLE_JSON%%;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function unesc(s) {
    return String(s).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
  }

  var tocEl = $('toc');
  var search = $('search');
  var searchCount = $('search-count');
  var outlineList = $('outline-list');
  var docContent = $('doc-content');
  var currentSlug = null;
  var pendingAnchor = null;
  var mmCounter = 0;
  var mmZoomCounter = 0;
  var textCache = {};
  var themePref = 'auto';
  try { themePref = localStorage.getItem('mdv-theme') || 'auto'; } catch (e) {}

  /* ---------------- 文档集合状态 ---------------- */
  // 始终使用构建时快照；扫描目录在构建期固定，无需运行时选文件夹。
  var docs = [];               // [{slug,path,group,title,html}]
  var docBySlug = {};
  var docByPath = {};          // rel -> {slug}

  function rebuildIndexes() {
    docBySlug = {};
    docByPath = {};
    textCache = {};
    docs.forEach(function (d) { docBySlug[d.slug] = d; docByPath[d.path] = { slug: d.slug }; });
  }

  /* ---------------- 客户端 Markdown 渲染管线（实时模式用） ---------------- */
  function slugifyHeading(t) {
    return String(t).toLowerCase().trim()
      .replace(/[\\\x60*_~]/g, '')
      .replace(/[^\\p{L}\\p{N}\\s-]/gu, '')
      .replace(/\\s+/g, '-');
  }
  function slugForPath(rel) { return rel.replace(/\\.md$/i, '').replace(/[^A-Za-z0-9]+/g, '-'); }

  function extractMermaid(md, tag) {
    var blocks = [];
    var lines = md.split('\\n');
    var out = [];
    var fence = null, fenceLen = 0, marker = '', buf = [], lang = '';
    lines.forEach(function (line) {
      if (fence) {
        var close = /^ {0,3}(\x60{3,}|~{3,})[ \\t]*$/.exec(line);
        if (close && close[1].charAt(0) === fence && close[1].length >= fenceLen) {
          if (lang === 'mermaid') {
            blocks.push(buf.join('\\n'));
            out.push('[[' + tag + blocks.length + ']]');
          } else {
            out.push(marker + lang);
            out = out.concat(buf);
            out.push(marker);
          }
          fence = null; buf = []; lang = '';
        } else buf.push(line);
      } else {
        var open = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
        if (open) {
          marker = open[1]; fence = marker.charAt(0); fenceLen = marker.length;
          lang = (open[2].trim().split(/\\s+/)[0] || '').toLowerCase();
        } else out.push(line);
      }
    });
    if (fence) { out.push(marker + lang); out = out.concat(buf); out.push(marker); }
    return { md: out.join('\\n'), blocks: blocks };
  }

  function addHeaderIds(html) {
    var used = {};
    return html.replace(/<h([1-6])([^>]*)>([\\s\\S]*?)<\\/h\\1>/g, function (m, level, attrs, inner) {
      if (/id="/.test(attrs)) return m;
      var text = inner.replace(/<[^>]+>/g, '');
      var base = slugifyHeading(text) || 'section';
      var id = base, i = 2;
      while (used[id]) id = base + '-' + (i++);
      used[id] = true;
      return '<h' + level + ' id="' + id + '"' + attrs + '>' + inner + '</h' + level + '>';
    });
  }

  function highlightCode(html) {
    if (!window.hljs) return html;
    return html.replace(/<pre><code class="language-([^"]+)">([\\s\\S]*?)<\\/code><\\/pre>/g,
      function (m, lang, codeHtml) {
        var code = unesc(codeHtml);
        var out;
        try {
          if (window.hljs.getLanguage(lang)) out = window.hljs.highlight(code, { language: lang }).value;
          else out = window.hljs.highlightAuto(code).value;
        } catch (e) { out = esc(code); }
        return '<pre><code class="language-' + lang + ' hljs">' + out + '</code></pre>';
      });
  }

  function rewriteLinks(html) {
    return html.replace(/<a href="([^"]+)"/g, function (m, href) {
      if (/^(https?:|mailto:|tel:|javascript:|#)/i.test(href)) return m;
      var qIdx = href.indexOf('?');
      var clean = qIdx >= 0 ? href.slice(0, qIdx) : href;
      if (!/\\.md$/i.test(clean)) return m;
      var parts = clean.split('#');
      var target = docByPath[parts[0]];
      if (!target) return m;
      var anchor = parts[1] ? ' data-anchor="' + parts[1] + '"' : '';
      return '<a href="#doc-' + target.slug + '"' + anchor;
    });
  }

  function renderMarkdown(raw) {
    if (!window.marked) return '<pre>' + esc(raw) + '</pre>';
    var tag = 'MMD' + Math.random().toString(16).slice(2);
    var r = extractMermaid(raw, tag);
    var html = window.marked.parse(r.md, { gfm: true });
    html = html.replace(new RegExp('<p>\\\\[\\\\[' + tag + '(\\\\d+)\\\\]\\\\]</p>', 'g'), function (m, n) {
      return '<pre class="mermaid">' + esc(r.blocks[+n]) + '</pre>';
    });
    html = highlightCode(html);
    html = addHeaderIds(html);
    html = rewriteLinks(html);
    return html;
  }

  function titleFromHtml(html, fallback) {
    var m = /<h1[^>]*>([\\s\\S]*?)<\\/h1>/.exec(html);
    return m ? m[1].replace(/<[^>]+>/g, '').trim() || fallback : fallback;
  }

  /* ---------------- 主题 ---------------- */
  function resolveTheme() {
    if (themePref === 'dark') return 'dark';
    if (themePref === 'light') return 'light';
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { return 'light'; }
  }
  function applyTheme() {
    var t = resolveTheme();
    document.documentElement.setAttribute('data-theme', t);
    $('btn-theme').textContent = themePref === 'auto' ? '🌗' : (t === 'dark' ? '🌙' : '☀️');
    if (currentSlug) renderMermaid();
  }
  $('btn-theme').addEventListener('click', function () {
    var order = ['auto', 'light', 'dark'];
    var i = order.indexOf(themePref);
    themePref = order[(i + 1) % order.length];
    try { localStorage.setItem('mdv-theme', themePref); } catch (e) {}
    applyTheme();
  });
  /* ---------------- 侧边栏 ---------------- */
  // 文件树：根目录文档平铺，文件夹递归嵌套、默认收起，每层按文件系统顺序混排。
  // 副标题只显文件名：树形分组已表达层级，完整路径太长会把侧边栏撑爆，
  // 完整路径保留在 hover tooltip 里。
  function tocItemHtml(d, depth) {
    var fname = d.path.split('/').pop();
    return '<button type="button" class="toc-item" data-slug="' + esc(d.slug) + '" title="' + esc(d.path) + '" style="padding-left:' + (10 + depth * 14) + 'px">' +
           '<span class="toc-title">' + esc(d.title) + '</span>' +
           '<span class="toc-path">' + esc(fname) + '</span></button>';
  }
  function buildTree() {
    var root = { name: '', type: 'dir', children: {}, count: 0 };
    docs.forEach(function (d) {
      var parts = d.path.split('/');
      var node = root;
      for (var i = 0; i < parts.length - 1; i++) {
        if (!node.children[parts[i]]) node.children[parts[i]] = { name: parts[i], type: 'dir', children: {}, count: 0 };
        node = node.children[parts[i]];
      }
      node.children[parts[parts.length - 1]] = { name: parts[parts.length - 1], type: 'file', doc: d };
    });
    (function count(n) {
      var c = 0;
      Object.keys(n.children).forEach(function (k) {
        var ch = n.children[k];
        c += ch.type === 'file' ? 1 : count(ch);
      });
      n.count = c;
      return c;
    })(root);
    return root;
  }
  function sortChildren(node) {
    // 与文件浏览器一致：文件夹在前、文件在后，各自按名称排序
    return Object.keys(node.children).map(function (k) { return node.children[k]; })
      .sort(function (a, b) {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
      });
  }
  function renderNode(node, depth) {
    if (node.type === 'file') return tocItemHtml(node.doc, depth);
    var html = '<div class="toc-group collapsed">' +
      '<button type="button" class="toc-group-title" aria-expanded="false" title="展开 / 收起" style="padding-left:' + (8 + depth * 14) + 'px">' +
        '<span class="toc-caret">▶</span>' + esc(node.name) +
        '<span class="toc-count">' + node.count + '</span>' +
      '</button><div class="toc-group-body">';
    sortChildren(node).forEach(function (ch) { html += renderNode(ch, depth + 1); });
    return html + '</div></div>';
  }
  function renderSidebar() {
    var html = '';
    sortChildren(buildTree()).forEach(function (ch) { html += renderNode(ch, 0); });
    tocEl.innerHTML = html;
    Array.prototype.forEach.call(tocEl.querySelectorAll('.toc-item'), function (btn) {
      btn.addEventListener('click', function () { navigate(btn.getAttribute('data-slug')); });
    });
    Array.prototype.forEach.call(tocEl.querySelectorAll('button.toc-group-title'), function (btn) {
      btn.addEventListener('click', function () {
        var grp = btn.parentNode;
        var collapsed = grp.classList.toggle('collapsed');
        btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      });
    });
    if (search.value.trim()) applyFilter();
  }
  // 当前文档若藏在折叠分组里，逐层展开其所有祖先分组
  function expandGroupOf(slug) {
    var btn = tocEl.querySelector('.toc-item[data-slug="' + slug + '"]');
    if (!btn) return;
    var el = btn.parentElement;
    while (el && el !== tocEl) {
      if (el.classList && el.classList.contains('toc-group') && el.classList.contains('collapsed')) {
        el.classList.remove('collapsed');
        var t = el.firstElementChild;
        if (t && t.tagName === 'BUTTON') t.setAttribute('aria-expanded', 'true');
      }
      el = el.parentElement;
    }
  }

  function docText(d) {
    if (textCache[d.slug] !== undefined) return textCache[d.slug];
    var div = document.createElement('div');
    div.innerHTML = d.html;
    var t = div.textContent || '';
    textCache[d.slug] = t;
    return t;
  }

  function applyFilter() {
    var q = search.value.trim().toLowerCase();
    tocEl.classList.toggle('filtering', !!q);
    var items = Array.prototype.slice.call(tocEl.querySelectorAll('.toc-item'));
    if (!q) {
      items.forEach(function (b) { b.style.display = ''; });
      searchCount.textContent = '';
      return;
    }
    var hits = 0;
    items.forEach(function (b) {
      var d = docBySlug[b.getAttribute('data-slug')];
      if (!d) return;
      var match = d.path.toLowerCase().indexOf(q) !== -1 || d.title.toLowerCase().indexOf(q) !== -1;
      if (!match && q.length >= 2) match = docText(d).toLowerCase().indexOf(q) !== -1;
      b.style.display = match ? '' : 'none';
      if (match) hits++;
    });
    searchCount.textContent = hits === 0 ? '无匹配文档' : '匹配 ' + hits + ' 篇文档';
  }
  search.addEventListener('input', applyFilter);

  /* ---------------- 文档切换 ---------------- */
  function docFooterHtml(d) {
    return '<footer class="doc-meta">源文件：<a href="./' + esc(d.path) + '" target="_blank" rel="noopener">' + esc(d.path) +
           '</a>（构建时快照 · 在新标签页打开原始 Markdown）</footer>';
  }

  function showDoc(slug, opts) {
    opts = opts || {};
    if (!docBySlug[slug]) slug = docs.length ? docs[0].slug : null;
    if (!slug) return;
    currentSlug = slug;
    var d = docBySlug[slug];
    docContent.innerHTML = d.html + docFooterHtml(d);
    Array.prototype.forEach.call(tocEl.querySelectorAll('.toc-item'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-slug') === slug);
    });
    expandGroupOf(slug);
    $('crumb-doc').textContent = d.title;
    document.title = d.title + ' · ' + SITE_TITLE;
    var idx = docs.indexOf(d);
    $('btn-prev').setAttribute('data-slug', docs[(idx - 1 + docs.length) % docs.length].slug);
    $('btn-next').setAttribute('data-slug', docs[(idx + 1) % docs.length].slug);
    buildOutline();
    renderMermaid();
    if (opts.scrollTop) window.scrollTo(0, 0);
    if (pendingAnchor) {
      var el = docContent.querySelector('[id="' + pendingAnchor + '"]');
      pendingAnchor = null;
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    }
  }

  function navigate(slug) {
    pendingAnchor = null;
    showDoc(slug, { scrollTop: true });
    try { if (location.hash !== '#doc-' + slug) location.hash = 'doc-' + slug; } catch (e) {}
  }

  function slugFromHash() {
    var h = location.hash;
    if (h && h.indexOf('#doc-') === 0) return h.slice(5);
    return null;
  }

  window.addEventListener('hashchange', function () {
    var s = slugFromHash();
    if (s && s !== currentSlug) showDoc(s, { scrollTop: true });
  });

  /* ---------------- 本页目录 ---------------- */
  function buildOutline() {
    outlineList.innerHTML = '';
    var heads = docContent.querySelectorAll('h2, h3, h4');
    if (!heads.length) {
      outlineList.innerHTML = '<div class="outline-empty">（本文无二级标题）</div>';
      return;
    }
    var html = '';
    Array.prototype.forEach.call(heads, function (h) {
      if (!h.id) h.id = 'h' + (++mmCounter);
      html += '<a class="outline-item lvl' + h.tagName.charAt(1) + '" href="#' + h.id + '" data-id="' + h.id + '">' + esc((h.textContent || '').trim()) + '</a>';
    });
    outlineList.innerHTML = html;
    Array.prototype.forEach.call(outlineList.querySelectorAll('a'), function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        var el = docContent.querySelector('[id="' + a.getAttribute('data-id') + '"]');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    updateSpy();
  }

  var spyTicking = false;
  window.addEventListener('scroll', function () {
    if (spyTicking) return;
    spyTicking = true;
    requestAnimationFrame(function () { spyTicking = false; updateSpy(); });
  });
  function updateSpy() {
    if (!currentSlug) return;
    var heads = docContent.querySelectorAll('h2, h3, h4');
    var pos = window.scrollY + 90;
    var current = null;
    Array.prototype.forEach.call(heads, function (h) {
      if (h.offsetTop <= pos) current = h;
    });
    Array.prototype.forEach.call(outlineList.querySelectorAll('a'), function (a) {
      a.classList.toggle('active', !!(current && a.getAttribute('data-id') === current.id));
    });
  }

  /* ---------------- Mermaid ---------------- */
  function mmTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default';
  }
  function markMermaidFallback() {
    Array.prototype.forEach.call(docContent.querySelectorAll('pre.mermaid'), function (pre) {
      var raw = pre.textContent;
      pre.outerHTML = '<pre class="mermaid-err"><div class="mermaid-err-tip">⚠ Mermaid 未加载，已显示源码</div><code>' + esc(raw) + '</code></pre>';
    });
  }
  function renderMermaid() {
    if (typeof window.mermaid === 'undefined') { markMermaidFallback(); return; }
    var theme = mmTheme();
    window.mermaid.initialize({
      startOnLoad: false,
      theme: theme,
      securityLevel: 'loose',
      fontFamily: '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",sans-serif'
    });
    Array.prototype.forEach.call(docContent.querySelectorAll('pre.mermaid'), function (pre) {
      if (pre.getAttribute('data-rendered') === theme) return;
      var code = pre.textContent;
      window.mermaid.parse(code).then(function () {
        var id = 'mmd-' + (++mmCounter);
        return window.mermaid.render(id, code).then(function (r) {
          pre.innerHTML = r.svg;
          pre.setAttribute('data-rendered', theme);
          pre.classList.remove('mermaid');
          pre.classList.add('mermaid-svg');
          enableMermaidZoom(pre);
        });
      }).catch(function () {
        pre.outerHTML = '<pre class="mermaid-err"><div class="mermaid-err-tip">⚠ Mermaid 渲染失败，已显示源码</div><code>' + esc(code) + '</code></pre>';
      });
    });
  }

  /* ---------------- Mermaid 缩放 / 平移 / 全屏 ---------------- */
  // 工厂函数：为单张已渲染的 Mermaid 图挂载独立缩放交互状态。
  // 缩放范围按项目规范限制在 100%~400%，禁止缩小到原始尺寸以下。
  function enableMermaidZoom(pre) {
    var svg = pre.querySelector('svg');
    if (!svg) return;
    var wrapId = 'mmdz-' + (++mmZoomCounter);
    var wrap = document.createElement('div');
    wrap.className = 'mmd-zoom-wrap';
    wrap.id = wrapId;
    wrap.innerHTML =
      '<div class="mmd-zoom-bar">' +
        '<button type="button" class="mmd-zbtn" data-act="out" title="缩小">−</button>' +
        '<span class="mmd-zoom-pct">100%</span>' +
        '<button type="button" class="mmd-zbtn" data-act="in" title="放大">＋</button>' +
        '<button type="button" class="mmd-zbtn" data-act="reset" title="还原到 100%">↺ 还原</button>' +
        '<button type="button" class="mmd-zbtn" data-act="full" title="全屏查看">⛶ 全屏</button>' +
        '<span class="mmd-zoom-tip">滚轮缩放 · 拖拽平移</span>' +
      '</div>';
    var vp = document.createElement('div');
    vp.className = 'mmd-viewport';
    var stage = document.createElement('div');
    stage.className = 'mmd-stage';
    vp.appendChild(stage);
    wrap.appendChild(vp);
    pre.parentNode.replaceChild(wrap, pre);
    stage.appendChild(svg);
    // 把 svg 钉成固定像素尺寸：mermaid 输出的 svg 自带 width="100%"，
    // 保留它会随容器反向伸缩，抵消 transform 缩放，导致无法真正放大。
    // 尺寸按 viewBox 宽高比、铺满可用区域（留 28px 边距）计算，作为 100% 基准。
    var vb = svg.viewBox && svg.viewBox.baseVal;
    var ratio = vb && vb.height > 0 ? vb.width / vb.height : 4 / 3;
    var availW = Math.max(80, vp.clientWidth - 28);
    var availH = Math.max(80, vp.clientHeight - 28);
    var baseW = availW, baseH = availW / ratio;
    if (baseH > availH) { baseH = availH; baseW = baseH * ratio; }
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.width = baseW + 'px';
    svg.style.height = baseH + 'px';
    svg.style.maxWidth = 'none';

    var MIN_SCALE = 1, MAX_SCALE = 4;
    var scale = 1, tx = 0, ty = 0;
    var pct = wrap.querySelector('.mmd-zoom-pct');
    function apply() {
      stage.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
      pct.textContent = Math.round(scale * 100) + '%';
    }
    function clamp(s) { return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)); }
    function setScale(s) {
      scale = clamp(s);
      if (scale === MIN_SCALE) { tx = 0; ty = 0; }
      apply();
    }
    wrap.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.mmd-zbtn') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'in') setScale(scale * 1.25);
      else if (act === 'out') setScale(scale / 1.25);
      else if (act === 'reset') { scale = 1; tx = 0; ty = 0; apply(); }
      else if (act === 'full') {
        var on = wrap.classList.toggle('mmd-full');
        btn.textContent = on ? '⛶ 退出全屏' : '⛶ 全屏';
      }
    });
    vp.addEventListener('wheel', function (e) {
      e.preventDefault();
      setScale(scale + (e.deltaY < 0 ? 0.15 : -0.15));
    }, { passive: false });
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    vp.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragging = true; sx = e.clientX; sy = e.clientY; ox = tx; oy = ty;
      vp.classList.add('mmd-dragging');
      try { vp.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    vp.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      tx = ox + (e.clientX - sx);
      ty = oy + (e.clientY - sy);
      apply();
    });
    function endDrag() { dragging = false; vp.classList.remove('mmd-dragging'); }
    vp.addEventListener('pointerup', endDrag);
    vp.addEventListener('pointercancel', endDrag);
  }

  /* ---------------- 跨文档锚点链接 ---------------- */
  $('content-wrap').addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (!a || !a.hasAttribute('data-anchor')) return;
    var slug = (a.getAttribute('href') || '').replace('#doc-', '');
    pendingAnchor = a.getAttribute('data-anchor');
    if (slug === currentSlug) showDoc(slug, {});
  });

  /* ---------------- 侧边栏底部信息 ---------------- */
  // 在浏览器运行时用 String.fromCharCode(10) 构造真换行；
  // 注释里如写反斜杠 n 或反斜杠 u0xxx 形式的字面文本，会被 mjs 模板字面量
  // 当作转义展开，把当前 // 注释拆断、未闭合的字符串字面量留在下一行
  // 导致浏览器解析失败、viewer 空白页。
  var NL = String.fromCharCode(10);
  function updateFoot() {
    $('side-foot').textContent = '共 ' + docs.length + ' 篇文档' + NL + '快照生成于 ' + META.generatedAt;
  }

  /* ---------------- 其余交互 ---------------- */
  function setSidebar(open) { document.body.classList.toggle('sidebar-open', open); }
  $('sidebar-toggle').addEventListener('click', function () { setSidebar(true); });
  $('sidebar-close').addEventListener('click', function () { setSidebar(false); });
  $('scrim').addEventListener('click', function () { setSidebar(false); });
  $('btn-print').addEventListener('click', function () { window.print(); });
  $('btn-prev').addEventListener('click', function () { navigate(this.getAttribute('data-slug')); });
  $('btn-next').addEventListener('click', function () { navigate(this.getAttribute('data-slug')); });

  document.addEventListener('keydown', function (ev) {
    var tag = (ev.target && ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || (ev.target && ev.target.isContentEditable)) {
      if (ev.key === 'Escape') search.blur();
      return;
    }
    if (ev.key === '/') { ev.preventDefault(); search.focus(); }
    else if (ev.key === '[') { var p = $('btn-prev'); if (p && p.getAttribute('data-slug')) navigate(p.getAttribute('data-slug')); }
    else if (ev.key === ']') { var n = $('btn-next'); if (n && n.getAttribute('data-slug')) navigate(n.getAttribute('data-slug')); }
  });

  /* ---------------- 启动 ---------------- */
  docs = SNAPSHOT.map(function (d) { return { slug: d.slug, path: d.path, group: d.group, title: d.title, html: d.html }; });
  rebuildIndexes();
  renderSidebar();
  updateFoot();
  applyTheme();
  var initial = slugFromHash();
  // 空文档集时 docs[0] 不存在，显式兜底为 null，showDoc 内直接返回不报错
  var firstSlug = docs.length ? docs[0].slug : null;
  showDoc(initial && docBySlug[initial] ? initial : firstSlug, { scrollTop: true });
  if (!initial && firstSlug) { try { history.replaceState(null, '', '#doc-' + firstSlug); } catch (e) {} }
})();
`;

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 用 esbuild JS API 把 CommonJS 包打成浏览器 iife bundle（免写临时文件） */
async function bundleEntry(contents) {
  const result = await esbuildRun({
    stdin: { contents, resolveDir: LIB_DIR, loader: 'js' },
    bundle: true,
    minify: true,
    format: 'iife',
    write: false,
    logLevel: 'error',
  });
  return result.outputFiles[0].text;
}

/**
 * 构建一次。
 * @param {object} opts
 * @param {string} opts.srcDir  扫描根目录（绝对路径）
 * @param {string} opts.outFile 输出 HTML 路径（绝对路径）
 * @param {string} opts.title   站点标题（注入 <title>/brand/面包屑）
 */
export async function build({ srcDir, outFile, title }) {
  console.log('扫描目录:', srcDir);

  // 依赖随 npm 安装预置在包自身 node_modules，直接解析，运行零等待
  const marked = require('marked');
  const hljs = require('highlight.js');

  // marked / highlight.js 的 npm 包不带浏览器 bundle，用 esbuild 现场打包
  const markedBundle = await bundleEntry('window.marked = require("marked");');
  const hljsBundle = await bundleEntry('window.hljs = require("highlight.js/lib/common");');

  // mermaid 浏览器 bundle（解析包自身 node_modules 内的 dist 产物）
  let mermaidBundle = null;
  for (const sub of ['mermaid/dist/mermaid.min.js', 'mermaid/dist/mermaid.js']) {
    try { mermaidBundle = await fs.readFile(require.resolve(sub), 'utf8'); break; } catch (e) {}
  }
  if (!mermaidBundle) throw new Error('未找到 mermaid 浏览器 bundle');
  console.log('mermaid bundle:', (mermaidBundle.length / 1024 / 1024).toFixed(2), 'MB');

  // 1. 扫描 md 文件
  let files = await findMds(srcDir);
  // 纯文件系统顺序排序，不做任何置顶
  files.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  console.log('发现', files.length, '个 md 文件');

  // 2. 先登记全部路径 → slug（供链接重写使用）
  const docByPath = new Map();
  files.forEach((rel) => docByPath.set(rel, { slug: slugForPath(rel) }));

  // 3. 逐个渲染（快照数据，JSON 内嵌到页面）
  const metas = [];
  for (const rel of files) {
    const raw = await fs.readFile(path.join(srcDir, rel), 'utf8');
    const tag = 'MMD' + crypto.randomBytes(6).toString('hex');
    const { md, blocks } = extractMermaid(raw, tag);
    let html = marked.parse(md, { gfm: true });
    // mermaid 占位符还原
    html = html.replace(new RegExp('<p>\\[\\[' + tag + '(\\d+)\\]\\]</p>', 'g'), (m, n) => {
      return '<pre class="mermaid">' + escHtml(blocks[+n]) + '</pre>';
    });
    html = highlightCode(html, hljs);
    html = addHeaderIds(html);
    html = rewriteLinks(html, docByPath);

    const slug = docByPath.get(rel).slug;
    const dir = path.dirname(rel);
    const group = dir === '.' ? '' : dir;

    // 标题：首个 H1；无 H1 时退回文件名（完整相对路径太长，不适合在目录/面包屑展示）
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
    const docTitle = h1 ? h1[1].replace(/<[^>]+>/g, '').trim() : path.basename(rel);

    metas.push({ slug, path: rel, group, title: docTitle, html });
  }

  // 4. 组装
  const meta = {
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    fileCount: files.length,
    buildCmd: 'md-viewer',
  };

  // JSON 嵌入 <script> 时把 < 转成 < 的 unicode 转义，避免 </script> 截断
  const ltGuard = '\\u003c';
  const docsJson = JSON.stringify(metas).replace(/</g, ltGuard);
  const metaJson = JSON.stringify(meta).replace(/</g, ltGuard);
  const titleJson = JSON.stringify(title).replace(/</g, ltGuard);

  // 注意：必须用函数式替换。字符串替换会把替换文本中的 $& / $' / $$ 等
  // 模式二次解释（文档代码里的 $&quot; 会触发），导致内容被注入/爆炸。
  const appJs = APP_JS
    .replace('%%DOCS_JSON%%', () => docsJson)
    .replace('%%META_JSON%%', () => metaJson)
    .replace('%%TITLE_JSON%%', () => titleJson);

  const escapeScript = (s) => s.replace(/<\/script/gi, '<\\/script');
  const html = HTML_TMPL
    .replace(/%%TITLE%%/g, () => escHtml(title))
    .replace('%%CSS%%', () => CSS)
    .replace('%%MARKED_BUNDLE%%', () => escapeScript(markedBundle))
    .replace('%%HLJS_BUNDLE%%', () => escapeScript(hljsBundle))
    .replace('%%MERMAID_BUNDLE%%', () => escapeScript(mermaidBundle))
    .replace('%%APP_JS%%', () => appJs);

  await fs.writeFile(outFile, html, 'utf8');

  const sizeMB = (Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(2);
  console.log('✔ 已生成', outFile);
  console.log('  文档数:', metas.length, '| 文件大小:', sizeMB, 'MB');
  console.log('  打开方式：双击输出文件、 open ' + outFile + '，或加 --open 自动打开');
  console.log('  提示：md 有变动后重新运行 md-viewer（加 --watch 可自动重建），再刷新浏览器即可看到更新');
}

/** watch 模式：监听目录下 md 文件变动，防抖后自动重新生成 */
export function startWatch(srcDir, rebuild) {
  let timer = null;
  let building = false;
  let dirty = false;
  const run = async () => {
    if (building) { dirty = true; return; }
    building = true;
    try {
      await rebuild();
    } catch (e) {
      console.error('重新生成失败:', e.message);
    } finally {
      building = false;
      if (dirty) { dirty = false; timer = setTimeout(run, 300); }
    }
  };
  try {
    watch(srcDir, { recursive: true }, (_eventType, filename) => {
      if (!filename || !filename.toLowerCase().endsWith('.md')) return;
      clearTimeout(timer);
      timer = setTimeout(run, 300);
    });
  } catch (e) {
    console.error('无法启动目录监听:', e.message);
    process.exit(1);
  }
  console.log('（watch 模式运行中：md 变动将自动重新生成快照，刷新浏览器即可看到更新；Ctrl+C 退出）');
}
