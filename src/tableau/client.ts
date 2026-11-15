/**
 * Tableau REST + Metadata API client: authentication, API version, rate limits.
 *
 * - **Auth.** A `tableau` DuckDB secret carries the server URL and site plus either a
 *   Personal Access Token (name + secret) or a Connected App (client id, secret id,
 *   secret value, username). The worker signs in (`POST /api/{v}/auth/signin`) — with
 *   the PAT, or with an HS256 JWT it mints for the connected app — and sends the
 *   returned session token as `X-Tableau-Auth`. Sessions are cached in memory per
 *   credential; a 401 (expired or superseded session) drops the cache entry and signs
 *   in once more. Credentials and session tokens never enter table-function state.
 * - **API version.** Read once per server from `GET /api/2.4/serverinfo`
 *   (`restApiVersion`), unless the secret pins `API_VERSION`.
 * - **Rate limits.** 429 honours `Retry-After` (bounded); 429/5xx and network errors
 *   retry with exponential backoff.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { secretOfType } from "@query-farm/vgi";
import { log } from "../log.ts";
import { VERSION } from "../meta.ts";

export const SECRET_TYPE = "tableau";
export const TIMEOUT_MS = 60_000;
export const MAX_ATTEMPTS = 5;
export const MAX_RATE_WAIT_MS = 60_000;
export const DEFAULT_PAGE_SIZE = 100;
const USER_AGENT = `vgi-tableau-worker/${VERSION}`;

/** Connected-app scopes requested when the secret names none: read-only content + users. */
export const DEFAULT_SCOPES = [
  "tableau:content:read",
  "tableau:users:read",
  "tableau:groups:read",
  "tableau:projects:read",
  "tableau:views:read",
  "tableau:workbooks:read",
  "tableau:datasources:read",
  "tableau:flows:read",
  "tableau:tasks:read",
  "tableau:jobs:read",
  "tableau:schedules:read",
  "tableau:metrics:read",
];

export class TableauError extends Error {}

export interface TableauConfig {
  serverUrl: string;
  /** Site content URL ("" = the Default site). */
  site: string;
  patName?: string;
  patSecret?: string;
  clientId?: string;
  secretId?: string;
  secretValue?: string;
  username?: string;
  scopes: string[];
  apiVersion?: string;
  pageSize: number;
}

