<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB.</em></p>

# Query Tableau Dashboards, Usage, Data Sources and Lineage in DuckDB

> **vgi-tableau** · a [Query.Farm](https://query.farm) VGI worker · written in TypeScript

[![CI](https://github.com/Query-farm/vgi-tableau/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-tableau/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

Tableau Cloud and Tableau Server metadata and usage as SQL, read-only, through the
[REST API](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref.htm) and the
[Metadata API](https://help.tableau.com/current/api/metadata_api/en-us/index.html): which
dashboards and worksheets exist and how often they are viewed, who owns what and where it
lives, which data sources and database connections it uses, who has which license, what
the extract refreshes and Prep flows did, and which warehouse tables feed each workbook.

```sql
CREATE SECRET tableau (TYPE tableau,
  SERVER_URL 'https://10ax.online.tableau.com', SITE_CONTENT_URL 'acme',
  PAT_NAME 'duckdb', PAT_SECRET '…');

-- The ten most viewed dashboards and where they live.
SELECT title, folder_path, owner, view_count
FROM tableau.main.dashboards ORDER BY view_count DESC LIMIT 10;

-- Impact analysis: what breaks if analytics.public.orders changes?
SELECT content_type, content_name
FROM tableau.main.lineage_tables WHERE qualified_name = 'analytics.public.orders';

-- Failed extract refreshes and Prep flow runs, in the shared orchestrator shape.
SELECT pipeline, started_at, duration_seconds
FROM tableau.unified.runs WHERE status = 'failed' ORDER BY started_at DESC;
```

## Tables

Everything is a table in `tableau.main` (plus `tableau.unified.runs`); filter with `WHERE`.

### Shared BI vocabulary

`dashboards`, `charts`, `queries`, `users`, `folders`, `content_usage`, `data_sources` and
`connections` use the table names shared by the Query.Farm BI workers (Looker, Tableau, …),
and the content tables start with the same columns, so rows `UNION ALL` across tools:

`tool, id, title, folder_path, owner, created_at, updated_at, last_viewed_at, view_count, url`

In Tableau, `folder_path` is the slash-separated project path (`Finance/Quarterly`), `owner`
is the owner's username, and `last_viewed_at` is always NULL (the REST API has no
last-viewed time; `view_count` is the all-time total). The vocabulary was fixed before the
sibling `vgi-looker` README existed; the names above follow the shared brief exactly.

### All tables

| Table | Tableau source | What pushes down |
|---|---|---|
| `dashboards` | `GET /sites/{site}/views?includeUsageStatistics=true` (dashboards + stories) | `title`, `workbook_name`, `project_name` (`=`, `IN`), `sheet_type`, `content_url` (`=`), `created_at`/`updated_at` ranges → `filter`; `ORDER BY title / created_at / updated_at / view_count … LIMIT n` → `sort` |
| `charts` | same, worksheets | same |
| `content_usage` | same, every view: `view_count` per view | same |
| `workbooks` | `GET /sites/{site}/workbooks` | `name`, `project_name` (`=`, `IN`), `content_url`, `created_at`/`updated_at` ranges; sort hints |
| `folders` | `GET /sites/{site}/projects` (with full path, depth, parent) | `title` (`=`, `IN`), `parent_id`, `top_level`, `created_at`/`updated_at` ranges |
| `data_sources` | `GET /sites/{site}/datasources` | `title`, `project_name` (`=`, `IN`), `datasource_type`, `is_certified`, `has_extracts`, `created_at`/`updated_at` ranges |
| `connections` | `GET /sites/{site}/{datasources,workbooks}/{id}/connections` | `content_id` (`=`, `IN`) reads only those items; `content_type` skips the other kind |
| `users` | `GET /sites/{site}/users?fields=_all_` | `name`, `site_role` (`=`, `IN`), `last_login` ranges |
| `groups` | `GET /sites/{site}/groups` | `name` (`=`, `IN`), `domain_name`, `minimum_site_role` |
| `group_members` | `GET /sites/{site}/groups/{id}/users` | `group_id` (`=`, `IN`) |
| `favorites` | `GET /sites/{site}/favorites/{user-id}` | `user_id` (`=`, `IN`) |
| `subscriptions` | `GET /sites/{site}/subscriptions` (recipient masked) | — |
| `data_alerts` | `GET /sites/{site}/dataAlerts` (+ `/dataAlerts/{id}` for `recipient_count`, only when selected) | — |
| `schedules` | `GET /schedules` (Tableau Server only; empty on Cloud) | — |
| `extract_refresh_tasks` | `GET /sites/{site}/tasks/extractRefreshes` | — |
| `jobs` | `GET /sites/{site}/jobs` | `job_type`, `status` (`=`, `IN`), `title`, `created_at`/`started_at`/`ended_at` ranges |
| `flows` | `GET /sites/{site}/flows` | `name` (`=`, `IN`), `created_at`/`updated_at` ranges |
| `flow_runs` | `GET /sites/{site}/flows/runs` | `flow_id`, `started_at`/`completed_at` ranges |
| `revisions` | `GET /sites/{site}/{workbooks,datasources}/{id}/revisions` | `content_id` (`=`, `IN`), `content_type` |
| `sites` | `GET /sites/{site-id}` (the signed-in site) | — |
| `lineage_tables` | Metadata API `workbooksConnection` / `publishedDatasourcesConnection` → `upstreamTables` | `content_id`, `content_name` (`=`, `IN`) → GraphQL `filter: {luidWithin, nameWithin}`; `content_type` |
| `field_lineage` | Metadata API fields → `upstreamColumns` (workbooks' embedded and published data sources) | same |
| `queries` | Metadata API `customSQLTablesConnection` (custom SQL) | `id` (`=`, `IN`) → `filter: {idWithin}` |
| `unified.runs` | extract refresh jobs (`jobType:in:[refresh_extracts,increment_extracts]`) + `flows/runs` | `status` (mapped back to Tableau's values), `queued_at`/`started_at`/`ended_at` ranges |

Pushed predicates only narrow what Tableau returns; the SDK re-applies every predicate
exactly, so results are always correct. Time bounds are widened to whole seconds (Tableau's
filter format), values containing `,` or `[ ]` are not pushed, and predicates under `OR`
stay in DuckDB. `lineage_tables.qualified_name` is the lower-cased
`database.schema.table` without Tableau's brackets, for joins with dbt models or
OpenLineage datasets.

**Never returned:** passwords or embedded credentials (`connections` exposes only the
connection type, server, port, database user name and whether a password is embedded),
subscription recipients' names (masked as `a***@example.com`), data-alert recipients
(counted only).

## Authentication

One `tableau` secret = one site. Either a personal access token:

```sql
CREATE SECRET tableau (TYPE tableau,
  SERVER_URL 'https://10ax.online.tableau.com',  -- or your Tableau Server URL
  SITE_CONTENT_URL 'acme',                       -- '' for the Default site
  PAT_NAME 'duckdb', PAT_SECRET '…');
```

or a [connected app (direct trust)](https://help.tableau.com/current/online/en-us/connected_apps_direct.htm);
the worker mints a short-lived HS256 JWT with read-only scopes and signs in as `USERNAME`:

```sql
CREATE SECRET tableau (TYPE tableau,
  SERVER_URL 'https://10ax.online.tableau.com', SITE_CONTENT_URL 'acme',
  CLIENT_ID '…', SECRET_ID '…', SECRET_VALUE '…', USERNAME 'analyst@example.com');
```

Optional fields: `SCOPES` (space-separated; default `tableau:content:read`,
`tableau:users:read`, … — only `:read` scopes), `API_VERSION` (default: read from
`/api/2.4/serverinfo`), `PAGE_SIZE` (1–1000, default 100). `PAT_SECRET` and
`SECRET_VALUE` are redacted. The session token lives only in the worker's memory and never
in query state.

A personal access token allows one session at a time: two processes signing in with the
same token invalidate each other's session. The worker signs in again on a 401, but give
long-running HTTP deployments a token (or connected app) of their own.

## Paging and rate limits

REST lists page with `pageSize` / `pageNumber`; the Metadata API pages with `first` /
`after`. Each page is one Arrow batch and the cursor (phase, page number or GraphQL cursor,
pending parent ids for per-item tables) is externalized in the scan state, so long scans
resume on any process over the HTTP transport. 429 responses are retried after
`Retry-After`; 5xx and network errors retry with exponential backoff. Enrichment lookups
(project paths, owner usernames, workbook / flow names) are read in pages of 1000 only when
a selected column needs them, and cached for a minute.

## Install

**Prerequisites:** [Bun](https://bun.sh) 1.3+ (for a source checkout).

```bash
git clone https://github.com/Query-farm/vgi-tableau.git && cd vgi-tableau
bun install --frozen-lockfile
```

**DuckDB 2.0:**

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
ATTACH 'tableau' (TYPE vgi, LOCATION '/abs/path/to/vgi-tableau/bin/vgi-tableau-worker');
```

**Haybarn 2.0** (`uvx haybarn-cli`):

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'tableau' (TYPE vgi, LOCATION '/abs/path/to/vgi-tableau/bin/vgi-tableau-worker');
```

`LOCATION` is the command DuckDB runs, so use an absolute path. Tagged releases ship
signed standalone executables (no Bun needed) for Linux, macOS (arm64) and Windows; point
`LOCATION` at the downloaded binary. The same binary serves HTTP with `--http --port 8000`
(see the `Dockerfile`).

## Testing

```bash
make test-unit                 # bun unit tests (filter translation, JWT, sessions, backoff)
make test-sql                  # test/sql/tableau.test through Haybarn 2.0 (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make check                     # everything CI runs
```

No test touches the network or a real Tableau site. `test/mock_api/server.py` is a
stdlib-only replay server over a hand-built site (`test/fixtures/tableau-site.json`, shaped
after Tableau's documented JSON responses). It requires `Accept: application/json` and
`X-Tableau-Auth`, signs in personal access tokens and verifies connected-app JWTs (HS256
signature, kid/iss, audience, expiry, read-only scopes), expires its first session after
three calls so the re-sign-in path runs, rejects unknown query parameters, validates and
evaluates `filter` / `sort` expressions, pages REST lists and GraphQL connections, checks
GraphQL selections against the fields it knows, and answers a 429 and a 503 once each. The
SQL tests read its `/__requests` log to check exactly what was pushed down. All
credentials in the tests are fixture values.

The metadata check runs with `execute: false` in CI: every table needs a `tableau` secret
for a live site.

## Authorship & License

Written by [Query.Farm](https://query.farm). Released under the
[BSD Zero Clause License](LICENSE) (0BSD).

Copyright 2026 Query Farm LLC - https://query.farm
