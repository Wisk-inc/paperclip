import { memo, useEffect, useState } from "react";
import { AgentCharacter } from "../AgentCharacter";
import { appearanceForPalette, type AgentAvatarSize } from "@paperclipai/shared";
import { agentAvatarUrl } from "@/lib/agent-avatar-url";
import { cn } from "@/lib/utils";
import { MASCOT_ART, MASCOT_PALETTE, MASCOT_POSES, type MascotAccent, type MascotArt, type MascotPose } from "./mascot-art";

export type { MascotPose } from "./mascot-art";

/** Where the mascot looks: `down` rests its eyes on the primary action placed under it. */
export type MascotGaze = "ahead" | "down";
const RESTING_GAZE: Record<MascotGaze, { x: number; y: number } | undefined> = {
  ahead: undefined,
  down: { x: 0, y: -0.7 },
};

/**
 * Explicit bounding boxes on the 8dp grid: sm 64, md 96, lg 128.
 * The art always fills the box, so changing art never shifts layout.
 */
const SIZES = {
  sm: { className: "size-16", px: 64 },
  md: { className: "size-24", px: 96 },
  lg: { className: "size-32", px: 128 },
} as const satisfies Record<string, { className: string; px: AgentAvatarSize }>;
export type MascotSize = keyof typeof SIZES;

function artSources(art: MascotArt, px: AgentAvatarSize): { src: string; srcSet?: string } {
  if (art.kind === "image") return { src: art.src };
  const appearance = appearanceForPalette(art.paletteId ?? MASCOT_PALETTE);
  return {
    src: agentAvatarUrl(appearance, px, 1, art.state),
    srcSet: `${agentAvatarUrl(appearance, px, 2, art.state)} 2x`,
  };
}

const preloaded = new Set<string>();

/** Warms the browser cache with every pose at one size, so a pose change never waits on the network. */
export function preloadMascotArt(size: MascotSize = "lg") {
  if (typeof Image === "undefined") return;
  const scale = typeof window !== "undefined" && window.devicePixelRatio > 1 ? 2 : 1;
  for (const pose of MASCOT_POSES) {
    const art = MASCOT_ART[pose];
    const url =
      art.kind === "image"
        ? art.src
        : agentAvatarUrl(appearanceForPalette(art.paletteId ?? MASCOT_PALETTE), SIZES[size].px, scale, art.state);
    if (preloaded.has(url)) continue;
    preloaded.add(url);
    const image = new Image();
    image.decoding = "async";
    image.src = url;
  }
}

/** Small celebratory accents drawn around the character (brand turquoise, cherry, and gold). */
function Accent({ kind }: { kind: MascotAccent }) {
  if (kind === "sparkles") {
    return (
      <svg viewBox="0 0 96 96" className="absolute inset-0 size-full overflow-visible" fill="none" aria-hidden="true">
        <path d="M84 12 L85.8 17.2 L91 19 L85.8 20.8 L84 26 L82.2 20.8 L77 19 L82.2 17.2 Z" className="fill-amber-400" />
        <path d="M12 26 L13.1 29.1 L16.2 30.2 L13.1 31.3 L12 34.4 L10.9 31.3 L7.8 30.2 L10.9 29.1 Z" className="fill-teal-400" />
        <circle cx="90" cy="38" r="2.2" className="fill-rose-400" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 96 96" className="absolute inset-0 size-full overflow-visible" fill="none" aria-hidden="true">
      <rect x="10" y="10" width="6" height="3.2" rx="1.6" transform="rotate(-30 13 11.6)" className="fill-teal-400" />
      <rect x="80" y="8" width="6" height="3.2" rx="1.6" transform="rotate(35 83 9.6)" className="fill-rose-400" />
      <rect x="86" y="34" width="5" height="3" rx="1.5" transform="rotate(-20 88.5 35.5)" className="fill-amber-400" />
      <rect x="4" y="38" width="5" height="3" rx="1.5" transform="rotate(25 6.5 39.5)" className="fill-amber-400" />
      <circle cx="48" cy="4" r="2" className="fill-rose-400" />
      <circle cx="26" cy="4" r="1.6" className="fill-amber-400" />
      <circle cx="70" cy="2" r="1.6" className="fill-teal-400" />
    </svg>
  );
}

const MascotLayer = memo(function MascotLayer({
  pose,
  active,
  px,
}: {
  pose: MascotPose;
  active: boolean;
  px: AgentAvatarSize;
}) {
  const art = MASCOT_ART[pose];
  const { src, srcSet } = artSources(art, px);
  const [failed, setFailed] = useState(false);
  return (
    <div className="mascot-layer absolute inset-0" data-active={active ? "true" : "false"} data-pose={pose}>
      {failed ? null : (
        <img
          src={src}
          srcSet={srcSet}
          alt=""
          width={px}
          height={px}
          loading="eager"
          decoding="async"
          draggable={false}
          className="size-full select-none object-contain"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
});

export interface MascotProps {
  pose?: MascotPose;
  size?: MascotSize;
  /** `down` makes the mascot look at the primary action placed directly under it. */
  gaze?: MascotGaze;
  /** Accessible name. Leave empty when the mascot is decorative (the default). */
  label?: string;
  className?: string;
}

/**
 * The Automa mascot, in two layers:
 * - Stills: every pose is mounted once and stacked in the same box; a pose
 *   change only crossfades opacity, so there is no remount, no image
 *   reload, and no blink. This is what reduced-motion users see.
 * - Live: when motion is allowed, the animated character (the same art)
 *   plays over the stills, breathes and blinks, rests its eyes on the
 *   action below (`gaze="down"`), and follows the pointer on desktop. A pose
 *   change switches its animation in place; it is never remounted.
 * Art and pose mapping live in `mascot-art.tsx`.
 */
export function Mascot({ pose = "idle", size = "md", gaze = "ahead", label, className }: MascotProps) {
  const { className: sizeClass, px } = SIZES[size];
  const [live, setLive] = useState(false);
  const activeArt = MASCOT_ART[pose];
  useEffect(() => preloadMascotArt(size), [size]);
  return (
    <div
      data-slot="mascot"
      data-pose={pose}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("relative shrink-0", sizeClass, className)}
    >
      <div className="mascot-float absolute inset-0">
        <div className="mascot-stills absolute inset-0" data-hidden={live ? "true" : "false"}>
          {MASCOT_POSES.map((layerPose) => (
            <MascotLayer key={layerPose} pose={layerPose} active={layerPose === pose} px={px} />
          ))}
        </div>
        {activeArt.kind === "character" ? (
          <AgentCharacter
            appearance={appearanceForPalette(activeArt.paletteId ?? MASCOT_PALETTE)}
            size={px}
            state={activeArt.state}
            restingGaze={RESTING_GAZE[gaze]}
            hideStill
            onLiveChange={setLive}
            className="absolute inset-0 size-full"
          />
        ) : null}
        {MASCOT_POSES.map((layerPose) => {
          const accent = MASCOT_ART[layerPose].accent;
          return accent ? (
            <div key={layerPose} className="mascot-layer absolute inset-0" data-active={layerPose === pose ? "true" : "false"}>
              <Accent kind={accent} />
            </div>
          ) : null;
        })}
      </div>
    </div>
  );
}
