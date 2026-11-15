#!/usr/bin/env python3
"""An offline Tableau REST + Metadata API replay server for the tests (stdlib only).

It serves the hand-built site in ``test/fixtures/tableau-site.json`` (documented
Tableau JSON response shapes, ``Accept: application/json``) and behaves like Tableau
where the worker depends on it:

* **Server info.** ``GET /api/2.4/serverinfo`` (no auth) reports ``restApiVersion``
  3.24. Versioned routes accept ``/api/3.0`` … ``/api/3.24`` only.
* **Sign-in.** ``POST /api/{v}/auth/signin`` with a personal access token
  (``vgi-test`` / ``test-pat-secret``) or a connected-app JWT (HS256 signed with
  ``test-connected-app-secret-value``; header kid/iss, claims iss/aud=tableau/sub/exp/
  jti/scp checked — expiry at most 10 minutes out, ``tableau:content:read`` required,
  write scopes refused). The site ``contentUrl`` must be ``acme``. Answers a session
  token; anything else is 401 ``401001``. The **first token issued expires after 3
  uses** (401 ``401002``), so the worker's re-sign-in path always runs.
* **Strict REST.** Every site route needs ``X-Tableau-Auth`` and the signed-in site's
  LUID; each route accepts only its documented query parameters (unknown → 400
  ``400006``); ``pageSize`` 1–1000; ``filter`` expressions (``field:op:value``, ops
  eq/in/gt/gte/lt/lte, ``in:[a,b]``, timestamps as ``YYYY-MM-DDTHH:MM:SSZ``) and
  ``sort`` (``field:asc|desc``) are validated per route and actually evaluated.
* **Metadata API.** ``POST /api/metadata/graphql`` recognises the worker's connection
  queries (workbooksConnection, publishedDatasourcesConnection,
  customSQLTablesConnection), checks every identifier in the selection against the
  schema fields it knows, validates ``first`` / ``after`` / ``filter`` (luidWithin,
  nameWithin, idWithin), and pages with ``pageInfo { hasNextPage endCursor }``.
* **Rate limits / flakiness.** The first ``/jobs`` request answers 429 with
  ``Retry-After: 1``; the first ``/datasources`` request answers 503.
* **Introspection.** ``GET /__requests?route=/views`` returns every recorded request to
  that route (``seq``, ``method``, ``route``, ``version``, ``query`` as a JSON object
  string, ``auth``). The GraphQL route is ``/graphql/<connection root>``; sign-ins are
  ``/auth/signin`` with ``auth`` = ``pat`` or ``jwt``.

Usage::

    python3 test/mock_api/server.py            # prints PORT:<n> once listening
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import hmac
import json
import re
import secrets
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
SITE = json.loads((HERE.parent / "fixtures" / "tableau-site.json").read_text())
SITE_ID = SITE["site"]["id"]
SITE_URL = "acme"
API_VERSION = "3.24"
PAT_NAME, PAT_SECRET = "vgi-test", "test-pat-secret"
APP_CLIENT_ID, APP_SECRET_ID, APP_SECRET = "client-id-1", "secret-id-1", "test-connected-app-secret-value"
WRITE_SCOPES = {"tableau:content:write", "tableau:users:create", "tableau:users:update", "tableau:users:delete"}

LOCK = threading.Lock()
REQUESTS: list[dict] = []
TOKENS: dict[str, dict] = {}
ONCE: set[str] = set()
ISSUED = [0]

USERS = {u["id"]: u for u in SITE["users"]}
PROJECTS = {p["id"]: p for p in SITE["projects"]}
WORKBOOKS = {w["id"]: w for w in SITE["workbooks"]}


class ApiError(Exception):
    def __init__(self, status: int, code: str, summary: str, detail: str):
        super().__init__(detail)
        self.status, self.code, self.summary, self.detail = status, code, summary, detail


def bad(detail: str) -> ApiError:
    return ApiError(400, "400006", "Bad Request", detail)


# ------------------------------------------------------------------ filters

TIME_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")


def parse_time(v: str) -> dt.datetime:
    return dt.datetime.fromisoformat(v.replace("Z", "+00:00"))


def split_top(expr: str) -> list[str]:
    """Split a filter on commas outside [ ]."""
    out, depth, cur = [], 0, ""
    for ch in expr:
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return out


def compare(kind: str, actual, op: str, raw: str) -> bool:
    if kind == "time":
        if not TIME_RE.match(raw):
            raise bad(f"invalid date '{raw}': use YYYY-MM-DDTHH:MM:SSZ")
        if actual in (None, ""):
            return False
        a, v = parse_time(actual), parse_time(raw)
    elif kind == "bool":
        if raw not in ("true", "false"):
            raise bad(f"invalid boolean '{raw}'")
        a, v = str(actual).lower() == "true", raw == "true"
    elif kind == "int":
        a, v = int(actual or 0), int(raw)
    else:
        a, v = actual, raw
    if op == "eq":
        return a == v
    if a is None:
        return False
    return {"gt": a > v, "gte": a >= v, "lt": a < v, "lte": a <= v}[op]


def apply_filter(rows: list[dict], expr: str, fields: dict) -> list[dict]:
    for part in split_top(expr):
        m = re.match(r"^(\w+):(\w+):(.*)$", part)
        if not m:
            raise bad(f"malformed filter expression '{part}'")
        name, op, raw = m.groups()
        if name not in fields:
            raise bad(f"'{name}' is not a filterable field here")
        kind, get = fields[name]
        if op == "in":
            if not (raw.startswith("[") and raw.endswith("]")):
                raise bad("in: needs a [a,b] list")
            vals = raw[1:-1].split(",")
            rows = [r for r in rows if any(compare(kind, get(r), "eq", v) for v in vals)]
        elif op in ("eq", "gt", "gte", "lt", "lte"):
            if kind in ("string", "bool") and op != "eq":
                raise bad(f"operator {op} is not valid for {name}")
            rows = [r for r in rows if compare(kind, get(r), op, raw)]
        else:
            raise bad(f"unknown filter operator '{op}'")
    return rows


def apply_sort(rows: list[dict], expr: str, fields: dict) -> list[dict]:
    m = re.match(r"^(\w+):(asc|desc)$", expr)
    if not m or m.group(1) not in fields:
        raise bad(f"invalid sort '{expr}'")
    kind, get = fields[m.group(1)]
    key = (lambda r: int(get(r) or 0)) if kind == "int" else (lambda r: get(r) or "")
    return sorted(rows, key=key, reverse=m.group(2) == "desc")


def f(path: str, kind: str = "string"):
    def get(r):
        cur = r
        for p in path.split("."):
            cur = cur.get(p) if isinstance(cur, dict) else None
        return cur

    return (kind, get)


def project_name(r):
    return PROJECTS.get((r.get("project") or {}).get("id"), {}).get("name")


TIMES = {"createdAt": f("createdAt", "time"), "updatedAt": f("updatedAt", "time")}

# route → (collection key, list key, item key, filter fields, sort fields, extra allowed params)
LISTS = {
    "/views": (
        "views", "views", "view",
        {"name": f("name"), "sheetType": f("sheetType"), "contentUrl": f("contentUrl"), **TIMES,
         "workbookName": ("string", lambda r: WORKBOOKS.get(r["workbook"]["id"], {}).get("name")),
         "projectName": ("string", project_name)},
        {"name": f("name"), **TIMES, "hitsTotal": f("usage.totalViewCount", "int")},
        {"includeUsageStatistics"},
    ),
    "/workbooks": (
        "workbooks", "workbooks", "workbook",
        {"name": f("name"), "contentUrl": f("contentUrl"), "projectName": ("string", project_name), **TIMES},
        {"name": f("name"), **TIMES, "size": f("size", "int")},
        set(),
    ),
    "/datasources": (
        "datasources", "datasources", "datasource",
        {"name": f("name"), "type": f("type"), "projectName": ("string", project_name),
         "isCertified": f("isCertified", "bool"), "hasExtracts": f("hasExtracts", "bool"), **TIMES},
        {"name": f("name"), **TIMES},
        set(),
    ),
    "/projects": (
        "projects", "projects", "project",
        {"name": f("name"), "parentProjectId": f("parentProjectId"),
         "topLevelProject": ("bool", lambda r: "false" if r.get("parentProjectId") else "true"), **TIMES},
        {"name": f("name"), **TIMES},
        set(),
    ),
    "/users": (
        "users", "users", "user",
        {"name": f("name"), "siteRole": f("siteRole"), "lastLogin": f("lastLogin", "time")},
        {"name": f("name"), "siteRole": f("siteRole"), "lastLogin": f("lastLogin", "time")},
        {"fields"},
    ),
    "/groups": (
        "groups", "groups", "group",
        {"name": f("name"), "domainName": f("domain.name"), "minimumSiteRole": f("import.siteRole")},
        {"name": f("name")},
        set(),
    ),
    "/jobs": (
        "jobs", "backgroundJobs", "backgroundJob",
        {"jobType": f("jobType"), "status": f("status"), "title": f("title"),
         "createdAt": f("createdAt", "time"), "startedAt": f("startedAt", "time"), "endedAt": f("endedAt", "time")},
        {},
        set(),
    ),
    "/flows": (
        "flows", "flows", "flow",
        {"name": f("name"), **TIMES},
        {"name": f("name"), **TIMES},
        set(),
    ),
    "/flows/runs": (
        "flow_runs", "flowRuns", "flowRuns",
        {"flowId": f("flowId"), "startedAt": f("startedAt", "time"), "completedAt": f("completedAt", "time")},
        {},
        set(),
    ),
    "/subscriptions": ("subscriptions", "subscriptions", "subscription", {}, {}, set()),
    "/dataAlerts": ("data_alerts", "dataAlerts", "dataAlert", {}, {}, set()),
}


def page(rows: list[dict], q: dict, outer: str, inner: str) -> dict:
    size = int(q.get("pageSize", "100"))
    num = int(q.get("pageNumber", "1"))
    if not 1 <= size <= 1000 or num < 1:
        raise bad("pageSize must be 1-1000 and pageNumber >= 1")
    chunk = rows[(num - 1) * size : num * size]
    return {
        "pagination": {"pageNumber": str(num), "pageSize": str(size), "totalAvailable": str(len(rows))},
        outer: {inner: chunk},
    }


def check_params(q: dict, allowed: set[str]) -> None:
    unknown = set(q) - allowed
    if unknown:
        raise bad(f"unknown query parameter(s): {', '.join(sorted(unknown))}")


PAGING = {"pageSize", "pageNumber"}


def strip_alerts(a: dict) -> dict:
    return {k: v for k, v in a.items() if k != "recipients"}


def site_get(route: str, q: dict) -> dict:
    if route in LISTS:
        key, outer, inner, ffields, sfields, extra = LISTS[route]
        allowed = PAGING | extra | ({"filter"} if ffields else set()) | ({"sort"} if sfields else set())
        check_params(q, allowed)
        rows = list(SITE[key])
        if route == "/dataAlerts":
            rows = [strip_alerts(a) for a in rows]
        if route == "/views" and q.get("includeUsageStatistics") != "true":
            rows = [{k: v for k, v in r.items() if k != "usage"} for r in rows]
        if route == "/users" and q.get("fields") != "_all_":
            rows = [{k: v for k, v in r.items() if k not in ("fullName", "email")} for r in rows]
        if "filter" in q:
            rows = apply_filter(rows, q["filter"], ffields)
        if "sort" in q:
            rows = apply_sort(rows, q["sort"], sfields)
        return page(rows, q, outer, inner)
    if route == "":
        check_params(q, set())
        return {"site": SITE["site"]}
    if route == "/tasks/extractRefreshes":
        check_params(q, set())
        return {"tasks": {"task": SITE["extract_tasks"]}}
    m = re.match(r"^/dataAlerts/([^/]+)$", route)
    if m:
        check_params(q, set())
        for a in SITE["data_alerts"]:
            if a["id"] == m.group(1):
                return {"dataAlert": a}
        raise ApiError(404, "404000", "Resource Not Found", "data-driven alert not found")
    m = re.match(r"^/(datasources|workbooks)/([^/]+)/(connections|revisions)$", route)
    if m:
        kind, cid, sub = m.groups()
        check_params(q, PAGING)
        store = SITE[sub]
        if f"{kind}/{cid}" not in store:
            raise ApiError(404, "404004" if kind == "datasources" else "404006", "Resource Not Found", f"{kind} not found")
        items = store[f"{kind}/{cid}"]
        if sub == "connections":
            items = [{k: v for k, v in c.items() if k != "password"} for c in items]
            return page(items, q, "connections", "connection")
        return page(items, q, "revisions", "revision")
    m = re.match(r"^/groups/([^/]+)/users$", route)
    if m:
        check_params(q, PAGING)
        if m.group(1) not in SITE["group_users"]:
            raise ApiError(404, "404002", "Resource Not Found", "group not found")
        users = [{k: USERS[u][k] for k in ("id", "name", "siteRole")} for u in SITE["group_users"][m.group(1)]]
        return page(users, q, "users", "user")
    m = re.match(r"^/favorites/([^/]+)$", route)
    if m:
        check_params(q, PAGING)
        if m.group(1) not in USERS:
            raise ApiError(404, "404002", "Resource Not Found", "user not found")
        return page(SITE["favorites"].get(m.group(1), []), q, "favorites", "favorite")
    raise ApiError(404, "404000", "Resource Not Found", f"no route {route}")


# ------------------------------------------------------------------ GraphQL

KNOWN_IDENTIFIERS = set(
    """query first after filter Int String Workbook_Filter PublishedDatasource_Filter CustomSQLTable_Filter
    workbooksConnection publishedDatasourcesConnection customSQLTablesConnection nodes pageInfo hasNextPage
    endCursor luid name id schema fullName connectionType database upstreamTables embeddedDatasources fields
    __typename description on CalculatedField formula upstreamColumns table DatabaseTable query
    isUnsupportedCustomSql tables downstreamWorkbooks downstreamDatasources""".split()
)
OPERATION_NAMES = {"lineageTables", "workbookFieldLineage", "datasourceFieldLineage", "customSql"}
FILTER_KEYS = {
    "workbooksConnection": {"luidWithin", "nameWithin"},
    "publishedDatasourcesConnection": {"luidWithin", "nameWithin"},
    "customSQLTablesConnection": {"idWithin"},
}


def table(tid: str) -> dict:
    return SITE["metadata"]["tables"][tid]


def gql_nodes(root: str) -> list[dict]:
    md = SITE["metadata"]

    def fields(fs):
        return [{**x, "upstreamColumns": [{"name": c["name"], "table": table(c["table"])} for c in x["upstreamColumns"]]} for x in fs]

    if root == "workbooksConnection":
        return [
            {"luid": w["luid"], "name": w["name"], "upstreamTables": [table(t) for t in w["upstreamTables"]],
             "embeddedDatasources": [{"name": d["name"], "fields": fields(d["fields"])} for d in w["embeddedDatasources"]]}
            for w in md["workbooks"]
        ]
    if root == "publishedDatasourcesConnection":
        return [
            {"luid": d["luid"], "name": d["name"], "upstreamTables": [table(t) for t in d["upstreamTables"]],
             "fields": fields(d["fields"])}
            for d in md["datasources"]
        ]
    return [{**c, "tables": [table(t) for t in c["tables"]]} for c in md["custom_sql"]]


def graphql(body: dict) -> tuple[str, dict]:
    query = body.get("query")
    variables = body.get("variables") or {}
    if not isinstance(query, str):
        raise bad("GraphQL body needs a query string")
    m = re.match(r"^\s*query\s+(\w+)\(", query)
    if not m or m.group(1) not in OPERATION_NAMES:
        return "?", {"errors": [{"message": "unknown operation"}]}
    unknown = sorted({w for w in re.findall(r"[A-Za-z_]\w*", query) if w not in KNOWN_IDENTIFIERS} - OPERATION_NAMES)
    if unknown:
        return "?", {"errors": [{"message": f"Validation error: unknown field(s) {', '.join(unknown)}"}]}
    roots = re.findall(r"(\w+Connection)\(first: \$first, after: \$after, filter: \$filter\)", query)
    if len(roots) != 1 or roots[0] not in FILTER_KEYS:
        return "?", {"errors": [{"message": "expected exactly one known connection"}]}
    root = roots[0]
    if set(variables) - {"first", "after", "filter"}:
        return root, {"errors": [{"message": "unknown variables"}]}
    first = variables.get("first")
    if not isinstance(first, int) or not 1 <= first <= 1000:
        return root, {"errors": [{"message": "first must be an Int 1-1000"}]}
    after = variables.get("after")
    start = 0
    if after is not None:
        if not (isinstance(after, str) and after.startswith("cursor:")):
            return root, {"errors": [{"message": "invalid cursor"}]}
        start = int(after.split(":")[1])
    nodes = gql_nodes(root)
    flt = variables.get("filter")
    if flt is not None:
        if not isinstance(flt, dict) or set(flt) - FILTER_KEYS[root]:
            return root, {"errors": [{"message": f"invalid filter for {root}"}]}
        for k, vals in flt.items():
            attr = {"luidWithin": "luid", "nameWithin": "name", "idWithin": "id"}[k]
            nodes = [n for n in nodes if n.get(attr) in vals]
    chunk = nodes[start : start + first]
    more = start + first < len(nodes)
    return root, {
        "data": {
            root: {"nodes": chunk, "pageInfo": {"hasNextPage": more, "endCursor": f"cursor:{start + first}" if more else None}}
        }
    }


# ------------------------------------------------------------------ auth


def b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def verify_jwt(token: str) -> str:
    try:
        h, c, s = token.split(".")
        header, claims = json.loads(b64d(h)), json.loads(b64d(c))
    except Exception:
        raise ApiError(401, "401001", "Signin Error", "malformed JWT")
    want = hmac.new(APP_SECRET.encode(), f"{h}.{c}".encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(want, b64d(s)):
        raise ApiError(401, "401001", "Signin Error", "JWT signature invalid")
    if header.get("alg") != "HS256" or header.get("kid") != APP_SECRET_ID or header.get("iss") != APP_CLIENT_ID:
        raise ApiError(401, "401001", "Signin Error", "JWT header kid/iss/alg mismatch")
    now = dt.datetime.now(dt.timezone.utc).timestamp()
    if claims.get("iss") != APP_CLIENT_ID or claims.get("aud") != "tableau" or not claims.get("jti"):
        raise ApiError(401, "401001", "Signin Error", "JWT claims iss/aud/jti invalid")
    if not now < claims.get("exp", 0) <= now + 600:
        raise ApiError(401, "401001", "Signin Error", "JWT exp must be within 10 minutes")
    scp = set(claims.get("scp") or [])
    if "tableau:content:read" not in scp or scp & WRITE_SCOPES:
        raise ApiError(401, "401001", "Signin Error", "JWT scopes must be read-only and include tableau:content:read")
    sub = claims.get("sub")
    if sub not in {u["name"] for u in SITE["users"]}:
        raise ApiError(401, "401001", "Signin Error", "unknown user")
    return sub


def sign_in(body: dict) -> tuple[str, dict]:
    c = (body or {}).get("credentials") or {}
    if (c.get("site") or {}).get("contentUrl") != SITE_URL:
        raise ApiError(401, "401001", "Signin Error", "Error signing in to Tableau Server (site not found)")
    if "personalAccessTokenName" in c:
        if c.get("personalAccessTokenName") != PAT_NAME or c.get("personalAccessTokenSecret") != PAT_SECRET:
            raise ApiError(401, "401001", "Signin Error", "Error signing in to Tableau Server")
        kind, user = "pat", "u-ada"
    elif "jwt" in c:
        sub = verify_jwt(c["jwt"])
        kind, user = "jwt", next(u["id"] for u in SITE["users"] if u["name"] == sub)
    else:
        raise bad("credentials need a personal access token or a jwt")
    token = secrets.token_hex(16)
    with LOCK:
        ISSUED[0] += 1
        TOKENS[token] = {"uses": 0, "limit": 3 if ISSUED[0] == 1 else None}
    return kind, {
        "credentials": {
            "token": token,
            "site": {"id": SITE_ID, "contentUrl": SITE_URL},
            "user": {"id": user},
            "estimatedTimeToExpiration": "239:59:59",
        }
    }


def check_token(token: str | None) -> None:
    with LOCK:
        t = TOKENS.get(token or "")
        if t is None:
            raise ApiError(401, "401002", "Unauthorized Access", "Invalid authentication credentials were provided.")
        t["uses"] += 1
        if t["limit"] is not None and t["uses"] > t["limit"]:
            del TOKENS[token]
            raise ApiError(401, "401002", "Unauthorized Access", "Invalid authentication credentials were provided.")


# ------------------------------------------------------------------ HTTP


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # quiet
        pass

    def send_json(self, status: int, body, headers: dict | None = None) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def record(self, route: str, version: str, q: dict, auth: str) -> None:
        with LOCK:
            REQUESTS.append(
                {"seq": len(REQUESTS) + 1, "method": self.command, "route": route, "version": version,
                 "query": json.dumps(q, sort_keys=True), "auth": auth}
            )

    def once(self, key: str) -> bool:
        with LOCK:
            if key in ONCE:
                return False
            ONCE.add(key)
            return True

    def handle_any(self) -> None:
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query, keep_blank_values=True).items()}
        path = url.path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            if path == "/__requests":
                route = q.get("route")
                with LOCK:
                    rows = [r for r in REQUESTS if route is None or r["route"] == route]
                return self.send_json(200, rows)
            if path == "/health":
                return self.send_json(200, {"status": "ok"})
            if self.headers.get("Accept") != "application/json":
                raise bad("send Accept: application/json")
            if path == "/api/2.4/serverinfo" and self.command == "GET":
                self.record("/serverinfo", "2.4", q, "none")
                return self.send_json(200, {"serverInfo": {"productVersion": {"value": "2025.3.0", "build": "20253.25.1104"}, "restApiVersion": API_VERSION}})
            if path == "/api/metadata/graphql" and self.command == "POST":
                check_token(self.headers.get("X-Tableau-Auth"))
                root, body = graphql(json.loads(raw or b"{}"))
                rec = json.loads(raw or b"{}").get("variables") or {}
                self.record(f"/graphql/{root}", "", rec, "token")
                return self.send_json(200, body)
            m = re.match(r"^/api/(3\.\d+)(/.*)$", path)
            if not m:
                raise ApiError(404, "404000", "Resource Not Found", f"no route {path}")
            version, rest = m.groups()
            if not 0 <= int(version.split(".")[1]) <= 24:
                raise ApiError(400, "400003", "Bad Request", f"API version {version} is not supported")
            if rest == "/auth/signin" and self.command == "POST":
                kind, body = sign_in(json.loads(raw or b"{}"))
                self.record("/auth/signin", version, {}, kind)
                return self.send_json(200, body)
            if self.command != "GET":
                raise ApiError(405, "405000", "Method Not Allowed", "read-only replay server")
            token = self.headers.get("X-Tableau-Auth")
            if rest == "/schedules":
                check_token(token)
                self.record("/schedules", version, q, "token")
                check_params(q, PAGING)
                return self.send_json(200, page(SITE["schedules"], q, "schedules", "schedule"))
            sm = re.match(r"^/sites/([^/]+)(/.*)?$", rest)
            if not sm:
                raise ApiError(404, "404000", "Resource Not Found", f"no route {rest}")
            check_token(token)
            if sm.group(1) != SITE_ID:
                raise ApiError(403, "403069", "Forbidden", "site id does not match the signed-in site")
            route = sm.group(2) or ""
            self.record(route, version, q, "token")
            if route == "/jobs" and self.once("jobs"):
                return self.send_json(429, {"error": {"code": "429000", "summary": "Too Many Requests", "detail": "slow down"}}, {"Retry-After": "1"})
            if route == "/datasources" and self.once("datasources"):
                return self.send_json(503, {"error": {"code": "503000", "summary": "Service Unavailable", "detail": "try again"}})
            return self.send_json(200, site_get(route, q))
        except ApiError as e:
            return self.send_json(e.status, {"error": {"code": e.code, "summary": e.summary, "detail": e.detail}})

    do_GET = handle_any
    do_POST = handle_any


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"PORT:{srv.server_address[1]}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
