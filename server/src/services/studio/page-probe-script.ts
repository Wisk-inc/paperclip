/**
 * Put into every previewed page, before its own scripts: it notes console
 * errors, uncaught errors and files that fail to load, and when the App
 * Studio around it asks (an agent used view_app), it reports what is on the
 * screen and what looks wrong, the way the person would see it. It answers
 * only its own parent frame and sends only text about the page; the preview
 * link's token is left out of every address it reports.
 */
const PROBE_SOURCE = String.raw`(function () {
  if (window.__automaProbe) return;
  window.__automaProbe = true;
  var problems = [];
  var consoleWarnings = [];
  function squash(value, max) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
  }
  function rel(url) {
    var text = String(url || "");
    var here = location.protocol + "//" + location.host;
    if (text.indexOf(here) === 0) text = text.slice(here.length) || "/";
    return text.replace(/^.*?\/api\/studio-preview\/[^/]+\//, "/");
  }
  function add(list, line, max) {
    line = squash(line, max);
    if (line && list.length < 40 && list.indexOf(line) < 0) list.push(line);
  }
  function show(value) {
    try {
      if (value instanceof Error) return value.message;
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  }
  ["error", "warn"].forEach(function (level) {
    var original = console[level];
    if (typeof original !== "function") return;
    console[level] = function () {
      try {
        var line = "console." + level + ": " + Array.prototype.map.call(arguments, show).join(" ");
        if (level === "error") add(problems, line, 500);
        else add(consoleWarnings, line, 300);
      } catch (error) {}
      return original.apply(console, arguments);
    };
  });
  window.addEventListener("error", function (event) {
    var target = event.target;
    if (target && target !== window && target.tagName) {
      add(problems, "Failed to load " + target.tagName.toLowerCase() + " " + rel(target.src || target.href || ""), 500);
    } else {
      add(problems, "Uncaught error: " + (event.message || "unknown") + (event.filename ? " (" + rel(event.filename) + ":" + event.lineno + ")" : ""), 500);
    }
  }, true);
  window.addEventListener("unhandledrejection", function (event) {
    add(problems, "Unhandled promise rejection: " + show(event.reason), 500);
  });

  var TAGS = { H1: "h1", H2: "h2", H3: "h3", H4: "h4", H5: "h5", H6: "h6", BUTTON: "button", A: "link", INPUT: "input", TEXTAREA: "textarea", SELECT: "select", IMG: "image", CANVAS: "canvas", VIDEO: "video", SVG: "svg", TABLE: "table", NAV: "nav", FORM: "form", DIALOG: "dialog", LABEL: "label" };
  var TAPPABLE = { BUTTON: 1, A: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1 };
  function ownText(el) {
    var out = "";
    for (var node = el.firstChild; node; node = node.nextSibling) if (node.nodeType === 3) out += node.nodeValue;
    return squash(out, 140);
  }
  function rgba(value) {
    var match = /rgba?\(([^)]+)\)/.exec(value || "");
    if (!match) return null;
    var parts = match[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  function luminance(c) {
    function channel(v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  }
  function background(el) {
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      var style = getComputedStyle(node);
      if (style.backgroundImage && style.backgroundImage !== "none") return null;
      var color = rgba(style.backgroundColor);
      if (color && color.a > 0.5) return color;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }
  function build(path) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var root = document.documentElement;
    var pageWidth = Math.max(root.scrollWidth, document.body ? document.body.scrollWidth : 0);
    var pageHeight = Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0);
    var outline = [];
    var more = 0;
    var warnings = [];
    var wide = [];
    var small = 0;
    var cut = 0;
    var faint = 0;
    var all = document.body ? document.body.getElementsByTagName("*") : [];
    // A huge page is read as far as its first few thousand elements.
    for (var i = 0; i < all.length && i < 4000; i += 1) {
      var el = all[i];
      var tag = el.tagName.toUpperCase();
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") continue;
      var rect = el.getBoundingClientRect();
      // Nothing to see: no size, or a 1px helper such as screen-reader-only text.
      if (rect.width <= 2 || rect.height <= 2) continue;
      var style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) < 0.05) continue;
      if (style.clip === "rect(0px, 0px, 0px, 0px)" || /inset\(50%\)/.test(style.clipPath || "")) continue;
      if (el.closest && el.closest("svg") && tag !== "SVG") continue;
      var x = Math.round(rect.left + window.scrollX);
      var y = Math.round(rect.top + window.scrollY);
      var size = Math.round(rect.width) + "x" + Math.round(rect.height);
      var kind = TAGS[tag] || (el.getAttribute("role") === "button" ? "button" : null);
      var words = ownText(el);
      var line = null;
      if (kind === "input" || kind === "textarea" || kind === "select") {
        if (el.type === "hidden") continue;
        var hint = el.getAttribute("aria-label") || el.placeholder || (el.labels && el.labels[0] ? el.labels[0].innerText : "") || el.name || "";
        line = kind + (el.type && kind === "input" ? " (" + el.type + ")" : "") + (hint ? ' "' + squash(hint, 80) + '"' : "") + (el.value ? " value " + JSON.stringify(squash(el.value, 60)) : "");
      } else if (kind === "image") {
        line = "image" + (el.alt ? ' "' + squash(el.alt, 80) + '"' : " (no alt text)") + " " + rel(el.currentSrc || el.src).slice(0, 80);
        // Worded like the load error above, so one broken image is one line.
        if (el.complete && el.naturalWidth === 0 && el.getAttribute("src")) add(problems, "Failed to load img " + rel(el.src), 500);
      } else if (kind === "canvas" || kind === "video" || kind === "svg" || kind === "table" || kind === "nav" || kind === "form" || kind === "dialog") {
        line = kind + (el.getAttribute("aria-label") ? ' "' + squash(el.getAttribute("aria-label"), 80) + '"' : "");
      } else if (kind) {
        var label = squash(el.getAttribute("aria-label") || el.innerText || el.title || "", 120);
        line = kind + (label ? ' "' + label + '"' : " (no text)");
      } else if (words) {
        line = "text " + JSON.stringify(words);
      }
      if (rect.right > vw + 1 && tag !== "HTML" && tag !== "BODY" && wide.length < 3) wide.push((kind || tag.toLowerCase()) + (words ? ' "' + words.slice(0, 40) + '"' : "") + " reaches " + Math.round(rect.right + window.scrollX) + "px");
      if (vw < 600 && TAPPABLE[tag] && (rect.width < 32 || rect.height < 32) && small < 8) {
        small += 1;
        add(warnings, "Small to tap (" + size + ", aim for 44x44): " + (line || tag.toLowerCase()), 300);
      }
      if (words && cut < 6 && ((el.scrollWidth > el.clientWidth + 1 && style.overflowX !== "visible") || (el.scrollHeight > el.clientHeight + 1 && style.overflowY === "hidden"))) {
        cut += 1;
        add(warnings, 'Text cut off: "' + words.slice(0, 80) + '"', 300);
      }
      if (words && faint < 6) {
        var fg = rgba(style.color);
        var bg = background(el);
        if (fg && bg) {
          var a = luminance(fg);
          var b = luminance(bg);
          var ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          var px = parseFloat(style.fontSize) || 16;
          var large = px >= 24 || (px >= 18.6 && Number(style.fontWeight) >= 700);
          if (ratio < (large ? 3 : 4.5)) {
            faint += 1;
            add(warnings, "Hard to read (contrast " + ratio.toFixed(1) + ":1, needs " + (large ? "3" : "4.5") + "): \"" + words.slice(0, 60) + '"', 300);
          }
        }
      }
      if (!line) continue;
      if (outline.length >= 199) {
        more += 1;
        continue;
      }
      outline.push(squash(line, 230) + " " + size + " at (" + x + "," + y + ")");
    }
    if (more) outline.push("... and " + more + " more elements");
    if (pageWidth > vw + 1) warnings.unshift(squash("Wider than the screen: the page is " + pageWidth + "px wide on a " + vw + "px screen, so people scroll sideways" + (wide.length ? ". Too wide: " + wide.join("; ") : ""), 300));
    consoleWarnings.forEach(function (line) { add(warnings, line, 300); });
    return {
      title: squash(document.title, 300),
      path: squash(path || rel(location.pathname), 500),
      viewport: { width: vw, height: vh },
      page: { width: pageWidth, height: pageHeight },
      outline: outline,
      problems: problems.slice(0, 40),
      warnings: warnings.slice(0, 40),
    };
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== "automa:probe" || typeof data.requestId !== "string") return;
    var report;
    try {
      report = build(typeof data.path === "string" ? data.path : "");
    } catch (error) {
      report = { title: "", path: "", viewport: { width: window.innerWidth, height: window.innerHeight }, page: { width: 0, height: 0 }, outline: [], problems: ["Automa could not read the page: " + squash(error && error.message, 300)], warnings: [] };
    }
    window.parent.postMessage({ type: "automa:page-report", requestId: data.requestId, report: report }, "*");
  });
})();`;

export const PREVIEW_PROBE_SCRIPT = `<script>${PROBE_SOURCE}</script>`;
