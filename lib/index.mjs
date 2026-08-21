/**
 * lib/index.mjs — md-viewer 程序化公共 API
 *
 * 供其他 Node 程序（如 dsh 插件）直接调用渲染能力，无需走 CLI。
 * CLI（bin/md-viewer.mjs）同样基于本入口。
 */
export { build, startWatch, findDocs, findMds } from './build.mjs';
