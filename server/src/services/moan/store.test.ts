import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, moanKnowledge } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { pruneKnowledge, replacePage } from "./store.js";

const DAY = 24 * 60 * 60_000;
const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("Moan knowledge index pruning", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-moan-prune-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });
  beforeEach(async () => { await db.delete(moanKnowledge); });

  const rules = (maxRows = 1_000) => ({ listed: ["gleaner", "jis", "laws", "wiki-jamaica"], feeds: ["gleaner", "jis"], newsBefore: new Date(Date.now() - 365 * DAY), maxRows });

  async function page(sourceId: string, url: string, publishedAt: Date | null, chunks = 1, fetchedAt?: Date) {
    await replacePage(db, { sourceId, url, title: url, topic: "news", publishedAt, chunks: Array.from({ length: chunks }, (_, i) => `Part ${i + 1} of ${url}`), contentHash: url });
    if (fetchedAt) await db.update(moanKnowledge).set({ fetchedAt }).where(eq(moanKnowledge.url, url));
  }

  async function urls(): Promise<string[]> {
    return (await db.selectDistinct({ url: moanKnowledge.url }).from(moanKnowledge)).map((row) => row.url).sort();
  }

  it("drops news older than a year and the reference pages of sources no longer listed, and keeps the rest", async () => {
    const now = Date.now();
    await page("gleaner", "https://jamaica-gleaner.com/old", new Date(now - 400 * DAY), 3);
    await page("gleaner", "https://jamaica-gleaner.com/new", new Date(now - 30 * DAY));
    // A feed page with no date ages by when it was fetched.
    await page("jis", "https://jis.gov.jm/undated-old", null, 1, new Date(now - 400 * DAY));
    await page("jis", "https://jis.gov.jm/undated-new", null);
    // Reference pages of listed sources stay however old they are.
    await page("laws", "https://moj.gov.jm/laws/act.pdf", null, 2, new Date(now - 800 * DAY));
    await page("wiki-jamaica", "https://en.wikipedia.org/wiki/Jamaica", null);
    // A source dropped from the list: its reference page goes, its news ages out on the usual clock.
    await page("retired", "https://retired.example/about", null);
    await page("retired", "https://retired.example/story", new Date(now - 10 * DAY));

    expect(await pruneKnowledge(db, rules())).toBe(5);
    expect(await urls()).toEqual([
      "https://en.wikipedia.org/wiki/Jamaica",
      "https://jamaica-gleaner.com/new",
      "https://jis.gov.jm/undated-new",
      "https://moj.gov.jm/laws/act.pdf",
      "https://retired.example/story",
    ]);
    expect(await pruneKnowledge(db, rules())).toBe(0);
  });

  it("past the row cap drops whole pages, the oldest news first, then the oldest of the rest", async () => {
    const now = Date.now();
    await page("gleaner", "https://jamaica-gleaner.com/a", new Date(now - 30 * DAY), 2);
    await page("gleaner", "https://jamaica-gleaner.com/b", new Date(now - 20 * DAY), 2);
    await page("gleaner", "https://jamaica-gleaner.com/c", new Date(now - 10 * DAY), 2);
    await page("laws", "https://moj.gov.jm/laws/act.pdf", null, 2, new Date(now - 900 * DAY));
    await page("wiki-jamaica", "https://en.wikipedia.org/wiki/Jamaica", null, 2, new Date(now - 5 * DAY));

    // Ten rows, a cap of seven: the two oldest stories go, whole.
    expect(await pruneKnowledge(db, rules(7))).toBe(4);
    expect(await urls()).toEqual(["https://en.wikipedia.org/wiki/Jamaica", "https://jamaica-gleaner.com/c", "https://moj.gov.jm/laws/act.pdf"]);
    // A cap of two: the last story, then the oldest reference page.
    expect(await pruneKnowledge(db, rules(2))).toBe(4);
    expect(await urls()).toEqual(["https://en.wikipedia.org/wiki/Jamaica"]);
  });
});
