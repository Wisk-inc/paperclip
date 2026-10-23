export const ISSUE_REFERENCE_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-\d+$/;

export interface IssueReferenceMatch {
  index: number;
  length: number;
  identifier: string;
  matchedText: string;
}

// The identifier branch only starts at the beginning of a letter/digit run:
// without the lookbehind a long run with no dash (a hash, base64, "xxxx…")
// is rescanned from every position, which took the server down on a 2 MB
// comment.
const ISSUE_REFERENCE_TOKEN_RE = /https?:\/\/[^\s<>()]+|\/[^\s<>()]+|(?<![A-Z0-9])[A-Z][A-Z0-9]*-\d+/gi;

function preserveNewlinesAsWhitespace(value: string) {
  return value.replace(/[^\n]/g, " ");
}

const FENCE_START_RE = /^(?:```+|~~~+)/;

function stripMarkdownCode(markdown: string): string {
  if (!markdown) return "";

  let output = "";
  let index = 0;

  while (index < markdown.length) {
    const atLineStart = index === 0 || markdown[index - 1] === "\n";
    const fenceMatch = atLineStart ? FENCE_START_RE.exec(markdown.slice(index, index + 64)) : null;

    if (atLineStart && fenceMatch) {
      const fence = fenceMatch[0]!;
      const blockStart = index;
      index += fence.length;
      while (index < markdown.length && markdown[index] !== "\n") index += 1;
      if (index < markdown.length) index += 1;

      while (index < markdown.length) {
        const lineStart = index === 0 || markdown[index - 1] === "\n";
        if (lineStart && markdown.startsWith(fence, index)) {
          index += fence.length;
          while (index < markdown.length && markdown[index] !== "\n") index += 1;
          if (index < markdown.length) index += 1;
          break;
        }
        index += 1;
      }

      output += preserveNewlinesAsWhitespace(markdown.slice(blockStart, index));
      continue;
    }

    if (markdown[index] === "`") {
      let tickCount = 1;
      while (index + tickCount < markdown.length && markdown[index + tickCount] === "`") {
        tickCount += 1;
      }
      const fence = "`".repeat(tickCount);
      const inlineStart = index;
      index += tickCount;
      const closeIndex = markdown.indexOf(fence, index);
      if (closeIndex === -1) {
        output += markdown.slice(inlineStart, inlineStart + tickCount);
        index = inlineStart + tickCount;
        continue;
      }
      index = closeIndex + tickCount;
      output += preserveNewlinesAsWhitespace(markdown.slice(inlineStart, index));
      continue;
    }

    // Plain text up to the next backtick or line start is copied in one go.
    let next = index + 1;
    while (next < markdown.length && markdown[next] !== "`" && markdown[next - 1] !== "\n") next += 1;
    output += markdown.slice(index, next);
    index = next;
  }

  return output;
}

function countChar(value: string, char: string): number {
  let count = 0;
  for (let index = value.indexOf(char); index !== -1; index = value.indexOf(char, index + 1)) count += 1;
  return count;
}

function trimTrailingPunctuation(token: string): string {
  // Bracket counts are taken once and kept up to date, so a token ending in
  // thousands of ")" or "]" is trimmed in one pass.
  let openParens = countChar(token, "(");
  let closeParens = countChar(token, ")");
  let openBrackets = countChar(token, "[");
  let closeBrackets = countChar(token, "]");
  let end = token.length;
  while (end > 0) {
    const last = token[end - 1]!;
    if (!".,!?;:".includes(last) && last !== ")" && last !== "]") break;

    if ((last === ")" && openParens >= closeParens) || (last === "]" && openBrackets >= closeBrackets)) {
      break;
    }
    if (last === ")") closeParens -= 1;
    if (last === "]") closeBrackets -= 1;
    end -= 1;
  }
  return token.slice(0, end);
}

export function normalizeIssueIdentifier(value: string): string | null {
  const trimmed = value.trim().toUpperCase();
  return ISSUE_REFERENCE_IDENTIFIER_RE.test(trimmed) ? trimmed : null;
}

export function buildIssueReferenceHref(identifier: string): string {
  const normalized = normalizeIssueIdentifier(identifier);
  return `/issues/${normalized ?? identifier.trim()}`;
}

export function parseIssueReferenceHref(href: string): { identifier: string } | null {
  const raw = href.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = raw.startsWith("/")
      ? new URL(raw, "https://paperclip.invalid")
      : new URL(raw);
  } catch {
    return null;
  }

  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index]?.toLowerCase() !== "issues") continue;
    const identifier = normalizeIssueIdentifier(segments[index + 1] ?? "");
    if (identifier) {
      return { identifier };
    }
  }

  return null;
}

export function findIssueReferenceMatches(text: string): IssueReferenceMatch[] {
  if (!text) return [];

  const matches: IssueReferenceMatch[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(ISSUE_REFERENCE_TOKEN_RE);

  while ((match = re.exec(text)) !== null) {
    const rawToken = match[0];
    const cleanedToken = trimTrailingPunctuation(rawToken);
    if (!cleanedToken) continue;

    const identifier =
      normalizeIssueIdentifier(cleanedToken)
      ?? parseIssueReferenceHref(cleanedToken)?.identifier
      ?? null;

    if (!identifier) continue;

    const cleanedIndex = match.index;
    matches.push({
      index: cleanedIndex,
      length: cleanedToken.length,
      identifier,
      matchedText: cleanedToken,
    });
  }

  return matches;
}

export function extractIssueReferenceIdentifiers(markdown: string): string[] {
  const scrubbed = stripMarkdownCode(markdown);
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const match of findIssueReferenceMatches(scrubbed)) {
    if (seen.has(match.identifier)) continue;
    seen.add(match.identifier);
    ordered.push(match.identifier);
  }

  return ordered;
}

export function extractIssueReferenceMatches(markdown: string): IssueReferenceMatch[] {
  const scrubbed = stripMarkdownCode(markdown);
  const seen = new Set<string>();
  const ordered: IssueReferenceMatch[] = [];

  for (const match of findIssueReferenceMatches(scrubbed)) {
    if (seen.has(match.identifier)) continue;
    seen.add(match.identifier);
    ordered.push(match);
  }

  return ordered;
}
