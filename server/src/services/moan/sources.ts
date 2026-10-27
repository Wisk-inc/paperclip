/**
 * Where Moan's Jamaican knowledge comes from: news feeds, government and
 * court sites, the published Laws of Jamaica, and reference pages. Each entry
 * says how it is read and how often it is refreshed. Everything here is a
 * public page; nothing is sent anywhere but the local index.
 */
export type MoanTopic = "news" | "government" | "law" | "history" | "economy" | "culture" | "weather" | "sport";

export interface MoanSource {
  id: string;
  name: string;
  topic: MoanTopic;
  /** rss: a feed and each item's page; page: one page; crawl: a page and the links it has; pdf-list: a page of PDF links. */
  kind: "rss" | "page" | "crawl" | "pdf-list";
  url: string;
  /** Tried in order when the first address fails: feeds move. */
  alternatives?: string[];
  /** How often to read it again. */
  everyMinutes: number;
  /** Items (articles, pages, PDFs) to take per refresh. */
  maxItems: number;
  /** crawl and pdf-list: only links whose URL or text matches this (case-insensitive) are followed. */
  match?: string;
}

const H = 60;
const DAY = 24 * H;

export const MOAN_SOURCES: MoanSource[] = [
  // The day's Jamaica: news and official word, every few hours.
  { id: "jis", name: "Jamaica Information Service", topic: "government", kind: "rss", url: "https://jis.gov.jm/feed/", alternatives: ["https://jis.gov.jm/news/feed/"], everyMinutes: 3 * H, maxItems: 20 },
  { id: "gleaner", name: "The Gleaner", topic: "news", kind: "rss", url: "https://jamaica-gleaner.com/feed/headlines/rss.xml", alternatives: ["https://jamaica-gleaner.com/feed/rss.xml", "https://jamaica-gleaner.com/rss"], everyMinutes: 3 * H, maxItems: 25 },
  { id: "observer", name: "Jamaica Observer", topic: "news", kind: "rss", url: "https://www.jamaicaobserver.com/feed/", alternatives: ["https://www.jamaicaobserver.com/rss/", "https://www.jamaicaobserver.com/feed"], everyMinutes: 3 * H, maxItems: 25 },
  { id: "rjr", name: "Radio Jamaica News", topic: "news", kind: "crawl", url: "https://radiojamaicanewsonline.com/local", alternatives: ["https://radiojamaicanewsonline.com/"], everyMinutes: 3 * H, maxItems: 15, match: "radiojamaicanewsonline\\.com/(local|business|regional|sport|politics)/[a-z0-9-]{12,}" },
  { id: "nationwide", name: "Nationwide 90FM", topic: "news", kind: "rss", url: "https://nationwideradiojm.com/feed/", everyMinutes: 4 * H, maxItems: 15 },
  { id: "loop", name: "Loop Jamaica", topic: "news", kind: "rss", url: "https://jamaica.loopnews.com/rss.xml", alternatives: ["https://jamaica.loopnews.com/feed"], everyMinutes: 4 * H, maxItems: 15 },
  { id: "star", name: "The Star", topic: "culture", kind: "rss", url: "https://jamaica-star.com/feed/rss.xml", alternatives: ["https://jamaica-star.com/rss"], everyMinutes: 6 * H, maxItems: 10 },
  { id: "opm", name: "Office of the Prime Minister", topic: "government", kind: "rss", url: "https://opm.gov.jm/feed/", everyMinutes: 6 * H, maxItems: 15 },
  { id: "moj-news", name: "Ministry of Justice", topic: "law", kind: "rss", url: "https://moj.gov.jm/feed/", alternatives: ["https://moj.gov.jm/news/feed/"], everyMinutes: 12 * H, maxItems: 10 },
  { id: "moh", name: "Ministry of Health and Wellness", topic: "government", kind: "rss", url: "https://www.moh.gov.jm/feed/", everyMinutes: 12 * H, maxItems: 10 },
  { id: "jcf", name: "Jamaica Constabulary Force", topic: "news", kind: "crawl", url: "https://jcf.gov.jm/news/", alternatives: ["https://jcf.gov.jm/"], everyMinutes: 12 * H, maxItems: 8, match: "jcf\\.gov\\.jm/(news|press)" },
  { id: "met", name: "Meteorological Service of Jamaica", topic: "weather", kind: "page", url: "https://metservice.gov.jm/", everyMinutes: 3 * H, maxItems: 1 },
  { id: "odpem", name: "ODPEM", topic: "weather", kind: "page", url: "https://www.odpem.org.jm/", everyMinutes: 6 * H, maxItems: 1 },
  // Money and numbers, daily.
  { id: "boj", name: "Bank of Jamaica", topic: "economy", kind: "crawl", url: "https://boj.org.jm/", everyMinutes: 12 * H, maxItems: 10, match: "boj\\.org\\.jm/.*(news|press|release|monetary|rate|statistic|inflation)" },
  { id: "statin", name: "STATIN", topic: "economy", kind: "page", url: "https://statinja.gov.jm/", everyMinutes: DAY, maxItems: 1 },
  { id: "pioj", name: "Planning Institute of Jamaica", topic: "economy", kind: "crawl", url: "https://www.pioj.gov.jm/", everyMinutes: DAY, maxItems: 8, match: "pioj\\.gov\\.jm/.*(news|media|press|release|review|economic)" },
  { id: "jtb", name: "Jamaica Tourist Board", topic: "economy", kind: "page", url: "https://www.jtbonline.org/", everyMinutes: 2 * DAY, maxItems: 1 },
  // Parliament and the law.
  { id: "parliament", name: "Houses of Parliament", topic: "law", kind: "crawl", url: "https://www.japarliament.gov.jm/", everyMinutes: 12 * H, maxItems: 10, match: "japarliament\\.gov\\.jm/.*(bill|publication|sitting|hansard|news|order-paper|act)" },
  { id: "courts", name: "Supreme Court of Jamaica", topic: "law", kind: "crawl", url: "https://supremecourt.gov.jm/", everyMinutes: DAY, maxItems: 8, match: "supremecourt\\.gov\\.jm/.*(judgment|notice|news|practice|rule)" },
  {
    id: "laws",
    name: "The Laws of Jamaica (Ministry of Justice)",
    topic: "law",
    kind: "pdf-list",
    url: "https://moj.gov.jm/laws",
    alternatives: ["https://moj.gov.jm/laws/statutes", "https://moj.gov.jm/content/laws-jamaica"],
    everyMinutes: 7 * DAY,
    maxItems: 45,
    match: "constitution|charter of fundamental|offences against the person|dangerous drugs|road traffic|firearms|data protection|sexual offences|child care|domestic violence|labour relations|employment|minimum wage|maintenance act|property \\(rights of spouses\\)|rent restriction|registration of titles|companies act|proceeds of crime|cybercrimes|bail act|evidence act|jury act|noise abatement|larceny|criminal justice|legal aid|access to information|representation of the people|jamaican nationality|immigration|integrity commission|disabilities|trafficking in persons|consumer protection|fair competition|general consumption tax|income tax|stamp duty|transfer tax|holidays with pay|maternity leave|termination and redundancy|limitation of actions|wills act|intestates|defamation|public health|tobacco|parish courts|judicature|legal profession",
  },
  // The long story: reference pages, monthly.
  { id: "wiki-jamaica", name: "Wikipedia: Jamaica", topic: "history", kind: "page", url: "https://en.wikipedia.org/wiki/Jamaica", everyMinutes: 30 * DAY, maxItems: 1 },
  { id: "wiki-history", name: "Wikipedia: History of Jamaica", topic: "history", kind: "page", url: "https://en.wikipedia.org/wiki/History_of_Jamaica", everyMinutes: 30 * DAY, maxItems: 1 },
  { id: "wiki-politics", name: "Wikipedia: Politics of Jamaica", topic: "government", kind: "page", url: "https://en.wikipedia.org/wiki/Politics_of_Jamaica", everyMinutes: 30 * DAY, maxItems: 1 },
  { id: "wiki-constitution", name: "Wikipedia: Constitution of Jamaica", topic: "law", kind: "page", url: "https://en.wikipedia.org/wiki/Constitution_of_Jamaica", everyMinutes: 30 * DAY, maxItems: 1 },
  { id: "wiki-judiciary", name: "Wikipedia: Judiciary of Jamaica", topic: "law", kind: "page", url: "https://en.wikipedia.org/wiki/Judiciary_of_Jamaica", everyMinutes: 30 * DAY, maxItems: 1 },
  { id: "wiki-hurricanes", name: "Wikipedia: List of Jamaica hurricanes", topic: "weather", kind: "page", url: "https://en.wikipedia.org/wiki/List_of_Jamaica_hurricanes", everyMinutes: 30 * DAY, maxItems: 1 },
  { id: "wiki-economy", name: "Wikipedia: Economy of Jamaica", topic: "economy", kind: "page", url: "https://en.wikipedia.org/wiki/Economy_of_Jamaica", everyMinutes: 30 * DAY, maxItems: 1 },
  { id: "wiki-culture", name: "Wikipedia: Culture of Jamaica", topic: "culture", kind: "page", url: "https://en.wikipedia.org/wiki/Culture_of_Jamaica", everyMinutes: 30 * DAY, maxItems: 1 },
  { id: "wiki-patois", name: "Wikipedia: Jamaican Patois", topic: "culture", kind: "page", url: "https://en.wikipedia.org/wiki/Jamaican_Patois", everyMinutes: 30 * DAY, maxItems: 1 },
  { id: "wiki-parishes", name: "Wikipedia: Parishes of Jamaica", topic: "history", kind: "page", url: "https://en.wikipedia.org/wiki/Parishes_of_Jamaica", everyMinutes: 30 * DAY, maxItems: 1 },
  { id: "wiki-music", name: "Wikipedia: Music of Jamaica", topic: "culture", kind: "page", url: "https://en.wikipedia.org/wiki/Music_of_Jamaica", everyMinutes: 30 * DAY, maxItems: 1 },
  { id: "wiki-cuisine", name: "Wikipedia: Jamaican cuisine", topic: "culture", kind: "page", url: "https://en.wikipedia.org/wiki/Jamaican_cuisine", everyMinutes: 30 * DAY, maxItems: 1 },
  { id: "wiki-sport", name: "Wikipedia: Sport in Jamaica", topic: "sport", kind: "page", url: "https://en.wikipedia.org/wiki/Sport_in_Jamaica", everyMinutes: 30 * DAY, maxItems: 1 },
  { id: "wiki-pm", name: "Wikipedia: Prime Minister of Jamaica", topic: "government", kind: "page", url: "https://en.wikipedia.org/wiki/Prime_Minister_of_Jamaica", everyMinutes: 30 * DAY, maxItems: 1 },
  { id: "wiki-election", name: "Wikipedia: 2025 Jamaican general election", topic: "government", kind: "page", url: "https://en.wikipedia.org/wiki/2025_Jamaican_general_election", everyMinutes: 30 * DAY, maxItems: 1 },
  { id: "wiki-melissa", name: "Wikipedia: Hurricane Melissa", topic: "weather", kind: "page", url: "https://en.wikipedia.org/wiki/Hurricane_Melissa", everyMinutes: 30 * DAY, maxItems: 1 },
  { id: "nlj", name: "National Library of Jamaica", topic: "history", kind: "crawl", url: "https://nlj.gov.jm/", everyMinutes: 30 * DAY, maxItems: 8, match: "nlj\\.gov\\.jm/.*(history|heroes|jamaica|collection|project|parish)" },
];

export function moanSource(id: string): MoanSource | undefined {
  return MOAN_SOURCES.find((source) => source.id === id);
}
