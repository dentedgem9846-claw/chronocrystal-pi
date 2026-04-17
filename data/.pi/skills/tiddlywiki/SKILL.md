---
name: tiddlywiki
description: Read, inspect, create, and update the live KawaWiki through dedicated wiki tools. Use when the user asks about the wiki, wants a page added or edited, or needs existing tiddlers reviewed before changes.
---

# TiddlyWiki

Use the dedicated wiki tools for KawaWiki work.
The live wiki is served at `/wiki` and backed by the running TiddlyWiki server.
`KawaWiki.html` is only the seed import for first startup; it is not the canonical editable source after the server-backed wiki exists.

## Workflow

1. Use `list_wiki_tiddlers` when you need to discover likely page titles or avoid creating duplicates.
2. Use `get_wiki_tiddler` before editing an existing page so you preserve its current structure, links, and tags.
3. Use `set_wiki_tiddler` to create or update the page once you know the correct title and full content.
4. Tell the user the wiki can be viewed in the browser at `/wiki` when that is useful.

## Rules

- Prefer updating an existing relevant tiddler over creating a near-duplicate.
- Do not edit system tiddlers such as titles beginning with `$:/` unless the user explicitly asks.
- Preserve existing tags unless the user asks to recategorize the page.
- Prefer one tiddler per concept.
- When writing wiki links, use TiddlyWiki link syntax like `[[Exact Title]]`.
- Keep the saved text complete and intentional. Do not save placeholders or partial notes unless the user asked for a draft.
