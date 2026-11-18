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
  var rebuilt = typeof WeakSet === "function" ? new WeakSet() : null;
  var isolate = !!RTL[language];

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }
  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * A listed sentence with values in it ("Could not find {0}. Check…"): a
   * pattern whose groups are the values. A value may be empty (an optional
   * part the app adds or not), and one used twice must be the same both times.
   */
  function compile(source) {
    var parts = source.split(/\{(\d+)\}/);
    var pattern = "^";
    var groups = [];
    var group = {};
    for (var i = 0; i < parts.length; i += 1) {
      if (i % 2 === 0) {
        pattern += escapeRegExp(parts[i]);
      } else if (own(group, parts[i])) {
        pattern += "\\" + group[parts[i]];
      } else {
        groups.push(Number(parts[i]));
        group[parts[i]] = groups.length;
        pattern += "([\\s\\S]*?)";
      }
    }
    return { pattern: new RegExp(pattern + "$"), groups: groups };
  }

  /** {0}, {1}… in a translation, each replaced by its value. */
  function fill(translation, values) {
    return translation.replace(/\{(\d+)\}/g, function (whole, index) {
      return own(values, index) ? values[index] : whole;
    });
  }

  /** The translation of a whole text, or null. `nested`: a value inside another sentence. */
  function translateCore(core, nested) {
    if (own(exact, core)) return exact[core];
    for (var i = 0; i < templates.length; i += 1) {
      var found = templates[i].pattern.exec(core);
      if (!found) continue;
      var values = {};
      for (var g = 0; g < templates[i].groups.length; g += 1) {
        var value = found[g + 1];
        // A value that is itself one of the screen's sentences (an optional
        // part, " (its database is not answering yet)") is translated too.
        if (!nested) value = translateValue(value);
        values[templates[i].groups[g]] = isolate && normalize(value) ? FSI + value + PDI : value;
      }
      return fill(templates[i].translation, values);
    }
    return null;
  }

  function translateValue(value) {
    var core = normalize(value);
    if (!core) return value;
    var translated = translateCore(core, true);
    return translated === null ? value : value.match(/^\s*/)[0] + translated + value.match(/\s*$/)[0];
  }

  function translate(text) {
    var core = normalize(text);
    if (!core || core.length > 600) return null;
    var translated = translateCore(core, false);
    return translated === null ? null : text.match(/^\s*/)[0] + translated + text.match(/\s*$/)[0];
  }

  function originalOf(node) {
    return applied && applied.has(node) && applied.get(node).text === node.data ? applied.get(node).original : node.data;
  }

  function translateNode(node) {
    var original = originalOf(node);
    var result = translate(original);
    if (result === null || result === node.data) return;
    if (applied) applied.set(node, { original: original, text: result });
    node.data = result;
  }

  function translateAttributes(element) {
    for (var i = 0; i < ATTRIBUTES.length; i += 1) {
      var value = element.getAttribute && element.getAttribute(ATTRIBUTES[i]);
      if (value) {
        var result = translate(value);
        if (result !== null && result !== value) element.setAttribute(ATTRIBUTES[i], result);
      }
    }
  }

  /**
   * A sentence with words in bold or a command inside ("Tap <b>Paste</b>,
   * then press Enter."): listed whole, the inner elements as {0}, {1}…, so a
   * language can put them where its own word order needs them. The elements
   * themselves are moved into place, never copied (the page keeps its hold
   * on them), and their own words are translated on their own.
   */
  function translateSentence(element) {
    if (rebuilt ? rebuilt.has(element) : element.__automaRebuilt) return;
    var source = "";
    var inner = [];
    var words = false;
    for (var child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        var text = originalOf(child);
        source += text;
        if (/[A-Za-z]{2,}/.test(text)) words = true;
      } else if (child.nodeType === 1) {
        source += "{" + inner.length + "}";
        inner.push(child);
      }
    }
    if (!inner.length || !words) return;
    source = normalize(source);
    if (!own(exact, source)) return;
    var pieces = exact[source].split(/\{(\d+)\}/);
    var used = {};
    for (var i = 1; i < pieces.length; i += 2) {
      if (used[pieces[i]] || !inner[Number(pieces[i])]) return;
      used[pieces[i]] = true;
    }
    if (Object.keys(used).length !== inner.length) return;
    var fragment = document.createDocumentFragment();
    for (var j = 0; j < pieces.length; j += 1) {
      if (j % 2 === 1) fragment.appendChild(inner[Number(pieces[j])]);
      else if (pieces[j]) fragment.appendChild(document.createTextNode(pieces[j]));
    }
    while (element.firstChild) element.removeChild(element.firstChild);
    element.appendChild(fragment);
    if (rebuilt) rebuilt.add(element);
    else element.__automaRebuilt = true;
  }

  function translateElement(element) {
    translateAttributes(element);
    translateSentence(element);
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
      // Every entry is looked up whole (a sentence with bold words or commands
      // inside is found this way); one with values is also a pattern for text.
      exact[source] = translation;
      if (/\{\d+\}/.test(source)) {
        var compiled = compile(source);
        templates.push({ pattern: compiled.pattern, groups: compiled.groups, translation: translation, fixed: source.replace(/\{\d+\}/g, "").length });
      }
    });
    // The most specific sentence first: "Waiting {0} · step {1} of {2}" before "Waiting {0}",
    // which would otherwise take the rest of the line as its value.
    templates.sort(function (a, b) { return b.fixed - a.fixed; });
    walk(document.body);
    new MutationObserver(function (records) {
      records.forEach(function (record) {
        if (record.type === "characterData") {
          if (!skipped(record.target.parentElement)) translateNode(record.target);
        } else if (record.type === "attributes") {
          translateAttributes(record.target);
        } else {
          record.addedNodes.forEach(function (node) { walk(node); });
        }
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
