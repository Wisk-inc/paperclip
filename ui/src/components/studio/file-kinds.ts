import {
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
} from "lucide-react";
import type { StudioFileNode } from "@paperclipai/shared";
import { studioLanguageLogoUrl } from "@/lib/studio-language-logos";

/** What a file is, from its name: a language logo when there is one, otherwise a matching icon. */
export interface FileKind {
  logo: string | null;
  icon: LucideIcon;
  label: string;
}

const BY_EXTENSION: Record<string, { language?: string; icon?: LucideIcon; label: string }> = {
  js: { language: "javascript", label: "JavaScript" },
  mjs: { language: "javascript", label: "JavaScript" },
  cjs: { language: "javascript", label: "JavaScript" },
  jsx: { language: "react", label: "React" },
  ts: { language: "typescript", label: "TypeScript" },
  tsx: { language: "react", label: "React (TypeScript)" },
  py: { language: "python", label: "Python" },
  html: { language: "html", label: "HTML" },
  htm: { language: "html", label: "HTML" },
  css: { icon: FileCode2, label: "CSS" },
  scss: { icon: FileCode2, label: "Sass" },
  vue: { language: "vue", label: "Vue" },
  go: { language: "go", label: "Go" },
  rs: { language: "rust", label: "Rust" },
  java: { language: "java", label: "Java" },
  kt: { language: "kotlin", label: "Kotlin" },
  swift: { language: "swift", label: "Swift" },
  rb: { language: "ruby", label: "Ruby" },
  php: { language: "php", label: "PHP" },
  c: { language: "c", label: "C" },
  h: { language: "c", label: "C header" },
  cpp: { language: "cpp", label: "C++" },
  cs: { language: "csharp", label: "C#" },
  dart: { language: "dart", label: "Dart" },
  lua: { language: "lua", label: "Lua" },
  sh: { language: "bash", label: "Shell script" },
  bash: { language: "bash", label: "Shell script" },
  sql: { language: "sql", label: "SQL" },
  r: { language: "r", label: "R" },
  json: { icon: FileJson, label: "JSON" },
  md: { icon: FileText, label: "Markdown" },
  txt: { icon: FileText, label: "Text" },
  csv: { icon: FileSpreadsheet, label: "CSV" },
  yml: { icon: FileCog, label: "YAML" },
  yaml: { icon: FileCog, label: "YAML" },
  toml: { icon: FileCog, label: "TOML" },
  env: { icon: FileLock, label: "Environment" },
  lock: { icon: FileLock, label: "Lockfile" },
  png: { icon: FileImage, label: "Image" },
  jpg: { icon: FileImage, label: "Image" },
  jpeg: { icon: FileImage, label: "Image" },
  gif: { icon: FileImage, label: "Image" },
  webp: { icon: FileImage, label: "Image" },
  svg: { icon: FileImage, label: "SVG image" },
  ico: { icon: FileImage, label: "Icon" },
  mp3: { icon: FileAudio, label: "Audio" },
  wav: { icon: FileAudio, label: "Audio" },
  mp4: { icon: FileVideo, label: "Video" },
  webm: { icon: FileVideo, label: "Video" },
  zip: { icon: FileArchive, label: "Archive" },
  gz: { icon: FileArchive, label: "Archive" },
  tar: { icon: FileArchive, label: "Archive" },
  db: { icon: FileCog, label: "Database" },
  sqlite: { icon: FileCog, label: "Database" },
};

const BY_NAME: Record<string, { icon: LucideIcon; label: string }> = {
  "package.json": { icon: FileJson, label: "Node.js project" },
  "requirements.txt": { icon: FileText, label: "Python packages" },
  dockerfile: { icon: FileCog, label: "Dockerfile" },
  ".gitignore": { icon: FileCog, label: "Git ignore list" },
  ".env": { icon: FileLock, label: "Environment" },
  "readme.md": { icon: FileText, label: "Read me" },
};

export function fileKind(name: string): FileKind {
  const lower = name.toLowerCase();
  const named = BY_NAME[lower];
  if (named) return { logo: null, icon: named.icon, label: named.label };
  const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const entry = BY_EXTENSION[extension];
  if (!entry) return { logo: null, icon: File, label: extension ? `${extension.toUpperCase()} file` : "File" };
  return { logo: entry.language ? studioLanguageLogoUrl(entry.language) : null, icon: entry.icon ?? FileCode2, label: entry.label };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Files and total size under a folder (or the whole project). */
export function folderStats(nodes: StudioFileNode[]): { files: number; folders: number; bytes: number } {
  let files = 0;
  let folders = 0;
  let bytes = 0;
  for (const node of nodes) {
    if (node.type === "file") {
      files += 1;
      bytes += node.size ?? 0;
    } else {
      folders += 1;
      const inner = folderStats(node.children ?? []);
      files += inner.files;
      folders += inner.folders;
      bytes += inner.bytes;
    }
  }
  return { files, folders, bytes };
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", or a date. */
export function changedAgo(iso: string | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)} d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
