import { skillAccentColor } from "@/lib/skill-create";

/**
 * Minimal shape needed to render a skill's square icon. `DiscoveryCard`
 * (store) and the agent-skills row model both satisfy this, so the icon can be
 * shared without pulling the whole store page into other modules.
 */
export interface SkillIconCard {
  key: string;
  name: string;
  slug?: string | null;
  iconUrl: string | null;
  color: string | null;
}

/**
 * Skills that stand for a product show that product's logo, so the list reads
 * like the apps it reaches (Slack, GitHub, Gmail…) instead of coloured letters.
 * Matched on the slug or name; the first match wins, so "google-sheets" beats
 * "google". Assets live in ui/public/brands/apps (see its LOBE-LICENSE).
 */
const BRANDS: Array<{ match: RegExp; light: string; dark?: string }> = [
  { match: /google[-_ ]?sheets?/i, light: "google-sheets.svg" },
  { match: /google[-_ ]?docs?/i, light: "google-docs.svg" },
  { match: /google[-_ ]?drive/i, light: "google-drive.svg" },
  { match: /google[-_ ]?slides/i, light: "google-slides.svg" },
  { match: /google[-_ ]?calendar|gcal/i, light: "google-calendar.svg" },
  { match: /google[-_ ]?chat/i, light: "google-chat.svg" },
  { match: /gmail|google[-_ ]?mail/i, light: "gmail.svg" },
  { match: /agentmail/i, light: "agentmail.svg", dark: "agentmail-dark.svg" },
  { match: /github/i, light: "github.svg", dark: "github-dark.svg" },
  { match: /slack/i, light: "slack.svg" },
  { match: /discord/i, light: "discord.svg", dark: "discord-dark.svg" },
  { match: /telegram/i, light: "telegram.svg" },
  { match: /notion/i, light: "notion.svg", dark: "notion-dark.svg" },
  { match: /linear/i, light: "linear.svg", dark: "linear-dark.svg" },
  { match: /jira/i, light: "jira.svg", dark: "jira-dark.svg" },
  { match: /asana/i, light: "asana.svg" },
  { match: /airtable/i, light: "airtable.svg" },
  { match: /stripe/i, light: "stripe.svg" },
  { match: /shopify/i, light: "shopify.svg" },
  { match: /supabase/i, light: "supabase.svg" },
  { match: /planetscale/i, light: "planetscale.svg", dark: "planetscale-dark.svg" },
  { match: /clickhouse/i, light: "clickhouse.svg", dark: "clickhouse-dark.svg" },
  { match: /cloudflare/i, light: "cloudflare.svg" },
  { match: /netlify/i, light: "netlify.svg", dark: "netlify-dark.svg" },
  { match: /railway/i, light: "railway.svg", dark: "railway-dark.svg" },
  { match: /sentry/i, light: "sentry.svg", dark: "sentry-dark.svg" },
  { match: /posthog/i, light: "posthog.svg", dark: "posthog-dark.svg" },
  { match: /mixpanel/i, light: "mixpanel.svg", dark: "mixpanel-dark.svg" },
  { match: /pagerduty/i, light: "pagerduty.svg" },
  { match: /postman/i, light: "postman.svg" },
  { match: /resend/i, light: "resend.svg", dark: "resend-dark.svg" },
  { match: /miro/i, light: "miro.svg", dark: "miro-dark.svg" },
  { match: /coda/i, light: "coda.svg" },
  { match: /\bbox\b/i, light: "box.svg" },
  { match: /bitly/i, light: "bitly.svg" },
  { match: /fireflies/i, light: "fireflies.svg" },
  { match: /hugging[-_ ]?face|huggingface/i, light: "hugging-face.svg" },
  { match: /microsoft[-_ ]?teams|msteams/i, light: "microsoft-teams.svg" },
  { match: /openai|gpt|codex/i, light: "openai.svg", dark: "openai-dark.svg" },
  { match: /anthropic|claude/i, light: "anthropic.svg", dark: "anthropic-dark.svg" },
  { match: /openrouter/i, light: "openrouter.svg", dark: "openrouter-dark.svg" },
  { match: /composio/i, light: "composio.svg", dark: "composio-dark.svg" },
  { match: /context7/i, light: "context7.svg", dark: "context7-dark.svg" },
  { match: /mem0/i, light: "mem0.svg" },
  { match: /cognee/i, light: "cognee.png" },
  { match: /supermemory/i, light: "supermemory.png" },
  { match: /sanity/i, light: "sanity.svg", dark: "sanity-dark.svg" },
  { match: /brex/i, light: "brex.svg", dark: "brex-dark.svg" },
  { match: /razorpay/i, light: "razorpay.svg", dark: "razorpay-dark.svg" },
  { match: /egnyte/i, light: "egnyte.svg" },
  { match: /similarweb/i, light: "similarweb.svg", dark: "similarweb-dark.svg" },
  { match: /jam[-_. ]?dev/i, light: "jam-dev.svg", dark: "jam-dev-dark.svg" },
  { match: /beehiiv/i, light: "beehiiv.png" },
  { match: /arcade/i, light: "arcade.png" },
  { match: /kernel/i, light: "kernel.svg" },
  { match: /honcho/i, light: "honcho.svg" },
  { match: /manufact/i, light: "manufact.svg", dark: "manufact-dark.svg" },
  { match: /oreilly|o'reilly/i, light: "oreilly.svg" },
  { match: /imessage/i, light: "imessage-photon.png" },
  { match: /\bmake\b/i, light: "make.svg", dark: "make-dark.svg" },
];

/** The brand assets behind a skill, or null when it has no product logo. */
export function skillBrandAssets(card: Pick<SkillIconCard, "name" | "slug">): { light: string; dark: string } | null {
  const text = `${card.slug ?? ""} ${card.name}`;
  if (/paperclip|automa/i.test(text) && !/github|slack|gmail/i.test(text)) return { light: "/favicon.svg", dark: "/favicon.svg" };
  const brand = BRANDS.find((item) => item.match.test(text));
  if (!brand) return null;
  return { light: `/brands/apps/${brand.light}`, dark: `/brands/apps/${brand.dark ?? brand.light}` };
}

/** Capitalisations that sentence case would get wrong. */
const PROPER: Record<string, string> = {
  github: "GitHub", agentmail: "AgentMail", gmail: "Gmail", openai: "OpenAI", api: "API", apis: "APIs", ai: "AI", para: "PARA",
  pdf: "PDF", pdfs: "PDFs", csv: "CSV", json: "JSON", sql: "SQL", html: "HTML", css: "CSS", js: "JS", ts: "TS", mcp: "MCP", url: "URL",
  seo: "SEO", ui: "UI", ux: "UX", ios: "iOS", imessage: "iMessage", posthog: "PostHog", clickhouse: "ClickHouse", pagerduty: "PagerDuty",
  planetscale: "PlanetScale", openrouter: "OpenRouter", huggingface: "Hugging Face", linkedin: "LinkedIn", youtube: "YouTube", tiktok: "TikTok",
  oauth: "OAuth", sdk: "SDK", cli: "CLI", slack: "Slack", notion: "Notion", jira: "Jira", linear: "Linear", stripe: "Stripe", paperclip: "Paperclip",
};

/** "paperclip-create-agent" → "Paperclip create agent"; names with spaces are left as they are. */
export function skillDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || /\s/.test(trimmed)) return trimmed;
  const words = trimmed.split(/[-_.]+/).filter(Boolean);
  return words
    .map((word, index) => {
      const known = PROPER[word.toLowerCase()];
      if (known) return known;
      return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.toLowerCase();
    })
    .join(" ");
}

