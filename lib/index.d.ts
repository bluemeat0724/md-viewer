/**
 * md-viewer 公共 API 类型声明。
 */

/** 构建选项：与 CLI 的 [目录] / --out / --title 对应。 */
export interface BuildOptions {
  /** 扫描根目录（绝对路径）。 */
  srcDir: string;
  /** 输出 HTML 路径（绝对路径；父目录不存在会自动创建）。 */
  outFile: string;
  /** 站点标题（注入 <title>/brand/面包屑）。 */
  title: string;
}

/**
 * 扫描 srcDir 下所有 *.md，渲染并组装为自包含的 md-viewer.html。
 * 生成物依赖 marked / highlight.js / mermaid / esbuild，随包安装预置。
 */
export function build(options: BuildOptions): Promise<void>;

/**
 * watch 模式：监听 srcDir 下 md 文件变动，防抖后调用 rebuild。
 * 返回前不阻塞；进程退出时监听随进程结束。
 */
export function startWatch(
  srcDir: string,
  rebuild: () => void | Promise<void>,
): void;

/**
 * 递归收集目录下所有 *.md 的相对路径（跳过隐藏项与
 * node_modules / .git / dist / build / .venv）。
 */
export function findMds(dir: string, base?: string): Promise<string[]>;
