#!/usr/bin/env node
/**
 * md-viewer — 扫描目录下所有 *.md，构建自包含的离线 md-viewer.html。
 * 薄入口：解析参数 → 调 lib/index.mjs（公共 API）。
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build, startWatch } from '../lib/index.mjs';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const HELP = `md-viewer v${pkg.version} — 扫描目录下所有 *.md，构建自包含的离线 md-viewer.html

用法：
  md-viewer [目录] [选项]

参数：
  [目录]              扫描根目录（默认：当前执行目录）

选项：
  -w, --watch         构建后持续监听，md 变动自动重建
  -o, --open          构建后用系统默认浏览器打开生成的 HTML
      --harness       输出到 <目录>/.agents/md-viewer.html 并开启 watch（供 Agent 环境常驻）
      --out <file>    输出文件路径（默认：<目录>/md-viewer.html）
      --title <text>  站点标题（默认：扫描目录名）
  -h, --help          显示帮助
  -v, --version       显示版本号

环境变量：
  MD_VIEWER_OUT       输出文件路径（--out 优先）
  MD_VIEWER_TITLE     站点标题（--title 优先）`;

/** 用系统默认浏览器打开文件（macOS: open / Windows: start / Linux: xdg-open） */
function openInBrowser(file) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

/** 解析 CLI 参数；非法参数抛 Error（由调用方转可读错误） */
function parseArgs(argv) {
  const opts = { watch: false, open: false, harness: false, out: null, title: null, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--watch' || a === '-w') opts.watch = true;
    else if (a === '--open' || a === '-o') opts.open = true;
    else if (a === '--harness') opts.harness = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else if (a === '--out' || a === '--title') {
      const val = argv[i + 1];
      if (!val || val.startsWith('-')) throw new Error(`选项 ${a} 需要一个值`);
      if (a === '--out') opts.out = val; else opts.title = val;
      i++;
    } else if (a.startsWith('--out=')) opts.out = a.slice(8);
    else if (a.startsWith('--title=')) opts.title = a.slice(10);
    else if (a.startsWith('-')) throw new Error(`未知选项：${a}（md-viewer --help 查看用法）`);
    else if (opts.dir === null) opts.dir = a;
    else throw new Error(`只接受一个目录参数，多余参数：${a}`);
  }
  return opts;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error('错误：' + e.message);
  process.exit(1);
}

if (opts.help) { console.log(HELP); process.exit(0); }
if (opts.version) { console.log(pkg.version); process.exit(0); }

// CLI 语义：默认扫描执行目录（非脚本所在目录）
const SRC_DIR = path.resolve(opts.dir || process.cwd());
// --harness：产物改到扫描目录下 .agents/，并强制开启 watch（供 Agent 环境常驻）
if (opts.harness) opts.watch = true;
// 优先级：CLI --out > --harness 默认值 > 环境变量 > 默认值
const OUT_FILE = path.resolve(opts.out
  || (opts.harness ? path.join(SRC_DIR, '.agents', 'md-viewer.html') : null)
  || process.env.MD_VIEWER_OUT || path.join(SRC_DIR, 'md-viewer.html'));
// 默认标题取扫描目录名（如 lenovo_repo），避免写死的 "md-viewer 文档" 与内容无关；
// 仍可用 --title / MD_VIEWER_TITLE 覆盖
const TITLE = opts.title || process.env.MD_VIEWER_TITLE || path.basename(SRC_DIR) || 'md-viewer 文档';

const runBuild = () => build({ srcDir: SRC_DIR, outFile: OUT_FILE, title: TITLE });

try {
  await runBuild();
} catch (e) {
  console.error('构建失败:', e.message);
  process.exit(1);
}

if (opts.open) openInBrowser(OUT_FILE);
if (opts.watch) startWatch(SRC_DIR, runBuild);
