/**
 * The Tableau tables: one spec per REST / Metadata API collection.
 *
 * The BI-vocabulary tables (`dashboards`, `charts`, `queries`, `users`, `folders`,
 * `content_usage`, `data_sources`, `connections`) start with the columns shared by the
 * Query.Farm BI workers — tool, id, title, folder_path, owner, created_at, updated_at,
 * last_viewed_at, view_count, url — so Tableau and Looker rows UNION cleanly. The
 * rest keep Tableau's own names in snake_case.
 */

import type { TableDescriptor } from "@query-farm/vgi";
import { restGet, type TableauConfig } from "./client.ts";
import * as L from "./lookups.ts";
import { arr } from "./lookups.ts";
import { buildFilter, type Constraint, eqValues, type FieldMap } from "./pushdown.ts";
import {
  asStr,
  asTime,
  at,
  C,
  type Col,
  defineTableauTable,
  type GqlPhase,
  type Phase,
  type RestPhase,
  type Row,
  type ScanContext,
  tagLabels,
} from "./table.ts";

const Q = "tableau.main";
const TOOL = C.constant("tool", "Always 'tableau' (the BI tool; lets you UNION with other BI workers).", "tableau");

/** `filter=` + optional `sort=` query parameters from the pushed constraints. */
function listQuery(
  scan: ScanContext,
  fields: Record<string, FieldMap>,
  extra?: string[],
  more?: Record<string, string>,
): Record<string, string | undefined> {
  const parts = [...(extra ?? []), ...buildFilter(scan.constraints, fields)];
  return { ...more, filter: parts.length ? parts.join(",") : undefined, sort: scan.sort };
}

// ----------------------------------------------------------------- shared helpers

const nullCol = (c: Col): Col => ({ ...c, get: () => null });

/** A web URL on the Tableau site for a path after `#/`. */
export function siteUrl(cfg: TableauConfig, path: string): string {
  return `${cfg.serverUrl}/#/${cfg.site ? `site/${encodeURIComponent(cfg.site)}/` : ""}${path}`;
}

/** A view's web URL from its contentUrl (`Workbook/sheets/View` → `views/Workbook/View`). */
export function viewUrl(cfg: TableauConfig, contentUrl: unknown): string | null {
  const s = asStr(contentUrl);
  return s ? siteUrl(cfg, `views/${s.replace("/sheets/", "/")}`) : null;
}

/** Mask a name or email for listing a recipient: `ada@example.com` → `a***@example.com`. */
export function maskName(v: unknown): string | null {
  const s = asStr(v);
  if (!s) return null;
  const at = s.indexOf("@");
  return at > 0 ? `${s[0]}***${s.slice(at)}` : `${s[0]}***`;
}

interface EnrichPaths {
  project?: string;
  owner?: string;
  workbook?: string;
}

/**
 * Attach `__folder_path`, `__project_name`, `__owner`, `__workbook_name` (and the
 * workbook's own project/owner for views) from the lookup maps, reading only the maps
 * the projected columns need.
 */
async function enrich(cfg: TableauConfig, rows: Row[], need: Set<string>, paths: EnrichPaths): Promise<Row[]> {
  const wantProject = need.has("folder_path") || need.has("project_name");
  const wantOwner = need.has("owner");
  const wantWorkbook = need.has("workbook_name");
  const [projects, users, workbooks] = await Promise.all([
    wantProject && paths.project ? L.projects(cfg) : undefined,
    wantOwner && paths.owner ? L.users(cfg) : undefined,
    wantWorkbook && paths.workbook ? L.workbooks(cfg) : undefined,
  ]);
  for (const r of rows) {
    if (projects && paths.project) {
      const p = projects.get(String(at(r, paths.project) ?? ""));
      r.__folder_path = p?.__path ?? null;
      r.__project_name = p?.name ?? at(r, "project.name") ?? null;
    }
    if (users && paths.owner) r.__owner = users.get(String(at(r, paths.owner) ?? ""))?.name ?? null;
    if (workbooks && paths.workbook)
      r.__workbook_name = workbooks.get(String(at(r, paths.workbook) ?? ""))?.name ?? null;
  }
  return rows;
}

/** The ten BI-vocabulary columns. */
function commonColumns(opts: {
  kind: string;
  title: string;
  url: (r: Row) => string | null;
  viewCount?: string;
  noFolder?: boolean;
  folderDoc?: string;
}): Col[] {
  const viewCount = C.big(
    "view_count",
    opts.viewCount
      ? `Total views of the ${opts.kind} (Tableau usage statistics).`
      : "Count of views; always NULL here because Tableau reports view counts for views only.",
    opts.viewCount ?? "__none",
  );
  return [
    TOOL,
    C.str("id", `Tableau LUID of the ${opts.kind}.`, "id", false),
    C.str("title", `Name of the ${opts.kind}.`, opts.title),
    C.str(
      "folder_path",
      opts.folderDoc ??
        `Slash-separated path of the project (folder) holding the ${opts.kind}, e.g. 'Finance/Quarterly'.`,
      "__folder_path",
    ),
    C.str("owner", `Username of the ${opts.kind}'s owner.`, "__owner"),
    C.time("created_at", `When the ${opts.kind} was created.`, "createdAt"),
    C.time("updated_at", `When the ${opts.kind} was last updated (republished).`, "updatedAt"),
    nullCol(
      C.time(
        "last_viewed_at",
        "Always NULL: the Tableau REST API does not expose last-viewed times (use content_usage.view_count).",
        "__none",
      ),
    ),
    opts.viewCount ? viewCount : nullCol(viewCount),
    C.str("url", `Web URL of the ${opts.kind} on the Tableau site.`, (r) => r.__url ?? null),
  ];
}

const withUrl =
  (cfg: TableauConfig, f: (cfg: TableauConfig, r: Row) => string | null) =>
  (rows: Row[]): Row[] => {
    for (const r of rows) r.__url = f(cfg, r);
    return rows;
  };

// ---------------------------------------------------------------- views (sheets)

const VIEW_FIELDS: Record<string, FieldMap> = {
  title: { field: "name", kind: "string", in: true },
  sheet_type: { field: "sheetType", kind: "string" },
  workbook_name: { field: "workbookName", kind: "string", in: true },
  project_name: { field: "projectName", kind: "string", in: true },
  content_url: { field: "contentUrl", kind: "string" },
  created_at: { field: "createdAt", kind: "time" },
  updated_at: { field: "updatedAt", kind: "time" },
};
const VIEW_SORT = { title: "name", created_at: "createdAt", updated_at: "updatedAt", view_count: "hitsTotal" };
const VIEW_PUSHDOWN =
  "`title`, `workbook_name`, `project_name` (`=`, `IN`), `sheet_type`, `content_url` (`=`), `created_at`/`updated_at` " +
  "ranges → REST `filter`; `ORDER BY title|created_at|updated_at|view_count` hints → `sort`.";

function viewColumns(kind: string): Col[] {
  return [
    ...commonColumns({ kind, title: "name", url: () => null, viewCount: "usage.totalViewCount" }),
    C.str("sheet_type", "Tableau sheet type: worksheet, dashboard or story.", "sheetType"),
    C.str("content_url", "The view's content URL (Workbook/sheets/View).", "contentUrl"),
    C.str("view_url_name", "The view's URL name.", "viewUrlName"),
    C.str("workbook_id", "LUID of the workbook containing the view.", "workbook.id"),
    C.str("workbook_name", "Name of the workbook containing the view.", "__workbook_name"),
    C.str("project_id", "LUID of the project (folder) holding the view.", "project.id"),
    C.str("project_name", "Name of the project (folder) holding the view.", "__project_name"),
    C.str("owner_id", "LUID of the owner.", "owner.id"),
    C.strList("tags", "Tag labels on the view.", tagLabels),
  ];
}

function viewPhases(scan: ScanContext): Phase[] {
  return [
    {
      kind: "rest",
      path: "~/views",
      query: listQuery(scan, VIEW_FIELDS, [], { includeUsageStatistics: "true" }),
      rows: (b) => withUrl(scan.cfg, (cfg, r) => viewUrl(cfg, r.contentUrl))(arr(b, "views", "view")),
    },
  ];
}

const viewEnrich = (cfg: TableauConfig, rows: Row[], need: Set<string>) =>
  enrich(cfg, rows, need, { project: "project.id", owner: "owner.id", workbook: "workbook.id" });

export const dashboards = defineTableauTable({
  name: "dashboards",
  description: "Tableau dashboards and stories (views of sheet type dashboard/story), with usage counts",
  title: "Tableau Dashboards",
  category: "content",
  keywords: "tableau, dashboards, stories, views, bi, reports, usage, view count",
  docLlm:
    "Tableau dashboards and stories (GET /sites/{site}/views?includeUsageStatistics=true, sheet type dashboard or " +
    "story) in the shared BI vocabulary: tool, id, title, folder_path (project path), owner (username), " +
    "created_at, updated_at, last_viewed_at (always NULL in Tableau), view_count, url; then sheet_type, " +
    "content_url, workbook_id/name, project_id/name, owner_id, tags. Worksheets are in `charts`. Use for " +
    "'which dashboards are most viewed', 'dashboards in folder X', 'stale dashboards not updated since …'.",
  docMd: "## dashboards\n\nTableau dashboards and stories with view counts, one row each.",
  columns: viewColumns("dashboard"),
  phases: viewPhases,
  keep: (r) => r.sheetType === "dashboard" || r.sheetType === "story",
  expand: viewEnrich,
  sortFields: VIEW_SORT,
  foreignKeys: [
    { column: "workbook_id", table: "workbooks" },
    { column: "project_id", table: "folders" },
    { column: "owner_id", table: "users" },
  ],
  pushdown: VIEW_PUSHDOWN,
  examples: [
    {
      sql: `SELECT title, folder_path, view_count FROM ${Q}.dashboards ORDER BY view_count DESC LIMIT 10`,
      description: "The ten most viewed dashboards",
    },
    {
      sql: `SELECT folder_path, count(*) AS dashboards, sum(view_count) AS views FROM ${Q}.dashboards GROUP BY folder_path ORDER BY views DESC`,
      description: "Dashboards and views per folder",
    },
  ],
});

