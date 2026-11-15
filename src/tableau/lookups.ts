/**
 * Small per-site lookup maps (project tree, user, workbook, datasource, group and flow
 * names) used to enrich rows: Tableau list endpoints return only `{"owner": {"id"}}`,
 * `{"project": {"id"}}` and so on. Each map is read in full (pages of 1000) only when a
 * projected column needs it, and cached in memory for a minute per site.
 */

import type { TableauConfig } from "./client.ts";
import { asStr, listAll, type Row } from "./table.ts";

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: Promise<Map<string, Row>> }>();

/** Forget cached lookups (tests). */
export function clearLookups(): void {
  cache.clear();
}

function cached(cfg: TableauConfig, name: string, load: () => Promise<Map<string, Row>>): Promise<Map<string, Row>> {
  const key = `${cfg.serverUrl}\u0000${cfg.site}\u0000${cfg.patName ?? cfg.clientId ?? ""}\u0000${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

const byId = (rows: Row[]) => new Map(rows.map((r) => [String(r.id), r] as [string, Row]));

/** project id → project row plus `__path` ("Parent/Child/Self"). */
export function projects(cfg: TableauConfig): Promise<Map<string, Row>> {
  return cached(cfg, "projects", async () => {
    const rows = await listAll(cfg, { kind: "rest", path: "~/projects", rows: (b) => arr(b, "projects", "project") });
    const map = byId(rows);
    const pathOf = (id: string, depth = 0): string | null => {
      const p = map.get(id);
      if (!p || depth > 64) return null;
      const parent = asStr(p.parentProjectId);
      const up = parent ? pathOf(parent, depth + 1) : null;
      return up ? `${up}/${p.name}` : String(p.name);
    };
    for (const [id, p] of map) p.__path = pathOf(id);
    return map;
  });
}

export const users = (cfg: TableauConfig) =>
  cached(cfg, "users", async () =>
    byId(
      await listAll(cfg, {
        kind: "rest",
        path: "~/users",
        query: { fields: "_all_" },
        rows: (b) => arr(b, "users", "user"),
      }),
    ),
  );

export const workbooks = (cfg: TableauConfig) =>
  cached(cfg, "workbooks", async () =>
    byId(await listAll(cfg, { kind: "rest", path: "~/workbooks", rows: (b) => arr(b, "workbooks", "workbook") })),
  );

export const datasources = (cfg: TableauConfig) =>
  cached(cfg, "datasources", async () =>
    byId(await listAll(cfg, { kind: "rest", path: "~/datasources", rows: (b) => arr(b, "datasources", "datasource") })),
  );

export const groups = (cfg: TableauConfig) =>
  cached(cfg, "groups", async () =>
    byId(await listAll(cfg, { kind: "rest", path: "~/groups", rows: (b) => arr(b, "groups", "group") })),
  );

export const flows = (cfg: TableauConfig) =>
  cached(cfg, "flows", async () =>
    byId(await listAll(cfg, { kind: "rest", path: "~/flows", rows: (b) => arr(b, "flows", "flow") })),
  );

/** `body[outer][inner]` as an array (Tableau's JSON list envelope), tolerating a single object. */
export function arr(body: unknown, outer: string, inner: string): Row[] {
  const o = (body as Record<string, unknown> | null)?.[outer] as Record<string, unknown> | undefined;
  const v = o?.[inner];
  if (Array.isArray(v)) return v as Row[];
  if (v && typeof v === "object") return [v as Row];
  return [];
}
