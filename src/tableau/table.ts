/**
 * One factory for every Tableau collection.
 *
 * A spec names the columns (with a JSON extractor each) and how a scan reads its rows:
 * a list of *phases*, each either a paged REST list (`pageSize` / `pageNumber`), an
 * unpaged REST resource, or a Metadata API (GraphQL) connection (`first` / `after`).
 * Per-parent collections (connections, revisions, favorites, group members …) *fan
 * out*: parent ids come from a pushed `= / IN` filter on the key column, or else from
 * listing every parent a page at a time.
 *
 * The factory turns that into a catalog table whose scan:
 *
 * - streams one upstream page per Arrow batch;
 * - keeps its cursor (phase, page number or GraphQL cursor, pending parent ids) in
 *   serializable state, so a scan resumes on any process over HTTP and survives
 *   rate-limit pauses;
 * - reads the `tableau` secret on every call and never stores it in state;
 * - pushes filters down (narrowing only) and lets the SDK re-apply them exactly.
 */

import {
  batchFromColumns,
  bool,
  constraintRecord,
  defineTableFunction,
  field,
  float64,
  formatPushedFilters,
  int32,
  int64,
  list,
  schema,
  type TableDescriptor,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiFunction,
} from "@query-farm/vgi";
import { log } from "../log.ts";
import { type Category, column, objectTags } from "../meta.ts";
import { configFromSecrets, graphql, restGet, SECRET_TYPE, type TableauConfig, TableauError } from "./client.ts";
import { type Constraint, constraintsOf, eqValues } from "./pushdown.ts";

// ------------------------------------------------------------------ column helpers

// biome-ignore lint/suspicious/noExplicitAny: Tableau JSON is untyped.
export type Row = Record<string, any> & { __ctx?: Record<string, string> };

export interface Col {
  name: string;
  type: VgiDataType;
  /** DuckDB spelling for vgi.result_columns_schema. */
  sqlType: string;
  doc: string;
  nullable?: boolean;
  get: (row: Row) => unknown;
}

/** Walk a dotted path through untyped JSON. */
export function at(row: unknown, path: string): unknown {
  let cur: unknown = row;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export const asStr = (v: unknown): string | null =>
  v == null || v === "" ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
/** Tableau JSON carries booleans either as JSON booleans or as "true"/"false". */
export const asBool = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : null;
/** Tableau JSON carries most numbers as strings ("totalViewCount": "12"). */
export function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
export const asInt = (v: unknown): number | null => {
  const n = asNumber(v);
  return n === null ? null : Math.trunc(n);
};
export const asBig = (v: unknown): bigint | null => {
  const n = asNumber(v);
  return n === null ? null : BigInt(Math.trunc(n));
};
/** ISO 8601 → TIMESTAMPTZ microseconds. */
export function asTime(v: unknown): bigint | null {
  if (typeof v !== "string" || v === "") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : BigInt(ms) * 1000n;
}
export const asStrList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x) => x != null).map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : null;
export const asJson = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

/** Tableau's `{"tags": {"tag": [{"label": "x"}]}}` → ['x']. */
export const tagLabels = (r: Row): string[] => {
  const t = at(r, "tags.tag");
  return Array.isArray(t) ? t.map((x) => asStr(at(x, "label"))).filter((x): x is string => x !== null) : [];
};

const JSON_META: [string, string] = ["ARROW:extension:name", "arrow.json"];
type Getter = string | ((r: Row) => unknown);
const pick = (g: Getter, r: Row) => (typeof g === "string" ? at(r, g) : g(r));

function mkCol(
  name: string,
  type: VgiDataType,
  sqlType: string,
  doc: string,
  get: (r: Row) => unknown,
  nullable = true,
) {
  return { name, type, sqlType, doc, get, nullable };
}

