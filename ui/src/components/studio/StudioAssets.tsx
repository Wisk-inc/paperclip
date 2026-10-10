import { useMemo, useRef, useState } from "react";
import { Check, Copy, Download, FileAudio, FileVideo, ImagePlus, Type, Upload } from "lucide-react";
import type { StudioFileNode } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/issue-output";
import { haptic } from "@/lib/haptics";
import { Mascot } from "../mascot/Mascot";

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const AUDIO = /\.(mp3|wav|ogg|m4a)$/i;
const VIDEO = /\.(mp4|webm|mov)$/i;
const FONT = /\.(woff2?|ttf|otf)$/i;

export function isAssetPath(path: string) {
  return IMAGE.test(path) || AUDIO.test(path) || VIDEO.test(path) || FONT.test(path);
}

function collectAssets(nodes: StudioFileNode[], out: StudioFileNode[] = []) {
  for (const node of nodes) {
    if (node.type === "file" && isAssetPath(node.path)) out.push(node);
    else if (node.children) collectAssets(node.children, out);
  }
  return out;
}

interface StudioAssetsProps {
  tree: StudioFileNode[];
  rawUrl: (path: string) => string;
  downloadUrl?: (path: string) => string;
  /** Uploads into `assets/` unless the files say otherwise. */
  onUpload?: (files: File[], folder: string | null) => Promise<void> | void;
}

/**
 * The project's pictures, sounds, videos, and fonts at a glance, with their
 * paths ready to copy into code and an upload button that puts new ones in
 * `assets/`.
 */
export function StudioAssets({ tree, rawUrl, downloadUrl, onUpload }: StudioAssetsProps) {
  const assets = useMemo(() => collectAssets(tree), [tree]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const copyPath = (path: string) => {
    void navigator.clipboard?.writeText(path).then(() => {
      haptic("success");
      setCopied(path);
      setTimeout(() => setCopied(null), 1400);
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {onUpload ? (
        <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
          <span className="mr-auto text-xs text-muted-foreground">{assets.length ? `${assets.length} ${assets.length === 1 ? "asset" : "assets"}` : "Images, sounds, videos, fonts"}</span>
          <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} data-testid="studio-assets-upload">
            <ImagePlus /> Add assets
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            accept="image/*,audio/*,video/*,.woff,.woff2,.ttf,.otf"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length) void onUpload(files, "assets");
            }}
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="studio-assets">
        {assets.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <Mascot pose="idle" size="sm" gaze="down" />
            <p className="text-sm font-medium">No assets yet</p>
            <p className="max-w-xs text-sm text-muted-foreground">Add pictures, sounds, or fonts. They go in the assets folder, ready to use in your app.</p>
            {onUpload ? (
              <Button onClick={() => inputRef.current?.click()}>
                <Upload /> Upload assets
              </Button>
            ) : null}
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {assets.map((asset) => (
              <li key={asset.path} className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex aspect-square items-center justify-center bg-muted/60">
                  {IMAGE.test(asset.path) ? (
                    <img src={rawUrl(asset.path)} alt={asset.name} loading="lazy" className="size-full object-contain p-2" />
                  ) : AUDIO.test(asset.path) ? (
                    <div className="flex w-full flex-col items-center gap-2 p-2">
                      <FileAudio className="size-8 text-muted-foreground" />
                      <audio controls preload="none" src={rawUrl(asset.path)} className="w-full" />
                    </div>
                  ) : VIDEO.test(asset.path) ? (
                    <video controls preload="metadata" src={rawUrl(asset.path)} className="size-full object-contain">
                      <FileVideo />
                    </video>
                  ) : (
                    <Type className="size-8 text-muted-foreground" />
                  )}
                </div>
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs" title={asset.path}>
                      {asset.path}
                    </p>
                    <p className="text-(length:--text-micro) text-muted-foreground">{formatBytes(asset.size ?? 0)}</p>
                  </div>
                  <Button variant="ghost" size="icon-xs" aria-label={`Copy the path of ${asset.name}`} onClick={() => copyPath(asset.path)}>
                    {copied === asset.path ? <Check /> : <Copy />}
                  </Button>
                  {downloadUrl ? (
                    <Button variant="ghost" size="icon-xs" aria-label={`Download ${asset.name}`} asChild>
                      <a href={downloadUrl(asset.path)} download={asset.name}>
                        <Download />
                      </a>
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
