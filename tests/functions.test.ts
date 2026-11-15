// Unit tests. The SQL-level tests live in test/sql and run through DuckDB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { CATALOG } from "../src/catalog.ts";
import {
  apiVersion,
  clearSessions,
  configFromSecrets,
  connectedAppJwt,
  graphql,
  normalizeServerUrl,
  restGet,
  retryAfterMs,
  signIn,
  type TableauConfig,
} from "../src/tableau/client.ts";
import { buildFilter, type Constraint, tableauTime } from "../src/tableau/pushdown.ts";
import { maskName, qualified, viewUrl } from "../src/tableau/resources.ts";
import { asBig, asBool, asTime, tagLabels } from "../src/tableau/table.ts";

const ROOT = join(import.meta.dir, "..");

test("server_url: https required except for loopback fixtures; trailing slash dropped", () => {
  expect(normalizeServerUrl("https://10ax.online.tableau.com/")).toBe("https://10ax.online.tableau.com");
  expect(normalizeServerUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  expect(() => normalizeServerUrl("http://tableau.example.com")).toThrow(/https/);
  expect(() => normalizeServerUrl("not a url")).toThrow(/not a URL/);
});

test("configFromSecrets: needs a server and a PAT or a complete connected app", () => {
  expect(() => configFromSecrets({})).toThrow(/no tableau secret/);
  const base = { type: "tableau", server_url: "https://t.example.com" };
  expect(() => configFromSecrets({ s: base })).toThrow(/PAT_NAME/);
  expect(() => configFromSecrets({ s: { ...base, client_id: "c", secret_id: "s" } })).toThrow(/PAT_NAME/);
  expect(() => configFromSecrets({ s: { ...base, pat_name: "n", pat_secret: "x", page_size: "0" } })).toThrow(
    /page_size/,
  );
  expect(() => configFromSecrets({ s: { ...base, pat_name: "n", pat_secret: "x", api_version: "v3" } })).toThrow(
    /api_version/,
  );
  const cfg = configFromSecrets({ s: { ...base, pat_name: "n", pat_secret: "x" } });
  expect(cfg.site).toBe("");
  expect(cfg.pageSize).toBe(100);
  expect(cfg.scopes).toContain("tableau:content:read");
  expect(cfg.scopes.every((s) => s.endsWith(":read"))).toBe(true);
});

test("connectedAppJwt: HS256 over header.claims with kid/iss and read scopes", () => {
  const cfg = configFromSecrets({
    s: {
      type: "tableau",
      server_url: "https://t.example.com",
      client_id: "cid",
      secret_id: "sid",
      secret_value: "shh",
      username: "ada@example.com",
    },
  });
  const jwt = connectedAppJwt(cfg, 1_000_000);
  const [h, c, s] = jwt.split(".") as [string, string, string];
  expect(createHmac("sha256", "shh").update(`${h}.${c}`).digest("base64url")).toBe(s);
  expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
    alg: "HS256",
    typ: "JWT",
    kid: "sid",
    iss: "cid",
  });
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  expect(claims.iss).toBe("cid");
  expect(claims.sub).toBe("ada@example.com");
  expect(claims.aud).toBe("tableau");
  expect(claims.exp).toBe(1_000_300);
  expect(claims.scp).toContain("tableau:content:read");
});

test("retryAfterMs: seconds or an HTTP date", () => {
  expect(retryAfterMs(new Headers({ "Retry-After": "3" }))).toBe(3000);
  const now = Date.parse("2026-01-01T00:00:00Z");
  expect(retryAfterMs(new Headers({ "Retry-After": "Thu, 01 Jan 2026 00:00:05 GMT" }), now)).toBe(5000);
  expect(retryAfterMs(new Headers())).toBeUndefined();
});

describe("buildFilter", () => {
  const fields = {
    name: { field: "name", kind: "string" as const, in: true },
    type: { field: "type", kind: "string" as const },
    certified: { field: "isCertified", kind: "bool" as const },
    updated: { field: "updatedAt", kind: "time" as const },
  };
  const t = (iso: string) => BigInt(Date.parse(iso)) * 1000n;

  test("eq, in, bool", () => {
    const cs: Constraint[] = [
      { kind: "cmp", column: "type", op: "eq", value: "snowflake" },
      { kind: "in", column: "name", values: ["A", "B"] },
      { kind: "cmp", column: "certified", op: "eq", value: true },
    ];
    expect(buildFilter(cs, fields)).toEqual(["type:eq:snowflake", "name:in:[A,B]", "isCertified:eq:true"]);
  });

  test("time bounds widen to whole seconds and never narrow", () => {
    const cs: Constraint[] = [
      { kind: "cmp", column: "updated", op: "gt", value: t("2026-01-01T00:00:00.400Z") },
      { kind: "cmp", column: "updated", op: "lt", value: t("2026-02-01T00:00:00.400Z") },
    ];
    expect(buildFilter(cs, fields)).toEqual([
      "updatedAt:gte:2026-01-01T00:00:00Z",
      "updatedAt:lte:2026-02-01T00:00:01Z",
    ]);
    expect(
      buildFilter([{ kind: "cmp", column: "updated", op: "eq", value: t("2026-03-01T10:00:00Z") }], fields),
    ).toEqual(["updatedAt:gte:2026-03-01T10:00:00Z", "updatedAt:lte:2026-03-01T10:00:00Z"]);
  });

  test("values the filter grammar cannot carry, ranges on strings and unknown columns are not pushed", () => {
    const cs: Constraint[] = [
      { kind: "cmp", column: "name", op: "eq", value: "a,b" },
      { kind: "in", column: "name", values: ["ok", "x]"] },
      { kind: "in", column: "type", values: ["a", "b"] },
      { kind: "cmp", column: "type", op: "gt", value: "a" },
      { kind: "cmp", column: "other", op: "eq", value: "x" },
    ];
    expect(buildFilter(cs, fields)).toEqual([]);
  });

  test("tableauTime drops milliseconds", () => {
    expect(tableauTime(Date.parse("2026-05-04T21:24:49.123Z"))).toBe("2026-05-04T21:24:49Z");
  });
});