export const charts = defineTableauTable({
  name: "charts",
  description: "Tableau worksheets (views of sheet type worksheet), with usage counts",
  title: "Tableau Worksheets",
  category: "content",
  keywords: "tableau, charts, worksheets, sheets, views, visualizations, usage",
  docLlm:
    "Tableau worksheets — individual charts — (GET /sites/{site}/views?includeUsageStatistics=true, sheet type " +
    "worksheet) in the shared BI vocabulary (tool, id, title, folder_path, owner, created_at, updated_at, " +
    "last_viewed_at NULL, view_count, url) plus sheet_type, content_url, workbook_id/name, project, owner_id, " +
    "tags. Dashboards and stories are in `dashboards`. Hidden worksheets of published workbooks are not listed.",
  docMd: "## charts\n\nTableau worksheets with view counts, one row each.",
  columns: viewColumns("worksheet"),
  phases: viewPhases,
  keep: (r) => r.sheetType === "worksheet",
  expand: viewEnrich,
  sortFields: VIEW_SORT,
  foreignKeys: [
    { column: "workbook_id", table: "workbooks" },
    { column: "project_id", table: "folders" },
    { column: "owner_id", table: "users" },
  ],
  pushdown: VIEW_PUSHDOWN,
  examples: [
    {
      sql: `SELECT workbook_name, count(*) AS charts FROM ${Q}.charts GROUP BY workbook_name ORDER BY charts DESC`,
      description: "Worksheet count per workbook",
    },
    {
      sql: `SELECT title, workbook_name FROM ${Q}.charts WHERE view_count = 0 ORDER BY workbook_name, title`,
      description: "Worksheets nobody has viewed",
    },
  ],
});

export const contentUsage = defineTableauTable({
  name: "content_usage",
  description: "View counts for every Tableau view (dashboards, stories and worksheets)",
  title: "Tableau Content Usage",
  category: "usage",
  keywords: "tableau, usage, view count, popularity, adoption, hits, unused content",
  docLlm:
    "Usage of every Tableau view (GET /sites/{site}/views?includeUsageStatistics=true): tool, content_type " +
    "('view'), content_id, title, sheet_type, workbook_id/name, folder_path, owner, view_count (all-time total " +
    "views), last_viewed_at (always NULL: not exposed by the REST API), url. Use for adoption questions: most / " +
    "least viewed content, unused views, views per folder or owner. Same rows as dashboards + charts.",
  docMd: "## content_usage\n\nAll-time view counts for every view (dashboards, stories, worksheets).",
  columns: [
    TOOL,
    C.constant("content_type", "Always 'view' (Tableau reports usage per view).", "view"),
    C.str("content_id", "LUID of the view.", "id", false),
    C.str("title", "Name of the view.", "name"),
    C.str("sheet_type", "worksheet, dashboard or story.", "sheetType"),
    C.str("workbook_id", "LUID of the workbook containing the view.", "workbook.id"),
    C.str("workbook_name", "Name of the workbook containing the view.", "__workbook_name"),
    C.str("folder_path", "Slash-separated project path holding the view.", "__folder_path"),
    C.str("owner", "Username of the view's owner.", "__owner"),
    C.big("view_count", "All-time total views (usage.totalViewCount).", "usage.totalViewCount"),
    nullCol(C.time("last_viewed_at", "Always NULL: the Tableau REST API does not expose last-viewed times.", "x")),
    C.str("url", "Web URL of the view.", (r) => r.__url ?? null),
  ],
  phases: viewPhases,
  expand: viewEnrich,
  sortFields: VIEW_SORT,
  primaryKey: "content_id",
  foreignKeys: [{ column: "workbook_id", table: "workbooks" }],
  pushdown: VIEW_PUSHDOWN,
  examples: [
    {
      sql: `SELECT workbook_name, sum(view_count) AS views FROM ${Q}.content_usage GROUP BY workbook_name ORDER BY views DESC`,
      description: "Total views per workbook",
    },
    {
      sql: `SELECT title, sheet_type, folder_path FROM ${Q}.content_usage WHERE view_count = 0 ORDER BY folder_path, title`,
      description: "Views that have never been opened",
    },
  ],
});

// --------------------------------------------------------------------- workbooks

const WORKBOOK_FIELDS: Record<string, FieldMap> = {
  name: { field: "name", kind: "string", in: true },
  project_name: { field: "projectName", kind: "string", in: true },
  content_url: { field: "contentUrl", kind: "string" },
  created_at: { field: "createdAt", kind: "time" },
  updated_at: { field: "updatedAt", kind: "time" },
};

export const workbooksTable = defineTableauTable({
  name: "workbooks",
  description: "Tableau workbooks on the site with project, owner and size",
  title: "Tableau Workbooks",
  category: "content",
  keywords: "tableau, workbooks, twb, twbx, published content, projects",
  docLlm:
    "Tableau workbooks (GET /sites/{site}/workbooks): id, name, description, folder_path (project path), " +
    "project_id/name, owner (username) and owner_id, content_url, url (webpageUrl), show_tabs, size_mb, " +
    "encrypt_extracts, default_view_id, created_at, updated_at, tags. Views (sheets) of a workbook are in " +
    "dashboards / charts (join on workbook_id); its connections in connections (content_type = 'workbook').",
  docMd: "## workbooks\n\nPublished Tableau workbooks, one row each.",
  columns: [
    C.str("id", "Workbook LUID.", "id", false),
    C.str("name", "Workbook name.", "name"),
    C.str("description", "Workbook description.", "description"),
    C.str("folder_path", "Slash-separated project path holding the workbook.", "__folder_path"),
    C.str("project_id", "Project LUID.", "project.id"),
    C.str("project_name", "Name of the project (folder) holding the item, without its parents.", "__project_name"),
    C.str("owner", "Owner's username.", "__owner"),
    C.str("owner_id", "Owner's user LUID.", "owner.id"),
    C.str("content_url", "The workbook's content URL name.", "contentUrl"),
    C.str("url", "Web URL of the workbook (webpageUrl).", "webpageUrl"),
    C.bool("show_tabs", "Whether the workbook shows sheet tabs.", "showTabs"),
    C.big("size_mb", "Workbook size in megabytes as reported by Tableau.", "size"),
    C.bool("encrypt_extracts", "Whether the workbook's extracts are encrypted.", "encryptExtracts"),
    C.str("default_view_id", "LUID of the workbook's default view.", "defaultViewId"),
    C.time("created_at", "When the workbook was created.", "createdAt"),
    C.time("updated_at", "When the workbook was last published.", "updatedAt"),
    C.strList("tags", "Tag labels.", tagLabels),
  ],
  phases: (scan) => [
    {
      kind: "rest",
      path: "~/workbooks",
      query: listQuery(scan, WORKBOOK_FIELDS),
      rows: (b) => arr(b, "workbooks", "workbook"),
    },
  ],
  expand: (cfg, rows, need) => enrich(cfg, rows, need, { project: "project.id", owner: "owner.id" }),
  foreignKeys: [
    { column: "project_id", table: "folders" },
    { column: "owner_id", table: "users" },
  ],
  sortFields: { name: "name", created_at: "createdAt", updated_at: "updatedAt", size_mb: "size" },
  pushdown:
    "`name`, `project_name` (`=`, `IN`), `content_url` (`=`), `created_at`/`updated_at` ranges → REST `filter`.",
  examples: [
    {
      sql: `SELECT name, folder_path, updated_at FROM ${Q}.workbooks WHERE updated_at < TIMESTAMPTZ '2026-01-01' ORDER BY updated_at`,
      description: "Workbooks not republished since 2026 (the date bound is pushed to Tableau)",
    },
    {
      sql: `SELECT owner, count(*) AS workbooks, sum(size_mb) AS total_mb FROM ${Q}.workbooks GROUP BY owner ORDER BY total_mb DESC`,
      description: "Workbook count and size per owner",
    },
  ],
});

// ------------------------------------------------------------------ data sources

const DATASOURCE_FIELDS: Record<string, FieldMap> = {
  title: { field: "name", kind: "string", in: true },
  datasource_type: { field: "type", kind: "string" },
  project_name: { field: "projectName", kind: "string", in: true },
  is_certified: { field: "isCertified", kind: "bool" },
  has_extracts: { field: "hasExtracts", kind: "bool" },
  created_at: { field: "createdAt", kind: "time" },
  updated_at: { field: "updatedAt", kind: "time" },
};

export const dataSources = defineTableauTable({
  name: "data_sources",
  description: "Published Tableau data sources, with certification and extract flags",
  title: "Tableau Published Data Sources",
  category: "data",
  keywords: "tableau, data sources, published datasources, certified, extracts, hyper, semantic layer",
  docLlm:
    "Published Tableau data sources (GET /sites/{site}/datasources) in the shared BI vocabulary (tool, id, title, " +
    "folder_path, owner, created_at, updated_at, last_viewed_at NULL, view_count NULL, url) plus " +
    "datasource_type (connection class, e.g. snowflake, sqlserver, hyper), description, content_url, " +
    "is_certified, certification_note, has_extracts, encrypt_extracts, use_remote_query_agent (Tableau Bridge), " +
    "project_id/name, owner_id, tags. Connection details are in connections; upstream tables in lineage_tables.",
  docMd: "## data_sources\n\nPublished data sources, one row each.",
  columns: [
    ...commonColumns({ kind: "data source", title: "name", url: () => null }),
    C.str("datasource_type", "Connection class of the data source (e.g. snowflake, sqlserver, hyper).", "type"),
    C.str("description", "Owner-written description of the data source.", "description"),
    C.str("content_url", "Content URL name.", "contentUrl"),
    C.bool("is_certified", "Whether the data source is certified.", "isCertified"),
    C.str(
      "certification_note",
      "Free-text note the certifier left explaining why the source is trusted.",
      "certificationNote",
    ),
    C.bool("has_extracts", "Whether the data source has an extract.", "hasExtracts"),
    C.bool("encrypt_extracts", "Whether its extracts are encrypted.", "encryptExtracts"),
    C.bool("use_remote_query_agent", "Whether it connects through Tableau Bridge.", "useRemoteQueryAgent"),
    C.str("project_id", "Project LUID.", "project.id"),
    C.str("project_name", "Name of the project (folder) holding the item, without its parents.", "__project_name"),
    C.str("owner_id", "Owner's user LUID.", "owner.id"),
    C.strList("tags", "Tag labels.", tagLabels),
  ],
  phases: (scan) => [
    {
      kind: "rest",
      path: "~/datasources",
      query: listQuery(scan, DATASOURCE_FIELDS),
      rows: (b) =>
        arr(b, "datasources", "datasource").map((r) => ({ ...r, __url: asStr(r.webpageUrl) ?? null }) as Row),
    },
  ],
  expand: (cfg, rows, need) => enrich(cfg, rows, need, { project: "project.id", owner: "owner.id" }),
  foreignKeys: [
    { column: "project_id", table: "folders" },
    { column: "owner_id", table: "users" },
  ],
  sortFields: { title: "name", created_at: "createdAt", updated_at: "updatedAt" },
  pushdown:
    "`title`, `project_name` (`=`, `IN`), `datasource_type`, `is_certified`, `has_extracts` (`=`), " +
    "`created_at`/`updated_at` ranges → REST `filter`.",
  examples: [
    {
      sql: `SELECT title, datasource_type, folder_path FROM ${Q}.data_sources WHERE is_certified ORDER BY title`,
      description: "Certified data sources (pushed down as isCertified:eq:true)",
    },
    {
      sql: `SELECT datasource_type, count(*) AS sources, count(*) FILTER (WHERE has_extracts) AS extracts FROM ${Q}.data_sources GROUP BY datasource_type ORDER BY sources DESC`,
      description: "Data sources and extracts per connection type",
    },
  ],
});

