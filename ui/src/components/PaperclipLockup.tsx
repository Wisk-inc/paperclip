import type { SVGProps } from "react";

interface PaperclipLockupProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  decorative?: boolean;
  title?: string;
}

/** The Automa mark: a rounded tile knocked out with an "A" chevron and an agent node. */
export const AUTOMA_MARK_PATH =
  "M8 0H24A8 8 0 0 1 32 8V24A8 8 0 0 1 24 32H8A8 8 0 0 1 0 24V8A8 8 0 0 1 8 0Z M8.5 24.5 14.1 8.5H17.9L23.5 24.5H20.1L16 12.6 11.9 24.5Z M18.1 20.9A2.1 2.1 0 1 1 13.9 20.9A2.1 2.1 0 1 1 18.1 20.9Z";

/**
 * The full Automa lockup — mark plus wordmark. The wordmark outlines are
 * Inter (the app typeface) at a heavy weight, converted to paths so the
 * lockup renders identically before web fonts load. Every path fills
 * `currentColor`, so one geometry follows the theme on both surfaces.
 *
 * Size it with a height class (`h-5 w-auto`); width follows the aspect.
 */
export function PaperclipLockup({
  decorative = false,
  title = "Automa",
  className,
  ...rest
}: PaperclipLockupProps) {
  return (
    <svg
      {...rest}
      className={className}
      viewBox="0 0 122 32"
      fill="currentColor"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title}
      focusable="false"
    >
      <path fillRule="evenodd" d={AUTOMA_MARK_PATH} />
      <path transform="translate(42 24)" d="M0.2 0 5.81 -16.01H9.93L15.57 0H12.01L9.43 -7.9Q8.97 -9.38 8.49 -11.02Q8.01 -12.65 7.45 -14.72H8.29Q7.72 -12.65 7.24 -11.01Q6.77 -9.37 6.3 -7.9L3.68 0ZM3.7 -3.6V-6.17H12.07V-3.6Z M20.55 0.22Q19.34 0.22 18.43 -0.31Q17.52 -0.83 17.02 -1.84Q16.52 -2.84 16.52 -4.27V-11.49H19.61V-4.82Q19.61 -3.67 20.18 -3.05Q20.74 -2.44 21.76 -2.44Q22.43 -2.44 22.95 -2.72Q23.47 -3 23.76 -3.57Q24.06 -4.15 24.06 -5.02V-11.49H27.14V0H24.13L24.12 -2.95H24.58Q24.05 -1.44 23.06 -0.61Q22.08 0.22 20.55 0.22Z M35.38 -11.49V-9.07H28.09V-11.49ZM29.99 -14.53H33.08V-3.46Q33.08 -2.88 33.32 -2.64Q33.56 -2.41 34.19 -2.41Q34.44 -2.41 34.8 -2.42Q35.16 -2.43 35.36 -2.44L35.46 -0.03Q35.12 0.01 34.61 0.02Q34.11 0.04 33.61 0.04Q31.77 0.04 30.88 -0.72Q29.99 -1.48 29.99 -3.03Z M41.93 0.25Q40.2 0.25 38.91 -0.5Q37.61 -1.24 36.89 -2.59Q36.17 -3.94 36.17 -5.73Q36.17 -7.52 36.89 -8.87Q37.61 -10.22 38.91 -10.97Q40.2 -11.73 41.93 -11.73Q43.66 -11.73 44.95 -10.97Q46.25 -10.22 46.96 -8.87Q47.68 -7.52 47.68 -5.73Q47.68 -3.94 46.96 -2.59Q46.25 -1.24 44.95 -0.5Q43.66 0.25 41.93 0.25ZM41.93 -2.25Q42.74 -2.25 43.33 -2.68Q43.92 -3.1 44.24 -3.88Q44.56 -4.67 44.56 -5.73Q44.56 -6.8 44.24 -7.58Q43.92 -8.36 43.33 -8.79Q42.74 -9.22 41.93 -9.22Q41.12 -9.22 40.53 -8.8Q39.94 -8.37 39.62 -7.59Q39.3 -6.8 39.3 -5.73Q39.3 -4.66 39.62 -3.88Q39.94 -3.1 40.53 -2.68Q41.12 -2.25 41.93 -2.25Z M49.13 0V-11.49H52.08L52.11 -8.86H51.91Q52.21 -9.83 52.75 -10.46Q53.3 -11.1 54.02 -11.41Q54.74 -11.72 55.54 -11.72Q56.84 -11.72 57.76 -10.95Q58.68 -10.19 58.92 -8.82H58.57Q58.8 -9.74 59.36 -10.38Q59.92 -11.03 60.72 -11.37Q61.52 -11.72 62.44 -11.72Q63.53 -11.72 64.4 -11.24Q65.26 -10.77 65.76 -9.86Q66.26 -8.95 66.26 -7.64V0H63.17V-7.09Q63.17 -8.13 62.61 -8.64Q62.04 -9.15 61.22 -9.15Q60.59 -9.15 60.14 -8.87Q59.68 -8.6 59.43 -8.12Q59.18 -7.63 59.18 -6.99V0H56.2V-7.19Q56.2 -8.08 55.67 -8.61Q55.13 -9.15 54.28 -9.15Q53.71 -9.15 53.24 -8.88Q52.77 -8.61 52.49 -8.1Q52.21 -7.58 52.21 -6.84V0Z M71.65 0.2Q70.52 0.2 69.63 -0.18Q68.74 -0.57 68.23 -1.33Q67.72 -2.1 67.72 -3.24Q67.72 -4.21 68.08 -4.86Q68.44 -5.5 69.06 -5.89Q69.69 -6.29 70.49 -6.49Q71.3 -6.69 72.18 -6.78Q73.22 -6.89 73.84 -6.98Q74.46 -7.07 74.74 -7.26Q75.01 -7.44 75.01 -7.82V-7.89Q75.01 -8.34 74.78 -8.68Q74.56 -9.02 74.13 -9.21Q73.71 -9.4 73.11 -9.4Q72.5 -9.4 72.04 -9.21Q71.58 -9.02 71.31 -8.68Q71.04 -8.35 70.97 -7.91L68.07 -8.02Q68.2 -9.16 68.84 -9.99Q69.49 -10.81 70.58 -11.26Q71.68 -11.71 73.17 -11.71Q74.28 -11.71 75.18 -11.45Q76.09 -11.2 76.73 -10.7Q77.38 -10.2 77.72 -9.46Q78.07 -8.73 78.07 -7.78V0H75.07V-1.61H75.01Q74.72 -1.07 74.27 -0.66Q73.82 -0.25 73.18 -0.03Q72.54 0.2 71.65 0.2ZM72.49 -1.97Q73.28 -1.97 73.85 -2.27Q74.42 -2.56 74.72 -3.06Q75.03 -3.56 75.03 -4.19V-5.38Q74.89 -5.3 74.65 -5.23Q74.41 -5.15 74.08 -5.09Q73.76 -5.02 73.4 -4.96Q73.04 -4.9 72.68 -4.85Q72.12 -4.77 71.67 -4.59Q71.22 -4.4 70.95 -4.1Q70.69 -3.79 70.69 -3.31Q70.69 -2.89 70.91 -2.59Q71.14 -2.29 71.54 -2.13Q71.95 -1.97 72.49 -1.97Z" />
    </svg>
  );
}

/** The Automa mark on its own, for compact chrome (sidebars, loaders). */
export function AutomaMark({ decorative = true, title = "Automa", className, ...rest }: PaperclipLockupProps) {
  return (
    <svg
      {...rest}
      className={className}
      viewBox="0 0 32 32"
      fill="currentColor"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title}
      focusable="false"
    >
      <path fillRule="evenodd" d={AUTOMA_MARK_PATH} />
    </svg>
  );
}
