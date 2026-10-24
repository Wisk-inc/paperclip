import {
  Braces,
  Coffee,
  File,
  FileArchive,
  FileCode2,
  FileCog,
  FileImage,
  FileText,
  Folder,
  Languages,
  Package,
  type LucideIcon,
} from "lucide-react";

export interface FileKind {
  icon: LucideIcon;
  /** A token color class for the icon. */
  tone: string;
  /** Short type name shown under the file name. */
  label: string;
  /** Shown as a thumbnail (served by the image route). */
  image: boolean;
  /** Opens in the code editor. */
  text: boolean;
}

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

/** Icon, color and handling for a file in a decoded app, the way Apktool M marks them. */
export function fileKind(name: string, dir: boolean): FileKind {
  const lower = name.toLowerCase();
  if (dir) {
    if (lower === "smali" || lower.startsWith("smali_")) return { icon: Folder, tone: "text-(--studio-syntax-keyword)", label: "Code (smali)", image: false, text: false };
    if (lower === "res") return { icon: Folder, tone: "text-(--studio-syntax-string)", label: "Resources", image: false, text: false };
    if (lower.startsWith("values")) return { icon: Languages, tone: "text-(--studio-syntax-string)", label: "Values", image: false, text: false };
    if (lower === "lib") return { icon: Folder, tone: "text-(--studio-syntax-number)", label: "Native libraries", image: false, text: false };
    if (lower === "assets") return { icon: Folder, tone: "text-(--studio-syntax-attribute)", label: "Assets", image: false, text: false };
    return { icon: Folder, tone: "text-(--studio-syntax-function)", label: "Folder", image: false, text: false };
  }
  if (lower === "androidmanifest.xml") return { icon: FileCog, tone: "text-(--studio-syntax-tag)", label: "Manifest", image: false, text: true };
  if (lower === "apktool.yml") return { icon: FileCog, tone: "text-(--studio-syntax-attribute)", label: "apktool settings", image: false, text: true };
  if (lower.endsWith(".smali")) return { icon: FileCode2, tone: "text-(--studio-syntax-keyword)", label: "Smali", image: false, text: true };
  if (lower.endsWith(".java") || lower.endsWith(".kt")) return { icon: Coffee, tone: "text-(--studio-syntax-type)", label: lower.endsWith(".kt") ? "Kotlin" : "Java", image: false, text: true };
  if (lower.endsWith(".xml")) return { icon: FileCode2, tone: "text-(--studio-syntax-tag)", label: "XML", image: false, text: true };
  if (lower.endsWith(".json")) return { icon: Braces, tone: "text-(--studio-syntax-number)", label: "JSON", image: false, text: true };
  if (IMAGE.test(lower)) return { icon: FileImage, tone: "text-(--studio-syntax-string)", label: "Image", image: true, text: false };
  if (lower.endsWith(".so")) return { icon: Package, tone: "text-(--studio-syntax-number)", label: "Native library", image: false, text: false };
  if (lower.endsWith(".dex")) return { icon: Package, tone: "text-(--studio-syntax-keyword)", label: "Dalvik code", image: false, text: false };
  if (/\.(zip|jar|apk|arsc)$/.test(lower)) return { icon: FileArchive, tone: "text-(--studio-syntax-function)", label: "Archive", image: false, text: false };
  if (/\.(txt|md|properties|yml|yaml|html?|js|css|cfg|pro|version)$/.test(lower)) return { icon: FileText, tone: "text-muted-foreground", label: "Text", image: false, text: true };
  return { icon: File, tone: "text-muted-foreground", label: "File", image: false, text: true };
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
