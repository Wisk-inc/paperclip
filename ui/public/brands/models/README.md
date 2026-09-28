# AI model provider icons

Logos for the companies behind AI models, shown next to model names in the
chat model switcher and on agent cards. `ui/src/lib/model-brand.ts` maps a
model id (for example `openrouter/deepseek/deepseek-v4-pro`) to one of these
files. Anthropic, OpenAI, xAI, and OpenRouter reuse the marks in
`../apps/`; Google Gemini and Moonshot Kimi reuse the marks in `../adapters/`.

Source: [Lobe Icons](https://github.com/lobehub/lobe-icons/tree/a94750e3f5f8fc33757b839d85030e742284e43a/packages/static-svg/icons), pinned to commit `a94750e3f5f8fc33757b839d85030e742284e43a`.

Color marks drop the `-color` suffix from the upstream file name (Tencent uses
the Hunyuan mark and Amazon uses the Nova mark). IBM, Inception, Liquid AI,
Nous Research, and Z.ai use monochrome marks; their `-dark` variants replace
`currentColor` with white for dark surfaces. All other artwork is unchanged.

Artwork is distributed under the accompanying MIT license. Brand names and
marks belong to their respective owners.
