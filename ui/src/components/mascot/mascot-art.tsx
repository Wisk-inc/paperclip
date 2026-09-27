import type { AgentPaletteId, CharacterState } from "@paperclipai/shared";

/**
 * Mascot art registry.
 *
 * The Automa mascot is the same colorful character family the app uses for
 * agents and on the Connections screen, drawn in one fixed palette so it
 * reads as a single mascot everywhere. Each mascot pose maps to one of the
 * character's expressions (served as crisp PNGs by the character renderer
 * at the exact box size). This file is the only place to change the art:
 * point a pose at another expression or palette, or at an image file with
 * `{ kind: "image", src: "/mascot/excited.webp" }`.
 */

export const MASCOT_POSES = ["idle", "excited", "cheering", "confused", "thinking"] as const;
export type MascotPose = (typeof MASCOT_POSES)[number];

/** The mascot's palette: turquoise and cherry, matching the Connections artwork. */
export const MASCOT_PALETTE: AgentPaletteId = "turquoise-cherry";

export type MascotAccent = "sparkles" | "confetti";

export type MascotArt =
  | { kind: "character"; state: CharacterState; paletteId?: AgentPaletteId; accent?: MascotAccent }
  | { kind: "image"; src: string; accent?: MascotAccent };

export const MASCOT_ART: Record<MascotPose, MascotArt> = {
  // Friendly smile: the resting face on screens that are simply empty.
  idle: { kind: "character", state: "idle" },
  // Big grin with sparkles: "make the first one" screens.
  excited: { kind: "character", state: "success", accent: "sparkles" },
  // Big grin with confetti: everything is done.
  cheering: { kind: "character", state: "success", accent: "confetti" },
  // Wavy mouth and a question mark: nothing matched, or something failed.
  confused: { kind: "character", state: "confused" },
  // Question mark and an "o" mouth: waiting on work in progress.
  thinking: { kind: "character", state: "thinking" },
};
