/* FileGuard portal prototype: page behaviour. No server calls; data comes from data.js. */
(function () {
  "use strict";

  var DATA = window.FILEGUARD_DATA;
  var CLIENTS = DATA.clients;
  var SERIES_COLORS = ["#E95420", "#772953"]; // orange for the first client, aubergine for the second

  /* ---------------- Helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  // Shown in UTC so the placeholder data reads the same everywhere.
  function fmtDate(unix) {
    if (!unix) return "";
    var d = new Date(unix * 1000);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + " " +
      pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + " UTC";
  }
  function fmtShort(unix) {
    var d = new Date(unix * 1000);
    return pad(d.getUTCMonth() + 1) + "/" + pad(d.getUTCDate()) + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
  }
  function fmtDuration(sec) { return Math.floor(sec / 60) + "m " + pad(sec % 60) + "s"; }
  function fmtSize(kib) { return kib >= 1024 ? (kib / 1024).toFixed(1) + " MiB" : kib + " KiB"; }
  function clientById(id) { return CLIENTS.filter(function (c) { return c.id === id; })[0]; }
  function isErrorCode(h) { return !/^[0-9a-f]{64}$/.test(h); }

  function fillClientSelect(sel, includeAll) {
    var html = includeAll ? '<option value="all">All clients</option>' : "";
    CLIENTS.forEach(function (c) {
      html += '<option value="' + esc(c.id) + '">' + esc(c.name) + " (" + esc(c.id) + ")</option>";
    });
    sel.innerHTML = html;
  }

  var toastTimer;
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2200);
  }

  /* ---------------- Tabs ---------------- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  function selectTab(tab) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !on;
    });
    if (tab.id === "tab-trends") renderChart(); // size depends on being visible
  }
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { selectTab(t); });
    t.addEventListener("keydown", function (e) {
      var j = null;
      if (e.key === "ArrowRight") j = (i + 1) % tabs.length;
      if (e.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
      if (j !== null) { tabs[j].focus(); selectTab(tabs[j]); }
    });
  });

  /* ---------------- Report (kept for this browser tab only) ---------------- */
  var report = [];
  try { report = JSON.parse(sessionStorage.getItem("fg-report") || "[]"); } catch (e) { report = []; }
  function saveReport() { try { sessionStorage.setItem("fg-report", JSON.stringify(report)); } catch (e) { /* ignore */ } }

  function addToReport(kind, title, html) {
    report.push({ kind: kind, title: title, html: html, added: Math.floor(Date.now() / 1000) });
    saveReport();
    renderReport();
    toast("Added to report: " + title);
  }
  function renderReport() {
    $("report-count").textContent = report.length;
    $("report-export").disabled = report.length === 0;
    $("report-clear").disabled = report.length === 0;
    var list = $("report-list");
    if (!report.length) {
      list.innerHTML = '<div class="report-item"><span class="when" style="margin:0">Nothing added yet. Use the "+ Add" buttons on each tab.</span></div>';
      return;
    }
    list.innerHTML = report.map(function (r, i) {
      return '<div class="report-item"><span class="kind">' + esc(r.kind) + "</span><span>" + esc(r.title) +
        '</span><span class="when">' + fmtShort(r.added) + '</span><button class="btn ghost" data-remove="' + i + '">Remove</button></div>';
    }).join("");
  }
  $("report-list").addEventListener("click", function (e) {
    var i = e.target.getAttribute("data-remove");
    if (i === null) return;
    report.splice(+i, 1);
    saveReport();
    renderReport();
  });
  $("report-toggle").addEventListener("click", function () {
    var list = $("report-list");
    list.hidden = !list.hidden;
    this.setAttribute("aria-expanded", String(!list.hidden));
    this.textContent = list.hidden ? "Show items" : "Hide items";
  });
  $("report-clear").addEventListener("click", function () {
    report = [];
    saveReport();
    renderReport();
    toast("Report cleared");
  });
  // PROTOTYPE: export does not create a file. It only shows a confirmation.
  $("report-export").addEventListener("click", function () {
    $("export-text").textContent = report.length + (report.length === 1 ? " item" : " items") +
      " included. (Prototype: no file is actually created.)";
    $("export-modal").hidden = false;
    $("export-close").focus();
  });
  function closeModal() { $("export-modal").hidden = true; $("report-export").focus(); }
  $("export-close").addEventListener("click", closeModal);
  $("export-modal").addEventListener("click", function (e) { if (e.target === this) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("export-modal").hidden) closeModal(); });

  /* ---------------- Tab 1: Scan imports ---------------- */
  var importsSel = $("imports-client");
  fillClientSelect(importsSel, true);

  function scansFor(id) {
    var rows = [];
    CLIENTS.forEach(function (c) {
      if (id !== "all" && c.id !== id) return;
      c.scans.forEach(function (s) { rows.push({ client: c, scan: s }); });
    });
    return rows.sort(function (a, b) { return b.scan.started - a.scan.started; }); // newest first
  }
  function numCell(n, kind) {
    if (!n) return '<td class="num"><span class="badge zero">0</span></td>';
    return '<td class="num"><span class="badge ' + kind + '">' + n + "</span></td>";
  }
  function renderImports() {
    var id = importsSel.value;
    var rows = scansFor(id);
    var latest = {};
    rows.forEach(function (r) { if (!latest[r.client.id]) latest[r.client.id] = r.scan; });
    var tot = { found: 0, hashed: 0, failed: 0, changed: 0 };
    Object.keys(latest).forEach(function (k) {
      tot.found += latest[k].filesFound; tot.hashed += latest[k].filesHashed;
      tot.failed += latest[k].failed; tot.changed += latest[k].changed;
    });
    var changedAll = rows.reduce(function (a, r) { return a + r.scan.changed; }, 0);
    $("imports-stats").innerHTML =
      '<div class="card stat"><div class="label">Files found</div><div class="value">' + tot.found + '</div><div class="hint">latest scan per client</div></div>' +
      '<div class="card stat alt"><div class="label">Files hashed</div><div class="value">' + tot.hashed + '</div><div class="hint">latest scan per client</div></div>' +
      '<div class="card stat bad"><div class="label">Failed hashes</div><div class="value">' + tot.failed + '</div><div class="hint">latest scan per client</div></div>' +
      '<div class="card stat"><div class="label">Hash changes</div><div class="value">' + changedAll + '</div><div class="hint">across ' + rows.length + " scans shown</div></div>";

    $("imports-table").querySelector("tbody").innerHTML = rows.map(function (r, i) {
      var s = r.scan;
      var fails = s.failures.map(function (f) {
        return '<div><span class="badge error">' + esc(f.code) + '</span> <span class="mono">' + esc(f.path) + "</span></div>";
      }).join("") || '<span class="badge ok">No failures</span>';
      return '<tr class="scan-row" data-i="' + i + '" tabindex="0" aria-expanded="false">' +
        '<td><span class="caret">&#9656;</span></td>' +
        "<td><strong>" + esc(r.client.name) + '</strong><br><span class="mono" style="font-size:12px;color:var(--muted)">' + esc(r.client.id) + "</span></td>" +
        "<td>" + fmtDate(s.started) + "</td><td>" + fmtDuration(s.finished - s.started) + "</td>" +
        '<td class="num">' + s.dirsScanned + '</td><td class="num">' + s.filesFound + '</td><td class="num">' + s.filesHashed + "</td>" +
        numCell(s.failed, "error") + numCell(s.newFiles, "new") + numCell(s.changed, "changed") + numCell(s.deleted, "deleted") +
        "</tr>" +
        '<tr class="detail-row" hidden><td colspan="11"><strong>Scan #' + s.id + " failures</strong>" + fails + "</td></tr>";
    }).join("");
  }
  function toggleScanRow(tr) {
    var open = !tr.classList.contains("open");
    tr.classList.toggle("open", open);
    tr.setAttribute("aria-expanded", String(open));
    tr.nextElementSibling.hidden = !open;
  }
  $("imports-table").addEventListener("click", function (e) {
    var tr = e.target.closest("tr.scan-row");
    if (tr) toggleScanRow(tr);
  });
  $("imports-table").addEventListener("keydown", function (e) {
    var tr = e.target.closest("tr.scan-row");
    if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleScanRow(tr); }
  });
  importsSel.addEventListener("change", renderImports);
  $("imports-add").addEventListener("click", function () {
    var label = importsSel.options[importsSel.selectedIndex].text;
    var tbl = $("imports-table").cloneNode(true);
    tbl.removeAttribute("id");
    addToReport("Scans", "Scan imports: " + label, $("imports-stats").outerHTML + tbl.outerHTML);
  });

  /* ---------------- Tab 2: Client file tree ---------------- */
  var treeSel = $("tree-client");
  fillClientSelect(treeSel, false);
  var nodeIndex = [];   // flat list so each row can look up its node
  var selectedNode = null;

  var ICON_DIR = '<svg class="ico" viewBox="0 0 24 24" fill="#E95420"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  var ICON_FILE = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="#772953" stroke-width="1.8"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>';
  var ICON_PC = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="#2C001E" stroke-width="1.8"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/></svg>';

  function statusBadge(n) {
    if (n.status === "error") return '<span class="badge error">' + esc(n.errorCode) + "</span>";
    if (n.status === "changed") return '<span class="badge changed">Changed</span>';
    if (n.status === "deleted") return '<span class="badge deleted">Deleted</span>';
    if (n.status === "new") return '<span class="badge new">New</span>';
    return "";
  }
  function countFiles(n) {
    if (n.type === "file") return 1;
    return n.children.reduce(function (a, c) { return a + countFiles(c); }, 0);
  }
  function hasFlag(n) {
    if (n.type === "file") return n.status !== "ok";
    return n.status === "error" || n.children.some(hasFlag);
  }

  function renderNode(n, depth) {
    var i = nodeIndex.push(n) - 1;
    var isDir = n.type === "dir";
    var expandable = isDir && n.children.length > 0;
    var row = '<div class="tree-row" role="treeitem" tabindex="-1" data-i="' + i + '" style="">' +
      '<span class="twisty">' + (expandable ? "&#9656;" : "") + "</span>" +
      (isDir ? ICON_DIR : ICON_FILE) + '<span class="nm">' + esc(n.name) + "</span>" + statusBadge(n) + "</div>";
    var kids = expandable ? "<ul role=\"group\">" + n.children.map(function (c) { return renderNode(c, depth + 1); }).join("") + "</ul>" : "";
    return '<li' + (expandable ? ' aria-expanded="false"' : "") + ">" + row + kids + "</li>";
  }
  function renderTree() {
    var c = clientById(treeSel.value);
    nodeIndex = [];
    var rootNode = { type: "client", name: c.name, client: c, children: c.tree };
    var ri = nodeIndex.push(rootNode) - 1;
    $("tree").innerHTML = '<li aria-expanded="true"><div class="tree-row tree-root-row" role="treeitem" tabindex="0" data-i="' + ri + '">' +
      '<span class="twisty">&#9656;</span>' + ICON_PC + '<span class="nm">' + esc(c.name) + "</span></div>" +
      '<ul role="group">' + c.tree.map(function (n) { return renderNode(n, 1); }).join("") + "</ul></li>";
    updateTwisties();
    selectRow($("tree").querySelector(".tree-row"));
  }
  function updateTwisties() {
    Array.prototype.forEach.call($("tree").querySelectorAll("li[aria-expanded]"), function (li) {
      var tw = li.querySelector(":scope > .tree-row .twisty");
      tw.innerHTML = li.getAttribute("aria-expanded") === "true" ? "&#9662;" : "&#9656;";
    });
  }
  function selectRow(row) {
    Array.prototype.forEach.call($("tree").querySelectorAll(".tree-row"), function (r) {
      r.classList.remove("selected"); r.tabIndex = -1; r.removeAttribute("aria-selected");
    });
    row.classList.add("selected");
    row.tabIndex = 0;
    row.setAttribute("aria-selected", "true");
    selectedNode = nodeIndex[+row.getAttribute("data-i")];
    renderDetail(selectedNode);
  }
  function toggleRow(row, force) {
    var li = row.parentElement;
    if (!li.hasAttribute("aria-expanded")) return;
    var open = force !== undefined ? force : li.getAttribute("aria-expanded") !== "true";
    li.setAttribute("aria-expanded", String(open));
    updateTwisties();
  }
  $("tree").addEventListener("click", function (e) {
    var row = e.target.closest(".tree-row");
    if (!row) return;
    if (e.target.closest(".twisty") || row.classList.contains("selected")) toggleRow(row);
    else { selectRow(row); toggleRow(row, true); }
  });
  $("tree").addEventListener("dblclick", function (e) {
    var row = e.target.closest(".tree-row");
    if (row) toggleRow(row);
  });
  $("tree").addEventListener("keydown", function (e) {
    var row = e.target.closest(".tree-row");
    if (!row) return;
    var visible = Array.prototype.filter.call($("tree").querySelectorAll(".tree-row"), function (r) { return r.offsetParent !== null; });
    var idx = visible.indexOf(row);
    var next = null;
    if (e.key === "ArrowDown") next = visible[idx + 1];
    else if (e.key === "ArrowUp") next = visible[idx - 1];
    else if (e.key === "ArrowRight") toggleRow(row, true);
    else if (e.key === "ArrowLeft") toggleRow(row, false);
    else if (e.key === "Enter" || e.key === " ") toggleRow(row);
    else return;
    e.preventDefault();
    if (next) { selectRow(next); next.focus(); }
  });
  $("tree-expand").addEventListener("click", function () {
    var lis = $("tree").querySelectorAll("li[aria-expanded]");
    var anyClosed = Array.prototype.some.call(lis, function (li) { return li.getAttribute("aria-expanded") === "false"; });
    Array.prototype.forEach.call(lis, function (li) { li.setAttribute("aria-expanded", String(anyClosed)); });
    if (!anyClosed) $("tree").firstElementChild.setAttribute("aria-expanded", "true");
    this.textContent = anyClosed ? "Collapse all" : "Expand all";
    updateTwisties();
  });
  treeSel.addEventListener("change", function () { $("tree-expand").textContent = "Expand all"; renderTree(); });

  function detailHtml(n) {
    var c = clientById(treeSel.value);
    if (n.type === "client") {
      var last = c.scans[c.scans.length - 1];
      return "<h3>" + esc(c.name) + "</h3>" +
        '<dl class="props">' +
        "<dt>Client ID</dt><dd class=\"mono\">" + esc(c.id) + "</dd>" +
        "<dt>Operating system</dt><dd>" + esc(c.os) + "</dd>" +
        "<dt>Monitored roots</dt><dd class=\"mono\">" + c.roots.map(esc).join("<br>") + "</dd>" +
        "<dt>Scan interval</dt><dd>Every " + c.scanEveryHours + " hours</dd>" +
        "<dt>Last upload</dt><dd>" + fmtDate(c.lastContact) + "</dd>" +
        "<dt>Last scan</dt><dd>#" + last.id + ": " + last.filesFound + " found, " + last.filesHashed + " hashed, " + last.failed + " failed</dd>" +
        "</dl>";
    }
    if (n.type === "dir") {
      var out = "<h3>" + ICON_DIR.replace('class="ico"', 'class="ico" style="vertical-align:-3px"') + " " + esc(n.name) + "</h3>";
      if (n.status === "error") {
        out += '<div class="callout bad"><strong>' + esc(n.errorCode) + ":</strong> " + esc(DATA.errorCodes[n.errorCode] || "") + "</div>";
      }
      var dirs = n.children.filter(function (x) { return x.type === "dir"; }).length;
      out += '<dl class="props">' +
        "<dt>Path</dt><dd class=\"mono\">" + esc(n.path) + "</dd>" +
        "<dt>Subfolders</dt><dd>" + dirs + "</dd>" +
        "<dt>Files (all levels)</dt><dd>" + countFiles(n) + "</dd>" +
        "<dt>Needs attention</dt><dd>" + (hasFlag(n) ? '<span class="badge changed">Yes</span>' : '<span class="badge ok">No</span>') + "</dd>" +
        (n.firstSeen ? "<dt>First reported</dt><dd>" + fmtDate(n.firstSeen) + "</dd>" : "") +
        "</dl>";
      if (n.children.length) {
        out += '<table><thead><tr><th>Name</th><th class="num">Size</th><th>Status</th></tr></thead><tbody>' +
          n.children.map(function (k) {
            return "<tr><td>" + esc(k.name) + (k.type === "dir" ? "/" : "") + '</td><td class="num">' + (k.type === "file" ? fmtSize(k.sizeKiB) : "") +
              "</td><td>" + (statusBadge(k) || '<span class="badge ok">OK</span>') + "</td></tr>";
          }).join("") + "</tbody></table>";
      }
      return out;
    }
    // file
    var active = n.history[0];
    var lastChange = n.history.length > 1 ? active.hashDate : null;
    var goodHashes = n.history.filter(function (h) { return !isErrorCode(h.hash); });
    var out2 = "<h3>" + ICON_FILE.replace('class="ico"', 'class="ico" style="vertical-align:-3px"') + " " + esc(n.name) + "</h3>";
    if (n.status === "changed") out2 += '<div class="callout warn"><strong>Hash changed.</strong> The file content is different from an earlier scan. Confirm the change was expected.</div>';
    if (n.status === "new") out2 += '<div class="callout warn"><strong>New file.</strong> First seen in the latest scan of a folder that was already monitored.</div>';
    if (n.status === "deleted") out2 += '<div class="callout info"><strong>Deleted.</strong> Not found since ' + fmtDate(n.deletedAt) + ". Last known hash is kept below.</div>";
    if (n.status === "error") out2 += '<div class="callout bad"><strong>' + esc(n.errorCode) + ":</strong> " + esc(DATA.errorCodes[n.errorCode] || "") + "</div>";
    out2 += '<dl class="props">' +
      "<dt>Name</dt><dd>" + esc(n.name) + "</dd>" +
      "<dt>Path</dt><dd class=\"mono\">" + esc(n.path) + "</dd>" +
      "<dt>Size</dt><dd>" + fmtSize(n.sizeKiB) + "</dd>" +
      "<dt>Current SHA-256</dt><dd class=\"hash\">" + (goodHashes.length && !isErrorCode(active.hash) ? esc(active.hash) : '<span class="badge error">' + esc(active.hash) + "</span>") + "</dd>" +
      "<dt>Date found</dt><dd>" + fmtDate(n.firstSeen) + "</dd>" +
      "<dt>Last hash change</dt><dd>" + (lastChange ? fmtDate(lastChange) : "No change since first found") + "</dd>" +
      "<dt>Last checked</dt><dd>" + fmtDate(active.hashDate) + "</dd>" +
      "</dl>";
    out2 += '<div class="pane-title" style="padding-left:0">Hash history (newest first)</div>' +
      '<table><thead><tr><th>Hash or error code</th><th>Recorded</th><th>State</th></tr></thead><tbody>' +
      n.history.map(function (h, i) {
        var state = (i === 0 && h.active !== 0) ? '<span class="badge ok">Active</span>' :
          (isErrorCode(h.hash) ? '<span class="badge error">Error</span>' : '<span class="badge deleted">Superseded</span>');
        return '<tr><td class="hash">' + (isErrorCode(h.hash) ? '<span class="badge error">' + esc(h.hash) + "</span>" : esc(h.hash)) +
          "</td><td>" + fmtDate(h.hashDate) + "</td><td>" + state + "</td></tr>";
      }).join("") + "</tbody></table>";
    return out2;
  }
  function renderDetail(n) { $("tree-detail").innerHTML = detailHtml(n); }

  $("tree-add").addEventListener("click", function () {
    if (!selectedNode) return;
    var c = clientById(treeSel.value);
    var what = selectedNode.type === "client" ? "client summary" : (selectedNode.type === "dir" ? "folder " + selectedNode.path : selectedNode.path);
    addToReport(selectedNode.type === "file" ? "File" : "Folder", c.name + ": " + what, $("tree-detail").innerHTML);
  });

  /* ---------------- Tab 3: Trend chart (plain SVG, no library) ---------------- */
  var chartClient = $("chart-client");
  var chartMetric = $("chart-metric");
  fillClientSelect(chartClient, true);
  var tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  document.body.appendChild(tip);

  function niceMax(v) {
    if (v <= 5) return 5;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * p >= v) return steps[i] * p;
    return 10 * p;
  }

  function buildChartSvg() {
    var metric = chartMetric.value;
    var metricLabel = chartMetric.options[chartMetric.selectedIndex].text;
    var chosen = chartClient.value === "all" ? CLIENTS : [clientById(chartClient.value)];
    var W = 760, H = 340, m = { t: 20, r: 24, b: 56, l: 48 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var n = Math.max.apply(null, chosen.map(function (c) { return c.scans.length; }));
    var maxV = 0;
    chosen.forEach(function (c) { c.scans.forEach(function (s) { maxV = Math.max(maxV, s[metric]); }); });
    var yMax = niceMax(Math.max(maxV, 1));
    var ticks = yMax <= 5 ? yMax : 5;
    function x(i) { return m.l + (n === 1 ? iw / 2 : (i * iw) / (n - 1)); }
    function y(v) { return m.t + ih - (v / yMax) * ih; }

    // Attributes are inline (not CSS classes) so the chart looks the same when copied into a report.
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(metricLabel) + '" font-family="Ubuntu, Segoe UI, sans-serif">';
    for (var k = 0; k <= ticks; k++) {
      var v = (yMax / ticks) * k, yy = y(v);
      svg += '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + yy + '" y2="' + yy + '" stroke="' + (k === 0 ? "#AEA79F" : "#ECE8E5") + '" stroke-width="1"/>';
      svg += '<text x="' + (m.l - 8) + '" y="' + (yy + 4) + '" text-anchor="end" font-size="12" fill="#6A6460">' + (Math.round(v * 10) / 10) + "</text>";
    }
    // x labels use the first selected client's scan times, labelled as scan number + time
    var ref = chosen[0].scans;
    for (var i = 0; i < n; i++) {
      var lbl = ref[i] ? fmtShort(ref[i].started) : "";
      svg += '<text x="' + x(i) + '" y="' + (H - m.b + 18) + '" text-anchor="middle" font-size="11" fill="#6A6460">Scan ' + (i + 1) + "</text>";
      if (chosen.length === 1) svg += '<text x="' + x(i) + '" y="' + (H - m.b + 32) + '" text-anchor="middle" font-size="10" fill="#9A938E">' + lbl + "</text>";
    }
    svg += '<text x="' + (m.l + iw / 2) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="12" fill="#5E2750">Scan (oldest to newest, UTC)</text>';

    chosen.forEach(function (c) {
      var color = SERIES_COLORS[CLIENTS.indexOf(c) % SERIES_COLORS.length];
      var pts = c.scans.map(function (s, i) { return x(i) + "," + y(s[metric]); }).join(" ");
      svg += '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
      c.scans.forEach(function (s, i) {
        svg += '<circle cx="' + x(i) + '" cy="' + y(s[metric]) + '" r="4.5" fill="#fff" stroke="' + color + '" stroke-width="2.5" ' +
          'data-tip="' + esc(c.name + " · Scan #" + s.id + " · " + fmtDate(s.started) + " · " + s[metric]) + '"/>';
      });
    });
    svg += "</svg>";
    return { svg: svg, label: metricLabel, chosen: chosen };
  }

  function legendHtml(chosen) {
    return chosen.map(function (c) {
      return '<span><i style="background:' + SERIES_COLORS[CLIENTS.indexOf(c) % SERIES_COLORS.length] + '"></i>' + esc(c.name) + "</span>";
    }).join("");
  }
  function renderChart() {
    var b = buildChartSvg();
    $("chart-legend").innerHTML = legendHtml(b.chosen);
    $("chart").innerHTML = b.svg;
  }
  $("chart").addEventListener("mousemove", function (e) {
    var t = e.target.getAttribute && e.target.getAttribute("data-tip");
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t;
    tip.hidden = false;
    tip.style.left = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8) + "px";
    tip.style.top = (e.clientY - 34) + "px";
  });
  $("chart").addEventListener("mouseleave", function () { tip.hidden = true; });
  chartMetric.addEventListener("change", renderChart);
  chartClient.addEventListener("change", renderChart);
  $("chart-add").addEventListener("click", function () {
    var b = buildChartSvg();
    var who = chartClient.options[chartClient.selectedIndex].text;
    addToReport("Chart", b.label + " (" + who + ")", '<div class="chart-legend">' + legendHtml(b.chosen) + "</div>" + b.svg);
  });

  /* ---------------- Start ---------------- */
  renderImports();
  renderTree();
  renderChart();
  renderReport();
})();