// ------------------------------------------------------------------- connections

/** Fan-out refs are `kind\tid` where kind is datasources | workbooks. */
const KIND_OF: Record<string, string> = { datasources: "datasource", workbooks: "workbook" };

function contentChild(sub: string, rows: (b: unknown) => Row[]) {
  return (ref: string): RestPhase => {
    const [kind, id] = ref.split("\t") as [string, string];
    return {
      kind: "rest",
      path: `~/${kind}/${encodeURIComponent(id)}/${sub}`,
      rows,
      notFoundEmpty: true,
      ctx: { content_type: KIND_OF[kind] ?? kind, content_id: id },
    };
  };
}

/** Which content kinds a pushed `content_type = / IN` allows. */
function contentKinds(cs: Constraint[]): string[] {
  const allowed = eqValues(cs, "content_type");
  return ["datasources", "workbooks"].filter((k) => !allowed || allowed.includes(KIND_OF[k] as string));
}

const contentParents = (scan: ScanContext): RestPhase[] =>
  contentKinds(scan.constraints).map((k) => ({
    kind: "rest",
    path: `~/${k}`,
    rows: (b) => arr(b, k, k.slice(0, -1)).map((r) => ({ ...r, __kind: k }) as Row),
  }));

async function contentNames(cfg: TableauConfig, rows: Row[], need: Set<string>): Promise<Row[]> {
  if (!need.has("content_name")) return rows;
  const [wb, ds] = await Promise.all([L.workbooks(cfg), L.datasources(cfg)]);
  for (const r of rows) {
    const id = r.__ctx?.content_id ?? "";
    r.__content_name = (r.__ctx?.content_type === "workbook" ? wb : ds).get(id)?.name ?? null;
  }
  return rows;
}

export const connections = defineTableauTable({
  name: "connections",
  description: "Database connections of published data sources and workbooks (never passwords)",
  title: "Tableau Connections",
  category: "data",
  keywords: "tableau, connections, database connections, server address, data source connections, credentials audit",
  docLlm:
    "Database connections (GET /sites/{site}/datasources/{id}/connections and /workbooks/{id}/connections): tool, " +
    "id, content_type ('datasource' or 'workbook'), content_id, content_name, connection_type (e.g. snowflake, " +
    "postgres, sqlproxy for a published data source), server_address, server_port, username (the database user " +
    "name only), embed_password (whether a password is embedded — the password itself is never returned), " +
    "query_tagging_enabled, datasource_id/datasource_name (the data source the connection belongs to). Filter " +
    "`content_id = '…'` (or IN) to read just those items; otherwise every data source and workbook is read, one " +
    "call each. `content_type = 'datasource'` skips workbooks.",
  docMd:
    "## connections\n\nConnection type, server, port and database user of each data source and workbook. " +
    "Passwords and embedded credentials are never returned.",
  columns: [
    TOOL,
    C.str("id", "Connection LUID.", "id", false),
    C.ctx("content_type", "'datasource' or 'workbook'.", "content_type"),
    C.ctx("content_id", "LUID of the data source or workbook.", "content_id"),
    C.str("content_name", "Name of the data source or workbook.", "__content_name"),
    C.str("connection_type", "Connection class, e.g. snowflake, postgres, sqlproxy.", "type"),
    C.str("server_address", "Database server host name.", "serverAddress"),
    C.str("server_port", "Database server port.", "serverPort"),
    C.str("username", "Database user name the connection signs in as (no password).", "userName"),
    C.bool("embed_password", "Whether a password is embedded (the password itself is never exposed).", "embedPassword"),
    C.bool("query_tagging_enabled", "Whether query tagging is enabled.", "queryTaggingEnabled"),
    C.str("datasource_id", "LUID of the data source the connection belongs to.", "datasource.id"),
    C.str("datasource_name", "Name of the data source the connection belongs to.", "datasource.name"),
  ],
  fanout: {
    key: "content_id",
    parents: contentParents,
    parentRef: (r) => (r.id ? `${r.__kind}\t${r.id}` : null),
    child: contentChild("connections", (b) => arr(b, "connections", "connection")),
    fromKeys: (ids, scan) =>
      ids.flatMap((id) =>
        contentKinds(scan.constraints).map((k) =>
          contentChild("connections", (b) => arr(b, "connections", "connection"))(`${k}\t${id}`),
        ),
      ),
  },
  expand: contentNames,
  pushdown:
    "`content_id` (`=`, `IN`) reads only those items; `content_type` (`=`, `IN`) skips the other kind's listing.",
  examples: [
    {
      sql: `SELECT connection_type, server_address, count(*) AS connections FROM ${Q}.connections GROUP BY ALL ORDER BY connections DESC`,
      description: "Which database servers Tableau content connects to",
    },
    {
      sql: `SELECT content_name, username FROM ${Q}.connections WHERE content_type = 'datasource' AND embed_password ORDER BY content_name`,
      description: "Data sources with an embedded database password",
    },
  ],
});

// ---------------------------------------------------------------- folders/projects

const PROJECT_FIELDS: Record<string, FieldMap> = {
  title: { field: "name", kind: "string", in: true },
  parent_id: { field: "parentProjectId", kind: "string" },
  top_level: { field: "topLevelProject", kind: "bool" },
  created_at: { field: "createdAt", kind: "time" },
  updated_at: { field: "updatedAt", kind: "time" },
};

export const folders = defineTableauTable({
  name: "folders",
  description: "Tableau projects (folders) with their full path",
  title: "Tableau Projects",
  category: "content",
  keywords: "tableau, projects, folders, nested projects, hierarchy, permissions",
  docLlm:
    "Tableau projects — the BI vocabulary's folders — (GET /sites/{site}/projects): tool, id, title, folder_path " +
    "(the project's own full path, e.g. 'Finance/Quarterly', so it equals the folder_path of content inside it), " +
    "owner, created_at, updated_at, last_viewed_at / view_count (always NULL), url (NULL), description, " +
    "parent_id, parent_path, top_level, depth, content_permissions (ManagedByOwner / LockedToProject / " +
    "LockedToProjectWithoutNested), controlling_permissions_project_id.",
  docMd: "## folders\n\nTableau projects with their full slash-separated path.",
  columns: [
    ...commonColumns({
      kind: "project",
      title: "name",
      url: () => null,
      folderDoc: "The project's own full path, e.g. 'Finance/Quarterly' (equals folder_path of content inside it).",
    }).map((c) => (c.name === "url" ? nullCol({ ...c, doc: "Always NULL for projects." }) : c)),
    C.str("description", "Project description.", "description"),
    C.str("parent_id", "LUID of the parent project; NULL for a top-level project.", "parentProjectId"),
    C.str("parent_path", "Full path of the parent project; NULL for a top-level project.", (r) =>
      r.__folder_path && r.parentProjectId ? String(r.__folder_path).split("/").slice(0, -1).join("/") : null,
    ),
    C.bool("top_level", "True for a top-level project.", (r) => !r.parentProjectId),
    C.int("depth", "Count of nesting levels above the project: 0 for a top-level project.", (r) =>
      r.__folder_path ? String(r.__folder_path).split("/").length - 1 : null,
    ),
    C.str(
      "content_permissions",
      "ManagedByOwner, LockedToProject or LockedToProjectWithoutNested.",
      "contentPermissions",
    ),
    C.str(
      "controlling_permissions_project_id",
      "LUID of the project whose permissions govern this one.",
      "controllingPermissionsProjectId",
    ),
    C.str("owner_id", "Owner's user LUID.", "owner.id"),
  ],
  phases: (scan) => [
    {
      kind: "rest",
      path: "~/projects",
      query: listQuery(scan, PROJECT_FIELDS),
      rows: (b) => arr(b, "projects", "project"),
    },
  ],
  expand: async (cfg, rows, need) => {
    const needPath = need.has("folder_path") || need.has("parent_path") || need.has("depth");
    await enrich(cfg, rows, needPath ? new Set([...need, "folder_path"]) : need, { project: "id", owner: "owner.id" });
    return rows;
  },
  sortFields: { title: "name", created_at: "createdAt", updated_at: "updatedAt" },
  foreignKeys: [
    { column: "owner_id", table: "users" },
    { column: "parent_id", table: "folders" },
  ],
  pushdown: "`title` (`=`, `IN`), `parent_id`, `top_level` (`=`), `created_at`/`updated_at` ranges → REST `filter`.",
  examples: [
    {
      sql: `SELECT folder_path, owner FROM ${Q}.folders ORDER BY folder_path`,
      description: "The project tree",
    },
    {
      sql: `SELECT f.folder_path, count(d.id) AS dashboards FROM ${Q}.folders f LEFT JOIN ${Q}.dashboards d USING (folder_path) GROUP BY f.folder_path ORDER BY dashboards DESC`,
      description: "Dashboards per folder, including empty folders",
    },
  ],
});

// ------------------------------------------------------------------------- users

const USER_FIELDS: Record<string, FieldMap> = {
  name: { field: "name", kind: "string", in: true },
  site_role: { field: "siteRole", kind: "string", in: true },
  last_login: { field: "lastLogin", kind: "time" },
};

