# @pipeworx/at-ris

Austria's consolidated federal law and case law — full text, by provision or
by decision, with in-force dates kept separate from publication dates: search
and read a §/Article/Annex of a federal statute as of any date, and search and
read a decision of the constitutional court (VfGH), the supreme administrative
court (VwGH) or the ordinary courts (OGH/OLG/LG/BG), by Geschäftszahl or ECLI.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1815+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `at_search_legislation(query?, titel?, gesetzesnummer?, in_force_on?, limit?, offset?)`
  — search consolidated federal law (Bundesrecht konsolidiert) by full-text
  words, law title, or exact law number. Returns matching provisions with
  their law, citation, in-force dates, subject index and the official RIS page.
- `at_get_provision(law, paragraph, provision_type?, as_of?, text_offset?)` —
  the original-language (German) text of one provision, as of a given date.
  `law` accepts a Gesetzesnummer or a title/abbreviation (resolved first).
  Long text is paged via `text_offset`/`text_has_more`/`text_next_offset`.
- `at_get_legislation_document(document_id, text_offset?)` — fetch one
  Bundesrecht konsolidiert document's text directly by its RIS id (from the
  two tools above), without re-resolving the citation.
- `at_search_case_law(court, query?, geschaeftszahl?, date_from?, date_to?, doc_type?, limit?, offset?)`
  — search case law in exactly one court family (`vfgh`, `vwgh` or `justiz`)
  by full-text words, case number and/or date range. Defaults to decision
  texts; `doc_type: "rechtssatz"` searches headnote summaries instead.
- `at_get_decision(document_id?, ecli?, geschaeftszahl?, court?, text_offset?)`
  — the original-language full text of one decision, by document id, ECLI
  (court inferred automatically) or Geschäftszahl (court required). Returns
  decision date, legal/subject area, headnote and norms cited alongside the
  text, paged the same way as `at_get_provision`.

## Auth

Keyless.

## Data sources

- Bundeskanzleramt (Austria), Rechtsinformationssystem (RIS) — Bundesrecht
  konsolidiert (consolidated federal law): every federal statute and
  regulation kept up to date with later amendments folded in, broken into
  provisions (§/Article/Annex), each with its own historical versions
  ("Fassungen") and in-force dates. These consolidated texts are explicitly
  informational, not the legally binding form (that is the separately
  authenticated Bundesgesetzblatt, not covered by this pack).
- Bundeskanzleramt (Austria), Rechtsinformationssystem (RIS) — Judikatur
  (case law): decisions of the Verfassungsgerichtshof (VfGH, constitutional
  court, from 1980), the Verwaltungsgerichtshof (VwGH, supreme administrative
  court, from 1990) and the ordinary courts (OGH plus OLG/LG/BG, "Justiz").
- A record's own RIS page is linked back from search/get results
  (`official_url` / document pages) for citation — that is the record, not a
  route.

## Notes

- **Keyless, live proxy, low-volume by design.** RIS asks to be notified
  before high-volume harvesting. This pack never bulk-crawls: every tool
  makes exactly one upstream search request, and the two "get" tools make at
  most one further request to fetch that one document's text. Nothing is
  baked into the pack or mirrored.
- **Search never returns body text.** RIS's search API returns metadata and
  links to a document's Xml/Html/Rtf/Pdf, never inline text or a snippet.
  Getting the actual original-language text is always a second fetch, done
  inside `at_get_provision` / `at_get_decision` / `at_get_legislation_document`
  from the URL the search gave — never a URL constructed from guesswork,
  except in the two "by id" tools, which use the one confirmed-stable path
  shape for a caller who already holds an id from an earlier search.
- **The upstream JSON is XML-derived**: any field that can repeat comes back
  as `{"item": "x"}` for one value or `{"item": ["x","y"]}` for several —
  never a bare array, and the key is absent (not `[]`) when there are none.
- **Fassung (version) resolution is always explicit.** A provision can have
  several historical versions, each with its own in-force window. This pack
  always sends an as-of date (defaulting to today) to resolve to exactly the
  one version valid then, rather than returning every version and asking the
  caller to pick, so `in_force_from`/`in_force_until`/publication dates on a
  response are for the one version actually returned.
- **Case law id prefixes carry the court**, which is how `at_get_decision`
  infers it from `document_id` or `ecli` without an extra round trip:
  VfGH decisions start `JFT`, VwGH `JWT`, and Justiz (OGH/OLG/LG/BG) `JJT`
  (full text) or `JJR` (headnote/Rechtssatz). A bare `geschaeftszahl` does not
  reliably carry this, so that path requires `court` explicitly.
- **"Justiz" is the ordinary-courts family**, not only the OGH — it also
  carries OLG (higher regional courts), LG/BG (regional/district courts) and
  a few specialised senates. `at_search_case_law(court: "justiz", ...)`
  searches all of them together; RIS does not let a caller narrow to "OGH
  only" within that application.
- Long provisions and decisions are paged by character offset
  (`text_offset`/`text_has_more`/`text_next_offset`), never silently
  truncated — some Justiz decisions run well past a single response's worth
  of text.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "at-ris": {
      "url": "https://gateway.pipeworx.io/at-ris/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/at-ris/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1815+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/at_search_legislation \
  -H 'Content-Type: application/json' \
  -d '{"query":"Datenschutz","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/at_search_legislation`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "at-ris": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-at-ris"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-at-ris
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about At Ris data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
