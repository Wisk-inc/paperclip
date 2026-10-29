# Moan, the Jamaican model

Moan (`moan/moan-1:free`) is a free model in Automa that runs on Nemotron 3
Ultra under a Jamaican persona. It talks Jamaican Patois by default, switches
to Standard Jamaican English for formal, legal and submitted documents and
inside code, carries a primer on the island, and reads passages from a local
index of Jamaican sources on every turn.

## Where it lives

- `packages/shared/src/moan.ts`: the model id, the model it runs on, the
  persona, the primer (`JAMAICA_PRIMER`) and `moanSystemPrompt()`. Shared by
  the chat engine, App Studio and the Terminals free chat.
- `server/src/adapters/free-models/execute.ts`: resolves Moan to its base
  model, asks the knowledge service for passages, and puts the persona in
  front of the agent prompt. Usage is priced by the base model; runs show
  "Moan".
- `server/src/services/moan/`: the knowledge layer.
  - `sources.ts`: the Jamaican sources (news feeds, government and court
    sites, the Laws of Jamaica PDFs, reference pages) with their refresh
    intervals.
  - `ingest.ts`: reads a source (feed and articles, a page, a page and its
    links, a page of PDFs) with the same keyless web helpers the free agents
    use, cuts pages into chunks and stores them.
  - `store.ts`: the `moan_knowledge` and `moan_sources` tables and the
    Postgres full-text search over them (a GIN index on
    `to_tsvector('english', title || content)`).
  - `index.ts`: the service. A clock ticks every ten minutes and reads up to
    four due sources while Moan is in use; `contextFor(question)` returns
    matching passages plus the newest news, formatted with source, date and
    link, and a freshness line.
  - `text.ts`: feed parsing, chunking, query terms, context formatting.
- Routes (`server/src/routes/free-models.ts`):
  - `GET /api/free-models/moan/status`: pages, sources, last refresh.
  - `POST /api/free-models/moan/refresh` (board): read due sources now;
    `{ "force": true }` reads all of them, and only the instance's admins
    may ask for that (anyone else gets 403).
  - `GET /api/free-models/moan/context?q=`: what the engine calls each turn.
- UI: the model picker shows Moan first among the free models with its blurb,
  and, when an agent runs on Moan, a "Jamaica knowledge" card with the index
  size, when it last refreshed and a Refresh button.

## When it refreshes

The clock runs when any non-terminated agent uses Moan, or for a day after a
Moan reply. Set `PAPERCLIP_MOAN_KNOWLEDGE=on` to keep it running regardless,
or `off` to stop it (Moan then answers from its primer and, when the agent's
web tools are on, from the sites it looks up itself).

The first Moan reply on an empty index starts a refresh in the background;
the reply itself does not wait for it.

After each refresh, news older than a year goes, along with the pages of
sources no longer listed; past 80,000 rows the oldest news goes first. The
index therefore stays a bounded size on a phone.

## Scope and privacy

The index is instance-level on purpose: it holds only public pages fetched
from Jamaican sites, no company or user data, and every company's Moan agent
reads the same island. This is the documented exception to the company-scoping
rule in `AGENTS.md`. Nothing from the index or from conversations is sent
anywhere; the fetches go to the public sites in `sources.ts` only.

## Adding a source

Add an entry to `MOAN_SOURCES` in `server/src/services/moan/sources.ts`:
its `kind` (`rss`, `page`, `crawl` or `pdf-list`), the address and any
alternatives, how often to read it (`everyMinutes`), how many items to take
(`maxItems`) and, for crawls and PDF lists, a `match` pattern for the links
to follow. The status card and `GET /api/free-models/moan/status` show how
each source is doing.