export const usersTable = defineTableauTable({
  name: "users",
  description: "Users of the Tableau site with their site role and last sign-in",
  title: "Tableau Users",
  category: "people",
  keywords: "tableau, users, site role, licenses, creator, explorer, viewer, last login, inactive users",
  docLlm:
    "Users of the Tableau site (GET /sites/{site}/users?fields=_all_): tool, id, name (username; an email on " +
    "Tableau Cloud), full_name, email, site_role (Creator, Explorer, ExplorerCanPublish, SiteAdministratorCreator, " +
    "SiteAdministratorExplorer, Viewer, Unlicensed …), last_login, auth_setting, external_auth_user_id, " +
    "domain_name, locale, language. Use for license audits and inactive-user reviews.",
  docMd: "## users\n\nSite users, their site role (license) and last sign-in.",
  columns: [
    TOOL,
    C.str("id", "User LUID.", "id", false),
    C.str("name", "Username (an email address on Tableau Cloud).", "name"),
    C.str("full_name", "Display name.", "fullName"),
    C.str("email", "Email address.", "email"),
    C.str("site_role", "Site role (license level), e.g. Creator, Explorer, Viewer, Unlicensed.", "siteRole"),
    C.time("last_login", "Last sign-in; NULL if the user never signed in.", "lastLogin"),
    C.str("auth_setting", "Authentication type (ServerDefault, SAML, OpenID, TableauIDWithMFA …).", "authSetting"),
    C.str("external_auth_user_id", "External identity provider user id.", "externalAuthUserId"),
    C.str("domain_name", "Directory domain ('local' for local users).", "domain.name"),
    C.str("locale", "The user's display locale, e.g. en_US.", "locale"),
    C.str("language", "The user's interface language code, e.g. en.", "language"),
  ],
  phases: (scan) => [
    {
      kind: "rest",
      path: "~/users",
      query: listQuery(scan, USER_FIELDS, [], { fields: "_all_" }),
      rows: (b) => arr(b, "users", "user"),
    },
  ],
  sortFields: { name: "name", last_login: "lastLogin", site_role: "siteRole" },
  pushdown: "`name`, `site_role` (`=`, `IN`), `last_login` ranges → REST `filter`.",
  examples: [
    {
      sql: `SELECT site_role, count(*) AS users FROM ${Q}.users GROUP BY site_role ORDER BY users DESC`,
      description: "Licenses by site role",
    },
    {
      sql: `SELECT name, site_role, last_login FROM ${Q}.users WHERE site_role = 'Creator' ORDER BY last_login NULLS FIRST`,
      description: "Creators ordered by how long since they last signed in",
    },
  ],
});

// ------------------------------------------------------------------ groups

const GROUP_FIELDS: Record<string, FieldMap> = {
  name: { field: "name", kind: "string", in: true },
  domain_name: { field: "domainName", kind: "string" },
  minimum_site_role: { field: "minimumSiteRole", kind: "string" },
};

export const groupsTable = defineTableauTable({
  name: "groups",
  description: "Tableau groups (local and directory-synced)",
  title: "Tableau Groups",
  category: "people",
  keywords: "tableau, groups, active directory, grant license on sign in, permissions",
  docLlm:
    "Tableau groups (GET /sites/{site}/groups): id, name, domain_name ('local' for local groups), " +
    "minimum_site_role (grant-license-on-sign-in role, if any), grant_license_mode. Members are in group_members.",
  docMd: "## groups\n\nSite groups, one row each.",
  columns: [
    C.str("id", "Group LUID.", "id", false),
    C.str("name", "Group name.", "name"),
    C.str("domain_name", "Directory domain ('local' for local groups).", "domain.name"),
    C.str("minimum_site_role", "Site role granted on sign-in, if configured.", "import.siteRole"),
    C.str("grant_license_mode", "onSync / onLogin when a license is granted automatically.", "import.grantLicenseMode"),
  ],
  phases: (scan) => [
    { kind: "rest", path: "~/groups", query: listQuery(scan, GROUP_FIELDS), rows: (b) => arr(b, "groups", "group") },
  ],
  sortFields: { name: "name" },
  pushdown: "`name` (`=`, `IN`), `domain_name`, `minimum_site_role` (`=`) → REST `filter`.",
  examples: [
    { sql: `SELECT name, domain_name FROM ${Q}.groups ORDER BY name`, description: "All groups" },
    {
      sql: `SELECT domain_name, count(*) AS groups FROM ${Q}.groups GROUP BY domain_name ORDER BY groups DESC`,
      description: "Local versus directory groups",
    },
  ],
});

export const groupMembers = defineTableauTable({
  name: "group_members",
  description: "Members of each Tableau group, one row per group and user",
  title: "Tableau Group Members",
  category: "people",
  keywords: "tableau, group members, membership, users in group",
  docLlm:
    "Group membership (GET /sites/{site}/groups/{id}/users): group_id, group_name, user_id, user_name, site_role. " +
    "Filter `group_id = '…'` (or IN) to read just those groups; otherwise every group is read, one call each.",
  docMd: "## group_members\n\nOne row per (group, user).",
  columns: [
    C.ctx("group_id", "Group LUID.", "group_id"),
    C.str("group_name", "Display name of the group, e.g. 'All Users'.", "__group_name"),
    C.str("user_id", "User LUID.", "id", false),
    C.str("user_name", "The member's username (an email address on Tableau Cloud).", "name"),
    C.str("site_role", "The member's site role.", "siteRole"),
  ],
  fanout: {
    key: "group_id",
    parents: () => [{ kind: "rest", path: "~/groups", rows: (b) => arr(b, "groups", "group") }],
    parentRef: (r) => (r.id ? String(r.id) : null),
    child: (id) => groupUsers(id),
    fromKeys: (ids) => ids.map(groupUsers),
  },
  expand: async (cfg, rows, need) => {
    if (!need.has("group_name")) return rows;
    const g = await L.groups(cfg);
    for (const r of rows) r.__group_name = g.get(r.__ctx?.group_id ?? "")?.name ?? null;
    return rows;
  },
  primaryKey: ["group_id", "user_id"],
  foreignKeys: [
    { column: "group_id", table: "groups" },
    { column: "user_id", table: "users" },
  ],
  pushdown: "`group_id` (`=`, `IN`) reads only those groups.",
  examples: [
    {
      sql: `SELECT group_name, count(*) AS members FROM ${Q}.group_members GROUP BY group_name ORDER BY members DESC`,
      description: "Group sizes",
    },
    {
      sql: `SELECT m.user_name FROM ${Q}.group_members m JOIN ${Q}.groups g ON g.id = m.group_id WHERE g.name = 'Finance' ORDER BY 1`,
      description: "Members of the Finance group",
    },
  ],
});

function groupUsers(id: string): RestPhase {
  return {
    kind: "rest",
    path: `~/groups/${encodeURIComponent(id)}/users`,
    rows: (b) => arr(b, "users", "user"),
    notFoundEmpty: true,
    ctx: { group_id: id },
  };
}

// ---------------------------------------------------------------------- favorites

const FAVORITE_KINDS = ["view", "workbook", "datasource", "project", "flow", "metric", "collection"];

export const favorites = defineTableauTable({
  name: "favorites",
  description: "Each Tableau user's favorited views, workbooks, data sources and projects",
  title: "Tableau Favorites",
  category: "usage",
  keywords: "tableau, favorites, starred content, bookmarks, popularity",
  docLlm:
    "Favorites (GET /sites/{site}/favorites/{user-id}): user_id, label, content_type (view, workbook, datasource, " +
    "project, flow …), content_id, content_name, position, added_at. Filter `user_id = '…'` (or IN) to read just " +
    "those users; otherwise every user is read, one call each. Count favorites per content_id for a popularity signal.",
  docMd: "## favorites\n\nOne row per (user, favorite).",
  columns: [
    C.ctx("user_id", "LUID of the user who favorited the item.", "user_id"),
    C.str("label", "The favorite's label.", "label"),
    C.str("content_type", "view, workbook, datasource, project, flow, metric or collection.", (r) =>
      FAVORITE_KINDS.find((k) => r[k]),
    ),
    C.str("content_id", "LUID of the favorited item.", (r) => FAVORITE_KINDS.map((k) => r[k]?.id).find(Boolean)),
    C.str("content_name", "Name of the favorited item.", (r) => FAVORITE_KINDS.map((k) => r[k]?.name).find(Boolean)),
    C.int("position", "Position in the user's favorites list.", "position"),
    C.time("added_at", "When the favorite was added.", "addedAt"),
  ],
  fanout: {
    key: "user_id",
    parents: () => [{ kind: "rest", path: "~/users", rows: (b) => arr(b, "users", "user") }],
    parentRef: (r) => (r.id ? String(r.id) : null),
    child: (id) => userFavorites(id),
    fromKeys: (ids) => ids.map(userFavorites),
  },
  keep: (r) => FAVORITE_KINDS.some((k) => r[k]?.id),
  primaryKey: ["user_id", "content_id"],
  foreignKeys: [{ column: "user_id", table: "users" }],
  pushdown: "`user_id` (`=`, `IN`) reads only those users.",
  examples: [
    {
      sql: `SELECT content_name, count(*) AS favorited_by FROM ${Q}.favorites WHERE content_type = 'view' GROUP BY content_name ORDER BY favorited_by DESC`,
      description: "Most favorited views",
    },
    {
      sql: `SELECT u.name, count(f.content_id) AS favorites FROM ${Q}.users u LEFT JOIN ${Q}.favorites f ON f.user_id = u.id GROUP BY u.name ORDER BY favorites DESC`,
      description: "Favorites per user",
    },
  ],
});

function userFavorites(id: string): RestPhase {
  return {
    kind: "rest",
    path: `~/favorites/${encodeURIComponent(id)}`,
    rows: (b) => arr(b, "favorites", "favorite"),
    notFoundEmpty: true,
    ctx: { user_id: id },
  };
}

// --------------------------------------------------------- subscriptions & alerts

export const subscriptions = defineTableauTable({
  name: "subscriptions",
  description: "Tableau email subscriptions (recipient shown masked)",
  title: "Tableau Subscriptions",
  category: "usage",
  keywords: "tableau, subscriptions, email subscriptions, scheduled delivery, pdf, image",
  docLlm:
    "Subscriptions (GET /sites/{site}/subscriptions): id, subject, content_type (View / Workbook), content_id, " +
    "send_if_view_empty, schedule_id, schedule_frequency, schedule_next_run_at, user_id (the recipient's LUID), " +
    "user_masked (the recipient's username masked, e.g. a***@example.com — join users on user_id if you are " +
    "allowed to see it), attach_image, attach_pdf, page_orientation, page_size_option, suspended.",
  docMd: "## subscriptions\n\nEmail subscriptions; the recipient's name is masked.",
  columns: [
    C.str("id", "Subscription LUID.", "id", false),
    C.str("subject", "Email subject.", "subject"),
    C.str("content_type", "View or Workbook.", "content.type"),
    C.str("content_id", "LUID of the subscribed view or workbook.", "content.id"),
    C.bool("send_if_view_empty", "Whether an email is sent when the view is empty.", "content.sendIfViewEmpty"),
    C.str("schedule_id", "Schedule LUID (Tableau Server).", "schedule.id"),
    C.str(
      "schedule_frequency",
      "Hourly / Daily / Weekly / Monthly.",
      (r) => at(r, "schedule.frequency") ?? at(r, "frequency"),
    ),
    C.time("schedule_next_run_at", "Next delivery time, when reported.", "schedule.nextRunAt"),
    C.str("user_id", "LUID of the recipient.", "user.id"),
    C.str("user_masked", "Recipient's username, masked (first character + domain).", (r) =>
      maskName(at(r, "user.name")),
    ),
    C.bool("attach_image", "Whether an image is attached.", "attachImage"),
    C.bool("attach_pdf", "Whether a PDF is attached.", "attachPdf"),
    C.str("page_orientation", "PDF page orientation.", "pageOrientation"),
    C.str("page_size_option", "PDF page size.", "pageSizeOption"),
    C.bool("suspended", "Whether the subscription is suspended.", "suspended"),
  ],
  foreignKeys: [{ column: "user_id", table: "users" }],
  phases: () => [{ kind: "rest", path: "~/subscriptions", rows: (b) => arr(b, "subscriptions", "subscription") }],
  examples: [
    {
      sql: `SELECT content_type, count(*) AS subscriptions, count(*) FILTER (WHERE suspended) AS suspended FROM ${Q}.subscriptions GROUP BY content_type ORDER BY content_type`,
      description: "Subscriptions by content type, with suspended counts",
    },
    {
      sql: `SELECT d.title, count(*) AS subscribers FROM ${Q}.subscriptions s JOIN ${Q}.dashboards d ON d.id = s.content_id GROUP BY d.title ORDER BY subscribers DESC`,
      description: "Dashboards with the most subscribers",
    },
  ],
});

