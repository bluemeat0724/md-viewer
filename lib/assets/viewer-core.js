/**
 * md-viewer 共享渲染工具 —— 构建管线（Node）与浏览器查看器（viewer.js）的
 * 单一事实源。纯 ES2015，无 import、无 Node/浏览器专属 API（hljs、marked、
 * decodeURIComponent 等外部能力一律由调用方以参数传入）。
 *
 * 双端加载方式：
 * - 浏览器：构建时把本文件原样内联进 viewer.js 之前的 <script>，挂到
 *   globalThis.MDV_CORE（= window.MDV_CORE）。
 * - Node（lib/build.mjs / 测试）：`import './viewer-core.js'` 副作用导入后
 *   读 `globalThis.MDV_CORE`。
 *
 * 依赖本文件的调用方（Node 构建 + 浏览器运行时）必须保持行为一致——
 * 本文件是唯一允许定义这些函数的场所，不要再各自复制。
 */
(function (root) {
  'use strict';

  /** HTML 转义（标签文本/属性值用） */
  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** 反转义 marked/HTML 实体（代码块高亮前用） */
  function unescHtml(s) {
    return String(s)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /** GitHub 风格标题锚点 slug（文档内由 addHeaderIds 去重） */
  function slugifyHeading(text) {
    return String(text)
      .toLowerCase()
      .trim()
      .replace(/[`*_~]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-');
  }

  /** 相对 md 路径 → 文档 slug（跨文档 #doc-<slug> 链接与 toc data-slug 用） */
  function slugForPath(rel) {
    return rel.replace(/\.md$/i, '').replace(/[^\p{L}\p{N}]+/gu, '-');
  }

  /**
   * 行级扫描：把 ```mermaid / ~~~mermaid 代码块抽取出来，其余原样保留。
   * 返回 { md, blocks }：md 中 mermaid 块被替换为 [[tagN]] 占位，blocks 存原文。
   */
  function extractMermaid(md, tag) {
    var blocks = [];
    var lines = md.split('\n');
    var out = [];
    var fence = null; // backtick | tilde
    var fenceLen = 0;
    var marker = '';
    var buf = [];
    var lang = '';

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (fence) {
        var close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
        if (close && close[1].charAt(0) === fence && close[1].length >= fenceLen) {
          if (lang === 'mermaid') {
            var idx = blocks.length;
            blocks.push(buf.join('\n'));
            out.push('[[' + tag + idx + ']]');
          } else {
            out.push(marker + lang);
            out = out.concat(buf);
            out.push(marker);
          }
          fence = null;
          buf = [];
          lang = '';
        } else {
          buf.push(line);
        }
      } else {
        var open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (open) {
          marker = open[1];
          fence = marker.charAt(0);
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
      out = out.concat(buf);
      out.push(marker);
    }
    return { md: out.join('\n'), blocks: blocks };
  }

  /** 给渲染后的 HTML 的所有标题补 id（GitHub 风格，文档内去重） */
  function addHeaderIds(html) {
    var used = {};
    return html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g, function (m, level, attrs, inner) {
      if (/id="/.test(attrs)) return m;
      var text = inner.replace(/<[^>]+>/g, '');
      var base = slugifyHeading(text) || 'section';
      var id = base;
      var i = 2;
      while (used[id]) id = base + '-' + i++;
      used[id] = true;
      return '<h' + level + ' id="' + id + '"' + attrs + '>' + inner + '</h' + level + '>';
    });
  }

  /**
   * 高亮 <pre><code class="language-x"> 代码块。
   * @param {string} html 渲染后的 HTML
   * @param {{getLanguage(string):unknown, highlight(string,{language:string}):{value:string}, highlightAuto(string):{value:string}}} hljs
   *   浏览器传 window.hljs，Node 传 require('highlight.js')。
   */
  function highlightCode(html, hljs) {
    if (!hljs) return html;
    return html.replace(
      /<pre><code class="language-([^"]+)">([\s\S]*?)<\/code><\/pre>/g,
      function (m, lang, codeHtml) {
        var code = unescHtml(codeHtml);
        var out;
        try {
          if (hljs.getLanguage(lang)) out = hljs.highlight(code, { language: lang }).value;
          else out = hljs.highlightAuto(code).value;
        } catch (e) {
          out = escHtml(code);
        }
        return '<pre><code class="language-' + lang + ' hljs">' + out + '</code></pre>';
      },
    );
  }

  /**
   * posix 风格路径归一（纯实现，不依赖 node:path，双端共用）：
   * 反斜杠转 /，折叠 `.` 与空段，按栈消化 `..`；`..` 越出根目录返回 null。
   */
  function normalizeRelPath(p) {
    var segs = String(p).replace(/\\/g, '/').split('/');
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s === '' || s === '.') continue;
      if (s === '..') {
        if (!out.length) return null;
        out.pop();
      } else {
        out.push(s);
      }
    }
    return out.join('/');
  }

  /**
   * 重写内部 .md 链接为页内 #doc-<slug> 跳转。
   * @param {string} html 渲染后的 HTML
   * @param {{get(string): {slug:string} | undefined}} docByPath 相对路径 → {slug}
   *   （Node 传 Map，浏览器传 new Map()，二者都有 .get）
   * @param {string} [fromPath] 链接所在文档的相对路径（相对扫描根）。缺省时
   *   只按扫描根相对查表（旧行为）；提供时先按 Markdown 标准语义解析
   *   「所在文档目录 + 链接」，未命中再退回扫描根相对（兼容根相对写法）。
   */
  function rewriteLinks(html, docByPath, fromPath) {
    function safeDecode(s) {
      try { return decodeURIComponent(s); } catch (e) { return s; }
    }
    // 链接所在文档的目录（扫描根下为 ''）
    var baseDir = '';
    if (fromPath) {
      var norm = normalizeRelPath(fromPath);
      if (norm) {
        var slash = norm.lastIndexOf('/');
        baseDir = slash >= 0 ? norm.slice(0, slash) : '';
      }
    }
    return html.replace(/<a href="([^"]+)"/g, function (m, href) {
      if (/^(https?:|mailto:|tel:|javascript:|#)/i.test(href)) return m;
      // 先剥离 query 与锚点再判 .md 后缀（marked 会把 href 百分号编码，
      // 不先剥锚点则带 # 的链接过不了 endsWith 检查）
      var clean = href.split('?')[0];
      var anchor = '';
      var hIdx = clean.indexOf('#');
      if (hIdx >= 0) { anchor = clean.slice(hIdx + 1); clean = clean.slice(0, hIdx); }
      clean = safeDecode(clean);
      if (!clean.toLowerCase().endsWith('.md')) return m;
      var target = null;
      // 文档相对优先：先拼上所在文档目录再统一归一（单独归一会把开头的
      // ../ 判成越界，丢掉合法的上级引用）；未命中再退回扫描根相对查表，
      // 开头即 .. 的链接不可能相对扫描根成立，跳过兜底
      if (baseDir) target = docByPath.get(normalizeRelPath(baseDir + '/' + clean));
      if (!target && !/^\.\.([/\\]|$)/.test(clean)) {
        var rel = normalizeRelPath(clean);
        if (rel !== null) target = docByPath.get(rel);
      }
      if (!target) return m; // 目标不在集合内：保留原相对链接
      var anchorAttr = anchor ? ' data-anchor="' + safeDecode(anchor) + '"' : '';
      return '<a href="#doc-' + target.slug + '"' + anchorAttr;
    });
  }

  /** 从渲染后 HTML 取首个 H1 文本作为文档标题；无 H1 用 fallback */
  function titleFromHtml(html, fallback) {
    var m = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
    return m ? m[1].replace(/<[^>]+>/g, '').trim() || fallback : fallback;
  }

  root.MDV_CORE = {
    escHtml: escHtml,
    unescHtml: unescHtml,
    slugifyHeading: slugifyHeading,
    slugForPath: slugForPath,
    normalizeRelPath: normalizeRelPath,
    extractMermaid: extractMermaid,
    addHeaderIds: addHeaderIds,
    highlightCode: highlightCode,
    rewriteLinks: rewriteLinks,
    titleFromHtml: titleFromHtml,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
