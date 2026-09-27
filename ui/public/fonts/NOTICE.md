# Bundled UI Fonts

Paperclip bundles Inter for the board UI so screenshots and packaged installs use
the same sans-serif text stack without relying on host font packages.

## Inter

- Upstream project: https://github.com/rsms/inter
- Version: v4.1
- Source files:
  - https://raw.githubusercontent.com/rsms/inter/v4.1/docs/font-files/InterVariable.woff2
  - https://raw.githubusercontent.com/rsms/inter/v4.1/docs/font-files/InterVariable-Italic.woff2
- License: SIL Open Font License 1.1
- License text: https://github.com/rsms/inter/blob/v4.1/LICENSE.txt

Redistribution note: Inter is redistributed under the SIL Open Font License 1.1.
The bundled WOFF2 files are included unmodified from the upstream v4.1 release.

## Bricolage Grotesque

Automa uses Bricolage Grotesque as its display face (page titles, headline
numbers, and the wordmark) so headings do not share Inter with body text.

- Upstream project: https://github.com/ateliertriay/bricolage
- Source file: https://raw.githubusercontent.com/google/fonts/main/ofl/bricolagegrotesque/BricolageGrotesque%5Bopsz%2Cwdth%2Cwght%5D.ttf
- License: SIL Open Font License 1.1
- License text: https://github.com/google/fonts/blob/main/ofl/bricolagegrotesque/OFL.txt

Modification note: `BricolageGrotesque-UI.woff2` is a derivative instance
(width 100, optical size 20, weight axis kept at 400–700) subset to Latin
characters and converted to WOFF2 with fontTools. The upstream license declares
no Reserved Font Name; the file is redistributed under the same SIL Open Font
License 1.1.