export const dataAlerts = defineTableauTable({
  name: "data_alerts",
  description: "Tableau data-driven alerts with recipient counts (no recipient identities)",
  title: "Tableau Data-Driven Alerts",
  category: "usage",
  keywords: "tableau, data driven alerts, alerts, thresholds, notifications",
  docLlm:
    "Data-driven alerts (GET /sites/{site}/dataAlerts, and /dataAlerts/{id} for recipients): id, subject, " +
    "frequency (once / frequently / hourly / daily / weekly), public, owner_id, owner_masked, view_id, view_name, " +
    "workbook_id, workbook_name, created_at, updated_at, recipient_count (one extra call per alert, only when " +
    "the column is selected). Recipient identities are never returned.",
  docMd: "## data_alerts\n\nData-driven alerts and how many people receive each.",
  columns: [
    C.str("id", "Alert LUID.", "id", false),
    C.str("subject", "Alert subject.", "subject"),
    C.str("frequency", "once, frequently, hourly, daily or weekly.", "frequency"),
    C.bool("public", "Whether others can add themselves to the alert.", "public"),
    C.str("owner_id", "Owner's user LUID.", "owner.id"),
    C.str("owner_masked", "Owner's username, masked.", (r) => maskName(at(r, "owner.name"))),
    C.str("view_id", "LUID of the view the alert watches.", "view.id"),
    C.str("view_name", "Name of the view.", "view.name"),
    C.str("workbook_id", "LUID of the view's workbook.", "view.workbook.id"),
    C.str("workbook_name", "Name of the view's workbook.", "view.workbook.name"),
    C.time("created_at", "When the alert was created.", "createdAt"),
    C.time("updated_at", "When the alert was last updated.", "updatedAt"),
    C.int("recipient_count", "Number of recipients (identities are not exposed).", "__recipients"),
  ],
  foreignKeys: [
    { column: "owner_id", table: "users" },
    { column: "workbook_id", table: "workbooks" },
  ],
  phases: () => [{ kind: "rest", path: "~/dataAlerts", rows: (b) => arr(b, "dataAlerts", "dataAlert") }],
  expand: async (cfg, rows, need) => {
    if (!need.has("recipient_count")) return rows;
    for (const r of rows) {
      const body = await restGet(cfg, `~/dataAlerts/${encodeURIComponent(String(r.id))}`);
      r.__recipients = arr((body as Row)?.dataAlert, "recipients", "recipient").length;
    }
    return rows;
  },
  examples: [
    {
      sql: `SELECT view_name, subject, recipient_count FROM ${Q}.data_alerts ORDER BY recipient_count DESC`,
      description: "Alerts with the widest audience",
    },
    {
      sql: `SELECT frequency, count(*) AS alerts FROM ${Q}.data_alerts GROUP BY frequency ORDER BY alerts DESC`,
      description: "Alerts by check frequency",
    },
  ],
});

// ------------------------------------------------- schedules, tasks, jobs, flows

export const schedules = defineTableauTable({
  name: "schedules",
  description: "Server schedules for extracts, subscriptions and flows (Tableau Server)",
  title: "Tableau Server Schedules",
  category: "operations",
  keywords: "tableau, schedules, extract schedules, subscription schedules, flow schedules, server",
  docLlm:
    "Tableau Server schedules (GET /api/{v}/schedules): id, name, state (Active / Suspended), priority, " +
    "schedule_type (Extract / Subscription / Flow / DataAcceleration), frequency, execution_order (Parallel / " +
    "Serial), next_run_at, created_at, updated_at, frequency_details (JSON). Tableau Cloud has no server " +
    "schedules (its schedules live on each task, see extract_refresh_tasks); there this table is empty.",
  docMd: "## schedules\n\nServer-wide schedules (Tableau Server only; empty on Tableau Cloud).",
  columns: [
    C.str("id", "Schedule LUID.", "id", false),
    C.str("name", "Schedule name.", "name"),
    C.str("state", "Active or Suspended.", "state"),
    C.int("priority", "Priority (1 highest – 100).", "priority"),
    C.str("schedule_type", "Extract, Subscription, Flow or DataAcceleration.", "type"),
    C.str("frequency", "Hourly, Daily, Weekly or Monthly.", "frequency"),
    C.str("execution_order", "Parallel or Serial.", "executionOrder"),
    C.time("next_run_at", "Next run time.", "nextRunAt"),
    C.time("created_at", "When the schedule was created.", "createdAt"),
    C.time("updated_at", "When the schedule was last changed.", "updatedAt"),
    C.json("frequency_details", "Start/end times and intervals as JSON.", "frequencyDetails"),
  ],
  phases: () => [
    { kind: "rest", path: "/schedules", rows: (b) => arr(b, "schedules", "schedule"), notFoundEmpty: true },
  ],
  examples: [
    {
      sql: `SELECT name, schedule_type, frequency, next_run_at FROM ${Q}.schedules WHERE state = 'Active' ORDER BY next_run_at`,
      description: "Active schedules by next run",
    },
    {
      sql: `SELECT schedule_type, count(*) AS schedules FROM ${Q}.schedules GROUP BY schedule_type ORDER BY schedules DESC`,
      description: "Schedules per type",
    },
  ],
});

const taskOf = (t: Row): Row => (t.extractRefresh ?? t) as Row;

export const extractRefreshTasks = defineTableauTable({
  name: "extract_refresh_tasks",
  description: "Scheduled extract refresh tasks for data sources and workbooks",
  title: "Tableau Extract Refresh Tasks",
  category: "operations",
  keywords: "tableau, extract refresh, tasks, schedules, hyper extracts, failures",
  docLlm:
    "Extract refresh tasks (GET /sites/{site}/tasks/extractRefreshes): id, refresh_type (FullRefresh / " +
    "IncrementalRefresh), priority, consecutive_failed_count, content_type (datasource / workbook), content_id, " +
    "schedule_id, schedule_frequency, schedule_next_run_at, schedule_state, frequency_details (JSON). Join " +
    "content_id to data_sources.id or workbooks.id. Actual runs are in jobs and unified.runs.",
  docMd: "## extract_refresh_tasks\n\nScheduled extract refreshes and their failure streaks.",
  columns: [
    C.str("id", "Task LUID.", "id", false),
    C.str("refresh_type", "FullRefresh or IncrementalRefresh.", "type"),
    C.int("priority", "Task priority from 1 (highest) to 100 (lowest).", "priority"),
    C.int("consecutive_failed_count", "How many runs in a row have failed.", "consecutiveFailedCount"),
    C.str("content_type", "datasource or workbook.", (r) =>
      r.datasource ? "datasource" : r.workbook ? "workbook" : null,
    ),
    C.str("content_id", "LUID of the data source or workbook refreshed.", (r) => r.datasource?.id ?? r.workbook?.id),
    C.str("schedule_id", "Schedule LUID (Tableau Server).", "schedule.id"),
    C.str("schedule_frequency", "Hourly, Daily, Weekly or Monthly.", "schedule.frequency"),
    C.time("schedule_next_run_at", "Next scheduled run.", "schedule.nextRunAt"),
    C.str("schedule_state", "Active or Suspended (Tableau Server).", "schedule.state"),
    C.json("frequency_details", "Schedule start/end times and intervals as JSON.", "schedule.frequencyDetails"),
  ],
  phases: () => [
    {
      kind: "rest",
      path: "~/tasks/extractRefreshes",
      paged: false,
      rows: (b) => arr(b, "tasks", "task").map(taskOf),
    },
  ],
  examples: [
    {
      sql: `SELECT t.content_type, coalesce(d.title, w.name) AS content, t.consecutive_failed_count FROM ${Q}.extract_refresh_tasks t LEFT JOIN ${Q}.data_sources d ON d.id = t.content_id LEFT JOIN ${Q}.workbooks w ON w.id = t.content_id WHERE t.consecutive_failed_count > 0 ORDER BY t.consecutive_failed_count DESC`,
      description: "Extract refreshes that keep failing",
    },
    {
      sql: `SELECT schedule_frequency, count(*) AS tasks FROM ${Q}.extract_refresh_tasks GROUP BY schedule_frequency ORDER BY tasks DESC`,
      description: "Extract refresh tasks per frequency",
    },
  ],
});

const JOB_FIELDS: Record<string, FieldMap> = {
  job_type: { field: "jobType", kind: "string", in: true },
  status: { field: "status", kind: "string", in: true },
  title: { field: "title", kind: "string" },
  created_at: { field: "createdAt", kind: "time" },
  started_at: { field: "startedAt", kind: "time" },
  ended_at: { field: "endedAt", kind: "time" },
};

const seconds = (a: unknown, b: unknown): number | null => {
  const s = asTime(a);
  const e = asTime(b);
  return s !== null && e !== null ? Number(e - s) / 1e6 : null;
};

