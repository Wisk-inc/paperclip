import { fillTemplate, normalizeUiText, type UiStringIndex } from "./ui-string-index";

/**
 * Shows the board in another language without rewriting its components: it
 * watches the page and, for each run of text the board's own code wrote (see
 * UiStringIndex), puts the translation in place; text it does not know (a
 * person's chats, tasks, names) is never touched. React keeps working on the
 * same text nodes: a node React changes again is read anew and translated
 * again, and stop() puts every original back.
 *
 * Skipped: anything inside translate="no" or .notranslate (chat messages and
 * other people's words are marked so), editable text, inputs, code.
 */

/** Attributes that hold words people read or hear. */
export const TRANSLATED_ATTRIBUTES = ["placeholder", "title", "aria-label", "alt"] as const;

const SKIP_SELECTOR = [
  '[translate="no"]',
  ".notranslate",
  "script",
  "style",
  "noscript",
  "template",
  "textarea",
  "code",
  "pre",
  "kbd",
  "samp",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
].join(", ");

const LETTER = /\p{L}/u;
/**
 * Longer text is never the board's wording (its longest string is under 350
 * characters, and a template's values add little): a chat reply growing word
 * by word is passed over without being matched.
 */
export const MAX_BOARD_TEXT = 600;

/** Unicode first-strong isolate and pop: the text between keeps its own direction. */
export const FSI = "\u2068";
export const PDI = "\u2069";

export interface LiveTranslatorOptions {
  /** What to watch: the whole page in the app. */
  root: Element;
  index: UiStringIndex;
  /** The translation of a board string or template, when there is one. */
  lookup: (source: string) => string | undefined;
  /** Board strings seen on screen that have no translation yet. */
  onMissing?: (sources: string[]) => void;
  /**
   * A right-to-left language: values put into a translation ("Español
   * (México)" in an Arabic sentence) and board text still waiting for its
   * translation are wrapped in Unicode isolates, so Latin words keep their
   * own order and an English sentence keeps its full stop at its end.
   */
  isolate?: boolean;
}

interface Tracked {
  original: string;
  applied: string;
}

export class LiveTranslator {
  private readonly texts = new Map<Text, Tracked>();
  private readonly attributes = new Map<Element, Map<string, Tracked>>();
  private readonly pending = new Set<Node>();
  private readonly missing = new Set<string>();
  private observer: MutationObserver | null = null;
  private scheduled = false;

  constructor(private readonly options: LiveTranslatorOptions) {}

