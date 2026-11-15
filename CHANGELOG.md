# Changelog

## 0.1.0 (unreleased)

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

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)
