# Changelog

## 0.2.0 (2026-11-25)

- VGI protocol 3.4: bump @query-farm/vgi to 0.52.3 and @query-farm/vgi-rpc to 0.30.3. **Requires the
  3.4 vgi extension**: DuckDB 2.0 (`INSTALL vgi FROM query_farm`) or Haybarn 2.0.1+; Haybarn 2.0.0
  still serves the 3.3 extension, which cannot attach this worker.
- The Docker image supports Orchard hosted mode (`VGI_ORCHARD_HOSTED=1`): HTTP only, Orchard Pass
  authentication, large values through the Orchard blob vendor; the HEALTHCHECK uses `HEAD /health`.
- CI and `make` run the SQL tests on haybarn-unittest 2.0.1rc3.

## 0.1.2 (2026-11-16)

- Bump @query-farm/vgi to 0.50.1.
- CI tooling (haybarn-unittest, lint helpers) runs on Python 3.14.

## 0.1.1

- Catalog and schema docs are overviews instead of object lists, and schemas have their own one-line comments (vgi-lint 2.8: VGI173, VGI102).

## 0.1.0

First release: read-only Tableau Cloud / Tableau Server metadata and usage from DuckDB.

- Tables (`tableau.main`): dashboards, charts, content_usage, workbooks, folders,
  data_sources, connections, users, groups, group_members, favorites, subscriptions,
  data_alerts, schedules, extract_refresh_tasks, jobs, flows, flow_runs, revisions, sites,
  lineage_tables, field_lineage, queries (Metadata API custom SQL); `tableau.unified.runs`
  (extract refreshes + Prep flow runs in the shared orchestrator shape).
- Shared BI vocabulary columns (tool, id, title, folder_path, owner, created_at,
  updated_at, last_viewed_at, view_count, url) on the content tables.
- `tableau` secret: SERVER_URL + SITE_CONTENT_URL plus a personal access token or a
  connected app (HS256 JWT, read-only scopes); API version from serverinfo; re-sign-in on 401.
- Pushdown into REST `filter=` / `sort=` and Metadata API filters; externalized paging
  cursors; 429 Retry-After handling. Passwords never returned; recipients masked or counted.

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.1rc3 · vgi-lint-check 2.x (unpinned)
