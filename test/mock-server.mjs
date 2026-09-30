// Local stand-in for the Pitchup.com supplier API (www.sandbox.pitchup.com/rest/api/), serving the
// fixtures with the documented authentication (`Authorization: Token <key>`) and pagination (`next`
// and `previous` links that are followed as given, `page_size` up to 100).
import http from "node:http";
import * as fx from "./fixtures.mjs";

// Obviously fake, low-entropy keys. Never the placeholder from Pitchup's docs.
export const API_KEY = "pu-test-key-not-real";
export const WRONG_KEY = "pu-wrong-key-not-real";

// The guide's troubleshooting table quotes these messages; the {"detail": ...} body shape is the one
// the prospect research recorded from the live sandbox for a request without a key (401).
export const MESSAGES = {
  noKey: "Authentication credentials were not provided.",
  badKey: "Invalid token.",
  spaces: "Invalid token header. Token string should not contain spaces.",
  notFound: "Not found.",
};
const detail = (message) => ({ detail: message });

// Page sizes: page_size is honoured up to 100 ("You can set page_size to a maximum of 100"); without
// it the mock serves 20. Booking pages are capped at 3 records whatever is asked, so the suite pages
// through them; that cap is the mock's own, not documented behaviour.
const DEFAULT_PAGE = 20;
const CAPS = { "/booking/": 3 };

