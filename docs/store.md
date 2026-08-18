# OIE Cache Manager

**Database-backed lookup caches** for Open Integration Engine channels: define a
JDBC-sourced cache once, then read it from any channel script with
`$g('name').lookup(key)` — no per-message database round trips, no connection
handling in transformer code.

- **JDBC-sourced definitions** — point a cache at any database (PostgreSQL,
  MySQL, Oracle, SQL Server, SQLite, or a custom driver) with a key/value
  query; entries load on first lookup and stay hot.
- **Automatic eviction and refresh** — size caps and time-based eviction per
  cache, plus an on-demand full refresh that re-reads the source table.
- **Live statistics** — per-cache size, hit rate, evictions, memory estimate,
  and total database time saved, visible at a glance in the definitions table.
- **Cache inspector** — browse the actual cached entries with server-side
  search (literal or Java regex), sorting, and pagination; copy keys and
  values; view full entry detail.
- **Test before you save** — Test Connection and Test Query run your
  definition against the live database from the editor dialog.
- **Both administrators** — the classic Swing Administrator and the OIE web
  administrator, with full feature parity.

## Using it

- **Define** — Settings → OIE Cache Manager → New: name, JDBC connection,
  key/value query, size and eviction limits.
- **Look up** — in any channel script: `var v = $g('mycache').lookup(key);`
- **Monitor** — the definitions table shows live statistics; Inspect opens the
  entry browser; Refresh Cache re-reads the source.

## Compatibility

Requires Open Integration Engine **4.6.0+** (Java 17+). The web administrator
UI requires a web admin build 4.6+ with the Web Support plugin on the engine.
A restart is required after install. Safe to install with or without the web
administrator.
