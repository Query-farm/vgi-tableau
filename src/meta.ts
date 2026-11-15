/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 *
 * - Catalog-level tags (title, license, author, links, long description) live in
 *   `CATALOG_TAGS` below.
 * - Every function carries `objectTags(...)`: a title, a category from
 *   `SCHEMA_CATEGORIES`, search keywords, and LLM- and human-facing docs.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "tableau";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-tableau";

/**
 * Categories group tables in docs and agent tools. Every object's `vgi.category`
 * must name one of these.
 */
export const SCHEMA_CATEGORIES = [
  {
    name: "content",
    title: "Content",
    description: "Dashboards, worksheets, workbooks, projects (folders), revisions and the site.",
  },
  { name: "data", title: "Data Sources", description: "Published data sources and their database connections." },
  { name: "people", title: "People", description: "Users, groups and group membership." },
  {
    name: "usage",
    title: "Usage and Engagement",
    description: "View counts, favorites, subscriptions and data-driven alerts.",
  },
  {
    name: "operations",
    title: "Operations",
    description: "Schedules, extract refresh tasks, background jobs, Prep flows and their runs.",
  },
  {
    name: "lineage",
    title: "Lineage",
    description: "Metadata API lineage: upstream tables, field-to-column lineage and custom SQL.",
  },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const SOURCES_MD =
  "### Sources and references\n\n" +
  "- [Tableau REST API reference](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref.htm) — the endpoints this worker reads\n" +
  "- [Filtering and sorting](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_concepts_filtering_and_sorting.htm) and [paging](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_concepts_paging.htm)\n" +
  "- [Metadata API (GraphQL)](https://help.tableau.com/current/api/metadata_api/en-us/index.html) — lineage\n" +
  "- [Personal access tokens](https://help.tableau.com/current/online/en-us/security_personal_access_tokens.htm) and [connected apps (direct trust)](https://help.tableau.com/current/online/en-us/connected_apps_direct.htm)";

export const CATALOG_COMMENT =
  "Tableau Cloud and Tableau Server metadata and usage as SQL: dashboards, worksheets, workbooks, data sources, connections, users, jobs, Prep flows and Metadata API lineage, read-only.";

export const CATALOG_DOC_LLM =
  "Read-only SQL access to one Tableau Cloud or Tableau Server site through the REST API and the Metadata " +
  "API (GraphQL). Reach for it to inventory and audit BI content: which dashboards and worksheets exist, how " +
  "often each is viewed, who owns what, which projects (folders) hold it, which published data sources and " +
  "database connections it uses (connection type, server, database user; never passwords), users and site " +
  "roles (licenses), groups, favorites, subscriptions and data-driven alerts (recipients masked or counted), " +
  "extract refresh tasks, background jobs and Prep flow runs, revision history, and Metadata API lineage — " +
  "upstream database tables (lineage_tables.qualified_name joins dbt / OpenLineage), field-to-column lineage " +
  "and custom SQL. Every table needs a `tableau` DuckDB secret: SERVER_URL, SITE_CONTENT_URL ('' for the " +
  "Default site) and either a personal access token (PAT_NAME + PAT_SECRET) or a connected app (CLIENT_ID, " +
  "SECRET_ID, SECRET_VALUE, USERNAME). BI-vocabulary tables (dashboards, charts, queries, users, folders, " +
  "content_usage, data_sources, connections) share columns tool, id, title, folder_path, owner, created_at, " +
  "updated_at, last_viewed_at, view_count, url with the other Query.Farm BI workers (e.g. Looker) so they " +
  "UNION. unified.runs puts extract refreshes and flow runs in the shared orchestrator run shape. WHERE " +
  "filters push down into Tableau's REST `filter=` syntax and Metadata API filters and are re-checked " +
  "exactly. Docs: https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref.htm ; " +
  "https://help.tableau.com/current/api/metadata_api/en-us/index.html .";

export const CATALOG_DOC_MD =
  "# Tableau\n\n" +
  "Query a Tableau Cloud or Tableau Server site from DuckDB: dashboards and worksheets with view counts, " +
  "workbooks, projects, published data sources and their connections, users, groups, favorites, " +
  "subscriptions, alerts, extract refreshes, jobs, Prep flows, revisions, and Metadata API lineage. " +
  "Read-only.\n\n" +
  "Create a `tableau` secret with `SERVER_URL`, `SITE_CONTENT_URL` and a personal access token " +
  "(`PAT_NAME`, `PAT_SECRET`) or a connected app (`CLIENT_ID`, `SECRET_ID`, `SECRET_VALUE`, `USERNAME`). " +
  "Filters become Tableau REST `filter=` expressions, paging and rate limits are handled for you, and " +
  "passwords are never returned.\n\n" +
  SOURCES_MD;

export const SCHEMA_DOC_LLM =
  "Tableau site collections as SQL tables (no arguments; filter with WHERE). BI-vocabulary tables: " +
  "dashboards (dashboards + stories), charts (worksheets), content_usage (view counts of every view), folders " +
  "(projects, with full path), data_sources (published), connections, users, queries (custom SQL). Native " +
  "tables: sites, workbooks, groups, group_members, favorites, subscriptions, data_alerts, schedules (Server " +
  "only), extract_refresh_tasks, jobs, flows, flow_runs, revisions, lineage_tables and field_lineage " +
  "(Metadata API). Per-item collections (connections, revisions, group_members, favorites) read only the " +
  "items named by a pushed `= / IN` filter on their key column, otherwise every item. All tables need a " +
  "`tableau` secret.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "Tableau site content, people, usage, operations and lineage as tables.\n\n" +
  "Per-item collections (connections, revisions, group members, favorites) take their parent id from a " +
  "pushed filter and otherwise read every parent. All tables need a `tableau` secret.";

export const UNIFIED_DOC_LLM =
  "Cross-tool shapes shared with the Query.Farm orchestrator workers (Airflow, Dagster, Prefect, Temporal, " +
  "Databricks, dbt, GitHub). `runs` holds Tableau extract refresh jobs and Prep flow runs with columns " +
  "orchestrator, run_id, pipeline, status (queued / running / success / failed / cancelled), raw_status, " +
  "trigger, queued_at, started_at, ended_at, duration_seconds, url, ready to UNION ALL with the other workers.";

export const UNIFIED_DOC_MD =
  "## unified\n\n" +
  "Tableau extract refreshes and Prep flow runs in the shared orchestrator `runs` shape.\n\n" +
  "Every Query.Farm orchestrator worker (Airflow, Dagster, Prefect, Temporal, Databricks, dbt, GitHub) " +
  "exposes the same columns and status values, so their runs UNION ALL into one cross-tool run history.\n\n" +
  "Use it to answer questions such as 'what failed overnight, anywhere?'; use `main.jobs` and " +
  "`main.flow_runs` for Tableau-specific detail.";

export const AGENT_TEST_TASKS = [
  { name: "top_dashboards", prompt: "Which three Tableau dashboards have the most views?" },
  { name: "finance_dashboards", prompt: "List the dashboards in the Finance/Quarterly folder." },
  { name: "unviewed_charts", prompt: "Which Tableau worksheets have never been viewed?" },
  { name: "certified_sources", prompt: "Which published data sources are certified?" },
  {
    name: "snowflake_connections",
    prompt: "Which Tableau data sources connect to Snowflake, and as which database user?",
  },
  { name: "creators", prompt: "How many Tableau users hold each site role?" },
  { name: "finance_members", prompt: "Who is in the Finance group?" },
  { name: "failed_refreshes", prompt: "Which extract refresh jobs failed?" },
  { name: "flow_failures", prompt: "Which Prep flow runs failed?" },
  { name: "orders_impact", prompt: "Which workbooks and data sources read the table analytics.public.orders?" },
  { name: "custom_sql_count", prompt: "How many custom SQL queries are there, and which workbooks use them?" },
  { name: "failing_tasks", prompt: "Which extract refresh tasks have failed more than once in a row?" },
  { name: "revision_count", prompt: "How many revisions does the Sales Overview workbook have?" },
  { name: "unified_failed", prompt: "List failed Tableau runs (extract refreshes or flows) in the unified runs view." },
  { name: "workbook_views", prompt: "What is the total number of views per Tableau workbook?" },
  { name: "alert_audience", prompt: "Which data-driven alert has the most recipients?" },
  { name: "most_favorited", prompt: "Which Tableau view has been favorited by the most users?" },
  {
    name: "calculated_fields",
    prompt: "List the calculated fields of the Sales Overview workbook and their formulas.",
  },
  { name: "flow_owners", prompt: "Who owns each Tableau Prep flow?" },
  { name: "nested_projects", prompt: "Which Tableau projects are nested inside another project?" },
  { name: "directory_groups", prompt: "Which Tableau groups are synced from a directory rather than local?" },
  { name: "suspended_schedules", prompt: "Which Tableau Server schedules are suspended?" },
  {
    name: "revision_setting",
    prompt: "Is revision history enabled on this Tableau site, and how many revisions are kept?",
  },
  { name: "suspended_subscriptions", prompt: "How many subscriptions are suspended?" },
  { name: "largest_workbook", prompt: "Which Tableau workbook is the largest?" },
];

/** Bind-only probes: each binds a table and shows its columns without fetching (LIMIT 0). */
export const EXECUTABLE_EXAMPLES = [
  {
    name: "dashboards_columns",
    description: "The dashboards columns (binds only; create a tableau secret and drop LIMIT 0 for rows)",
    sql: "SELECT tool, id, title, folder_path, owner, view_count, url FROM tableau.main.dashboards LIMIT 0",
  },
  {
    name: "runs_columns",
    description: "The unified.runs columns (binds only; create a tableau secret and drop LIMIT 0 for rows)",
    sql: "SELECT orchestrator, run_id, pipeline, status, started_at, ended_at FROM tableau.unified.runs LIMIT 0",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Tableau Cloud and Server",
  "vgi.subtitle":
    "Tableau dashboards, worksheets, data sources, users, jobs, flows and lineage as SQL tables, read-only.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC - https://query.farm",
  "vgi.keywords": keywordsArray(
    "tableau, tableau cloud, tableau server, bi, business intelligence, dashboards, workbooks, data sources, usage, lineage, metadata api, prep flows",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
  "vgi.executable_examples": JSON.stringify(EXECUTABLE_EXAMPLES),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Tableau Site",
  domain: "business intelligence",
  "vgi.keywords": keywordsArray(
    "tableau, dashboards, worksheets, workbooks, projects, data sources, users, groups, jobs, flows, lineage",
  ),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};

export const UNIFIED_SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Unified Orchestrator Shapes",
  domain: "business intelligence",
  "vgi.keywords": keywordsArray("unified, runs, orchestrator, pipelines, extract refresh, flow runs"),
  "vgi.doc_llm": UNIFIED_DOC_LLM,
  "vgi.doc_md": UNIFIED_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES.filter((c) => c.name === "operations")),
};