export function startMock() {
  const requests = [];
  // Injected failures: { method, path, status, times, headers, body }. body undefined = an HTML gateway page.
  let failures = [];
  let foreignNext = false; // when set, list pages link to another host
  let pitchTypeAsObject = false; // when set, GET /pitchtype/{pk}/ answers a bare object instead of the spec's list shape
  let htmlOn200 = false; // when set, the next GET answers 200 with an HTML page
  let pitchTypeAnswer; // when set, GET /pitchtype/{pk}/ answers this JSON whatever pk is (a record with another ID, say)
  let origin = "";

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), rawQuery: url.search, auth: req.headers.authorization, accept: req.headers.accept, contentType: req.headers["content-type"], body, t: Date.now() });

    const send = (status, json, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };

    const auth = req.headers.authorization;
    if (!auth) return send(401, detail(MESSAGES.noKey), { "WWW-Authenticate": "Token" });
    const parts = auth.split(" ");
    if (parts[0] !== "Token") return send(401, detail(MESSAGES.noKey), { "WWW-Authenticate": "Token" });
    if (parts.length > 2) return send(401, detail(MESSAGES.spaces), { "WWW-Authenticate": "Token" });
    if (parts[1] !== API_KEY) return send(401, detail(MESSAGES.badKey), { "WWW-Authenticate": "Token" });

    const path = url.pathname.replace(/^\/rest\/api(?=\/)/, "");
    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failure) {
      failure.times--;
      if (failure.body === undefined) {
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(`<html><body><h1>${failure.status}</h1></body></html>`);
      }
      return send(failure.status, failure.body, failure.headers ?? {});
    }
    if (htmlOn200 && req.method === "GET") {
      htmlOn200 = false;
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<html><body>Pitchup log in page with support@pitchup.example</body></html>");
    }

    const q = url.searchParams;
    const notFound = () => send(404, detail(MESSAGES.notFound));

    // DRF-style page-number pagination ({count, next, previous, results}); bookings use the cursor form
    // shown in the guide's booking example (?cursor=...). Filters are kept in the links, as DRF does.
    const paged = (items, { cursor = false } = {}) => {
      const cap = CAPS[path] ?? 100;
      const size = Math.min(Number(q.get("page_size") || DEFAULT_PAGE), 100, cap);
      const start = cursor ? Number(Buffer.from(q.get("cursor") || "MA==", "base64").toString()) || 0 : (Number(q.get("page") || 1) - 1) * size;
      const results = items.slice(start, start + size);
      const linkTo = (s) => {
        const p = new URLSearchParams(q);
        if (cursor) {
          p.delete("page");
          p.set("cursor", Buffer.from(String(s)).toString("base64"));
        } else p.set("page", String(s / size + 1));
        return `${foreignNext ? "https://elsewhere.example.test" : origin}${url.pathname}?${p}`;
      };
      const next = start + size < items.length ? linkTo(start + size) : null;
      const previous = start > 0 ? linkTo(Math.max(0, start - size)) : null;
      return cursor ? { next, previous, results } : { count: items.length, next, previous, results };
    };
    const byDate = (items) => {
      // `date`, `after` and `before` are documented filter names; whether after/before include the
      // date itself is not. The mock treats both as exclusive, the stricter reading.
      const date = q.get("date"), after = q.get("after"), before = q.get("before");
      return items.filter((x) => (!date || x.date === date) && (!after || x.date > after) && (!before || x.date < before));
    };
    const idOf = (link) => link.split("/").filter(Boolean).pop();

    const m = req.method;
    const seg = path.split("/").filter(Boolean);

    if (path === "/" && m === "GET") return send(200, fx.root);

    if (seg[0] === "campsite" && m === "GET") {
      if (seg.length === 1) return send(200, paged(fx.campsites));
      const c = fx.campsites.find((x) => x.slug === seg[1]);
      return c ? send(200, c) : notFound();
    }

    if (seg[0] === "pitchtype") {
      if (seg.length === 1 && m === "GET") return send(200, paged(fx.pitchTypes));
      if (seg.length === 2 && m === "GET" && pitchTypeAnswer !== undefined) return send(200, pitchTypeAnswer);
      const pt = fx.pitchTypes.find((x) => String(x.id) === seg[1]);
      if (!pt) return notFound();
      if (seg.length === 2 && m === "GET") return send(200, pitchTypeAsObject ? pt : { next: null, previous: null, results: [pt] });
      if (seg[2] === "allocation" && m === "POST") {
        // Documented 201: the parameters sent plus task_id.
        return send(201, { ...body, task_id: "00000000-0000-4000-8000-000000000001" });
      }
    }

    if (seg[0] === "pitch" && seg.length === 1 && m === "GET") {
      const ext = q.get("external_id");
      return send(200, paged(fx.pitches.filter((p) => !ext || p.external_id === ext)));
    }

    if (seg[0] === "chargetype") {
      if (seg.length === 1 && m === "GET") return send(200, paged(fx.chargeTypes));
      const ct = fx.chargeTypes.find((x) => String(x.id) === seg[1]);
      if (!ct) return notFound();
      if (seg.length === 2 && m === "GET") return send(200, ct);
      if (seg.length === 2 && m === "PUT") {
        if (!body || typeof body.name !== "string" || typeof body.pitchtype !== "string" || typeof body.is_active !== "boolean") {
          return send(400, { name: ["This field is required."] }); // placeholder shape: the spec documents no 400 body
        }
        return send(200, { ...ct, name: body.name, description: body.description ?? ct.description, is_active: body.is_active, status: body.is_active ? "active" : "inactive", last_modified: "2026-09-30T12:00:00.000000Z" });
      }
      if (seg[2] === "pricing" && m === "POST") return send(201, { ...body, task_id: "00000000-0000-4000-8000-000000000002" });
    }

    if (seg[0] === "arrival" && seg.length === 1 && m === "GET") return send(200, paged(byDate(fx.arrivals)));

    if (seg[0] === "allocation" && seg.length === 1) {
      if (m === "GET") return send(200, paged(byDate(fx.allocations)));
      if (m === "POST") {
        const list = Array.isArray(body) ? body : [body];
        if (list.length > 90 || list.some((x) => !x || typeof x.date !== "string" || typeof x.max_allocation !== "number" || typeof x.pitchtype !== "string")) {
          return send(400, { non_field_errors: ["Invalid allocation."] }); // placeholder shape
        }
        const saved = list.map((x, i) => ({ url: `${fx.HOST}/rest/api/allocation/${90000 + i}/`, id: 90000 + i, date: x.date, max_allocation: x.max_allocation, pitchtype: x.pitchtype, pitches_to_sell: x.max_allocation, has_availability: x.max_allocation > 0 }));
        return send(201, Array.isArray(body) ? saved : saved[0]);
      }
    }

    if (seg[0] === "extra" && seg.length === 1 && m === "GET") return send(200, paged(fx.extras));
    if (seg[0] === "extraprice" && seg.length === 1 && m === "GET") return send(200, paged(fx.extraPrices));

    if (seg[0] === "booking" && seg.length === 1 && m === "GET") {
      const keyToName = { 1: "not_invoiced", 2: "invoiced", 3: "confirmed", 4: "cancelled", 5: "declined", 6: "amended", 7: "reserved", 8: "cancelled_reallocate", 9: "error", 10: "sold_out", 11: "abandoned", 12: "calendar_conflict" };
      const has = (k) => q.has(k);
      const cmp = (field, op, v) => (op === "" ? field === v : op === "__gt" ? field > v : op === "__gte" ? field >= v : op === "__lt" ? field < v : field <= v);
      const contains = (a, b) => String(a ?? "").toLowerCase().includes(String(b).toLowerCase());
      const items = fx.bookings.filter((b) => {
        for (const f of ["arrive", "depart"]) for (const op of ["", "__gt", "__gte", "__lt", "__lte"]) if (has(f + op) && !cmp(b[f], op, q.get(f + op))) return false;
        if (has("status") && b.status !== keyToName[q.get("status")]) return false;
        if (has("first_name") && !contains(b.first_name, q.get("first_name"))) return false;
        if (has("last_name") && !contains(b.last_name, q.get("last_name"))) return false;
        if (has("campsite") && b.campsite !== q.get("campsite")) return false;
        if (has("pitch") && idOf(b.pitch) !== q.get("pitch")) return false;
        if (has("external_id") && b.external_id !== q.get("external_id")) return false;
        if (has("after") && b.created < q.get("after")) return false;
        if (has("before") && b.created >= q.get("before")) return false;
        if (has("modified_after") && b.modified < q.get("modified_after")) return false;
        if (has("modified_before") && b.modified >= q.get("modified_before")) return false;
        return true;
      });
      return send(200, paged(items, { cursor: true }));
    }

    if (seg.length === 0 || ["campsite", "pitchtype", "pitch", "chargetype", "arrival", "allocation", "extra", "extraprice", "booking"].includes(seg[0])) {
      if (seg.length <= 2) return send(405, detail(`Method "${m}" not allowed.`));
    }
    return notFound();
  });

  const arm = ({ method, path, status, times = 1, headers, body }) => failures.push({ method, path, status, times, headers, body });
  const disarm = () => {
    failures = [];
    foreignNext = false;
    pitchTypeAsObject = false;
    htmlOn200 = false;
    pitchTypeAnswer = undefined;
  };
  const set = (opts) => {
    if ("foreignNext" in opts) foreignNext = opts.foreignNext;
    if ("pitchTypeAsObject" in opts) pitchTypeAsObject = opts.pitchTypeAsObject;
    if ("htmlOn200" in opts) htmlOn200 = opts.htmlOn200;
    if ("pitchTypeAnswer" in opts) pitchTypeAnswer = opts.pitchTypeAnswer;
  };
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, port: server.address().port, origin, requests, arm, disarm, set });
    }),
  );
}
