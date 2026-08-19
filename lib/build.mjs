/**
 * lib/build.mjs — md-viewer 构建主体
 *
 * 扫描指定目录（默认执行目录）下所有 *.md，用 marked 渲染、highlight.js 高亮
 * 代码、抽取 mermaid 代码块，组装成一个自包含的 md-viewer.html。
 * 打开生成的 HTML 无需任何服务（file:// 双击即可）。
 *
 * 资产拆分（0.4.0 起）：
 * - lib/assets/viewer.css       页面样式（真实文件）
 * - lib/assets/viewer-core.js   共享渲染纯函数（Node 构建与浏览器查看器共用，
 *   副作用导入后经 globalThis.MDV_CORE 读取；浏览器端内联进 HTML）
 * - lib/assets/viewer.js        浏览器查看器应用（真实文件，引用 MDV_CORE）
 * - lib/assets/viewer.tmpl.html 页面骨架模板
 * 浏览器依赖（marked / highlight.js / mermaid / esbuild）随 npm 安装预置在
 * 包自身 node_modules，运行零等待；生成物只有输出 HTML 一个文件。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build as esbuildRun } from 'esbuild';

// 共享渲染工具单源：本文件（Node 构建侧）与浏览器查看器（viewer.js）共用
// lib/assets/viewer-core.js。副作用导入执行 IIFE，把 MDV_CORE 挂到 globalThis。
import './assets/viewer-core.js';
const CORE = globalThis.MDV_CORE;
if (!CORE) throw new Error('viewer-core.js 加载失败：globalThis.MDV_CORE 未定义');

const require = createRequire(import.meta.url);
const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(LIB_DIR, 'assets');

/** CLI 语义：扫描目录跳过依赖/产物类目录，避免把依赖包里的 md 扫进来 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv']);

/* ------------------------------------------------------------------ */
/* 资产与依赖 bundle（进程内缓存：watch 重建不再重复读取/打包）            */
/* ------------------------------------------------------------------ */

/** 四个静态资产文本，读取一次后缓存 */
let assetsCache = null;
async function loadAssets() {
  if (assetsCache) return assetsCache;
  const [css, tmpl, viewerJs, viewerCore] = await Promise.all([
    fs.readFile(path.join(ASSETS_DIR, 'viewer.css'), 'utf8'),
    fs.readFile(path.join(ASSETS_DIR, 'viewer.tmpl.html'), 'utf8'),
    fs.readFile(path.join(ASSETS_DIR, 'viewer.js'), 'utf8'),
    fs.readFile(path.join(ASSETS_DIR, 'viewer-core.js'), 'utf8'),
  ]);
  assetsCache = { css, tmpl, viewerJs, viewerCore };
  return assetsCache;
}

/** marked / highlight.js / mermaid 浏览器 bundle，打包一次后缓存 */
let bundleCache = null;
async function getBundles() {
  if (bundleCache) return bundleCache;
  const markedBundle = await bundleEntry('window.marked = require("marked");');
  const hljsBundle = await bundleEntry('window.hljs = require("highlight.js/lib/common");');
  // mermaid 浏览器 bundle（解析包自身 node_modules 内的 dist 产物）
  let mermaidBundle = null;
  for (const sub of ['mermaid/dist/mermaid.min.js', 'mermaid/dist/mermaid.js']) {
    try { mermaidBundle = await fs.readFile(require.resolve(sub), 'utf8'); break; } catch (e) {}
  }
  if (!mermaidBundle) throw new Error('未找到 mermaid 浏览器 bundle');
  console.log('mermaid bundle:', (mermaidBundle.length / 1024 / 1024).toFixed(2), 'MB');
  bundleCache = { markedBundle, hljsBundle, mermaidBundle };
  return bundleCache;
}

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

/* ------------------------------------------------------------------ */
/* 工具函数（构建期）                                                    */
/* ------------------------------------------------------------------ */

/** 递归收集目录下所有 *.md 的相对路径（跳过隐藏项与 SKIP_DIRS） */
export async function findMds(dir, base = '') {
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

/* ------------------------------------------------------------------ */
/* 页面骨架模板（占位符：%%TITLE%% / %%CSS%% / %%MARKED_BUNDLE%% /        */
/* %%HLJS_BUNDLE%% / %%MERMAID_BUNDLE%% / %%APP_JS%%）                   */
/* 模板本体在 lib/assets/viewer.tmpl.html（不再内嵌 JS 字符串）。          */
/* ------------------------------------------------------------------ */

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
  const { css, tmpl, viewerJs, viewerCore } = await loadAssets();
  const { markedBundle, hljsBundle, mermaidBundle } = await getBundles();

  // 1. 扫描 md 文件
  let files = await findMds(srcDir);
  // 纯文件系统顺序排序，不做任何置顶
  files.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  console.log('发现', files.length, '个 md 文件');

  // 2. 先登记全部路径 → slug（供链接重写使用）
  const docByPath = new Map();
  files.forEach((rel) => docByPath.set(rel, { slug: CORE.slugForPath(rel) }));

  // 3. 逐个渲染（快照数据，JSON 内嵌到页面）
  const metas = [];
  for (const rel of files) {
    const raw = await fs.readFile(path.join(srcDir, rel), 'utf8');
    const tag = 'MMD' + crypto.randomBytes(6).toString('hex');
    const { md, blocks } = CORE.extractMermaid(raw, tag);
    let html = marked.parse(md, { gfm: true });
    // mermaid 占位符还原
    html = html.replace(new RegExp('<p>\\[\\[' + tag + '(\\d+)\\]\\]</p>', 'g'), (m, n) => {
      return '<pre class="mermaid">' + CORE.escHtml(blocks[+n]) + '</pre>';
    });
    html = CORE.highlightCode(html, hljs);
    html = CORE.addHeaderIds(html);
    html = CORE.rewriteLinks(html, docByPath);

    const slug = docByPath.get(rel).slug;
    const dir = path.dirname(rel);
    const group = dir === '.' ? '' : dir;

    // 标题：首个 H1；无 H1 时退回文件名（完整相对路径太长，不适合在目录/面包屑展示）
    const docTitle = CORE.titleFromHtml(html, path.basename(rel));

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

  // 浏览器应用 = 共享核心 + 查看器主逻辑；viewer-core 必须先于 viewer.js
  // 注意：必须用函数式替换。字符串替换会把替换文本中的 $& / $' / $$ 等
  // 模式二次解释（文档代码里的 $&quot; 会触发），导致内容被注入/爆炸。
  const appJs = (viewerCore + '\n' + viewerJs)
    .replace('%%DOCS_JSON%%', () => docsJson)
    .replace('%%META_JSON%%', () => metaJson)
    .replace('%%TITLE_JSON%%', () => titleJson);

  const escapeScript = (s) => s.replace(/<\/script/gi, '<\\/script');
  const html = tmpl
    .replace(/%%TITLE%%/g, () => CORE.escHtml(title))
    .replace('%%CSS%%', () => css)
    .replace('%%MARKED_BUNDLE%%', () => escapeScript(markedBundle))
    .replace('%%HLJS_BUNDLE%%', () => escapeScript(hljsBundle))
    .replace('%%MERMAID_BUNDLE%%', () => escapeScript(mermaidBundle))
    .replace('%%APP_JS%%', () => appJs);

  // 确保输出目录存在（如 --harness 的 .agent/、--out 指向的不存在目录）
  await fs.mkdir(path.dirname(outFile), { recursive: true });
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
