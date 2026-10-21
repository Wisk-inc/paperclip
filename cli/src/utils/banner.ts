import pc from "picocolors";

const PAPERCLIP_ART = [
  " █████╗ ██╗   ██╗████████╗ ██████╗ ███╗   ███╗ █████╗ ",
  "██╔══██╗██║   ██║╚══██╔══╝██╔═══██╗████╗ ████║██╔══██╗",
  "███████║██║   ██║   ██║   ██║   ██║██╔████╔██║███████║",
  "██╔══██║██║   ██║   ██║   ██║   ██║██║╚██╔╝██║██╔══██║",
  "██║  ██║╚██████╔╝   ██║   ╚██████╔╝██║ ╚═╝ ██║██║  ██║",
  "╚═╝  ╚═╝ ╚═════╝    ╚═╝    ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝",
] as const;

const TAGLINE = "Automa · your AI team, in your pocket · Corx Labs";

export function printPaperclipCliBanner(): void {
  const lines = [
    "",
    ...PAPERCLIP_ART.map((line) => pc.cyan(line)),
    pc.blue("  ───────────────────────────────────────────────────────"),
    pc.bold(pc.white(`  ${TAGLINE}`)),
    "",
  ];

  console.log(lines.join("\n"));
}
