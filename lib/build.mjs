/**
 * lib/build.mjs — md-viewer 构建主体
 *
 * 扫描指定目录（默认执行目录）下所有 *.md 与 *.json，把原始文本连同
 * 站点元信息组装成一个自包含的 md-viewer.html。0.7.0 起快照只存 raw，
 * markdown 渲染 / 代码高亮 / JSON 树全部在浏览器打开文档时按需执行
 * （marked / hljs 浏览器 bundle 内嵌，mermaid 惰性激活）。
 * 打开生成的 HTML 无需任何服务（file:// 双击即可）。
 *
 * 资产拆分（0.4.0 起）：
 * - lib/assets/viewer.css       页面样式（真实文件）
 * - lib/assets/viewer-core.js   共享渲染纯函数（Node 测试与浏览器查看器共用，
 *   副作用导入后经 globalThis.MDV_CORE 读取；浏览器端内联进 HTML）
 * - lib/assets/viewer.js        浏览器查看器应用（真实文件，引用 MDV_CORE）
 * - lib/assets/viewer.tmpl.html 页面骨架模板
 * 浏览器依赖（marked / highlight.js / mermaid / esbuild）随 npm 安装预置在
 * 包自身 node_modules，运行零等待；生成物只有输出 HTML 一个文件。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build as esbuildRun } from 'esbuild';

// 共享渲染工具单源：Node 测试与浏览器查看器（viewer.js）共用
// lib/assets/viewer-core.js。副作用导入执行 IIFE，把 MDV_CORE 挂到 globalThis。
import './assets/viewer-core.js';
const CORE = globalThis.MDV_CORE;
if (!CORE) throw new Error('viewer-core.js 加载失败：globalThis.MDV_CORE 未定义');

const require = createRequire(import.meta.url);
const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(LIB_DIR, 'assets');

/** CLI 语义：扫描目录跳过依赖/产物类目录，避免把依赖包里的文档扫进来 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv']);

/** 参与快照的文档扩展名 */
const DOC_EXTS = ['.md', '.json'];

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
let markedBundleCache = null;
async function getMarkedBundle() {
  if (markedBundleCache === null) {
    markedBundleCache = await bundleEntry('window.marked = require("marked");');
  }
  return markedBundleCache;
}

/**
 * hljs 按需打包：core + common 清单 ∪ 构建期扫描到的围栏语言。
 * 未收录的别名 / 语言维持「不高亮」现状（highlightAuto 兜底仍可用）。
 */
const hljsBundleCache = new Map();
async function getHljsBundle(langIds) {
  const key = langIds.join(',');
  if (!hljsBundleCache.has(key)) {
    const parts = ['window.hljs = require("highlight.js/lib/core");'];
    for (const id of langIds) {
      // 无扩展名子路径（highlight.js 的 exports 未暴露 ./lib/*.js 形式）
      parts.push('window.hljs.registerLanguage("' + id + '", require("highlight.js/lib/languages/' + id + '"));');
    }
    hljsBundleCache.set(key, await bundleEntry(parts.join('\n')));
  }
  return hljsBundleCache.get(key);
}