export const C = {
  str: (name: string, doc: string, g: Getter, nullable = true): Col =>
    mkCol(name, utf8(), "VARCHAR", doc, (r) => asStr(pick(g, r)), nullable),
  /** A constant VARCHAR column (e.g. `tool` = 'tableau'). */
  constant: (name: string, doc: string, value: string): Col => mkCol(name, utf8(), "VARCHAR", doc, () => value, false),
  time: (name: string, doc: string, g: Getter): Col =>
    mkCol(name, timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", doc, (r) => asTime(pick(g, r))),
  bool: (name: string, doc: string, g: Getter): Col => mkCol(name, bool, "BOOLEAN", doc, (r) => asBool(pick(g, r))),
  int: (name: string, doc: string, g: Getter): Col => mkCol(name, int32, "INTEGER", doc, (r) => asInt(pick(g, r))),
  big: (name: string, doc: string, g: Getter): Col => mkCol(name, int64(), "BIGINT", doc, (r) => asBig(pick(g, r))),
  num: (name: string, doc: string, g: Getter): Col =>
    mkCol(name, float64(), "DOUBLE", doc, (r) => asNumber(pick(g, r))),
  strList: (name: string, doc: string, g: Getter): Col =>
    mkCol(name, list(utf8()), "VARCHAR[]", doc, (r) => asStrList(pick(g, r))),
  json: (name: string, doc: string, g: Getter): Col => mkCol(name, utf8(), "JSON", doc, (r) => asJson(pick(g, r))),
  ctx: (name: string, doc: string, key: string, nullable = false): Col =>
    mkCol(name, utf8(), "VARCHAR", doc, (r) => r.__ctx?.[key] ?? null, nullable),
};

// ------------------------------------------------------------------------- phases

/** A paged REST list: `rows` pulls the array out of the body (e.g. body.workbooks.workbook). */
export interface RestPhase {
  kind: "rest";
  /** `~/x` = site-relative, `/x` = relative to /api/{version}. */
  path: string;
  query?: Record<string, string | undefined>;
  rows: (body: unknown) => Row[];
  /** false for endpoints without pageSize/pageNumber (single resources, task lists). */
  paged?: boolean;
  /** 404 (and 403 when set) → zero rows instead of an error. */
  notFoundEmpty?: boolean;
  ctx?: Record<string, string>;
}

/** A Metadata API connection: `root` is e.g. workbooksConnection; `rows` flattens its nodes. */
export interface GqlPhase {
  kind: "gql";
  query: string;
  root: string;
  variables?: Record<string, unknown>;
  rows: (nodes: Row[]) => Row[];
  ctx?: Record<string, string>;
}

export type Phase = RestPhase | GqlPhase;

export interface ScanContext {
  constraints: Constraint[];
  cfg: TableauConfig;
  /** Tableau sort expression from DuckDB's ORDER BY hint (`field:asc`), if it maps. */
  sort?: string;
}

export interface FnExample {
  sql: string;
  description: string;
}

export interface TableauTableSpec {
  name: string;
  /** Catalog schema; default `main`. */
  schemaName?: string;
  description: string;
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  columns: Col[];
  /** The phases of an ordinary scan. */
  phases?: (scan: ScanContext) => Phase[];
  /**
   * Per-parent endpoints. `key` is an output column; a pushed `key = 'x'` / `IN (…)`
   * reads only those parents (`fromKeys`), otherwise every parent from `parents` is
   * listed (paged) and `child` reads each one in turn. Pending parent refs live in the
   * scan state, so the fan-out resumes too.
   */
  fanout?: {
    key: string;
    parents: (scan: ScanContext) => RestPhase[];
    /** A parent row → an opaque ref passed to `child` (e.g. `workbooks/<id>`). */
    parentRef: (row: Row, parentPhase: number) => string | null;
    child: (ref: string, scan: ScanContext) => Phase;
    fromKeys: (ids: string[], scan: ScanContext) => Phase[];
  };
  /** Keep only matching rows (client-side narrowing the API cannot do). */
  keep?: (row: Row) => boolean;
  /** Enrich a page of rows; `need` is the set of projected column names. */
  expand?: (cfg: TableauConfig, rows: Row[], need: Set<string>) => Promise<Row[]>;
  /** SQL column → Tableau sort field, for DuckDB's ORDER BY hint. */
  sortFields?: Record<string, string>;
  /** Primary-key column(s) (attested unique + not null; default `id`); null for none. */
  primaryKey?: string | string[] | null;
  /** Foreign keys to another table's single-column primary key in the same schema. */
  foreignKeys?: { column: string; table: string }[];
  /** Text appended to doc_md describing what pushes down. */
  pushdown?: string;
  examples: FnExample[];
}

interface ScanState {
  phase: number;
  /** REST: next page number (0 = phase not started). */
  page: number;
  /** GraphQL: endCursor of the previous page ("" = first page). */
  cursor: string;
  /** Fan-out: pending parent refs, newline-joined (the head is being read). */
  queue: string;
  parentPhase: number;
  parentPage: number;
}

/** The Arrow output schema of a spec (column comments ride along as field metadata). */
function outputSchemaOf(spec: TableauTableSpec) {
  const pk = new Set(spec.primaryKey === undefined ? ["id"] : spec.primaryKey === null ? [] : [spec.primaryKey].flat());
  return schema(
    spec.columns
      .map((c) => (pk.has(c.name) ? { ...c, nullable: false } : c))
      .map((c) =>
        c.sqlType === "JSON"
          ? field(c.name, c.type, c.nullable ?? true, new Map([["comment", c.doc], JSON_META]))
          : column(c.name, c.type, c.doc, c.nullable ?? true),
      ),
  );
}

/** " Join x.col = table.id …" for the declared foreign keys. */
function joinDoc(spec: TableauTableSpec): string {
  const schemaName = spec.schemaName ?? "main";
  const fks = spec.foreignKeys ?? [];
  return fks.length
    ? ` Join ${fks.map((fk) => `${spec.name}.${fk.column} = ${schemaName}.${fk.table}.id (the ${fk.table} table)`).join("; ")}.`
    : "";
}

function tagsOf(spec: TableauTableSpec): Record<string, string> {
  return {
    domain: "business intelligence",
    ...objectTags({
      title: spec.title,
      category: spec.category,
      keywords: spec.keywords,
      docLlm: spec.docLlm + joinDoc(spec),
      docMd:
        spec.docMd +
        (spec.pushdown ? `\n\n**Pushdown:** ${spec.pushdown}` : "") +
        (spec.foreignKeys?.length ? `\n\n**Joins:**${joinDoc(spec)}` : ""),
    }),
    "vgi.result_columns_schema": JSON.stringify(
      spec.columns.map((c) => ({ name: c.name, type: c.sqlType, description: c.doc })),
    ),
  };
}

const isMissing = (err: unknown, forbiddenToo: boolean) =>
  err instanceof TableauError && (/HTTP 404/.test(err.message) || (forbiddenToo && /HTTP 403/.test(err.message)));

interface Page {
  rows: Row[];
  /** True when another page of this phase follows. */
  more: boolean;
  cursor: string;
}

async function readPage(cfg: TableauConfig, phase: Phase, page: number, cursor: string): Promise<Page> {
  if (phase.kind === "gql") {
    const data = (await graphql(cfg, phase.query, {
      ...(phase.variables ?? {}),
      first: cfg.pageSize,
      after: cursor || null,
    })) as Record<string, { nodes?: Row[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } }> | null;
    const conn = data?.[phase.root];
    const nodes = conn?.nodes ?? [];
    const next = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? "") : "";
    return { rows: phase.rows(nodes), more: next !== "", cursor: next };
  }
  const paged = phase.paged ?? true;
  const query = paged
    ? { ...phase.query, pageSize: String(cfg.pageSize), pageNumber: String(page) }
    : (phase.query ?? {});
  let body: unknown;
  try {
    body = await restGet(cfg, phase.path, query);
  } catch (err) {
    if (phase.notFoundEmpty && isMissing(err, true)) return { rows: [], more: false, cursor: "" };
    throw err;
  }
  const rows = phase.rows(body);
  if (!paged) return { rows, more: false, cursor: "" };
  const total = asInt(at(body, "pagination.totalAvailable"));
  const more = rows.length > 0 && total !== null && page * cfg.pageSize < total;
  return { rows, more, cursor: "" };
}