export interface Session {
  token: string;
  siteId: string;
  userId: string;
  version: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Normalize and check a server URL: https, or http only for a loopback fixture server. */
export function normalizeServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new TableauError(
      `tableau secret: server_url '${raw}' is not a URL (expected e.g. https://10ax.online.tableau.com)`,
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new TableauError(
      "tableau secret: server_url must use https:// (http:// is accepted only for 127.0.0.1/localhost)",
    );
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Build the client config from the `tableau` secret DuckDB resolved for this call. */
export function configFromSecrets(secrets: Record<string, Record<string, unknown>>): TableauConfig {
  const s = secretOfType(secrets as never, SECRET_TYPE) as Record<string, unknown> | undefined;
  if (!s) {
    throw new TableauError(
      "no tableau secret: run CREATE SECRET (TYPE tableau, SERVER_URL 'https://<pod>.online.tableau.com', " +
        "SITE_CONTENT_URL '<site>', PAT_NAME '<token name>', PAT_SECRET '<token secret>') " +
        "or use CLIENT_ID + SECRET_ID + SECRET_VALUE + USERNAME for a connected app",
    );
  }
  const serverRaw = str(s.server_url);
  if (!serverRaw)
    throw new TableauError("tableau secret: server_url is required (e.g. https://10ax.online.tableau.com)");
  const pageRaw = s.page_size;
  const pageSize = pageRaw == null || pageRaw === "" ? DEFAULT_PAGE_SIZE : Number(pageRaw);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new TableauError("tableau secret: page_size must be an integer between 1 and 1000");
  }
  const version = str(s.api_version);
  if (version && !/^\d+\.\d+$/.test(version)) {
    throw new TableauError(`tableau secret: api_version '${version}' must look like 3.24`);
  }
  const cfg: TableauConfig = {
    serverUrl: normalizeServerUrl(serverRaw),
    site: typeof s.site_content_url === "string" ? s.site_content_url.trim() : "",
    patName: str(s.pat_name),
    patSecret: str(s.pat_secret),
    clientId: str(s.client_id),
    secretId: str(s.secret_id),
    secretValue: str(s.secret_value),
    username: str(s.username),
    scopes:
      str(s.scopes)
        ?.split(/[\s,]+/)
        .filter(Boolean) ?? DEFAULT_SCOPES,
    apiVersion: version,
    pageSize,
  };
  const pat = cfg.patName && cfg.patSecret;
  const app = cfg.clientId && cfg.secretId && cfg.secretValue && cfg.username;
  if (!pat && !app) {
    throw new TableauError(
      "tableau secret: set PAT_NAME + PAT_SECRET, or CLIENT_ID + SECRET_ID + SECRET_VALUE + USERNAME (connected app)",
    );
  }
  return cfg;
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

/** Mint the HS256 JWT a Tableau connected app (direct trust) signs in with. */
export function connectedAppJwt(cfg: TableauConfig, nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (!cfg.clientId || !cfg.secretId || !cfg.secretValue || !cfg.username) {
    throw new TableauError("tableau secret: client_id, secret_id, secret_value and username are required");
  }
  const header = { alg: "HS256", typ: "JWT", kid: cfg.secretId, iss: cfg.clientId };
  const claims = {
    iss: cfg.clientId,
    sub: cfg.username,
    aud: "tableau",
    exp: nowSeconds + 300,
    jti: randomUUID(),
    scp: cfg.scopes,
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = createHmac("sha256", cfg.secretValue).update(input).digest();
  return `${input}.${b64url(sig)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Delay before retrying a 429, from Retry-After (seconds or HTTP date). */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const v = headers.get("Retry-After");
  if (!v) return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

/** Tableau errors are `{"error": {"summary", "detail", "code"}}`; keep the message short. */
function errorSummary(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { summary?: string; detail?: string; code?: string } };
    if (j.error) return [j.error.code, j.error.summary, j.error.detail].filter(Boolean).join(" - ");
  } catch {}
  return text.slice(0, 300);
}

interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
}

/** One HTTP call with retries for network errors, 429 and 5xx. */
async function send(url: string, init: RequestInit, label: string): Promise<RawResponse> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new TableauError(`${label} failed: ${(err as Error).message}`);
      await sleep(250 * 2 ** attempt);
      continue;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      return { status: res.status, headers: res.headers, text: await res.text() };
    }
    await res.body?.cancel();
    const delay =
      res.status === 429 ? Math.min(retryAfterMs(res.headers) ?? 1000 * attempt, MAX_RATE_WAIT_MS) : 250 * 2 ** attempt;
    log.debug(`tableau: HTTP ${res.status} for ${label}; retry ${attempt} in ${delay} ms`);
    await sleep(delay);
  }
}

const versions = new Map<string, string>();

/** The server's REST API version (cached per server; the secret can pin it). */
export async function apiVersion(cfg: TableauConfig): Promise<string> {
  if (cfg.apiVersion) return cfg.apiVersion;
  const hit = versions.get(cfg.serverUrl);
  if (hit) return hit;
  const res = await send(
    `${cfg.serverUrl}/api/2.4/serverinfo`,
    { headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
    "GET /api/2.4/serverinfo",
  );
  if (res.status !== 200) {
    throw new TableauError(`GET /api/2.4/serverinfo failed with HTTP ${res.status}: ${errorSummary(res.text)}`);
  }
  const v = (JSON.parse(res.text) as { serverInfo?: { restApiVersion?: string } }).serverInfo?.restApiVersion;
  if (!v || !/^\d+\.\d+$/.test(v)) throw new TableauError("serverinfo returned no restApiVersion");
  versions.set(cfg.serverUrl, v);
  return v;
}

const sessions = new Map<string, Session>();

function sessionKey(cfg: TableauConfig): string {
  return createHash("sha256")
    .update(
      [
        cfg.serverUrl,
        cfg.site,
        cfg.patName,
        cfg.patSecret,
        cfg.clientId,
        cfg.secretId,
        cfg.secretValue,
        cfg.username,
        cfg.scopes.join(" "),
        cfg.apiVersion,
      ]
        .map((x) => x ?? "")
        .join("\u0000"),
    )
    .digest("hex");
}

/** Forget cached sessions and API versions (tests). */
export function clearSessions(): void {
  sessions.clear();
  versions.clear();
}

/** Sign in (PAT first, else connected-app JWT) and cache the session. */
export async function signIn(cfg: TableauConfig, force = false): Promise<Session> {
  const key = sessionKey(cfg);
  const hit = sessions.get(key);
  if (hit && !force) return hit;
  const version = await apiVersion(cfg);
  const credentials: Record<string, unknown> = { site: { contentUrl: cfg.site } };
  if (cfg.patName && cfg.patSecret) {
    credentials.personalAccessTokenName = cfg.patName;
    credentials.personalAccessTokenSecret = cfg.patSecret;
  } else {
    credentials.jwt = connectedAppJwt(cfg);
  }
  const res = await send(
    `${cfg.serverUrl}/api/${version}/auth/signin`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ credentials }),
    },
    "POST auth/signin",
  );
  if (res.status !== 200) {
    throw new TableauError(`Tableau sign-in failed with HTTP ${res.status}: ${errorSummary(res.text)}`);
  }
  const c = (
    JSON.parse(res.text) as { credentials?: { token?: string; site?: { id?: string }; user?: { id?: string } } }
  ).credentials;
  if (!c?.token || !c.site?.id) throw new TableauError("Tableau sign-in response had no token or site id");
  const session: Session = { token: c.token, siteId: c.site.id, userId: c.user?.id ?? "", version };
  sessions.set(key, session);
  return session;
}

/**
 * Resolve a path: `~/x` is site-relative (`/api/{v}/sites/{site-id}/x`), `~` the site
 * itself, `/x` is relative to `/api/{v}`.
 */
export function resolvePath(cfg: TableauConfig, s: Session, path: string): string {
  const base = `${cfg.serverUrl}/api/${s.version}`;
  if (path === "~") return `${base}/sites/${s.siteId}`;
  if (path.startsWith("~/")) return `${base}/sites/${s.siteId}${path.slice(1)}`;
  return `${base}${path}`;
}

/** Run one authenticated call; on 401 sign in once more and retry. */
async function authed(
  cfg: TableauConfig,
  label: string,
  build: (s: Session) => { url: string; init: RequestInit },
): Promise<unknown> {
  for (let round = 0; ; round++) {
    const session = await signIn(cfg, round > 0);
    const { url, init } = build(session);
    const headers = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "X-Tableau-Auth": session.token,
      ...(init.headers as Record<string, string> | undefined),
    };
    const res = await send(url, { ...init, headers }, label);
    if (res.status === 401 && round === 0) {
      log.debug(`tableau: 401 for ${label}; signing in again`);
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new TableauError(`${label} failed with HTTP ${res.status}: ${errorSummary(res.text)}`);
    }
    return res.text ? JSON.parse(res.text) : null;
  }
}

/** GET a REST resource (see `resolvePath`) with query parameters. */
export async function restGet(
  cfg: TableauConfig,
  path: string,
  query?: Record<string, string | undefined>,
): Promise<unknown> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") qs.set(k, v);
  const q = qs.toString();
  return authed(cfg, `GET ${path}${q ? `?${q}` : ""}`, (s) => ({
    url: `${resolvePath(cfg, s, path)}${q ? `?${q}` : ""}`,
    init: { method: "GET" },
  }));
}

/** POST a Metadata API (GraphQL) query; GraphQL `errors` become a TableauError. */
export async function graphql(cfg: TableauConfig, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const body = (await authed(cfg, "POST /api/metadata/graphql", () => ({
    url: `${cfg.serverUrl}/api/metadata/graphql`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    },
  }))) as { data?: unknown; errors?: { message?: string }[] };
  if (body?.errors?.length) {
    throw new TableauError(`Metadata API error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body?.data;
}