test("row helpers: Tableau's stringly typed JSON", () => {
  expect(asBig("1520")).toBe(1520n);
  expect(asBig("")).toBeNull();
  expect(asBool("true")).toBe(true);
  expect(asBool(false)).toBe(false);
  expect(asBool("yes")).toBeNull();
  expect(asTime("2026-01-01T00:00:00Z")).toBe(1767225600000000n);
  expect(tagLabels({ tags: { tag: [{ label: "a" }, { label: "b" }] } })).toEqual(["a", "b"]);
  expect(tagLabels({ tags: {} })).toEqual([]);
});

test("maskName, viewUrl, qualified", () => {
  expect(maskName("ada@example.com")).toBe("a***@example.com");
  expect(maskName("jdoe")).toBe("j***");
  expect(maskName(null)).toBeNull();
  const cfg = { serverUrl: "https://t.example.com", site: "acme" } as TableauConfig;
  expect(viewUrl(cfg, "Sales/sheets/Overview")).toBe("https://t.example.com/#/site/acme/views/Sales/Overview");
  expect(viewUrl({ ...cfg, site: "" }, "Sales/sheets/Overview")).toBe("https://t.example.com/#/views/Sales/Overview");
  expect(qualified("ANALYTICS", "[PUBLIC]", "[ORDERS]")).toBe("analytics.public.orders");
  expect(qualified(null, "dbo", "t")).toBe("dbo.t");
  expect(qualified(null, null, null)).toBeNull();
});

test("catalog: BI vocabulary and unified.runs shapes", () => {
  const main = CATALOG.schemas.find((s) => s.path?.[0] === "main");
  const unified = CATALOG.schemas.find((s) => s.path?.[0] === "unified");
  const names = (main?.tables ?? []).map((t) => t.name);
  for (const t of [
    "dashboards",
    "charts",
    "queries",
    "users",
    "folders",
    "content_usage",
    "data_sources",
    "connections",
  ]) {
    expect(names).toContain(t);
  }
  const common = [
    "tool",
    "id",
    "title",
    "folder_path",
    "owner",
    "created_at",
    "updated_at",
    "last_viewed_at",
    "view_count",
    "url",
  ];
  for (const t of ["dashboards", "charts", "data_sources", "folders"]) {
    const cols = main?.tables?.find((x) => x.name === t)?.columns?.fields.map((f) => f.name);
    expect(cols?.slice(0, common.length)).toEqual(common);
  }
  const runs = unified?.tables?.find((t) => t.name === "runs");
  expect(runs?.columns?.fields.map((f) => f.name)).toEqual([
    "orchestrator",
    "run_id",
    "pipeline",
    "status",
    "raw_status",
    "trigger",
    "queued_at",
    "started_at",
    "ended_at",
    "duration_seconds",
    "url",
  ]);
});

describe("against the replay server", () => {
  let mock: ReturnType<typeof Bun.spawn>;
  let cfg: TableauConfig;

  beforeAll(async () => {
    mock = Bun.spawn([process.env.PYTHON ?? "python3", join(ROOT, "test", "mock_api", "server.py")], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const port = text.match(/^PORT:(\d+)/)?.[1];
    if (!port) throw new Error(`replay server did not report a port: ${text}`);
    cfg = configFromSecrets({
      s: {
        type: "tableau",
        server_url: `http://127.0.0.1:${port}`,
        site_content_url: "acme",
        pat_name: "vgi-test",
        pat_secret: "test-pat-secret",
      },
    });
    clearSessions();
  });

  afterAll(() => {
    mock?.kill();
  });

  test("API version comes from serverinfo", async () => {
    expect(await apiVersion(cfg)).toBe("3.24");
  });

  test("an expired session is replaced transparently (first token dies after 3 calls)", async () => {
    const first = await signIn(cfg);
    for (let i = 0; i < 5; i++) {
      const body = (await restGet(cfg, "~/groups")) as { groups: { group: unknown[] } };
      expect(body.groups.group.length).toBe(3);
    }
    expect((await signIn(cfg)).token).not.toBe(first.token);
  });

  test("429 is retried after Retry-After", async () => {
    const t0 = Date.now();
    const body = (await restGet(cfg, "~/jobs", { pageSize: "100" })) as {
      backgroundJobs: { backgroundJob: unknown[] };
    };
    expect(body.backgroundJobs.backgroundJob.length).toBe(7);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  test("a strict 400 names the problem", async () => {
    await expect(restGet(cfg, "~/workbooks", { bogus: "1" })).rejects.toThrow(/HTTP 400.*bogus/);
  });

  test("GraphQL errors surface as errors", async () => {
    await expect(graphql(cfg, "query nope($first: Int) { x }", { first: 1 })).rejects.toThrow(/Metadata API error/);
  });
});
