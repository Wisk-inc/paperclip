/**
 * Markdown that is still being written: closes what the model has opened but
 * not finished yet (bold, italics, inline code, a code fence, a link), so the
 * live reply shows formatted text instead of stray asterisks and brackets.
 * The finished reply is rendered as written; this is only for the live view.
 */
export function settleStreamingMarkdown(text: string): string {
  if (!text) return text;
  let out = text;
  const fences = (out.match(/^[^\S\n]*```/gm) ?? []).length;
  if (fences % 2 === 1) return `${out}\n\`\`\``;

  // Only the paragraph being written can hold an unfinished marker.
  const lastBreak = out.lastIndexOf("\n\n");
  const tail = out.slice(lastBreak + 1);
  const withoutCode = tail.replace(/`[^`\n]*`/g, "");
  if ((withoutCode.match(/`/g) ?? []).length % 2 === 1) return `${out}\``;

  // A link or image whose URL is still arriving: show just its text. Code
  // spans are blanked out first, so `foo[0](x` inside code is left alone.
  const maskCode = (value: string) => value.replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
  const openLinkAt = /!?\[[^\]\n]*\]\([^)\n]*$/.exec(maskCode(out))?.index;
  if (openLinkAt !== undefined) {
    const linkText = /^!?\[([^\]\n]*)\]/.exec(out.slice(openLinkAt))?.[1] ?? "";
    out = out.slice(0, openLinkAt) + linkText;
  }
  const openBracketAt = /\[[^\]\n]*$/.exec(maskCode(out))?.index;
  if (openBracketAt !== undefined) out = out.slice(0, openBracketAt) + out.slice(openBracketAt + 1);

  const plain = out.slice(lastBreak + 1).replace(/`[^`\n]*`/g, "");
  // A list marker or a lone asterisk at the very end is not emphasis yet.
  // (Checked on the last line only: a pattern spanning the whole text was
  // quadratic on long runs of spaces.)
  const trimmed = plain.trimEnd();
  if (/^\s*[*-]$/.test(trimmed.slice(trimmed.lastIndexOf("\n") + 1))) return out;
  // Asterisks at the very end may be half of a closer ("**bold*"): they are
  // set aside and the markers are counted without them.
  const body = plain.replace(/(?<!\*)\*+$/, "");
  const strong = (body.match(/\*\*/g) ?? []).length;
  let closing = "";
  if (strong % 2 === 1) closing = "**";
  const singles = (body.replace(/\*\*/g, "").match(/(?<![\\\w])\*(?!\s)|(?<=\S)\*(?![\w])/g) ?? []).length;
  if (singles % 2 === 1) closing = `*${closing}`;
  if (!closing) return out;
  return `${out.replace(/(?<!\*)\*+$/, "").trimEnd()}${closing}`;
}