  start(): void {
    if (this.observer) return;
    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.observer.observe(this.options.root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATED_ATTRIBUTES],
    });
    this.translateTree(this.options.root);
    this.reportMissing();
  }

  /** Puts every original back and stops watching. */
  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.pending.clear();
    for (const [node, tracked] of this.texts) {
      if (node.data === tracked.applied) node.data = tracked.original;
    }
    for (const [element, names] of this.attributes) {
      for (const [name, tracked] of names) {
        if (element.getAttribute(name) === tracked.applied) element.setAttribute(name, tracked.original);
      }
    }
    this.texts.clear();
    this.attributes.clear();
  }

  /** Goes over the whole page again: new translations arrived. */
  refresh(): void {
    for (const node of this.texts.keys()) if (!node.isConnected) this.texts.delete(node);
    for (const element of this.attributes.keys()) if (!element.isConnected) this.attributes.delete(element);
    this.translateTree(this.options.root);
    this.reportMissing();
  }

  /** Text nodes and attributes currently showing a translation (for tests and diagnostics). */
  get translatedCount(): number {
    let count = 0;
    for (const [node, tracked] of this.texts) if (node.isConnected && tracked.applied !== tracked.original) count += 1;
    for (const names of this.attributes.values()) count += names.size;
    return count;
  }

  private onMutations(records: MutationRecord[]): void {
    for (const record of records) {
      if (record.type === "characterData") {
        const node = record.target as Text;
        const tracked = this.texts.get(node);
        if (tracked && node.data === tracked.applied) continue; // this translator's own write
        if (node.parentElement) this.pending.add(node.parentElement);
      } else if (record.type === "attributes") {
        const element = record.target as Element;
        const name = record.attributeName ?? "";
        const tracked = this.attributes.get(element)?.get(name);
        if (tracked && element.getAttribute(name) === tracked.applied) continue;
        this.pending.add(element);
      } else {
        this.pending.add(record.target);
        record.addedNodes.forEach((node) => this.pending.add(node));
      }
    }
    if (this.pending.size === 0 || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const nodes = [...this.pending];
      this.pending.clear();
      for (const node of nodes) {
        if (!node.isConnected) continue;
        if (node.nodeType === Node.TEXT_NODE) {
          if (node.parentElement) this.translateElement(node.parentElement, false);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          this.translateTree(node as Element);
        }
      }
      this.reportMissing();
    });
  }

  private reportMissing(): void {
    if (this.missing.size === 0) return;
    const sources = [...this.missing];
    this.missing.clear();
    this.options.onMissing?.(sources);
  }

  private skipped(element: Element): boolean {
    return element.closest(SKIP_SELECTOR) !== null;
  }

  /** An element and everything under it, minus skipped parts. */
  private translateTree(top: Element): void {
    if (this.skipped(top)) return;
    const walker = top.ownerDocument.createTreeWalker(top, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => ((node as Element).matches(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let element: Element | null = top; element; element = walker.nextNode() as Element | null) {
      this.translateElement(element, true);
    }
  }

  /** The element's own runs of text and its attributes. */
  private translateElement(element: Element, checked: boolean): void {
    if (!checked && this.skipped(element)) return;
    let run: Text[] = [];
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        run.push(child as Text);
      } else {
        if (run.length) this.translateRun(run);
        run = [];
      }
    }
    if (run.length) this.translateRun(run);
    for (const name of TRANSLATED_ATTRIBUTES) this.translateAttribute(element, name);
  }

  private originalOf(node: Text): string {
    const tracked = this.texts.get(node);
    return tracked && node.data === tracked.applied ? tracked.original : node.data;
  }

  /** Adjacent text nodes: the board wrote them as one sentence with values in it. */
  private translateRun(nodes: Text[]): void {
    const originals = nodes.map((node) => this.originalOf(node));
    const pieces = originals.filter((text) => text.trim() !== "");
    if (pieces.length > 1) {
      const whole = this.translateText(originals.join(""), true);
      if (whole !== null) {
        nodes.forEach((node, index) => this.write(node, originals[index]!, index === 0 ? whole : ""));
        return;
      }
    }
    nodes.forEach((node, index) => this.write(node, originals[index]!, this.translateText(originals[index]!, false)));
  }

  private write(node: Text, original: string, translated: string | null): void {
    const tracked = this.texts.get(node);
    if (translated === null) {
      if (tracked) {
        if (node.data !== original) node.data = original;
        this.texts.delete(node);
      }
      return;
    }
    if (node.data !== translated) node.data = translated;
    this.texts.set(node, { original, applied: translated });
  }

  private translateAttribute(element: Element, name: string): void {
    const current = element.getAttribute(name);
    const names = this.attributes.get(element);
    const tracked = names?.get(name);
    if (current === null) {
      names?.delete(name);
      return;
    }
    const original = tracked && current === tracked.applied ? tracked.original : current;
    const translated = this.translateText(original, false);
    if (translated === null) {
      if (tracked) {
        if (current !== original) element.setAttribute(name, original);
        names!.delete(name);
        if (names!.size === 0) this.attributes.delete(element);
      }
      return;
    }
    if (current !== translated) element.setAttribute(name, translated);
    const map = names ?? new Map<string, Tracked>();
    map.set(name, { original, applied: translated });
    this.attributes.set(element, map);
  }

  /** The translation of a board string, with its spacing kept, or null. */
  private translateText(text: string, pieced: boolean): string | null {
    if (text.length > MAX_BOARD_TEXT || !LETTER.test(text)) return null;
    const match = this.options.index.match(text, pieced);
    if (!match) return null;
    const lead = text.match(/^\s*/)?.[0] ?? "";
    const trail = text.match(/\s*$/)?.[0] ?? "";
    const translation = this.options.lookup(match.source);
    if (translation === undefined) {
      this.missing.add(match.source);
      if (!this.options.isolate) return null;
      // Still English for now: kept in its own direction until the translation comes.
      return `${lead}${FSI}${text.slice(lead.length, text.length - trail.length)}${PDI}${trail}`;
    }
    // A value that is itself a board string ("Done" in "Status: {0}") is translated too.
    const values = match.values.map((value) => {
      const inner = normalizeUiText(value) ? this.options.index.match(value, false) : null;
      if (!inner || inner.values.length > 0) return value;
      const translated = this.options.lookup(inner.source);
      if (translated === undefined) {
        this.missing.add(inner.source);
        return value;
      }
      return translated;
    });
    const filled = this.options.isolate ? values.map((value) => `${FSI}${value}${PDI}`) : values;
    return `${lead}${fillTemplate(translation, filled)}${trail}`;
  }
}