export const jobs = defineTableauTable({
  name: "jobs",
  description: "Tableau background jobs (extract refreshes, flow runs, subscriptions …)",
  title: "Tableau Background Jobs",
  category: "operations",
  keywords: "tableau, jobs, background jobs, extract refresh, run history, failures, backgrounder",
  docLlm:
    "Background jobs (GET /sites/{site}/jobs): id, job_type (refresh_extracts, increment_extracts, run_flow, " +
    "single_subscription_notify …), status (Pending, InProgress, Success, Failed, Cancelled), title (content " +
    "name), subtitle (content kind), priority, created_at, started_at, ended_at, duration_seconds. Tableau keeps " +
    "recent job history only. For a cross-orchestrator view use unified.runs.",
  docMd: "## jobs\n\nRecent background jobs and their outcome.",
  columns: [
    C.str("id", "Job LUID.", "id", false),
    C.str("job_type", "Job type, e.g. refresh_extracts, increment_extracts, run_flow.", "jobType"),
    C.str("status", "Pending, InProgress, Success, Failed or Cancelled.", "status"),
    C.str("title", "Name of the content the job ran for.", "title"),
    C.str("subtitle", "Kind of content (e.g. Data Source, Workbook, Flow).", "subtitle"),
    C.int("priority", "Job priority from 1 (highest) to 100 (lowest).", "priority"),
    C.time("created_at", "When the job was queued.", "createdAt"),
    C.time("started_at", "When the job started.", "startedAt"),
    C.time("ended_at", "When the job ended.", "endedAt"),
    C.num("duration_seconds", "ended_at − started_at in seconds.", (r) => seconds(r.startedAt, r.endedAt)),
  ],
  phases: (scan) => [
    {
      kind: "rest",
      path: "~/jobs",
      query: listQuery(scan, JOB_FIELDS),
      rows: (b) => arr(b, "backgroundJobs", "backgroundJob"),
    },
  ],
  pushdown:
    "`job_type`, `status` (`=`, `IN`), `title` (`=`), `created_at`/`started_at`/`ended_at` ranges → REST `filter`.",
  examples: [
    {
      sql: `SELECT title, job_type, ended_at FROM ${Q}.jobs WHERE status = 'Failed' ORDER BY ended_at DESC`,
      description: "Failed jobs, most recent first (status pushed to Tableau)",
    },
    {
      sql: `SELECT job_type, avg(duration_seconds) AS avg_seconds FROM ${Q}.jobs WHERE status = 'Success' GROUP BY job_type ORDER BY avg_seconds DESC`,
      description: "Average successful job duration per type",
    },
  ],
});

const FLOW_FIELDS: Record<string, FieldMap> = {
  name: { field: "name", kind: "string", in: true },
  created_at: { field: "createdAt", kind: "time" },
  updated_at: { field: "updatedAt", kind: "time" },
};

export const flowsTable = defineTableauTable({
  name: "flows",
  description: "Tableau Prep flows published to the site",
  title: "Tableau Prep Flows",
  category: "operations",
  keywords: "tableau, prep, flows, etl, data preparation",
  docLlm:
    "Tableau Prep flows (GET /sites/{site}/flows): id, name, description, folder_path, project_id/name, owner, " +
    "owner_id, file_type, url (webpageUrl), created_at, updated_at, tags. Runs are in flow_runs and unified.runs.",
  docMd: "## flows\n\nPublished Prep flows, one row each.",
  columns: [
    C.str("id", "Flow LUID.", "id", false),
    C.str("name", "Flow name.", "name"),
    C.str("description", "Owner-written description of the flow.", "description"),
    C.str("folder_path", "Slash-separated project path.", "__folder_path"),
    C.str("project_id", "Project LUID.", "project.id"),
    C.str("project_name", "Name of the project (folder) holding the item, without its parents.", "__project_name"),
    C.str("owner", "Owner's username.", "__owner"),
    C.str("owner_id", "Owner's user LUID.", "owner.id"),
    C.str("file_type", "tfl or tflx.", "fileType"),
    C.str("url", "Web URL of the flow.", "webpageUrl"),
    C.time("created_at", "When the flow was created.", "createdAt"),
    C.time("updated_at", "When the flow was last published.", "updatedAt"),
    C.strList("tags", "Tag labels.", tagLabels),
  ],
  phases: (scan) => [
    { kind: "rest", path: "~/flows", query: listQuery(scan, FLOW_FIELDS), rows: (b) => arr(b, "flows", "flow") },
  ],
  expand: (cfg, rows, need) => enrich(cfg, rows, need, { project: "project.id", owner: "owner.id" }),
  foreignKeys: [
    { column: "project_id", table: "folders" },
    { column: "owner_id", table: "users" },
  ],
  sortFields: { name: "name", created_at: "createdAt", updated_at: "updatedAt" },
  pushdown: "`name` (`=`, `IN`), `created_at`/`updated_at` ranges → REST `filter`.",
  examples: [
    { sql: `SELECT name, folder_path, owner FROM ${Q}.flows ORDER BY name`, description: "All Prep flows" },
    {
      sql: `SELECT f.name, count(r.id) AS runs FROM ${Q}.flows f LEFT JOIN ${Q}.flow_runs r ON r.flow_id = f.id GROUP BY f.name ORDER BY runs DESC`,
      description: "Run count per flow",
    },
  ],
});

const FLOW_RUN_FIELDS: Record<string, FieldMap> = {
  flow_id: { field: "flowId", kind: "string" },
  started_at: { field: "startedAt", kind: "time" },
  completed_at: { field: "completedAt", kind: "time" },
};

export const flowRuns = defineTableauTable({
  name: "flow_runs",
  description: "Run history of Tableau Prep flows with status and duration",
  title: "Tableau Prep Flow Runs",
  category: "operations",
  keywords: "tableau, prep, flow runs, run history, etl runs, failures",
  docLlm:
    "Prep flow runs (GET /sites/{site}/flows/runs): id, flow_id, flow_name, status (Success, Failed, InProgress, " +
    "Pending, Cancelled), progress (0-100), started_at, completed_at, duration_seconds, background_job_id.",
  docMd: "## flow_runs\n\nPrep flow run history.",
  columns: [
    C.str("id", "Flow run LUID.", "id", false),
    C.str("flow_id", "LUID of the flow.", "flowId"),
    C.str("flow_name", "Name of the flow.", "__flow_name"),
    C.str("status", "Success, Failed, InProgress, Pending or Cancelled.", "status"),
    C.int("progress", "Percent complete, 0 to 100.", "progress"),
    C.time("started_at", "When the run started.", "startedAt"),
    C.time("completed_at", "When the run completed.", "completedAt"),
    C.num("duration_seconds", "completed_at − started_at in seconds.", (r) => seconds(r.startedAt, r.completedAt)),
    C.str("background_job_id", "LUID of the background job.", "backgroundJobId"),
  ],
  phases: (scan) => [
    {
      kind: "rest",
      path: "~/flows/runs",
      query: listQuery(scan, FLOW_RUN_FIELDS),
      rows: (b) => arr(b, "flowRuns", "flowRuns"),
    },
  ],
  expand: async (cfg, rows, need) => {
    if (!need.has("flow_name")) return rows;
    const f = await L.flows(cfg);
    for (const r of rows) r.__flow_name = f.get(String(r.flowId))?.name ?? null;
    return rows;
  },
  foreignKeys: [{ column: "flow_id", table: "flows" }],
  pushdown: "`flow_id` (`=`), `started_at`/`completed_at` ranges → REST `filter`.",
  examples: [
    {
      sql: `SELECT flow_name, status, started_at FROM ${Q}.flow_runs WHERE status = 'Failed' ORDER BY started_at DESC`,
      description: "Failed flow runs",
    },
    {
      sql: `SELECT flow_name, avg(duration_seconds) AS avg_seconds FROM ${Q}.flow_runs GROUP BY flow_name ORDER BY avg_seconds DESC`,
      description: "Average run time per flow",
    },
  ],
});

// ------------------------------------------------------------------ revisions

export const revisions = defineTableauTable({
  name: "revisions",
  description: "Revision history of workbooks and data sources",
  title: "Tableau Revisions",
  category: "content",
  keywords: "tableau, revisions, version history, publish history, audit",
  docLlm:
    "Revision history (GET /sites/{site}/workbooks/{id}/revisions and /datasources/{id}/revisions): content_type " +
    "(workbook / datasource), content_id, content_name, revision_number, published_at, publisher_id, " +
    "publisher_name, size_bytes, is_current, is_deleted. Needs revision history enabled on the site. Filter " +
    "`content_id = '…'` (or IN) to read just those items; otherwise every workbook and data source is read.",
  docMd: "## revisions\n\nPublish history of workbooks and data sources.",
  columns: [
    C.ctx("content_type", "workbook or datasource.", "content_type"),
    C.ctx("content_id", "LUID of the workbook or data source.", "content_id"),
    C.str("content_name", "Name of the workbook or data source.", "__content_name"),
    C.int("revision_number", "Revision number (1 = first publish).", "revisionNumber"),
    C.time("published_at", "When the revision was published.", "publishedAt"),
    C.str("publisher_id", "LUID of the publishing user.", "publisher.id"),
    C.str("publisher_name", "Username of the publisher.", "publisher.name"),
    C.big("size_bytes", "Size of the revision in bytes.", "sizeInBytes"),
    C.bool("is_current", "Whether this is the current revision.", "current"),
    C.bool("is_deleted", "Whether the revision was deleted.", "deleted"),
  ],
  fanout: {
    key: "content_id",
    parents: contentParents,
    parentRef: (r) => (r.id ? `${r.__kind}\t${r.id}` : null),
    child: contentChild("revisions", (b) => arr(b, "revisions", "revision")),
    fromKeys: (ids, scan) =>
      ids.flatMap((id) =>
        contentKinds(scan.constraints).map((k) =>
          contentChild("revisions", (b) => arr(b, "revisions", "revision"))(`${k}\t${id}`),
        ),
      ),
  },
  expand: contentNames,
  primaryKey: ["content_type", "content_id", "revision_number"],
  pushdown:
    "`content_id` (`=`, `IN`) reads only those items; `content_type` (`=`, `IN`) skips the other kind's listing.",
  examples: [
    {
      sql: `SELECT content_name, max(revision_number) AS revisions FROM ${Q}.revisions GROUP BY content_name ORDER BY revisions DESC`,
      description: "Most frequently republished content",
    },
    {
      sql: `SELECT publisher_name, count(*) AS publishes FROM ${Q}.revisions GROUP BY publisher_name ORDER BY publishes DESC`,
      description: "Publishes per user",
    },
  ],
});

// ------------------------------------------------------------------------ sites