/** The author, in the product's own words. */
export function skillAuthorLabel(author: string): string {
  if (/^paperclip bundled$/i.test(author.trim())) return "Built into Automa";
  if (/^paperclip$/i.test(author.trim())) return "Automa";
  return author;
}

/** The whole author line: "Built into Automa", or "by Jane". */
export function skillAuthorLine(author: string): string {
  const label = skillAuthorLabel(author);
  return label.startsWith("Built into") ? label : `by ${label}`;
}

export function SkillCardIcon({ card, size = 36 }: { card: SkillIconCard; size?: number }) {
  if (card.iconUrl) {
    return (
      <img
        src={card.iconUrl}
        alt=""
        className="shrink-0 rounded-md object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  const brand = skillBrandAssets(card);
  if (brand) {
    return (
      <span
        aria-hidden="true"
        className="flex shrink-0 items-center justify-center rounded-md border border-border bg-background p-1.5"
        style={{ width: size, height: size }}
        data-slot="skill-brand-logo"
      >
        <img src={brand.light} alt="" className="size-full object-contain dark:hidden" />
        <img src={brand.dark} alt="" className="hidden size-full object-contain dark:block" />
      </span>
    );
  }
  const accent = skillAccentColor(card.key, card.color);
  const letter = (card.slug || card.name || "?").trim().charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-md font-semibold text-white"
      style={{ width: size, height: size, backgroundColor: accent, fontSize: Math.round(size * 0.42) }}
    >
      {letter}
    </span>
  );
}
