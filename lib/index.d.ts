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
  /**
   * 单文件嵌入上限（KB），默认不限制。
   * 超限的 md/json 不嵌入原文：目录项保留，浏览器显示占位提示。
   */
  maxRawKB?: number;
}

/**
 * 扫描 srcDir 下所有 *.md / *.json，把原始文本组装为自包含的
 * md-viewer.html（渲染在浏览器端按需执行）。
 * 生成物依赖 marked / highlight.js / mermaid / esbuild，随包安装预置。
 */
export function build(options: BuildOptions): Promise<void>;

/**
 * watch 模式：监听 srcDir 下 md/json 文件变动，防抖后调用 rebuild。
 * 返回前不阻塞；进程退出时监听随进程结束。
 */
export function startWatch(
  srcDir: string,
  rebuild: () => void | Promise<void>,
): void;

/**
 * 递归收集目录下所有 *.md / *.json 的相对路径（跳过隐藏项与
 * node_modules / .git / dist / build / .venv）。
 */
export function findDocs(dir: string, base?: string): Promise<string[]>;

/**
 * @deprecated 0.7.0 起改名 findDocs（md 与 json 一起返回）。
 * 别名保留一个版本，行为与 findDocs 相同。
 */
export function findMds(dir: string, base?: string): Promise<string[]>;