export const sites = defineTableauTable({
  name: "sites",
  description: "The Tableau site the secret signs in to, with its settings",
  title: "Tableau Site",
  category: "content",
  keywords: "tableau, site, settings, quotas, revision history",
  docLlm:
    "The signed-in Tableau site (GET /sites/{site-id}), one row: id, name, content_url, state, admin_mode, " +
    "user_quota, storage_quota, revision_history_enabled, revision_limit, catalog_enabled, settings (every " +
    "site attribute as JSON). One `tableau` secret = one site; create another secret (with a SCOPE) per site.",
  docMd: "## sites\n\nThe site the secret signs in to.",
  columns: [
    C.str("id", "Site LUID.", "id", false),
    C.str("name", "Site name.", "name"),
    C.str("content_url", "Site content URL ('' = Default site).", (r) => r.contentUrl ?? ""),
    C.str("state", "Active or Suspended.", "state"),
    C.str("admin_mode", "ContentAndUsers or ContentOnly.", "adminMode"),
    C.big("user_quota", "Maximum number of users.", "userQuota"),
    C.big("storage_quota", "Storage quota in MB.", "storageQuota"),
    C.bool("revision_history_enabled", "Whether revision history is kept.", "revisionHistoryEnabled"),
    C.int("revision_limit", "Revisions kept per item.", "revisionLimit"),
    C.bool("catalog_enabled", "Whether Tableau Catalog (Metadata API) is enabled.", "catalogEnabled"),
    C.json("settings", "Every site attribute as JSON.", (r) => r),
  ],
  phases: () => [{ kind: "rest", path: "~", paged: false, rows: (b) => [((b as Row)?.site ?? {}) as Row] }],
  examples: [
    { sql: `SELECT name, content_url, state FROM ${Q}.sites`, description: "The signed-in site" },
    {
      sql: `SELECT revision_history_enabled, revision_limit FROM ${Q}.sites`,
      description: "Is revision history on, and how many revisions are kept",
    },
  ],
});

// ------------------------------------------------------- Metadata API: lineage

/** Remove Tableau's `[ ]` quoting from a name. */
const unbracket = (s: unknown): string | null => {
  const v = asStr(s);
  return v ? v.replace(/^\[|\]$/g, "") : null;
};

/** Lower-cased `database.schema.table` (brackets removed, missing parts skipped). */
export function qualified(db: unknown, schemaName: unknown, tableName: unknown): string | null {
  const parts = [unbracket(db), unbracket(schemaName), unbracket(tableName)].filter((x) => x);
  return parts.length ? parts.join(".").toLowerCase() : null;
}

const TABLE_SELECTION = "upstreamTables { id name schema fullName connectionType database { name connectionType } }";

/** Metadata API filter variables for the pushed content constraints. */
function contentFilter(cs: Constraint[], idCol: string, nameCol: string): Record<string, unknown> | null {
  const f: Record<string, unknown> = {};
  const ids = eqValues(cs, idCol);
  const names = eqValues(cs, nameCol);
  if (ids) f.luidWithin = ids;
  if (names) f.nameWithin = names;
  return Object.keys(f).length ? f : null;
}

function connectionQuery(name: string, root: string, filterType: string, selection: string): string {
  return (
    `query ${name}($first: Int, $after: String, $filter: ${filterType}) { ` +
    `${root}(first: $first, after: $after, filter: $filter) { nodes { luid name ${selection} } ` +
    "pageInfo { hasNextPage endCursor } } }"
  );
}

const CONTENT_ROOTS = [
  { type: "workbook", root: "workbooksConnection", filter: "Workbook_Filter" },
  { type: "datasource", root: "publishedDatasourcesConnection", filter: "PublishedDatasource_Filter" },
];

function lineagePhases(scan: ScanContext, name: string, selection: string, rows: (n: Row) => Row[]): GqlPhase[] {
  const kinds = eqValues(scan.constraints, "content_type");
  const filter = contentFilter(scan.constraints, "content_id", "content_name");
  return CONTENT_ROOTS.filter((c) => !kinds || kinds.includes(c.type)).map((c) => ({
    kind: "gql",
    query: connectionQuery(name, c.root, c.filter, selection),
    root: c.root,
    variables: { filter },
    rows: (nodes) => nodes.flatMap(rows),
    ctx: { content_type: c.type },
  }));
}

export const lineageTables = defineTableauTable({
  name: "lineage_tables",
  description: "Upstream database tables of each workbook and published data source (Metadata API)",
  title: "Tableau Table Lineage",
  category: "lineage",
  keywords: "tableau, lineage, upstream tables, catalog, metadata api, dbt, openlineage, impact analysis",
  docLlm:
    "Table-level lineage from the Tableau Metadata API (GraphQL workbooksConnection / " +
    "publishedDatasourcesConnection → upstreamTables): content_type (workbook / datasource), content_id (LUID, " +
    "joins workbooks.id / data_sources.id), content_name, table_id, connection_type, database_name, schema_name, " +
    "table_name, full_name (as Tableau shows it), qualified_name (lower-cased database.schema.table without brackets — join " +
    "it to dbt models or OpenLineage datasets). Needs Tableau Catalog / the Metadata API enabled. Filter " +
    "content_id / content_name (= or IN) and content_type to narrow the GraphQL query.",
  docMd: "## lineage_tables\n\nWhich database tables each workbook and published data source reads.",
  columns: [
    C.ctx("content_type", "workbook or datasource.", "content_type"),
    C.ctx("content_id", "LUID of the workbook or published data source.", "content_id"),
    C.ctx("content_name", "Name of the workbook or data source.", "content_name", true),
    C.str("table_id", "Metadata API id of the table.", "id"),
    C.str(
      "connection_type",
      "Connection class, e.g. snowflake, postgres.",
      (r) => r.connectionType ?? r.database?.connectionType,
    ),
    C.str("database_name", "Database (or catalog) holding the table, as Tableau records it.", "database.name"),
    C.str("schema_name", "Schema of the table, brackets removed.", (r) => unbracket(r.schema)),
    C.str("table_name", "Physical table name, brackets removed.", (r) => unbracket(r.name)),
    C.str("full_name", "The table's full name as Tableau shows it, e.g. [dbo].[Orders].", "fullName"),
    C.str(
      "qualified_name",
      "Lower-cased database.schema.table without brackets, for joins with dbt / OpenLineage.",
      (r) => qualified(r.database?.name, r.schema, r.name),
    ),
  ],
  phases: (scan) =>
    lineagePhases(scan, "lineageTables", TABLE_SELECTION, (n) =>
      ((n.upstreamTables ?? []) as Row[]).map((t) => ({
        ...t,
        __ctx: { content_id: String(n.luid), content_name: String(n.name ?? "") },
      })),
    ),
  primaryKey: ["content_type", "content_id", "table_id"],
  pushdown:
    "`content_id`, `content_name` (`=`, `IN`) → GraphQL `filter: {luidWithin, nameWithin}`; `content_type` " +
    "(`=`, `IN`) skips the other connection.",
  examples: [
    {
      sql: `SELECT qualified_name, count(DISTINCT content_id) AS used_by FROM ${Q}.lineage_tables GROUP BY qualified_name ORDER BY used_by DESC`,
      description: "Most widely used warehouse tables",
    },
    {
      sql: `SELECT content_type, content_name FROM ${Q}.lineage_tables WHERE qualified_name = 'analytics.public.orders' ORDER BY content_name`,
      description: "Impact analysis: what reads analytics.public.orders",
    },
  ],
});

const FIELD_SELECTION =
  "fields { name __typename description ... on CalculatedField { formula } " +
  "upstreamColumns { name table { ... on DatabaseTable { name schema database { name } } } } }";

function fieldRows(n: Row, datasource: string | null, fields: unknown): Row[] {
  const out: Row[] = [];
  for (const f of (fields ?? []) as Row[]) {
    const cols = (f.upstreamColumns ?? []) as Row[];
    const base = {
      field: f,
      __ctx: { content_id: String(n.luid), content_name: String(n.name ?? "") },
      ds: datasource,
    };
    if (cols.length === 0) out.push({ ...base, col: null } as Row);
    for (const c of cols) out.push({ ...base, col: c } as Row);
  }
  return out;
}

export const fieldLineage = defineTableauTable({
  name: "field_lineage",
  description: "Field-to-column lineage of workbooks and published data sources (Metadata API)",
  title: "Tableau Field Lineage",
  category: "lineage",
  keywords: "tableau, field lineage, column lineage, calculated fields, metadata api, catalog",
  docLlm:
    "Field-level lineage from the Metadata API: one row per (Tableau field, upstream database column). " +
    "content_type (workbook — its embedded data sources — or datasource), content_id, content_name, " +
    "datasource_name (embedded data source name for workbooks), field_name, field_type (ColumnField, " +
    "CalculatedField, …), formula (calculated fields), upstream_database, upstream_schema, upstream_table, " +
    "upstream_column, upstream_qualified_table. Fields with no upstream column get one row with NULL upstream " +
    "columns. Filter content_id / content_name / content_type to narrow the GraphQL query.",
  docMd: "## field_lineage\n\nWhich database columns feed each Tableau field.",
  columns: [
    C.ctx("content_type", "workbook or datasource.", "content_type"),
    C.ctx("content_id", "LUID of the workbook or published data source.", "content_id"),
    C.ctx("content_name", "Name of the workbook or data source.", "content_name", true),
    C.str("datasource_name", "Embedded data source name (workbooks) or the data source's own name.", (r) => r.ds),
    C.str("field_name", "Tableau field name.", "field.name"),
    C.str("field_type", "ColumnField, CalculatedField, BinField, GroupField, …", "field.__typename"),
    C.str("formula", "Formula of a calculated field.", "field.formula"),
    C.str("upstream_database", "Database of the upstream column.", "col.table.database.name"),
    C.str("upstream_schema", "Schema of the upstream column.", (r) => unbracket(at(r, "col.table.schema"))),
    C.str("upstream_table", "Table of the upstream column.", (r) => unbracket(at(r, "col.table.name"))),
    C.str("upstream_column", "Upstream database column name.", "col.name"),
    C.str("upstream_qualified_table", "Lower-cased database.schema.table of the upstream column.", (r) => {
      const t = at(r, "col.table") as Row | undefined;
      return t ? qualified(t.database?.name, t.schema, t.name) : null;
    }),
  ],
  phases: (scan) => {
    const kinds = eqValues(scan.constraints, "content_type");
    const filter = contentFilter(scan.constraints, "content_id", "content_name");
    const out: GqlPhase[] = [];
    if (!kinds || kinds.includes("workbook")) {
      out.push({
        kind: "gql",
        query: connectionQuery(
          "workbookFieldLineage",
          "workbooksConnection",
          "Workbook_Filter",
          `embeddedDatasources { name ${FIELD_SELECTION} }`,
        ),
        root: "workbooksConnection",
        variables: { filter },
        rows: (nodes) =>
          nodes.flatMap((n) =>
            ((n.embeddedDatasources ?? []) as Row[]).flatMap((d) => fieldRows(n, asStr(d.name), d.fields)),
          ),
        ctx: { content_type: "workbook" },
      });
    }
    if (!kinds || kinds.includes("datasource")) {
      out.push({
        kind: "gql",
        query: connectionQuery(
          "datasourceFieldLineage",
          "publishedDatasourcesConnection",
          "PublishedDatasource_Filter",
          FIELD_SELECTION,
        ),
        root: "publishedDatasourcesConnection",
        variables: { filter },
        rows: (nodes) => nodes.flatMap((n) => fieldRows(n, asStr(n.name), n.fields)),
        ctx: { content_type: "datasource" },
      });
    }
    return out;
  },
  primaryKey: null,
  pushdown:
    "`content_id`, `content_name` (`=`, `IN`) → GraphQL `filter: {luidWithin, nameWithin}`; `content_type` " +
    "(`=`, `IN`) skips the other connection.",
  examples: [
    {
      sql: `SELECT field_name, formula FROM ${Q}.field_lineage WHERE field_type = 'CalculatedField' AND content_name = 'Sales Overview' ORDER BY field_name`,
      description: "Calculated fields of one workbook",
    },
    {
      sql: `SELECT upstream_qualified_table, upstream_column, count(DISTINCT content_id) AS used_by FROM ${Q}.field_lineage WHERE upstream_column IS NOT NULL GROUP BY ALL ORDER BY used_by DESC`,
      description: "Most used warehouse columns",
    },
  ],
});

