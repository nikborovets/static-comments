/*
 * widget.js — self-contained text-review widget (part of comments-service).
 *
 * Reviewers select text on any page, leave a comment; comments + threaded
 * replies are stored by the comments-service backend. A side panel lists all
 * comments; hovering a card highlights the referenced fragment on the page.
 *
 * No external dependencies. Injects its own styles and DOM. The API base is
 * derived from this script's own <src>, so the same file works both behind a
 * reverse proxy (e.g. <script src="/api/widget.js">) and published directly
 * (e.g. <script src="http://host:8000/widget.js">).
 *
 * Disable with ?comments=off in the URL (persisted) or localStorage
 * sgd_comments_off=1.
 */
(function () {
  "use strict";

  // ---- kill switch ---------------------------------------------------------
  var params = new URLSearchParams(location.search);
  if (params.get("comments") === "off") {
    try { localStorage.setItem("sgd_comments_off", "1"); } catch (e) {}
    return;
  }
  if (params.get("comments") === "on") {
    try { localStorage.removeItem("sgd_comments_off"); } catch (e) {}
  }
  try {
    if (localStorage.getItem("sgd_comments_off") === "1") return;
  } catch (e) {}

  // ---- API base (derived from this script's own URL) -----------------------
  // e.g. src ".../api/widget.js" -> base ".../api/" -> endpoints ".../api/comments"
  var SELF = document.currentScript;
  if (!SELF) {
    var scripts = document.getElementsByTagName("script");
    for (var si = scripts.length - 1; si >= 0; si--) {
      if (scripts[si].src && /widget\.js(\?|$)/.test(scripts[si].src)) { SELF = scripts[si]; break; }
    }
  }
  var BASE = "/api/";
  if (SELF && SELF.src) {
    BASE = SELF.src.replace(/[?#].*$/, "").replace(/[^/]*$/, "");
  }
  var EP = {
    comments: BASE + "comments",
    exportMd: BASE + "export.md",
    exportJson: BASE + "export.json",
    comment: function (id) { return BASE + "comments/" + id; },
    replies: function (id) { return BASE + "comments/" + id + "/replies"; },
    reply: function (id) { return BASE + "replies/" + id; }
  };

  var HL_NAME = "sgd-cmt";
  var CONTEXT_LEN = 40;

  // ---- styles --------------------------------------------------------------
  var css = `
  .sgd-cmt-btn, .sgd-cmt-launcher, .sgd-cmt-panel, .sgd-cmt-popover { box-sizing: border-box; }
  .sgd-cmt-btn {
    position: absolute; z-index: 99999; transform: translate(-50%, 8px);
    background: #2b6cb0; color: #fff; border: none; border-radius: 6px;
    padding: 5px 10px; font: 500 13px/1 system-ui, sans-serif; cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,.25);
  }
  .sgd-cmt-btn:hover { background: #2c5282; }
  .sgd-cmt-popover {
    position: absolute; z-index: 99999; width: 300px; background: #fff;
    border: 1px solid #d0d5dd; border-radius: 8px; padding: 12px;
    box-shadow: 0 6px 24px rgba(0,0,0,.18); font: 14px/1.4 system-ui, sans-serif;
    color: #1a202c;
  }
  .sgd-cmt-popover blockquote {
    margin: 0 0 8px; padding: 6px 8px; border-left: 3px solid #2b6cb0;
    background: #f0f5fb; font-size: 12px; color: #475467; max-height: 66px;
    overflow: auto; white-space: pre-wrap;
  }
  .sgd-cmt-popover textarea {
    width: 100%; min-height: 68px; resize: vertical; padding: 6px 8px;
    border: 1px solid #cbd5e0; border-radius: 6px; font: inherit;
  }
  .sgd-cmt-row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .sgd-cmt-row button { border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; font: 500 13px system-ui; }
  .sgd-cmt-send { background: #2b6cb0; color: #fff; }
  .sgd-cmt-cancel { background: #edf0f3; color: #344054; }

  .sgd-cmt-launcher {
    position: fixed; right: 18px; bottom: 18px; z-index: 99998;
    background: #2b6cb0; color: #fff; border: none; border-radius: 24px;
    padding: 10px 16px; font: 600 14px system-ui; cursor: pointer;
    box-shadow: 0 4px 14px rgba(0,0,0,.25);
  }
  .sgd-cmt-launcher:hover { background: #2c5282; }

  .sgd-cmt-panel {
    position: fixed; top: 0; right: 0; height: 100vh; width: 360px; max-width: 92vw;
    background: #fff; z-index: 99999; box-shadow: -4px 0 24px rgba(0,0,0,.18);
    display: flex; flex-direction: column; font: 14px/1.45 system-ui, sans-serif;
    color: #1a202c; transform: translateX(105%); transition: transform .18s ease;
  }
  .sgd-cmt-panel.open { transform: translateX(0); }
  .sgd-cmt-phead { padding: 12px 14px; border-bottom: 1px solid #e4e7ec; display: flex; align-items: center; gap: 8px; }
  .sgd-cmt-phead strong { font-size: 15px; flex: 1; }
  .sgd-cmt-phead button { border: none; background: #edf0f3; border-radius: 6px; padding: 5px 9px; cursor: pointer; font: 500 12px system-ui; }
  .sgd-cmt-tools { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid #e4e7ec; }
  .sgd-cmt-tools select { flex: 1; min-width: 0; font: 12px system-ui; padding: 4px 6px; border: 1px solid #cbd5e0; border-radius: 6px; background: #fff; color: #1a202c; }
  .sgd-cmt-plist { flex: 1; overflow: auto; padding: 8px 10px; }
  .sgd-cmt-section-h { font: 600 12px system-ui; text-transform: uppercase; letter-spacing: .04em; color: #667085; margin: 14px 4px 6px; }
  .sgd-cmt-card { border: 1px solid #e4e7ec; border-radius: 8px; padding: 9px 10px; margin-bottom: 8px; cursor: default; }
  .sgd-cmt-card:hover { border-color: #2b6cb0; background: #f7fafd; }
  .sgd-cmt-card.resolved { opacity: .55; }
  .sgd-cmt-card blockquote { margin: 0 0 6px; padding: 4px 8px; border-left: 3px solid #98a2b3; background: #f2f4f7; font-size: 12px; color: #475467; white-space: pre-wrap; }
  .sgd-cmt-card .sgd-cmt-text { white-space: pre-wrap; }
  .sgd-cmt-loc { font: 500 11px system-ui; color: #2b6cb0; margin: 0 0 5px; }
  .sgd-cmt-meta { display: flex; gap: 6px; align-items: center; margin-top: 6px; font-size: 11px; color: #667085; }
  .sgd-cmt-meta .sgd-cmt-actions { margin-left: auto; display: flex; gap: 6px; }
  .sgd-cmt-meta button { border: none; background: none; color: #2b6cb0; cursor: pointer; font: 500 11px system-ui; padding: 0; }
  .sgd-cmt-meta button.del { color: #b42318; }
  .sgd-cmt-empty { color: #667085; text-align: center; padding: 30px 12px; }
  .sgd-cmt-name-line { padding: 8px 14px; border-top: 1px solid #e4e7ec; font-size: 12px; color: #667085; display: flex; gap: 6px; align-items: center; }
  .sgd-cmt-name-line button { border: none; background: none; color: #2b6cb0; cursor: pointer; font: 500 12px system-ui; padding: 0; }
  ::highlight(sgd-cmt) { background: #ffe58f; color: inherit; }
  mark.sgd-cmt-hl { background: #ffe58f; color: inherit; padding: 0; }

  .sgd-cmt-replies { margin-top: 8px; border-top: 1px dashed #e4e7ec; padding-top: 6px; }
  .sgd-cmt-reply { font-size: 12px; padding: 4px 0 4px 10px; border-left: 2px solid #cbd5e0; margin-bottom: 4px; }
  .sgd-cmt-reply .sgd-cmt-reply-meta { color: #667085; font-size: 11px; display: flex; gap: 6px; align-items: center; }
  .sgd-cmt-reply .sgd-cmt-reply-meta button { border: none; background: none; color: #b42318; cursor: pointer; font: 500 11px system-ui; padding: 0; margin-left: auto; }
  .sgd-cmt-reply-body { white-space: pre-wrap; }
  .sgd-cmt-reply-form { display: flex; gap: 6px; margin-top: 6px; }
  .sgd-cmt-reply-form input { flex: 1; min-width: 0; border: 1px solid #cbd5e0; border-radius: 6px; padding: 4px 8px; font: 12px system-ui; }
  .sgd-cmt-reply-form button { border: none; background: #2b6cb0; color: #fff; border-radius: 6px; padding: 4px 10px; cursor: pointer; font: 500 12px system-ui; }
  `;
  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ---- reviewer name -------------------------------------------------------
  function getName() {
    var n = "";
    try { n = localStorage.getItem("sgd_reviewer_name") || ""; } catch (e) {}
    return n;
  }
  function ensureName() {
    var n = getName();
    if (n) return n;
    n = (window.prompt("Ваше имя (для подписи комментариев):", "") || "").trim();
    if (n) { try { localStorage.setItem("sgd_reviewer_name", n); } catch (e) {} }
    return n;
  }

  // ---- helpers -------------------------------------------------------------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function isInsideWidget(node) {
    while (node) {
      if (node.nodeType === 1 && node.classList &&
          (node.classList.contains("sgd-cmt-panel") ||
           node.classList.contains("sgd-cmt-popover") ||
           node.classList.contains("sgd-cmt-btn") ||
           node.classList.contains("sgd-cmt-launcher"))) return true;
      node = node.parentNode;
    }
    return false;
  }

  function closestSection(node) {
    var e = node.nodeType === 1 ? node : node.parentElement;
    // nearest <section> (id optional — many sections have a heading but no id)
    var sec = e && e.closest ? e.closest("section") : null;
    if (!sec) return { id: "", title: "" };
    var h = sec.querySelector("h1, h2, h3, .title, .subtitle");
    var title = h ? h.textContent.trim().replace(/\s+/g, " ") : "";
    return { id: sec.id || "", title: title || sec.id || "" };
  }

  // ---- floating "comment" button + popover ---------------------------------
  var floatBtn = null, popover = null;

  function clearFloat() {
    if (floatBtn) { floatBtn.remove(); floatBtn = null; }
  }
  function clearPopover() {
    if (popover) { popover.remove(); popover = null; }
  }

  document.addEventListener("mouseup", function (ev) {
    if (isInsideWidget(ev.target)) return;
    setTimeout(function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) { clearFloat(); return; }
      var text = sel.toString().trim();
      if (text.length < 2) { clearFloat(); return; }
      var range = sel.getRangeAt(0);
      if (isInsideWidget(range.commonAncestorContainer)) { clearFloat(); return; }
      showFloat(range, text);
    }, 0);
  });

  document.addEventListener("mousedown", function (ev) {
    if (floatBtn && ev.target === floatBtn) return;
    if (popover && popover.contains(ev.target)) return;
    clearFloat();
    if (popover && !popover.contains(ev.target)) clearPopover();
  });

  function showFloat(range, text) {
    clearFloat();
    var rects = range.getClientRects();
    var rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    floatBtn = el("button", "sgd-cmt-btn", "💬 Комментарий");
    floatBtn.style.left = (window.scrollX + rect.right) + "px";
    floatBtn.style.top = (window.scrollY + rect.bottom) + "px";
    var anchor = buildAnchor(range, text);
    floatBtn.addEventListener("click", function () { openPopover(rect, anchor); });
    document.body.appendChild(floatBtn);
  }

  function buildAnchor(range, exact) {
    var section = closestSection(range.startContainer);
    // prefix: text just before the selection start
    var pre = document.createRange();
    pre.setStart(range.startContainer, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    var prefix = pre.toString().slice(-CONTEXT_LEN);
    // suffix: text just after the selection end
    var suf = document.createRange();
    suf.setStart(range.endContainer, range.endOffset);
    try { suf.setEnd(range.endContainer, range.endContainer.length || range.endContainer.childNodes.length); } catch (e) {}
    var suffix = suf.toString().slice(0, CONTEXT_LEN);

    var anchor = {
      quote: exact, prefix: prefix, suffix: suffix,
      sectionId: section.id, sectionTitle: section.title,
      blockId: null, blockLine: null, blockIndex: null,
      startOffset: null, endOffset: null
    };

    // Block anchor: char offsets within the nearest [data-cmt-id] block's text.
    var startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    var block = startEl && startEl.closest ? startEl.closest("[data-cmt-id]") : null;
    if (block) {
      try {
        var s = document.createRange();
        s.selectNodeContents(block);
        s.setEnd(range.startContainer, range.startOffset);
        var startOffset = s.toString().length;
        var e = document.createRange();
        e.selectNodeContents(block);
        e.setEnd(range.endContainer, range.endOffset);
        var endOffset = e.toString().length;
        anchor.blockId = block.getAttribute("data-cmt-id");
        anchor.blockLine = parseInt(block.getAttribute("data-cmt-line"), 10) || null;
        var parts = (anchor.blockId || "").split(":");
        anchor.blockIndex = parts.length > 1 ? (parseInt(parts[parts.length - 1], 10) || null) : null;
        anchor.startOffset = startOffset;
        anchor.endOffset = endOffset;
      } catch (err) { /* fall back to quote-only anchoring */ }
    }
    return anchor;
  }

  function openPopover(rect, anchor) {
    var name = ensureName();
    if (!name) return;
    clearFloat();
    clearPopover();
    popover = el("div", "sgd-cmt-popover");
    var bq = el("blockquote", null, anchor.quote);
    var ta = el("textarea");
    ta.placeholder = "Что поправить в этом фрагменте?";
    var row = el("div", "sgd-cmt-row");
    var cancel = el("button", "sgd-cmt-cancel", "Отмена");
    var send = el("button", "sgd-cmt-send", "Отправить");
    row.appendChild(cancel); row.appendChild(send);
    popover.appendChild(bq); popover.appendChild(ta); popover.appendChild(row);

    var top = window.scrollY + rect.bottom + 8;
    var left = Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - 316);
    popover.style.top = top + "px";
    popover.style.left = Math.max(8, left) + "px";
    document.body.appendChild(popover);
    ta.focus();

    cancel.addEventListener("click", clearPopover);
    send.addEventListener("click", function () {
      var comment = ta.value.trim();
      if (!comment) { ta.focus(); return; }
      send.disabled = true; send.textContent = "…";
      fetch(EP.comments, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ author: name, comment: comment }, anchor))
      }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then(function () {
        clearPopover();
        window.getSelection().removeAllRanges();
        refreshComments();
      }).catch(function (err) {
        send.disabled = false; send.textContent = "Отправить";
        alert("Не удалось сохранить комментарий: " + err.message);
      });
    });
    ta.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send.click();
    });
  }

  // ---- side panel ----------------------------------------------------------
  var launcher, panel, listEl, sortSel, authorSel, comments = [];
  var sortMode = "pos";      // pos | new | old
  var authorFilter = "";     // "" = all reviewers

  function buildPanel() {
    launcher = el("button", "sgd-cmt-launcher", "💬 0");
    launcher.addEventListener("click", togglePanel);
    document.body.appendChild(launcher);

    panel = el("div", "sgd-cmt-panel");
    var head = el("div", "sgd-cmt-phead");
    head.appendChild(el("strong", null, "Комментарии"));
    var mdBtn = el("button", null, ".md");
    mdBtn.title = "Экспорт в Markdown (для чтения)";
    mdBtn.addEventListener("click", function () { window.open(EP.exportMd, "_blank"); });
    var jsonBtn = el("button", null, ".json");
    jsonBtn.title = "Экспорт в JSON (для обработки)";
    jsonBtn.addEventListener("click", function () { window.open(EP.exportJson, "_blank"); });
    var closeBtn = el("button", null, "✕");
    closeBtn.addEventListener("click", togglePanel);
    head.appendChild(mdBtn); head.appendChild(jsonBtn); head.appendChild(closeBtn);

    // toolbar: sort + reviewer filter
    var tools = el("div", "sgd-cmt-tools");
    sortSel = document.createElement("select");
    [["pos", "По расположению"], ["new", "Сначала новые"], ["old", "Сначала старые"]]
      .forEach(function (o) {
        var opt = document.createElement("option");
        opt.value = o[0]; opt.textContent = o[1];
        sortSel.appendChild(opt);
      });
    sortSel.value = sortMode;
    sortSel.addEventListener("change", function () { sortMode = sortSel.value; renderList(); });
    authorSel = document.createElement("select");
    authorSel.addEventListener("change", function () { authorFilter = authorSel.value; renderList(); });
    tools.appendChild(sortSel); tools.appendChild(authorSel);

    listEl = el("div", "sgd-cmt-plist");

    var nameLine = el("div", "sgd-cmt-name-line");
    var nameSpan = el("span", null, "");
    var changeBtn = el("button", null, "сменить имя");
    changeBtn.addEventListener("click", function () {
      var n = (window.prompt("Ваше имя:", getName()) || "").trim();
      if (n) { try { localStorage.setItem("sgd_reviewer_name", n); } catch (e) {} renderNameLine(nameSpan); }
    });
    nameLine.appendChild(nameSpan); nameLine.appendChild(changeBtn);
    renderNameLine(nameSpan);

    panel.appendChild(head);
    panel.appendChild(tools);
    panel.appendChild(listEl);
    panel.appendChild(nameLine);
    document.body.appendChild(panel);
  }

  function refreshAuthorOptions() {
    if (!authorSel) return;
    var seen = {}, authors = [];
    comments.forEach(function (c) {
      if (c.author && !seen[c.author]) { seen[c.author] = 1; authors.push(c.author); }
    });
    authors.sort(function (a, b) { return a.localeCompare(b); });
    if (authorFilter && authors.indexOf(authorFilter) === -1) authorFilter = "";
    authorSel.innerHTML = "";
    var all = document.createElement("option");
    all.value = ""; all.textContent = "Все ревьюеры";
    authorSel.appendChild(all);
    authors.forEach(function (a) {
      var opt = document.createElement("option");
      opt.value = a; opt.textContent = a;
      authorSel.appendChild(opt);
    });
    authorSel.value = authorFilter;
  }

  function renderNameLine(span) {
    var n = getName();
    span.textContent = n ? ("Вы: " + n) : "Имя не задано";
  }

  function togglePanel() {
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) refreshComments();
  }

  function refreshComments() {
    fetch(EP.comments).then(function (r) { return r.json(); }).then(function (data) {
      comments = data || [];
      computeMeta();               // page position + resolved section label
      refreshAuthorOptions();
      var open = comments.filter(function (c) { return !c.resolved; }).length;
      launcher.textContent = "💬 " + open;
      renderList();
    }).catch(function () {
      launcher.textContent = "💬 —";
    });
  }

  // For each comment, locate its fragment once to get: vertical page position
  // (for "by location" sort) and a resolved section label (fixes "Без секции"
  // for anchored comments even when the stored section was empty).
  function computeMeta() {
    var corpus = null;
    comments.forEach(function (c) {
      var range = blockRange(c);
      if (!range) {
        if (!corpus) corpus = collectTextNodes();
        range = quoteRangeFrom(c, corpus);
      }
      if (range) {
        var rect = range.getBoundingClientRect();
        c._y = rect.top + window.scrollY;
        var s = closestSection(range.startContainer);
        c._section = c.sectionTitle || s.title || c.sectionId || "Без секции";
      } else {
        c._y = Infinity;
        c._section = c.sectionTitle || c.sectionId || "Без секции";
      }
    });
  }

  function sortedFiltered() {
    var list = comments.filter(function (c) {
      return !authorFilter || c.author === authorFilter;
    });
    list.sort(function (a, b) {
      if (sortMode === "new" || sortMode === "old") {
        var d = (a.created_at || "").localeCompare(b.created_at || "");
        return sortMode === "new" ? -d : d;
      }
      // pos: by page position, then by id as a stable tiebreak
      if (a._y !== b._y) return a._y - b._y;
      return a.id - b.id;
    });
    return list;
  }

  function renderList() {
    listEl.innerHTML = "";
    var list = sortedFiltered();
    if (!list.length) {
      var msg = comments.length
        ? "Нет комментариев по этому фильтру."
        : "Пока нет комментариев. Выделите текст на странице, чтобы оставить первый.";
      listEl.appendChild(el("div", "sgd-cmt-empty", msg));
      return;
    }
    if (sortMode === "pos") {
      // group by section (already in page order)
      var lastSection = null;
      list.forEach(function (c) {
        if (c._section !== lastSection) {
          lastSection = c._section;
          listEl.appendChild(el("div", "sgd-cmt-section-h", c._section));
        }
        listEl.appendChild(renderCard(c));
      });
    } else {
      list.forEach(function (c) { listEl.appendChild(renderCard(c)); });
    }
  }

  function renderCard(c) {
    var card = el("div", "sgd-cmt-card" + (c.resolved ? " resolved" : ""));
    card.appendChild(el("blockquote", null, c.quote));
    card.appendChild(el("div", "sgd-cmt-text", c.comment));
    var loc = [];
    if (c.blockIndex != null) loc.push("блок " + c.blockIndex);
    if (c.blockLine != null) loc.push("стр. " + c.blockLine);
    var section = c._section || c.sectionTitle || c.sectionId || "";
    var locText = section;
    if (loc.length) locText += (locText ? "  ·  " : "") + loc.join(" · ");
    if (locText) card.appendChild(el("div", "sgd-cmt-loc", locText));

    var meta = el("div", "sgd-cmt-meta");
    var when = c.created_at ? new Date(c.created_at).toLocaleString() : "";
    meta.appendChild(el("span", null, (c.author || "?") + " · " + when));
    var actions = el("div", "sgd-cmt-actions");
    var resolveBtn = el("button", null, c.resolved ? "вернуть" : "решено");
    resolveBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      fetch(EP.comment(c.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved: !c.resolved })
      }).then(refreshComments);
    });
    var delBtn = el("button", "del", "удалить");
    delBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!confirm("Удалить комментарий?")) return;
      fetch(EP.comment(c.id), { method: "DELETE" }).then(refreshComments);
    });
    actions.appendChild(resolveBtn); actions.appendChild(delBtn);
    meta.appendChild(actions);
    card.appendChild(meta);

    card.appendChild(renderReplies(c));

    card.addEventListener("mouseenter", function () { highlightAnchor(c); });
    card.addEventListener("mouseleave", clearHighlight);
    return card;
  }

  function renderReplies(c) {
    var wrap = el("div", "sgd-cmt-replies");
    (c.replies || []).forEach(function (rep) {
      var r = el("div", "sgd-cmt-reply");
      var rmeta = el("div", "sgd-cmt-reply-meta");
      var when = rep.created_at ? new Date(rep.created_at).toLocaleString() : "";
      rmeta.appendChild(el("span", null, rep.author + " · " + when));
      var rdel = el("button", null, "×");
      rdel.title = "Удалить ответ";
      rdel.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!confirm("Удалить ответ?")) return;
        fetch(EP.reply(rep.id), { method: "DELETE" }).then(refreshComments);
      });
      rmeta.appendChild(rdel);
      r.appendChild(el("div", "sgd-cmt-reply-body", rep.body));
      r.appendChild(rmeta);
      wrap.appendChild(r);
    });

    var form = el("div", "sgd-cmt-reply-form");
    var input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Ответить…";
    var btn = el("button", null, "→");
    function submit() {
      var body = input.value.trim();
      if (!body) return;
      var name = ensureName();
      if (!name) return;
      btn.disabled = true;
      fetch(EP.replies(c.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author: name, body: body })
      }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        refreshComments();
      }).catch(function (err) {
        btn.disabled = false;
        alert("Не удалось отправить ответ: " + err.message);
      });
    }
    btn.addEventListener("click", function (e) { e.stopPropagation(); submit(); });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    form.appendChild(input); form.appendChild(btn);
    wrap.appendChild(form);
    return wrap;
  }

  // ---- hover highlight (CSS Custom Highlight API) --------------------------
  // The stored quote comes from Selection.toString(), which collapses
  // whitespace; the live DOM text keeps original newlines/indentation. So we
  // build a whitespace-normalized corpus with a map back to original offsets
  // and search in normalized space.
  function normStr(s) { return (s || "").replace(/\s+/g, " ").trim(); }

  function collectTextNodes() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (isInsideWidget(node)) return NodeFilter.FILTER_REJECT;
        var p = node.parentElement;
        if (p && (p.tagName === "SCRIPT" || p.tagName === "STYLE")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var map = [], full = "", n;
    while ((n = walker.nextNode())) {
      map.push({ node: n, start: full.length });
      full += n.nodeValue;
    }
    // normalized corpus + per-char mapping back to original `full` offsets
    var norm = "", normToOrig = [], prevSpace = true;
    for (var i = 0; i < full.length; i++) {
      var ch = full[i];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") {
        if (prevSpace) continue;
        norm += " "; normToOrig.push(i); prevSpace = true;
      } else {
        norm += ch; normToOrig.push(i); prevSpace = false;
      }
    }
    return { full: full, map: map, norm: norm, normToOrig: normToOrig };
  }

  // Returns { start, end } as original-`full` offsets, or null.
  function locate(data, c) {
    var q = normStr(c.quote);
    if (!q) return null;
    var pfx = normStr(c.prefix);
    var occurrences = [], from = 0, i;
    while ((i = data.norm.indexOf(q, from)) !== -1) {
      occurrences.push(i);
      from = i + 1;
    }
    if (!occurrences.length) return null;
    var chosen = occurrences[0];
    if (occurrences.length > 1 && pfx) {
      for (var k = 0; k < occurrences.length; k++) {
        var before = data.norm.slice(Math.max(0, occurrences[k] - pfx.length), occurrences[k]);
        if (before === pfx || before.slice(-pfx.length) === pfx) { chosen = occurrences[k]; break; }
      }
    }
    var normStart = chosen, normEnd = chosen + q.length - 1;
    return {
      start: data.normToOrig[normStart],
      end: data.normToOrig[normEnd] + 1
    };
  }

  function offsetToPoint(map, offset) {
    for (var i = map.length - 1; i >= 0; i--) {
      if (offset >= map[i].start) {
        return { node: map[i].node, offset: offset - map[i].start };
      }
    }
    return { node: map[0].node, offset: 0 };
  }

  function highlightAnchor(c) {
    clearHighlight();
    var range = blockRange(c) || quoteRange(c);
    if (!range) { scrollToPlain(c); return; }

    var host = range.startContainer.nodeType === 1
      ? range.startContainer
      : range.startContainer.parentElement;

    if (("highlights" in CSS) && typeof Highlight !== "undefined") {
      CSS.highlights.set(HL_NAME, new Highlight(range));
    } else {
      // Fallback for browsers without the Highlight API: wrap in a <mark>.
      fallbackWrap(range);
    }
    if (host && host.scrollIntoView) host.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // Safe [data-cmt-id="..."] lookup: escape the value for the attribute
  // selector (backslash/quote) and swallow any SyntaxError from a crafted id.
  function blockById(id) {
    if (id == null) return null;
    var esc = String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    try {
      return document.querySelector('[data-cmt-id="' + esc + '"]');
    } catch (e) { return null; }
  }

  // Preferred anchor: exact char offsets inside a known [data-cmt-id] block.
  function blockRange(c) {
    if (c.blockId == null || c.startOffset == null || c.endOffset == null) return null;
    var block = blockById(c.blockId);
    if (!block) return null;
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    var acc = 0, startPt = null, endPt = null, n;
    while ((n = walker.nextNode())) {
      var len = n.nodeValue.length;
      if (startPt === null && c.startOffset <= acc + len) {
        startPt = { node: n, offset: Math.max(0, c.startOffset - acc) };
      }
      if (c.endOffset <= acc + len) {
        endPt = { node: n, offset: Math.max(0, c.endOffset - acc) };
        break;
      }
      acc += len;
    }
    if (!startPt || !endPt) return null;
    var range = document.createRange();
    try {
      range.setStart(startPt.node, startPt.offset);
      range.setEnd(endPt.node, endPt.offset);
    } catch (e) { return null; }
    return range;
  }

  // Fallback anchor (legacy comments / missing block): normalized text search.
  function quoteRange(c) {
    return quoteRangeFrom(c, collectTextNodes());
  }

  // Same, but reusing a prebuilt corpus (so a whole list can be located in one pass).
  function quoteRangeFrom(c, data) {
    var pos = locate(data, c);
    if (!pos) return null;
    var a = offsetToPoint(data.map, pos.start);
    var b = offsetToPoint(data.map, pos.end);
    var range = document.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    } catch (e) { return null; }
    return range;
  }

  // Fallback highlight: surround the range with a removable <mark>.
  var fallbackMark = null;
  function fallbackWrap(range) {
    try {
      var mark = document.createElement("mark");
      mark.className = "sgd-cmt-hl";
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
      fallbackMark = mark;
    } catch (e) { /* range crosses element boundaries — skip */ }
  }
  function fallbackUnwrap() {
    if (!fallbackMark) return;
    var parent = fallbackMark.parentNode;
    while (fallbackMark.firstChild) parent.insertBefore(fallbackMark.firstChild, fallbackMark);
    parent.removeChild(fallbackMark);
    parent.normalize();
    fallbackMark = null;
  }

  function scrollToPlain(c) {
    if (c.sectionId) {
      var sec = document.getElementById(c.sectionId);
      if (sec) sec.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function clearHighlight() {
    if ("highlights" in CSS) CSS.highlights.delete(HL_NAME);
    fallbackUnwrap();
  }

  // ---- init ----------------------------------------------------------------
  function init() {
    buildPanel();
    refreshComments();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
