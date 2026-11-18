/*
 * The connect screen in the person's language: the choice they made on the
 * board (kept by the app, AutomaNative.getLanguage), or Auto, the phone's own
 * languages. Only this screen's wording is replaced, from i18n/<code>.json
 * (made by mobile/android/scripts/sync-translations.mjs); the setup steps
 * full of commands stay as written. Text the screen's script writes later is
 * translated as it appears.
 */
(function () {
  "use strict";
  var CODES = [
    "en", "ar", "bn", "cs", "da", "de", "el", "es", "fa", "fi",
    "fil", "fr", "he", "hi", "hu", "id", "it", "ja", "ko", "mr",
    "ms", "nb", "nl", "pa", "pl", "pt-BR", "pt-PT", "ro", "ru", "sv",
    "sw", "ta", "te", "th", "tr", "uk", "ur", "vi", "zh-CN", "zh-TW",
  ];
  var RTL = { ar: true, fa: true, he: true, ur: true };
  var LEGACY = { iw: "he", "in": "id", tl: "fil", no: "nb", nn: "nb" };
  var EUROPEAN_PORTUGUESE = ["PT", "AO", "MZ", "CV", "GW", "ST", "TL", "GQ", "LU", "CH"];
  var TRADITIONAL_CHINESE = ["TW", "HK", "MO"];
  var ATTRIBUTES = ["placeholder", "title", "aria-label", "alt"];
  var FSI = "⁨";
  var PDI = "⁩";

  /** The Automa language for a locale tag, as the board matches it (packages/shared/src/app-languages.ts). */
  function match(tag) {
    var parts = String(tag || "").trim().replace(/_/g, "-").split("-").filter(Boolean);
    var language = (parts[0] || "").toLowerCase();
    if (!/^[a-z]{2,3}$/.test(language)) return null;
    language = LEGACY[language] || language;
    var script = null;
    var region = null;
    for (var i = 1; i < parts.length; i += 1) {
      if (!script && /^[A-Za-z]{4}$/.test(parts[i])) script = parts[i].charAt(0).toUpperCase() + parts[i].slice(1).toLowerCase();
      else if (!region && /^([A-Za-z]{2}|\d{3})$/.test(parts[i])) region = parts[i].toUpperCase();
    }
    if (language === "zh") return script === "Hant" || (!script && region && TRADITIONAL_CHINESE.indexOf(region) >= 0) ? "zh-TW" : "zh-CN";
    if (language === "pt") return region && EUROPEAN_PORTUGUESE.indexOf(region) >= 0 ? "pt-PT" : "pt-BR";
    return CODES.indexOf(language) >= 0 ? language : null;
  }

  function chosen() {
    var saved = "auto";
    try {
      var bridge = window.AutomaNative;
      var key = typeof window.__automaKey === "string" ? window.__automaKey : "";
      if (bridge && typeof bridge.getLanguage === "function") saved = String(bridge.getLanguage(key) || "auto");
    } catch (e) {
      saved = "auto";
    }
    if (saved !== "auto" && CODES.indexOf(saved) >= 0) return saved;
    var tags = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"];
    for (var i = 0; i < tags.length; i += 1) {
      var code = match(tags[i]);
      if (code) return code;
    }
    return "en";
  }

  function normalize(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  var language = chosen();
  var root = document.documentElement;
  root.lang = language;
  root.dir = RTL[language] ? "rtl" : "ltr";
  window.__automaConnectLanguage = language;
  if (language === "en") return;

  var exact = {};
  var templates = [];
  var applied = typeof WeakMap === "function" ? new WeakMap() : null;
  var isolate = !!RTL[language];

  function translate(text) {
    var core = normalize(text);
    if (!core || core.length > 400) return null;
    var lead = text.match(/^\s*/)[0];
    var trail = text.match(/\s*$/)[0];
    if (Object.prototype.hasOwnProperty.call(exact, core)) return lead + exact[core] + trail;
    for (var i = 0; i < templates.length; i += 1) {
      var found = templates[i].pattern.exec(core);
      if (found) {
        var value = isolate ? FSI + found[1] + PDI : found[1];
        return lead + templates[i].translation.replace("{0}", value) + trail;
      }
    }
    return null;
  }

  function translateNode(node) {
    var original = applied && applied.has(node) && applied.get(node).text === node.data ? applied.get(node).original : node.data;
    var result = translate(original);
    if (result === null || result === node.data) return;
    if (applied) applied.set(node, { original: original, text: result });
    node.data = result;
  }

  function translateElement(element) {
    for (var i = 0; i < ATTRIBUTES.length; i += 1) {
      var value = element.getAttribute && element.getAttribute(ATTRIBUTES[i]);
      if (value) {
        var result = translate(value);
        if (result !== null && result !== value) element.setAttribute(ATTRIBUTES[i], result);
      }
    }
  }

  function skipped(element) {
    return !!(element && element.closest && element.closest('code, pre, kbd, script, style, textarea, [translate="no"]'));
  }

  function walk(top) {
    if (!top) return;
    if (top.nodeType === 3) {
      if (!skipped(top.parentElement)) translateNode(top);
      return;
    }
    if (top.nodeType !== 1 || skipped(top)) return;
    translateElement(top);
    var walker = document.createTreeWalker(top, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 1) {
        if (!skipped(node)) translateElement(node);
      } else if (!skipped(node.parentElement)) {
        translateNode(node);
      }
    }
  }

  function start(dictionary) {
    Object.keys(dictionary).forEach(function (source) {
      var translation = dictionary[source];
      if (typeof translation !== "string" || !translation) return;
      if (source.indexOf("{0}") >= 0) {
        var parts = source.split("{0}");
        var escape = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); };
        templates.push({ pattern: new RegExp("^" + escape(parts[0]) + "(.+?)" + escape(parts[1]) + "$"), translation: translation });
      } else {
        exact[source] = translation;
      }
    });
    walk(document.body);
    new MutationObserver(function (records) {
      records.forEach(function (record) {
        if (record.type === "characterData") translateNode(record.target);
        else if (record.type === "attributes") translateElement(record.target);
        else record.addedNodes.forEach(function (node) { walk(node); });
      });
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
  }

  // Hidden until the words are in place (a local file: a few milliseconds), never longer than a second.
  root.classList.add("i18n-pending");
  var reveal = function () { root.classList.remove("i18n-pending"); };
  var fallback = setTimeout(reveal, 1000);
  var ready = function (dictionary) {
    var go = function () {
      try {
        start(dictionary || {});
      } finally {
        clearTimeout(fallback);
        reveal();
      }
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
    else go();
  };
  fetch("i18n/" + language + ".json")
    .then(function (response) { return response.ok ? response.json() : {}; })
    .then(ready, function () { ready({}); });
})();