export const queries = defineTableauTable({
  name: "queries",
  description: "Custom SQL queries embedded in Tableau content (Metadata API)",
  title: "Tableau Custom SQL Queries",
  category: "lineage",
  keywords: "tableau, custom sql, queries, sql, metadata api, lineage",
  docLlm:
    "Custom SQL from the Metadata API (customSQLTablesConnection) — the BI vocabulary's queries: tool, id, title " +
    "(Tableau's name for the custom SQL table), query_text (the SQL), connection_type, database_name, " +
    "is_unsupported_custom_sql (Tableau could not parse it for lineage), upstream_tables (full names it reads), " +
    "workbook_ids / workbook_names and datasource_ids / datasource_names (content that uses it). Filter `id` (= or " +
    "IN) to narrow the GraphQL query.",
  docMd: "## queries\n\nCustom SQL embedded in workbooks and data sources.",
  columns: [
    TOOL,
    C.str("id", "Metadata API id of the custom SQL table.", "id", false),
    C.str("title", "Tableau's name for the custom SQL table.", "name"),
    C.str("query_text", "The custom SQL text.", "query"),
    C.str("connection_type", "Connection class, e.g. snowflake.", "connectionType"),
    C.str("database_name", "Database the query runs against.", "database.name"),
    C.bool(
      "is_unsupported_custom_sql",
      "True when Tableau could not parse the SQL for lineage.",
      "isUnsupportedCustomSql",
    ),
    C.strList("upstream_tables", "Full names of the tables the query reads.", (r) =>
      ((r.tables ?? []) as Row[]).map((t) => t.fullName),
    ),
    C.strList("workbook_ids", "LUIDs of workbooks using the query.", (r) =>
      ((r.downstreamWorkbooks ?? []) as Row[]).map((t) => t.luid),
    ),
    C.strList("workbook_names", "Names of workbooks using the query.", (r) =>
      ((r.downstreamWorkbooks ?? []) as Row[]).map((t) => t.name),
    ),
    C.strList("datasource_ids", "LUIDs of published data sources using the query.", (r) =>
      ((r.downstreamDatasources ?? []) as Row[]).map((t) => t.luid),
    ),
    C.strList("datasource_names", "Names of published data sources using the query.", (r) =>
      ((r.downstreamDatasources ?? []) as Row[]).map((t) => t.name),
    ),
  ],
  phases: (scan) => {
    const ids = eqValues(scan.constraints, "id");
    return [
      {
        kind: "gql",
        query:
          "query customSql($first: Int, $after: String, $filter: CustomSQLTable_Filter) { " +
          "customSQLTablesConnection(first: $first, after: $after, filter: $filter) { nodes { id name query " +
          "connectionType isUnsupportedCustomSql database { name } tables { fullName } " +
          "downstreamWorkbooks { luid name } downstreamDatasources { luid name } } " +
          "pageInfo { hasNextPage endCursor } } }",
        root: "customSQLTablesConnection",
        variables: { filter: ids ? { idWithin: ids } : null },
        rows: (nodes) => nodes,
      },
    ];
  },
  pushdown: "`id` (`=`, `IN`) → GraphQL `filter: {idWithin}`.",
  examples: [
    {
      sql: `SELECT title, connection_type, len(workbook_ids) AS workbooks FROM ${Q}.queries ORDER BY workbooks DESC`,
      description: "Custom SQL queries and how many workbooks use them",
    },
    {
      sql: `SELECT title, query_text FROM ${Q}.queries WHERE is_unsupported_custom_sql ORDER BY title`,
      description: "Custom SQL Tableau cannot trace lineage through",
    },
  ],
});

// ----------------------------------------------------------------- unified.runs

const RUN_STATUS: Record<string, string> = {
  Success: "success",
  Failed: "failed",
  Cancelled: "cancelled",
  InProgress: "running",
  Running: "running",
  Pending: "queued",
};
const STATUS_TO_JOB: Record<string, string> = {
  success: "Success",
  failed: "Failed",
  cancelled: "Cancelled",
  running: "InProgress",
  queued: "Pending",
};

export const unifiedRuns = defineTableauTable({
  name: "runs",
  schemaName: "unified",
  description: "Extract refresh jobs and Prep flow runs in the shared orchestrator run shape",
  title: "Tableau Unified Runs",
  category: "operations",
  keywords: "tableau, unified runs, orchestrator, extract refresh, flow runs, pipeline runs, cross tool",
  docLlm:
    "Tableau extract refreshes (background jobs of type refresh_extracts / increment_extracts) and Prep flow runs " +
    "in the shared orchestrator shape, so they UNION ALL with Airflow, Dagster, Prefect, dbt … runs: orchestrator " +
    "('tableau'), run_id (job LUID or flow run LUID), pipeline (refreshed content name / flow name), status " +
    "(queued, running, success, failed, cancelled), raw_status (Tableau's value), trigger (NULL: Tableau does not " +
    "say), queued_at, started_at, ended_at, duration_seconds, url (the flow's page for flow runs; NULL for " +
    "extract jobs).",
  docMd: "## unified.runs\n\nExtract refreshes and flow runs as cross-orchestrator runs.",
  columns: [
    C.constant("orchestrator", "Always 'tableau'.", "tableau"),
    C.str("run_id", "Background job LUID (extract refresh) or flow run LUID.", "id", false),
    C.str("pipeline", "Name of the refreshed data source / workbook, or of the flow.", (r) => r.title ?? r.__flow_name),
    C.str(
      "status",
      "queued, running, success, failed or cancelled.",
      (r) => RUN_STATUS[String(r.status)] ?? "running",
      false,
    ),
    C.str("raw_status", "Tableau's status value.", "status"),
    nullCol(C.str("trigger", "Always NULL: Tableau does not report what triggered a run.", "x")),
    C.time("queued_at", "When the job was queued (NULL for flow runs).", "createdAt"),
    C.time("started_at", "When the run started.", "startedAt"),
    C.time("ended_at", "When the run ended.", (r) => r.endedAt ?? r.completedAt),
    C.num("duration_seconds", "ended_at − started_at in seconds.", (r) =>
      seconds(r.startedAt, r.endedAt ?? r.completedAt),
    ),
    C.str("url", "Web URL of the flow (flow runs); NULL for extract refresh jobs.", (r) => r.__flow_url ?? null),
  ],
  phases: (scan) => {
    const statuses = eqValues(scan.constraints, "status");
    const jobStatuses = statuses?.map((s) => STATUS_TO_JOB[s]).filter((s): s is string => !!s);
    const jobParts = buildFilter(scan.constraints, {
      queued_at: { field: "createdAt", kind: "time" },
      started_at: { field: "startedAt", kind: "time" },
      ended_at: { field: "endedAt", kind: "time" },
    });
    if (jobStatuses?.length === 1) jobParts.push(`status:eq:${jobStatuses[0]}`);
    else if (jobStatuses && jobStatuses.length > 1) jobParts.push(`status:in:[${jobStatuses.join(",")}]`);
    const flowParts = buildFilter(scan.constraints, {
      started_at: { field: "startedAt", kind: "time" },
      ended_at: { field: "completedAt", kind: "time" },
    });
    const queuedOnly = scan.constraints.some((c) => c.column === "queued_at");
    return [
      {
        kind: "rest",
        path: "~/jobs",
        query: { filter: ["jobType:in:[refresh_extracts,increment_extracts]", ...jobParts].join(",") },
        rows: (b) => arr(b, "backgroundJobs", "backgroundJob"),
      },
      // Flow runs have no queued time, so a queued_at filter can never match them.
      ...(queuedOnly
        ? []
        : [
            {
              kind: "rest",
              path: "~/flows/runs",
              query: { filter: flowParts.length ? flowParts.join(",") : undefined },
              rows: (b: unknown) => arr(b, "flowRuns", "flowRuns").map((r) => ({ ...r, __flow: true }) as Row),
            } as RestPhase,
          ]),
    ];
  },
  expand: async (cfg, rows, need) => {
    if (!rows.some((r) => r.__flow) || !(need.has("pipeline") || need.has("url"))) return rows;
    const f = await L.flows(cfg);
    for (const r of rows) {
      if (!r.__flow) continue;
      const flow = f.get(String(r.flowId));
      r.__flow_name = flow?.name ?? null;
      r.__flow_url = flow?.webpageUrl ?? null;
    }
    return rows;
  },
  primaryKey: "run_id",
  pushdown:
    "`status` (`=`, `IN`, mapped back to Tableau's values) → jobs `filter`; `queued_at` / `started_at` / " +
    "`ended_at` ranges → `createdAt` / `startedAt` / `endedAt` (jobs) and `startedAt` / `completedAt` (flow runs).",
  examples: [
    {
      sql: "SELECT pipeline, status, started_at, duration_seconds FROM tableau.unified.runs WHERE status = 'failed' ORDER BY started_at DESC",
      description: "Failed extract refreshes and flow runs",
    },
    {
      sql: "SELECT pipeline, count(*) AS runs, avg(duration_seconds) AS avg_seconds FROM tableau.unified.runs GROUP BY pipeline ORDER BY avg_seconds DESC",
      description: "Run count and average duration per pipeline",
    },
  ],
});

export const MAIN_TABLES: TableDescriptor[] = [
  dashboards,
  charts,
  queries,
  usersTable,
  folders,
  contentUsage,
  dataSources,
  connections,
  sites,
  workbooksTable,
  groupsTable,
  groupMembers,
  favorites,
  subscriptions,
  dataAlerts,
  schedules,
  extractRefreshTasks,
  jobs,
  flowsTable,
  flowRuns,
  revisions,
  lineageTables,
  fieldLineage,
];

export const UNIFIED_TABLES: TableDescriptor[] = [unifiedRuns];
