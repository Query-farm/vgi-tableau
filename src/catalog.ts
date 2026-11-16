/**
 * Assemble the `tableau` catalog: the site tables in `main`, the cross-orchestrator
 * `unified.runs`, and the `tableau` secret type.
 */

import { type CatalogDescriptor, field, schema, type TableDescriptor, utf8 } from "@query-farm/vgi";
import {
  CATALOG_COMMENT,
  CATALOG_NAME,
  CATALOG_TAGS,
  SCHEMA_COMMENT,
  SCHEMA_TAGS,
  SOURCE_URL,
  UNIFIED_COMMENT,
  UNIFIED_SCHEMA_TAGS,
} from "./meta.ts";
import { SECRET_TYPE } from "./tableau/client.ts";
import { MAIN_TABLES, UNIFIED_TABLES } from "./tableau/resources.ts";

const doc = (text: string) => new Map([["vgi_doc", text]]);
const redacted = (text: string) =>
  new Map([
    ["redact", "true"],
    ["vgi_doc", text],
  ]);

/** CREATE SECRET (TYPE tableau, SERVER_URL '…', SITE_CONTENT_URL '…', PAT_NAME '…', PAT_SECRET '…'). */
export const TABLEAU_SECRET_TYPE = {
  name: SECRET_TYPE,
  description: "Tableau server URL and site plus a personal access token or a connected app (direct trust)",
  schema: schema(
    [
      field(
        "server_url",
        utf8(),
        true,
        doc(
          "Tableau Cloud pod or Tableau Server URL, e.g. https://10ax.online.tableau.com (http:// only for 127.0.0.1/localhost).",
        ),
      ),
      field(
        "site_content_url",
        utf8(),
        true,
        doc("Site content URL (the part after /site/ in a URL); '' for Default."),
      ),
      field("pat_name", utf8(), true, doc("Personal access token name.")),
      field("pat_secret", utf8(), true, redacted("Personal access token secret.")),
      field("client_id", utf8(), true, doc("Connected app client id (instead of a PAT).")),
      field("secret_id", utf8(), true, doc("Connected app secret id (the JWT kid).")),
      field("secret_value", utf8(), true, redacted("Connected app secret value (signs the HS256 JWT).")),
      field("username", utf8(), true, doc("Tableau username the connected app signs in as (the JWT sub).")),
      field(
        "scopes",
        utf8(),
        true,
        doc("Space-separated connected-app scopes; defaults to read-only tableau:*:read scopes."),
      ),
      field("api_version", utf8(), true, doc("Pin the REST API version (e.g. 3.24); default: read from serverinfo.")),
      field("page_size", utf8(), true, doc("Rows per REST / Metadata API page, 1–1000 (default 100).")),
    ],
    new Map([["vgi_doc_url", "https://help.tableau.com/current/online/en-us/security_personal_access_tokens.htm"]]),
  ),
};

interface Example {
  description: string;
  sql: string;
}

const examplesOf = (tables: TableDescriptor[]) =>
  tables.flatMap((t) => JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]") as Example[]);

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_COMMENT,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  secretTypes: [TABLEAU_SECRET_TYPE],
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_COMMENT,
      functions: [],
      tables: MAIN_TABLES,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(examplesOf(MAIN_TABLES).slice(0, 12)) },
    },
    {
      path: ["unified"],
      comment: UNIFIED_COMMENT,
      functions: [],
      tables: UNIFIED_TABLES,
      tags: { ...UNIFIED_SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(examplesOf(UNIFIED_TABLES)) },
    },
  ],
};