/** A spec as a catalog table (`SELECT … FROM tableau.main.workbooks`). */
export function defineTableauTable(spec: TableauTableSpec): TableDescriptor {
  const outSchema = outputSchemaOf(spec);
  const schemaPath = [spec.schemaName ?? "main"];

  const fn: VgiFunction = defineTableFunction<Record<string, never>, ScanState>({
    name: `${spec.name}_scan`,
    description: spec.description,
    args: {},
    // Only the selected columns are built (and expensive lookups skipped otherwise).
    projectionPushdown: true,
    filterPushdown: true,
    // DuckDB drops pushed predicates from its plan; the SDK re-applies them exactly,
    // so translating a predicate only ever narrows what Tableau returns.
    autoApplyFilters: true,
    onBind: (params) =>
      params.resolvedSecretsProvided
        ? { outputSchema: outSchema }
        : { outputSchema: outSchema, lookupSecretTypes: [SECRET_TYPE] },
    initialState: () => ({ phase: 0, page: 0, cursor: "", queue: "", parentPhase: 0, parentPage: 0 }),
    process: async (params, state, out) => {
      const cfg = configFromSecrets(params.secrets);
      const orderCol = params.initCall?.order_by_column_name;
      const sortField = orderCol ? spec.sortFields?.[orderCol] : undefined;
      const scan: ScanContext = {
        cfg,
        constraints: constraintsOf(params.pushdownFilters),
        sort: sortField ? `${sortField}:${params.initCall?.order_by_direction === "DESC" ? "desc" : "asc"}` : undefined,
      };
      log.debug(`${spec.name}: pushed filters ${formatPushedFilters(params.pushdownFilters)}`);
      const need = new Set(params.outputSchema.fields.map((f) => f.name));

      /** Emit a page's rows; false when none survived (keep reading). */
      const emit = async (rows: Row[], ctx: Record<string, string>): Promise<boolean> => {
        let rs: Row[] = rows.map((r) => ({ ...r, __ctx: { ...ctx, ...r.__ctx } }));
        if (spec.keep) rs = rs.filter(spec.keep);
        if (spec.expand && rs.length) rs = await spec.expand(cfg, rs, need);
        if (rs.length === 0) return false;
        const cols: Record<string, unknown[]> = {};
        for (const f of params.outputSchema.fields) {
          const c = spec.columns.find((x) => x.name === f.name);
          cols[f.name] = c ? rs.map((r) => c.get(r)) : rs.map(() => null);
        }
        out.emit(batchFromColumns(cols, params.outputSchema));
        return true;
      };

      const fan = spec.fanout;
      const keys = fan ? eqValues(scan.constraints, fan.key) : undefined;
      const phases = fan ? (keys ? fan.fromKeys(keys, scan) : []) : (spec.phases?.(scan) ?? []);

      // Loop until a page yields rows or the scan ends, so no empty batches go out.
      for (;;) {
        if (fan && !keys) {
          if (!state.queue) {
            const parents = fan.parents(scan);
            const pp = parents[state.parentPhase];
            if (!pp) {
              out.finish();
              return;
            }
            const pageNo = state.parentPage || 1;
            const page = await readPage(cfg, pp, pageNo, "");
            if (page.more) state.parentPage = pageNo + 1;
            else {
              state.parentPhase += 1;
              state.parentPage = 0;
            }
            const phaseIdx = parents.indexOf(pp);
            state.queue = page.rows
              .map((r) => fan.parentRef(r, phaseIdx))
              .filter((x): x is string => !!x)
              .join("\n");
            continue;
          }
          const refs = state.queue.split("\n");
          const child = fan.child(refs[0] as string, scan);
          const pageNo = state.page || 1;
          const page = await readPage(cfg, child, pageNo, state.cursor);
          if (page.more) {
            state.page = pageNo + 1;
            state.cursor = page.cursor;
          } else {
            state.queue = refs.slice(1).join("\n");
            state.page = 0;
            state.cursor = "";
          }
          if (await emit(page.rows, child.ctx ?? {})) return;
          continue;
        }
        const phase = phases[state.phase];
        if (!phase) {
          out.finish();
          return;
        }
        const pageNo = state.page || 1;
        const page = await readPage(cfg, phase, pageNo, state.cursor);
        if (page.more) {
          state.page = pageNo + 1;
          state.cursor = page.cursor;
        } else {
          state.phase += 1;
          state.page = 0;
          state.cursor = "";
        }
        if (await emit(page.rows, phase.ctx ?? {})) return;
      }
    },
    tags: tagsOf(spec),
    examples: spec.examples,
  });

  const pkCols = spec.primaryKey === undefined ? ["id"] : spec.primaryKey === null ? [] : [spec.primaryKey].flat();
  const record = (
    id: string,
    kind: "NOT_NULL" | "PRIMARY_KEY" | "FOREIGN_KEY",
    columns: string[],
    references?: { table: string },
  ) =>
    constraintRecord({
      schemaPath,
      table: spec.name,
      id,
      kind,
      columns: columns.map((c) => [c]),
      enforcement: "ENFORCED",
      validation: "ALL_ROWS",
      references: references
        ? { schemaPath, table: references.table, columns: [["id"]], constraintId: "pk" }
        : undefined,
    });
  const constraints = [
    ...pkCols.map((c) => record(`${c}_not_null`, "NOT_NULL", [c])),
    ...(pkCols.length ? [record("pk", "PRIMARY_KEY", pkCols)] : []),
    ...(spec.foreignKeys ?? []).map((fk) => record(`${fk.column}_fk`, "FOREIGN_KEY", [fk.column], { table: fk.table })),
  ];
  return {
    name: spec.name,
    comment: spec.description,
    columns: outSchema,
    function: fn,
    constraints,
    tags: { ...tagsOf(spec), "vgi.example_queries": JSON.stringify(spec.examples) },
  };
}

/** Read every page of a REST list (for small lookups such as the project tree). */
export async function listAll(cfg: TableauConfig, phase: RestPhase): Promise<Row[]> {
  const big = { ...cfg, pageSize: Math.max(cfg.pageSize, 1000) };
  const rows: Row[] = [];
  for (let page = 1; page < 10_000; page++) {
    const p = await readPage(big, phase, page, "");
    rows.push(...p.rows);
    if (!p.more) break;
  }
  return rows;
}
