/**
 * Markdown that is still being written: closes what the model has opened but
 * not finished yet (bold, italics, inline code, a code fence, a link), so the
 * live reply shows formatted text instead of stray asterisks and brackets.
 * The finished reply is rendered as written; this is only for the live view.
 */
export function settleStreamingMarkdown(text: string): string {
  if (!text) return text;
  let out = text;
  const fences = (out.match(/^\s*```/gm) ?? []).length;
  if (fences % 2 === 1) return `${out}\n\`\`\``;

  // Only the paragraph being written can hold an unfinished marker.
  const lastBreak = out.lastIndexOf("\n\n");
  const tail = out.slice(lastBreak + 1);
  const withoutCode = tail.replace(/`[^`\n]*`/g, "");
  if ((withoutCode.match(/`/g) ?? []).length % 2 === 1) return `${out}\``;

  // A link or image whose URL is still arriving: show just its text.
  const openLink = /!?\[([^\]\n]*)\]\([^)\n]*$/.exec(out);
  if (openLink) out = out.slice(0, openLink.index) + openLink[1];
  const openBracket = /\[([^\]\n]*)$/.exec(out);
  if (openBracket && !/\]\(/.test(openBracket[0])) out = out.slice(0, openBracket.index) + openBracket[1];

  const plain = out.slice(lastBreak + 1).replace(/`[^`\n]*`/g, "");
  // A list marker or a lone asterisk at the very end is not emphasis yet.
  if (/(^|\n)\s*[*-]\s*$/.test(plain)) return out;
  const strong = (plain.match(/\*\*/g) ?? []).length;
  let closing = "";
  if (strong % 2 === 1) closing = "**";
  const singles = (plain.replace(/\*\*/g, "").match(/(?<![\\\w])\*(?!\s)|(?<=\S)\*(?![\w])/g) ?? []).length;
  if (singles % 2 === 1) closing = `*${closing}`;
  if (closing && /[*\s]$/.test(out)) out = out.replace(/[\s*]+$/, (match) => match.replace(/\*+$/, ""));
  return closing ? `${out.trimEnd()}${closing}` : out;
}
