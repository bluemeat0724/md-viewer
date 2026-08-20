(function () {
  'use strict';
  var META = %%META_JSON%%;
  var SNAPSHOT = %%DOCS_JSON%%;
  var SITE_TITLE = %%TITLE_JSON%%;

  // 共享渲染工具来自 viewer-core.js（内联于本文件之前），Node 与浏览器
  // 同一份源码，见 lib/assets/viewer-core.js。此处只做别名与参数接线。
  var MDV = (typeof window !== 'undefined' && window.MDV_CORE) ? window.MDV_CORE
    : (typeof globalThis !== 'undefined' && globalThis.MDV_CORE) ? globalThis.MDV_CORE : null;
  function esc(s) { return MDV.escHtml(s); }
  function unesc(s) { return MDV.unescHtml(s); }

  function $(id) { return document.getElementById(id); }

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
  var docByPath = new Map();   // rel -> {slug}

  function rebuildIndexes() {
    docBySlug = {};
    docByPath = new Map();
    textCache = {};
    docs.forEach(function (d) { docBySlug[d.slug] = d; docByPath.set(d.path, { slug: d.slug }); });
  }

  /* ---------------- 客户端 Markdown 渲染管线（实时模式用） ---------------- */
  // 纯函数（slugifyHeading / extractMermaid / addHeaderIds / highlightCode /
  // rewriteLinks / titleFromHtml / slugForPath）统一在 viewer-core.js。
  function renderMarkdown(raw, fromPath) {
    if (!window.marked) return '<pre>' + esc(raw) + '</pre>';
    var tag = 'MMD' + Math.random().toString(16).slice(2);
    var r = MDV.extractMermaid(raw, tag);
    var html = window.marked.parse(r.md, { gfm: true });
    html = html.replace(new RegExp('<p>\\[\\[' + tag + '(\\d+)\\]\\]</p>', 'g'), function (m, n) {
      return '<pre class="mermaid">' + esc(r.blocks[+n]) + '</pre>';
    });
    html = MDV.highlightCode(html, window.hljs);
    html = MDV.addHeaderIds(html);
    html = MDV.rewriteLinks(html, docByPath, fromPath);
    return html;
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
  var NL = String.fromCharCode(10);
  function updateFoot() {
    $('side-foot').textContent = '共 ' + docs.length + ' 篇文档' + NL + '快照生成于 ' + META.generatedAt;
  }

  /* ---------------- 其余交互 ---------------- */
  function setSidebar(open) { document.body.classList.toggle('sidebar-open', open); }
  function updateSidebarToggle(collapsed) {
    var btn = $('sidebar-toggle');
    btn.title = (collapsed ? '展开目录' : '收起目录') + ' (⌘/Ctrl+B)';
    btn.setAttribute('aria-label', collapsed ? '展开目录' : '收起目录');
  }
  // 桌面端（≥1024px，与 CSS 断点一致）折叠整栏并持久化偏好；
  // 移动端沿用现有抽屉遮罩（sidebar-open），忽略折叠类。
  function isDesktop() { return window.matchMedia('(min-width:1024px)').matches; }
  function toggleSidebar() {
    if (isDesktop()) {
      var collapsed = document.body.classList.toggle('sidebar-collapsed');
      try { localStorage.setItem('mdv-sidebar', collapsed ? 'collapsed' : 'open'); } catch (e) {}
      updateSidebarToggle(collapsed);
    } else {
      setSidebar(!document.body.classList.contains('sidebar-open'));
    }
  }
  $('sidebar-toggle').addEventListener('click', toggleSidebar);
  // 侧边栏头部 ×：桌面端折叠整栏，移动端关闭抽屉，与 ☰ / 快捷键同一入口
  $('sidebar-close').addEventListener('click', toggleSidebar);
  $('scrim').addEventListener('click', function () { setSidebar(false); });
  $('btn-print').addEventListener('click', function () { window.print(); });
  $('btn-prev').addEventListener('click', function () { navigate(this.getAttribute('data-slug')); });
  $('btn-next').addEventListener('click', function () { navigate(this.getAttribute('data-slug')); });

  document.addEventListener('keydown', function (ev) {
    // ⌘/Ctrl+B 切换侧边栏：搜索框聚焦时也生效（在输入框提前返回之前处理）
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'b' || ev.key === 'B')) {
      ev.preventDefault();
      toggleSidebar();
      return;
    }
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
  // 恢复桌面端侧边栏折叠偏好（移动端忽略）
  try {
    if (localStorage.getItem('mdv-sidebar') === 'collapsed' && isDesktop()) {
      document.body.classList.add('sidebar-collapsed');
    }
  } catch (e) {}
  updateSidebarToggle(document.body.classList.contains('sidebar-collapsed'));
  var initial = slugFromHash();
  // 空文档集时 docs[0] 不存在，显式兜底为 null，showDoc 内直接返回不报错
  var firstSlug = docs.length ? docs[0].slug : null;
  showDoc(initial && docBySlug[initial] ? initial : firstSlug, { scrollTop: true });
  if (!initial && firstSlug) { try { history.replaceState(null, '', '#doc-' + firstSlug); } catch (e) {} }
})();