/** 汇总 hljs 语言清单：common 子集 + 能解析到语言模块的围栏语言 */
async function resolveHljsLangs(fenceLangs) {
  // common.js 里是 require('./languages/xml') 形式（无 .js 后缀，带引号结尾）
  const commonSrc = await fs.readFile(require.resolve('highlight.js/lib/common'), 'utf8');
  const langs = new Set([...commonSrc.matchAll(/languages\/([a-z0-9#+-]+)['"]/g)].map((m) => m[1]));
  for (const l of fenceLangs) {
    if (langs.has(l)) continue;
    try {
      require.resolve('highlight.js/lib/languages/' + l);
      langs.add(l);
    } catch (e) { /* 别名或未知语言：common 内的别名已覆盖，未知的维持不高亮 */ }
  }
  return [...langs].sort();
}

let mermaidBundleCache = null;
async function getMermaidBundle() {
  if (mermaidBundleCache !== null) return mermaidBundleCache;
  // mermaid 浏览器 bundle（解析包自身 node_modules 内的 dist 产物）
  let bundle = null;
  for (const sub of ['mermaid/dist/mermaid.min.js', 'mermaid/dist/mermaid.js']) {
    try { bundle = await fs.readFile(require.resolve(sub), 'utf8'); break; } catch (e) {}
  }
  if (!bundle) throw new Error('未找到 mermaid 浏览器 bundle');
  console.log('mermaid bundle:', (bundle.length / 1024 / 1024).toFixed(2), 'MB');
  mermaidBundleCache = bundle;
  return bundle;
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

function isDocFile(name) {
  const lower = name.toLowerCase();
  return DOC_EXTS.some((ext) => lower.endsWith(ext));
}

/** 递归收集目录下所有 *.md / *.json 的相对路径（跳过隐藏项与 SKIP_DIRS） */
export async function findDocs(dir, base = '') {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...(await findDocs(full, rel)));
    } else if (isDocFile(e.name)) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * @deprecated 0.7.0 起改名 findDocs（md 与 json 一起返回），别名保留一个版本。
 */
export function findMds(dir, base = '') {
  return findDocs(dir, base);
}

/** 扫描 md 围栏语言标记（供 hljs 按需打包；仅作候选，真实性由 resolve 校验） */
function scanFenceLangs(raw) {
  const langs = new Set();
  for (const line of raw.split('\n')) {
    const m = /^ {0,3}(?:`{3,}|~{3,})([A-Za-z0-9_+-]+)/.exec(line);
    if (m) langs.add(m[1].toLowerCase());
  }
  return langs;
}

/* ------------------------------------------------------------------ */
/* 页面骨架模板（占位符：%%TITLE%% / %%CSS%% / %%DOCS_JSON%% /            */
/* %%MARKED_SCRIPT%% / %%HLJS_SCRIPT%% / %%MERMAID_SCRIPT%% / %%APP_JS%%）*/
/* 模板本体在 lib/assets/viewer.tmpl.html（不再内嵌 JS 字符串）。          */
/* ------------------------------------------------------------------ */

/**
 * 构建一次。
 * @param {object} opts
 * @param {string} opts.srcDir     扫描根目录（绝对路径）
 * @param {string} opts.outFile    输出 HTML 路径（绝对路径）
 * @param {string} opts.title      站点标题（注入 <title>/brand/面包屑）
 * @param {number} [opts.maxRawKB] 单文件嵌入上限；默认不限制（超限条目只保留目录项）
 */
export async function build({ srcDir, outFile, title, maxRawKB = Infinity }) {
  console.log('扫描目录:', srcDir);

  const { css, tmpl, viewerJs, viewerCore } = await loadAssets();

  // 1. 扫描文档（md + json）
  const files = await findDocs(srcDir);
  // 纯文件系统顺序排序，不做任何置顶
  files.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  const mdCount = files.filter((f) => !f.toLowerCase().endsWith('.json')).length;
  const jsonCount = files.length - mdCount;
  console.log('发现', mdCount, '个 md、', jsonCount, '个 json 文件');

  // 2. 先登记全部路径 → slug（供链接重写使用）；冲突时追加序号，避免多文档共享同一 slug
  const docByPath = new Map();
  const usedSlugs = new Set();
  files.forEach((rel) => {
    let slug = CORE.slugForPath(rel);
    if (usedSlugs.has(slug)) {
      let i = 2;
      while (usedSlugs.has(slug + '-' + i)) i++;
      slug = slug + '-' + i;
    }
    usedSlugs.add(slug);
    docByPath.set(rel, { slug });
  });

  // 3. 快照：嵌入原始文本（渲染移至浏览器端按需执行）
  const metas = [];
  const fenceLangs = new Set(['json']);
  let hasMermaid = false;
  let omittedCount = 0;
  for (const rel of files) {
    const type = rel.toLowerCase().endsWith('.json') ? 'json' : 'md';
    const raw = await fs.readFile(path.join(srcDir, rel), 'utf8');
    const size = Buffer.byteLength(raw, 'utf8');
    const dir = path.dirname(rel);

    const entry = {
      slug: docByPath.get(rel).slug,
      path: rel,
      group: dir === '.' ? '' : dir,
      type,
      title: CORE.titleFromRaw(type, raw, path.basename(rel)),
    };
    if (size > maxRawKB * 1024) {
      // 超限不嵌入：目录项保留（title 可寻），浏览器显示占位提示
      entry.raw = null;
      entry.size = size;
      entry.omitted = 'size';
      omittedCount++;
    } else {
      entry.raw = raw;
      if (type === 'md') {
        for (const l of scanFenceLangs(raw)) fenceLangs.add(l);
        if (CORE.extractMermaid(raw, 'SCAN').blocks.length > 0) hasMermaid = true;
      }
    }
    metas.push(entry);
  }
  if (omittedCount > 0) {
    console.log(' ', omittedCount, '个文件超过', maxRawKB + 'KB 未嵌入（保留目录项，浏览器显示占位提示）');
  }

  // 4. 依赖 bundle 按需内嵌：无 md 不带 marked；无任何文档不带 hljs；
  //    无 mermaid 图不带 mermaid（约 3.4MB，最大头）
  const [markedBundle, hljsBundle, mermaidBundle] = await Promise.all([
    mdCount > 0 ? getMarkedBundle() : Promise.resolve(''),
    metas.length > 0 ? getHljsBundle(await resolveHljsLangs(fenceLangs)) : Promise.resolve(''),
    hasMermaid ? getMermaidBundle() : Promise.resolve(''),
  ]);

  // 5. 组装
  const meta = {
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    fileCount: mdCount,
    jsonCount,
    buildCmd: 'md-viewer',
  };

  // JSON 嵌入 <script> 时把 < 转成 unicode 转义，避免 </script> 截断
  const ltGuard = '\\u003c';
  const docsJson = JSON.stringify(metas).replace(/</g, ltGuard);
  const metaJson = JSON.stringify(meta).replace(/</g, ltGuard);
  const titleJson = JSON.stringify(title).replace(/</g, ltGuard);

  // 浏览器应用 = 共享核心 + 查看器主逻辑；viewer-core 必须先于 viewer.js。
  // 注意：必须用函数式替换。字符串替换会把替换文本中的 $& / $' / $$ 等
  // 模式二次解释（文档代码里的 $&quot; 会触发），导致内容被注入/爆炸。
  const appJs = (viewerCore + '\n' + viewerJs)
    .replace('%%META_JSON%%', () => metaJson)
    .replace('%%TITLE_JSON%%', () => titleJson);

  const escapeScript = (s) => s.replace(/<\/script/gi, '<\\/script');
  const wrapScript = (body) => '<script>' + escapeScript(body) + '</script>';
  const html = tmpl
    .replace(/%%TITLE%%/g, () => CORE.escHtml(title))
    .replace('%%CSS%%', () => css)
    .replace('%%DOCS_JSON%%', () => docsJson)
    .replace('%%MARKED_SCRIPT%%', () => (markedBundle ? wrapScript(markedBundle) : ''))
    .replace('%%HLJS_SCRIPT%%', () => (hljsBundle ? wrapScript(hljsBundle) : ''))
    .replace('%%MERMAID_SCRIPT%%', () => (mermaidBundle
      ? '<script type="text/plain" id="mermaid-src">' + escapeScript(mermaidBundle) + '</script>'
      : ''))
    .replace('%%APP_JS%%', () => appJs);

  // 确保输出目录存在（如 --harness 的 .agents/、--out 指向的不存在目录）
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, html, 'utf8');

  const sizeMB = (Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(2);
  console.log('✔ 已生成', outFile);
  console.log('  文档数:', metas.length, '| 文件大小:', sizeMB, 'MB');
  console.log('  打开方式：双击输出文件、 open ' + outFile + '，或加 --open 自动打开');
  console.log('  提示：文档有变动后重新运行 md-viewer（加 --watch 可自动重建），再刷新浏览器即可看到更新');
}

/** watch 模式：监听目录下 md/json 文件变动，防抖后自动重新生成 */
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
      if (!filename || !isDocFile(filename.split('/').pop() || '')) return;
      clearTimeout(timer);
      timer = setTimeout(run, 300);
    });
  } catch (e) {
    console.error('无法启动目录监听:', e.message);
    process.exit(1);
  }
  console.log('（watch 模式运行中：md/json 变动将自动重新生成快照，刷新浏览器即可看到更新；Ctrl+C 退出）');
}
