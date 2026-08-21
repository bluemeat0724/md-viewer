/**
 * md-viewer 共享渲染工具 —— Node 测试与浏览器查看器（viewer.js）的
 * 单一事实源。纯 ES2015，无 import、无 Node/浏览器专属 API（hljs、marked、
 * decodeURIComponent 等外部能力一律由调用方以参数传入）。
 *
 * 0.7.0 起快照只存文档原始文本（md/json），完整渲染管线 renderMarkdown
 * 在浏览器端按需执行；本文件由双端共享以保证行为一致。
 *
 * 双端加载方式：
 * - 浏览器：构建时把本文件原样内联进 viewer.js 之前的 <script>，挂到
 *   globalThis.MDV_CORE（= window.MDV_CORE）。
 * - Node（测试）：`import './viewer-core.js'` 副作用导入后
 *   读 `globalThis.MDV_CORE`。
 *
 * 依赖本文件的调用方必须保持行为一致——
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

  /** HTML 属性值转义（双引号属性用） */
  function escAttr(s) {
    return escHtml(s)
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  /** 相对文档路径（.md / .json）→ 文档 slug（跨文档 #doc-<slug> 链接与 toc data-slug 用） */
  function slugForPath(rel) {
    return rel.replace(/\.(md|json)$/i, '').replace(/[^\p{L}\p{N}]+/gu, '-');
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
   * 重写内部文档链接（.md / .json）为页内 #doc-<slug> 跳转。
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
      // 先剥离 query 与锚点（marked 会把 href 百分号编码，不先剥锚点会
      // 干扰路径归一）；空链接（纯锚点已被上面的 # 分支拦截）直接跳过
      var clean = href.split('?')[0];
      var anchor = '';
      var hIdx = clean.indexOf('#');
      if (hIdx >= 0) { anchor = clean.slice(hIdx + 1); clean = clean.slice(0, hIdx); }
      clean = safeDecode(clean);
      if (!clean) return m;
      var target = null;
      // 文档相对优先：先拼上所在文档目录再统一归一（单独归一会把开头的
      // ../ 判成越界，丢掉合法的上级引用）；未命中再退回扫描根相对查表，
      // 开头即 .. 的链接不可能相对扫描根成立，跳过兜底。
      // 非 md/json 的相对链接（图片、目录等）查表未命中，保留原样
      if (baseDir) target = docByPath.get(normalizeRelPath(baseDir + '/' + clean));
      if (!target && !/^\.\.([/\\]|$)/.test(clean)) {
        var rel = normalizeRelPath(clean);
        if (rel !== null) target = docByPath.get(rel);
      }
      if (!target) return m; // 目标不在集合内：保留原相对链接
      var anchorAttr = anchor ? ' data-anchor="' + escAttr(safeDecode(anchor)) + '"' : '';
      return '<a href="#doc-' + escAttr(target.slug) + '"' + anchorAttr;
    });
  }

  /**
   * 从文档原始文本取标题（快照只存 raw 后的构建期标题来源）。
   * md：代码围栏外的首个 ATX H1（剥行内强调记号），无则 fallback；
   * json：fallback 去掉 .json 后缀（json 没有可提取的语义标题）。
   */
  function titleFromRaw(type, raw, fallback) {
    var name = String(fallback == null ? '' : fallback);
    if (type === 'json') return name.replace(/\.json$/i, '');
    var lines = String(raw == null ? '' : raw).split('\n');
    var fence = null; // '`' | '~'，处于围栏内时跳过标题识别
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (fence) {
        if (line.length < 3) continue;
        var close = /^ {0,3}(`{3,}[ \t]*|~{3,}[ \t]*)$/.exec(line);
        if (close && close[1].charAt(0) === fence) fence = null;
        continue;
      }
      var open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open) { fence = open[1].charAt(0); continue; }
      var m = /^ {0,3}#\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) {
        var t = m[1].replace(/[`*_~]/g, '').trim();
        if (t) return t;
      }
    }
    return name;
  }

  /**
   * md 完整渲染管线（原 0.6.x 构建期预渲染逻辑，0.7.0 起在浏览器按需执行；
   * Node 测试侧以真实 marked/hljs 传入以保证同一行为）。
   * @param {string} raw markdown 原文
   * @param {{marked:object, hljs?:object, docByPath?:Map, fromPath?:string}} ctx
   *   marked/hljs 由调用方注入（浏览器取内嵌 bundle，测试传 require 的实例）
   */
  function renderMarkdown(raw, ctx) {
    // 占位 tag 与构建期同理需避开正文：Math.random 足够（碰撞仅导致误还原）
    var tag = 'MMD' + Math.random().toString(36).slice(2, 10);
    var r = extractMermaid(String(raw), tag);
    var html = ctx.marked.parse(r.md, { gfm: true });
    html = html.replace(new RegExp('<p>\\[\\[' + tag + '(\\d+)\\]\\]</p>', 'g'), function (m, n) {
      return '<pre class="mermaid">' + escHtml(r.blocks[+n]) + '</pre>';
    });
    html = highlightCode(html, ctx.hljs);
    html = addHeaderIds(html);
    if (ctx.docByPath) html = rewriteLinks(html, ctx.docByPath, ctx.fromPath);
    return html;
  }

  /* ---------------- JSON 视图（pretty + 行内折叠） ---------------- */

  /** 解析 JSON；失败时返回 { ok:false, error } 供原文降级展示 */
  function prettifyJson(raw) {
    try {
      return { ok: true, value: JSON.parse(String(raw)) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  /** 键前缀："key": （根节点 key 为 ''，不渲染键名） */
  function jfKeyPrefix(key) {
    if (key === '') return '';
    return '<span class="jt-key">"' + escHtml(key) + '"</span><span class="jf-punc">: </span>';
  }

  /**
   * pretty-JSON 节点：美化文本（2 空格缩进）+ 行内折叠。
   * 深度 ≥ expand 的容器渲染为 `{ ⋯ N }` 一行（body 隐藏、标记用伪元素
   * 显示避免污染复制文本），查看器点击 .jf-brace / .jf-mark 切换；
   * 展开内容始终在 DOM 里（hidden 的 .jf-body 仍参与 textContent，
   * 复制按钮拿到的是完整美化文本）。
   */
  function jfNode(value, key, ind, depth, expand) {
    var isObj = value !== null && typeof value === 'object';
    if (!isObj) {
      var t = value === null ? 'null' : typeof value;
      var text = t === 'string' ? '"' + escHtml(value) + '"' : String(value);
      return jfKeyPrefix(key) + '<span class="jt-val jt-' + t + '">' + text + '</span>';
    }
    var isArr = Array.isArray(value);
    var open = isArr ? '[' : '{';
    var close = isArr ? ']' : '}';
    var keys = isArr ? value.map(function (_v, i) { return String(i); }) : Object.keys(value);
    if (keys.length === 0) {
      return jfKeyPrefix(key) + '<span class="jt-val jt-' + (isArr ? 'array' : 'object') + '">' + open + close + '</span>';
    }
    var inner = ind + '  ';
    // 每个子项独占一行并带 inner 缩进；数组子项不渲染键名（与 stringify 输出一致）
    var children = keys.map(function (k, i) {
      return '\n' + inner + jfNode(value[k], isArr ? '' : k, inner, depth + 1, expand) +
        (i < keys.length - 1 ? '<span class="jf-punc">,</span>' : '');
    }).join('');
    var body = children + '\n' + ind;
    var folded = depth >= expand;
    return jfKeyPrefix(key) +
      '<span class="jf-node"' + (folded ? ' data-folded="1"' : '') + '>' +
        '<span class="jf-brace" title="点击展开 / 折叠">' + open + '</span>' +
        '<span class="jf-mark" data-label="' + keys.length + (isArr ? ' 项' : ' 个键') + '" title="展开"' + (folded ? '' : ' hidden') + '></span>' +
        '<span class="jf-body"' + (folded ? ' hidden' : '') + '>' + body + '</span>' +
        '<span class="jf-brace" title="点击展开 / 折叠">' + close + '</span>' +
      '</span>';
  }

  /**
   * pretty JSON 全文 HTML（类型着色 + 层级折叠）。
   * @param {*} value 已解析的 JSON 值
   * @param {number} [expand] 展开层级：深度 ≥ expand 的容器折叠，默认 3
   */
  function prettyJsonHtml(value, expand) {
    var e = expand === undefined || expand === null || expand < 0 ? 3 : expand;
    return jfNode(value, '', '', 0, e);
  }

  root.MDV_CORE = {
    escHtml: escHtml,
    escAttr: escAttr,
    unescHtml: unescHtml,
    slugifyHeading: slugifyHeading,
    slugForPath: slugForPath,
    normalizeRelPath: normalizeRelPath,
    extractMermaid: extractMermaid,
    addHeaderIds: addHeaderIds,
    highlightCode: highlightCode,
    rewriteLinks: rewriteLinks,
    titleFromRaw: titleFromRaw,
    renderMarkdown: renderMarkdown,
    prettifyJson: prettifyJson,
    prettyJsonHtml: prettyJsonHtml,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
