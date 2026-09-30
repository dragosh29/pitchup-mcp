// End-to-end test: fixtures are validated against Pitchup's published OpenAPI schemas, then the built
// MCP server is driven over stdio by a real MCP client against a local mock of the API.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import { ErrorDetail, withNullableLinks } from "./schemas.mjs";
import { startMock, API_KEY, WRONG_KEY, MESSAGES } from "./mock-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const started = Date.now();
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fixtures match the published spec (so the mock returns what the real API documents).
const SPEC_URL = "https://docs.pitchup.com/api/pitchup-api-openapi.yaml";
if (!existsSync(`${root}spec.yaml`)) {
  try {
    const res = await fetch(SPEC_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(`${root}spec.yaml`, await res.text());
  } catch (err) {
    console.error(`Could not download the Pitchup spec (${err?.cause?.code ?? err.message}). Save it manually:\n  curl -o spec.yaml ${SPEC_URL}`);
    process.exit(1);
  }
}
const spec = parse(readFileSync(`${root}spec.yaml`, "utf8"));
const guide = spec.info.description;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
// The spec uses `format: decimal` (booking dimensions and vat_rate) for decimal strings such as "0.200".
ajv.addFormat("decimal", /^-?\d+(?:\.\d+)?$/);
ajv.addSchema({ $id: "pu", paths: spec.paths, components: spec.components });
const ptr = (...tokens) => "pu#/" + tokens.map((t) => encodeURIComponent(String(t).replace(/~/g, "~0").replace(/\//g, "~1"))).join("/");
// A schema copied out of the spec (to adjust it) keeps its local "#/components/..." refs; point them at the spec.
const rebase = (s) => JSON.parse(JSON.stringify(s).replace(/"\$ref":"#\//g, `"\$ref":"pu#/`));
const compile = (schemaOrRef) => (typeof schemaOrRef === "string" ? ajv.getSchema(schemaOrRef) ?? ajv.compile({ $ref: schemaOrRef }) : ajv.compile(rebase(schemaOrRef)));
const errorsOf = (schema, obj) => {
  const v = compile(schema);
  return v(obj) ? [] : v.errors;
};
const validate = (schema, obj, label) => {
  const errs = errorsOf(schema, obj);
  assert.equal(errs.length, 0, `${label}: ${ajv.errorsText(errs)}`);
};
const component = (name) => ptr("components", "schemas", name);
const response = (path, method, status) => ptr("paths", path, method, "responses", status, "content", "application/json", "schema");
const resolved = (name) => structuredClone(spec.components.schemas[name]);

// Where a component schema and the documented examples disagree on a property's type, the property is
// left out of that component check, the record is validated in full against the operation schema that
// agrees with the examples, and the suite proves the exclusion list is exact: every error the full
// component schema reports is on a listed property, and every listed property does fail.
const validateExcept = (name, records, conflicts, label) => {
  const reduced = resolved(name);
  for (const k of conflicts) delete reduced.properties[k];
  const failing = new Set();
  for (const r of records) {
    validate(reduced, r, `${label} vs ${name} (without ${conflicts.join(", ")})`);
    for (const e of errorsOf(component(name), r)) failing.add(e.instancePath.split("/")[1]);
  }
  assert.deepEqual([...failing].sort(), [...conflicts].sort(), `${name}: the properties that disagree with the fixtures should be exactly ${conflicts.join(", ")}`);
};

const BOOKING_CONFLICTS = ["adults", "extras", "party", "payment_status", "price", "taxes"];
const PITCHTYPE_CONFLICTS = ["ground_type", "lead_price", "pitches"];
const PITCH_CONFLICTS = ["calendar_feeds"];
const validators = {
  campsite: (c) => validate(component("CampsiteBase"), c, `campsite ${c.slug}`),
  pitchType: (p) => validate(ptr("paths", "/rest/api/pitchtype/{pk}/", "get", "responses", "200", "content", "application/json", "schema", "properties", "results", "items"), p, `pitch type ${p.id}`),
  pitch: (p) => validate(response("/rest/api/pitch/", "post", "201"), p, `pitch ${p.id} vs POST /pitch/ response`),
  chargeType: (c) => {
    validate(component("ChargeTypeBase"), c, `charge type ${c.id}`);
    validate(response("/rest/api/chargetype/{chargetype_id}/", "get", "200"), c, `charge type ${c.id} vs GET response`);
  },
  arrival: (a) => {
    validate(ptr("paths", "/rest/api/arrival/", "get", "responses", "200", "content", "application/json", "schema", "properties", "results", "items"), a, `arrival day ${a.id}`);
    validate(component("ArrivalBase"), a, `arrival day ${a.id} vs ArrivalBase`);
  },
  allocation: (a) => validate(component("AllocationBase"), a, `allocation day ${a.id}`),
  extra: (e) => validate(component("ExtraBase"), e, `extra ${e.id}`),
  extraPrice: (e) => validate(component("ExtraPriceBase"), e, `extra price ${e.id}`),
  booking: (b) => validate(response("/rest/api/booking/", "post", "201"), b, `booking ${b.pretty_id} vs POST /booking/ response`),
};

console.log("fixtures vs OpenAPI spec");
await check("root, campsites, pitch types, pitches, charge types, arrival days, allocation days, extras, extra prices, bookings", async () => {
  validate(response("/rest/api/", "get", "200"), fx.root, "API root");
  fx.campsites.forEach(validators.campsite);
  fx.pitchTypes.forEach(validators.pitchType);
  validateExcept("PitchTypeBase", fx.pitchTypes, PITCHTYPE_CONFLICTS, "pitch types");
  fx.pitches.forEach(validators.pitch);
  validateExcept("PitchBase", fx.pitches, PITCH_CONFLICTS, "pitches");
  fx.chargeTypes.forEach(validators.chargeType);
  fx.arrivals.forEach(validators.arrival);
  fx.allocations.forEach(validators.allocation);
  fx.extras.forEach(validators.extra);
  fx.extraPrices.forEach(validators.extraPrice);
  fx.bookings.forEach(validators.booking);
  validateExcept("BookingBase", fx.bookings, BOOKING_CONFLICTS, "bookings");
  // Negative controls: the schemas still reject wrong types, and nullable works as OpenAPI means it.
  assert.ok(errorsOf(component("AllocationBase"), { ...fx.allocations[0], max_allocation: "3" }).length > 0);
  assert.ok(errorsOf(response("/rest/api/booking/", "post", "201"), { ...fx.bookings[0], email: "not-an-email" }).length > 0);
  assert.equal(fx.pitchTypes[1].ground_type, null);
  // The booking example in the guide shows the objects and numbers the fixtures use.
  assert.match(guide, /"party": \{\s*"adults": 2,/);
  assert.match(guide, /"payment_status": \{\s*"card_details"/);
});

// 2. The mock's responses (lists, single records, writes, errors) match the documented schemas.
const mock = await startMock();
const { requests, arm, disarm, set } = mock;
const base = mock.origin;
const raw = async (method, path, { key = API_KEY, body, auth } = {}) => {
  const headers = { Accept: "application/json; version=2023-08-25", "Content-Type": "application/json" };
  if (auth !== null) headers.Authorization = auth ?? `Token ${key}`;
  const res = await fetch(`${base}/rest/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
};
const listOf = async (path, schemaPath, itemCheck) => {
  const r = await raw("GET", path);
  assert.equal(r.status, 200, path);
  validate(withNullableLinks(spec.paths[schemaPath].get.responses["200"].content["application/json"].schema), r.json, `list ${path}`);
  assert.ok(Array.isArray(r.json.results) && r.json.results.length > 0, `${path} has results`);
  r.json.results.forEach(itemCheck);
  return r.json;
};
await check("mock responses match the documented list, detail, write and error shapes", async () => {
  validate(response("/rest/api/", "get", "200"), (await raw("GET", "/")).json, "GET /");
  await listOf("/campsite/", "/rest/api/campsite/", validators.campsite);
  validators.campsite((await raw("GET", "/campsite/meadow-farm/")).json);
  // GET /rest/api/pitchtype/ is documented in the guide's text, not in `paths`; its list shape is the
  // one the spec gives for GET /pitchtype/{pk}/.
  assert.ok(guide.includes("GET https://www.pitchup.com/rest/api/pitchtype/"));
  await listOf("/pitchtype/", "/rest/api/pitchtype/{pk}/", validators.pitchType);
  await listOf("/pitchtype/101/", "/rest/api/pitchtype/{pk}/", validators.pitchType);
  await listOf("/pitch/", "/rest/api/pitch/", validators.pitch);
  await listOf("/chargetype/", "/rest/api/chargetype/", validators.chargeType);
  validators.chargeType((await raw("GET", "/chargetype/1001/")).json);
  const arrivals = await listOf("/arrival/?page_size=100", "/rest/api/arrival/", validators.arrival);
  assert.ok(arrivals.next && arrivals.previous === null && arrivals.results.length === 100);
  await listOf("/allocation/", "/rest/api/allocation/", validators.allocation);
  await listOf("/extra/", "/rest/api/extra/", validators.extra);
  await listOf("/extraprice/", "/rest/api/extraprice/", validators.extraPrice);
  const bookings = await listOf("/booking/", "/rest/api/booking/", validators.booking);
  assert.match(bookings.next, /[?&]cursor=/, "bookings page with a cursor, as in the guide's example");
  // Writes: request bodies from the spec's own examples, responses against the documented schemas.
  const allocExample = spec.paths["/rest/api/allocation/"].post.requestBody.content["application/json"].example;
  validate(response("/rest/api/allocation/", "post", "201"), (await raw("POST", "/allocation/", { body: allocExample })).json, "POST /allocation/");
  const ptAlloc = await raw("POST", "/pitchtype/101/allocation/", { body: spec.paths["/rest/api/pitchtype/{pk}/allocation/"].post.requestBody.content["application/json"].example });
  assert.equal(ptAlloc.status, 201);
  validate(response("/rest/api/pitchtype/{pk}/allocation/", "post", "201"), ptAlloc.json, "POST /pitchtype/{pk}/allocation/");
  const pricing = await raw("POST", "/chargetype/1001/pricing/", { body: spec.paths["/rest/api/chargetype/{chargetype_id}/pricing/"].post.requestBody.content["application/json"].example });
  validate(response("/rest/api/chargetype/{chargetype_id}/pricing/", "post", "201"), pricing.json, "POST pricing");
  const { url, id, status, last_modified, has_availability, pricing: _p, ...putBody } = fx.chargeTypes[0];
  validate(response("/rest/api/chargetype/{chargetype_id}/", "put", "200"), (await raw("PUT", "/chargetype/1001/", { body: putBody })).json, "PUT chargetype");
  // Errors: the documented messages, in the {"detail": ...} shape.
  for (const [label, r, message] of [
    ["no key", await raw("GET", "/campsite/", { auth: null }), MESSAGES.noKey],
    ["wrong key", await raw("GET", "/campsite/", { key: WRONG_KEY }), MESSAGES.badKey],
    ["Token typed twice", await raw("GET", "/campsite/", { auth: `Token Token ${API_KEY}` }), MESSAGES.spaces],
    ["unknown campsite", await raw("GET", "/campsite/nowhere/"), MESSAGES.notFound],
    ["unknown charge type", await raw("GET", "/chargetype/999999/"), MESSAGES.notFound],
    ["method not allowed", await raw("PATCH", "/chargetype/1001/"), 'Method "PATCH" not allowed.'],
  ]) {
    validate(ErrorDetail, r.json, label);
    assert.equal(r.json.detail, message, label);
    assert.ok(guide.includes(message.replace(/"/g, '\\"')) || guide.includes(message), `"${message}" is quoted in the guide`);
    assert.equal(r.status, label.includes("key") || label.includes("Token") ? 401 : label.startsWith("unknown") ? 404 : 405, label);
  }
});
requests.length = 0; // only count what the MCP server does from here on

// 3. Drive the server through MCP. `writes` is the literal PITCHUP_ALLOW_WRITES value; null leaves it unset.
const connect = async (key, writes = "true", extraEnv = {}) => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, PITCHUP_API_KEY: key, PITCHUP_BASE_URL: base, ...extraEnv };
  delete env.PITCHUP_ALLOW_WRITES;
  delete env.PITCHUP_ENV;
  delete env.PITCHUP_API_VERSION;
  if (writes !== null) env.PITCHUP_ALLOW_WRITES = writes;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env, stderr: "ignore" }));
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);
const noSecretsIn = (text, label) => {
  for (const s of fx.CARD_SECRETS) assert.ok(!text.includes(s), `${label}: payment detail ${s} leaked`);
  for (const s of ["stripe_token", "tok_campsite_test", "payment_email", "payments@", "card_types", "mastercard", "payment_advance_days", "payment_timing"]) assert.ok(!text.includes(s), `${label}: campsite payment setting ${s} leaked`);
};

const READ_TOOLS = ["api_root", "check_availability", "get_campsite", "get_charge_type", "get_pitch_type", "get_pricing", "list_allocations", "list_arrivals", "list_bookings", "list_campsites", "list_charge_types", "list_extras", "list_pitch_types", "list_pitches"];
const WRITE_TOOLS = ["set_allocation", "set_pitch_type_allocation", "set_pricing", "update_charge_type"];

const client = await connect(API_KEY);
console.log("mcp tools");

await check("tools/list: 14 read tools marked read-only, 4 write tools marked destructive and idempotent", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
  for (const t of tools) {
    const write = WRITE_TOOLS.includes(t.name);
    assert.equal(t.annotations?.readOnlyHint, !write, `${t.name} readOnlyHint`);
    if (write) assert.deepEqual([t.annotations?.destructiveHint, t.annotations?.idempotentHint], [true, true], `${t.name} hints`);
  }
});

await check("api_root lists the resources and the environment in use", async () => {
  const { data } = await call(client, "api_root");
  assert.deepEqual(data.resources, ["allocation", "arrival", "booking", "campsite", "chargetype", "extra", "extraprice", "pitch", "pitchtype"]);
  assert.equal(data.environment, "custom");
  assert.equal(data.api_version, "2023-08-25");
  assert.equal(requests.at(-1).path, "/rest/api/");
});

await check("campsites: contact details only on request, payment settings never", async () => {
  const { data, text } = await call(client, "list_campsites");
  assert.deepEqual(data.campsites.map((c) => [c.slug, c.state, c.currency]), [["meadow-farm", "bookable", "GBP"], ["hilltop-glamping", "settingup", "GBP"]]);
  assert.deepEqual(data.campsites[0].pitch_type_ids, [101, 102]);
  assert.equal(requests.at(-1).query.page_size, "100", "lists ask for the documented maximum page size");
  assert.ok(!text.includes("@") && !text.includes("01632 960001") && !text.includes("1 Test Lane"), "campsite contact details hidden by default");
  const one = await call(client, "get_campsite", { slug: "meadow-farm" });
  assert.equal(one.data.campsite.notices, "Gate code changes weekly. Call the warden on [phone redacted] after 6pm.");
  assert.equal(one.data.campsite.useful_info, "Questions: [email redacted]");
  assert.equal(one.data.campsite.email, undefined);
  assert.equal(one.data.campsite.camping_depart_by, "11:00:00");
  const withContact = await call(client, "get_campsite", { slug: "meadow-farm", include_contact_details: true });
  assert.deepEqual([withContact.data.campsite.email, withContact.data.campsite.owner_email, withContact.data.campsite.telephone], ["bookings@meadow-farm.example", "owner@meadow-farm.example", "01632 960001"]);
  assert.equal(withContact.data.campsite.address, "1 Test Lane, Testville, Testshire, TE1 2ST");
  for (const t of [text, one.text, withContact.text]) noSecretsIn(t, "campsite");
});

await check("pitch types: list (with campsite filter) and get, in the spec's list shape and as a plain object", async () => {
  const { data } = await call(client, "list_pitch_types");
  assert.deepEqual(data.pitch_types.map((p) => p.id), [101, 102, 201]);
  assert.equal(requests.at(-1).path, "/rest/api/pitchtype/");
  const hill = await call(client, "list_pitch_types", { campsite: "hilltop-glamping" });
  assert.deepEqual(hill.data.pitch_types.map((p) => [p.id, p.pricing_method]), [[201, "per person"]]);
  const one = await call(client, "get_pitch_type", { pitch_type_id: 101 });
  assert.deepEqual([one.data.pitch_type.charge_type_ids, one.data.pitch_type.pitch_ids, one.data.pitch_type.capacity], [[1001, 1002], [5001, 5002, 5003], 6]);
  assert.equal(requests.at(-1).path, "/rest/api/pitchtype/101/");
  set({ pitchTypeAsObject: true });
  const asObject = await call(client, "get_pitch_type", { pitch_type_id: 102 });
  assert.equal(asObject.data.pitch_type.name, "Bell tent - Meadow Farm");
  assert.equal(asObject.data.pitch_type.description, "Sleeps four. Ask about cots: [phone redacted].");
  disarm();
  const cut = await call(client, "list_pitch_types", { campsite: "meadow-farm", max_results: 1 });
  assert.deepEqual([cut.data.count, cut.data.complete], [1, false], "a campsite-filtered list cut by max_results is not complete");
  assert.match(cut.data.note, /^Stopped after 1 records; more exist\./);
  const fits = await call(client, "list_pitch_types", { campsite: "meadow-farm", max_results: 2 });
  assert.deepEqual([fits.data.count, fits.data.complete, fits.data.note], [2, true, undefined]);
});

await check("a GET /pitchtype/{pk}/ answer holding another pitch type is refused: no report on it, and no write to it", async () => {
  const other = fx.pitchTypes[0]; // pitch type 101
  for (const answer of [{ next: null, previous: null, results: [other] }, other]) {
    set({ pitchTypeAnswer: answer });
    const n = requests.length;
    const got = await call(client, "get_pitch_type", { pitch_type_id: 999 });
    assert.ok(got.res.isError, `get_pitch_type accepted ${JSON.stringify(answer).slice(0, 40)}`);
    assert.match(got.text, /^Not found: \/pitchtype\/999\/\. Pitchup answered, but not with pitch type 999/);
    assert.ok(!got.text.includes("Electric grass"));
    for (const [tool, args] of [
      ["set_allocation", { pitch_type_id: 999, days: [{ date: "2027-08-01", max_allocation: 0 }] }],
      ["check_availability", { pitch_type_id: 999, arrive: "2027-07-10", depart: "2027-07-12" }],
      ["get_pricing", { pitch_type_id: 999 }],
    ]) {
      const m = requests.length;
      const r = await call(client, tool, args);
      assert.ok(r.res.isError, `${tool} used another pitch type's record`);
      assert.deepEqual(since(m).map((x) => `${x.method} ${x.path}`), ["GET /rest/api/pitchtype/999/"], `${tool}: nothing after the pitch type lookup`);
    }
    assert.ok(!since(n).some((r) => r.method === "POST"), "no POST");
    disarm();
  }
  // The right ID but a url pointing at another pitch type: set_allocation would post to that one, so it refuses.
  set({ pitchTypeAnswer: { next: null, previous: null, results: [{ ...fx.pitchTypes[1], id: 101 }] } });
  const n = requests.length;
  const wrongUrl = await call(client, "set_allocation", { pitch_type_id: 101, days: [{ date: "2027-08-01", max_allocation: 0 }] });
  assert.ok(wrongUrl.res.isError);
  assert.match(wrongUrl.text, /^Not sent: pitch type 101 came back with a url that points to another resource/);
  assert.deepEqual(since(n).map((x) => x.method), ["GET"]);
  disarm();
});

await check("pitches: calendar links withheld and notes redacted by default; external_id passed through", async () => {
  const { data, text } = await call(client, "list_pitches", { pitch_type_id: 101 });
  assert.deepEqual(data.pitches.map((p) => p.id), [5001, 5002, 5003]);
  assert.equal(data.pitches[0].notes, "By the tap. Warden mobile [phone redacted].");
  assert.equal(data.pitches[0].external_calendar_feeds, 2);
  assert.equal(data.pitches[0].calendar_status, "SUCCESS");
  assert.ok(!text.includes("calendar.example.test") && !text.includes("SIGNATURE-not-real") && !text.includes("cal-test-token"), "feed links hidden by default");
  const withLinks = await call(client, "list_pitches", { pitch_type_id: 101, include_contact_details: true });
  assert.equal(withLinks.data.pitches[0].pitchup_calendar_feed, fx.pitches[0].pitchup_calendar_feed);
  assert.deepEqual(withLinks.data.pitches[0].calendar_feeds, ["https://calendar.example.test/feed/pitch1-extra"]);
  const cut = await call(client, "list_pitches", { pitch_type_id: 101, max_results: 1 });
  assert.deepEqual([cut.data.count, cut.data.complete], [1, false], "a pitch-type-filtered list cut by max_results is not complete");
  assert.match(cut.data.note, /^Stopped after 1 records; more exist\./);
  const byRef = await call(client, "list_pitches", { external_id: "EXT-P5004" });
  assert.deepEqual(byRef.data.pitches.map((p) => p.name), ["Bell tent A"]);
  assert.equal(requests.at(-1).query.external_id, "EXT-P5004");
});

await check("charge types: list by pitch type and get one", async () => {
  const { data } = await call(client, "list_charge_types", { pitch_type_id: 101 });
  assert.deepEqual(data.charge_types.map((c) => [c.id, c.name]), [[1001, "Standard"], [1002, "Weekly"]]);
  const cut = await call(client, "list_charge_types", { pitch_type_id: 101, max_results: 1 });
  assert.deepEqual([cut.data.count, cut.data.complete], [1, false], "a pitch-type-filtered list cut by max_results is not complete");
  assert.match(cut.data.note, /^Stopped after 1 records; more exist\./);
  const one = await call(client, "get_charge_type", { charge_type_id: 2001 });
  assert.deepEqual([one.data.charge_type.is_active, one.data.charge_type.status, one.data.charge_type.pitch_type_id], [false, "inactive", 201]);
});

await check("get_pricing follows next links across three pages to the end and passes date, after and before as documented", async () => {
  let n = requests.length;
  const { data } = await call(client, "get_pricing", { max_results: 2000 });
  assert.equal(data.count, fx.arrivals.length);
  assert.equal(data.complete, true);
  const pages = since(n);
  assert.deepEqual(pages.map((r) => r.query.page ?? "1"), ["1", "2", "3"], "three pages, stopping when next is null");
  assert.ok(pages.every((r) => r.query.page_size === "100"));
  for (let i = 1; i < pages.length; i++) assert.ok(pages[i].t - pages[i - 1].t >= 240, `requests are spaced about 250 ms apart (gap ${pages[i].t - pages[i - 1].t} ms)`);
  n = requests.length;
  const july = await call(client, "get_pricing", { after: "2027-07-09", before: "2027-07-12", charge_type_id: 1001 });
  assert.deepEqual(since(n)[0].query, { after: "2027-07-09", before: "2027-07-12", page_size: "100" });
  assert.deepEqual(july.data.arrival_days.map((d) => [d.date, d.price_pitch, d.closed_to_arrival]), [["2027-07-10", "24.00 GBP", false], ["2027-07-11", "24.00 GBP", true]]);
  const oneDay = await call(client, "get_pricing", { date: "2027-07-10", pitch_type_id: 101 });
  assert.equal(requests.at(-1).query.date, "2027-07-10");
  assert.deepEqual(oneDay.data.arrival_days.map((d) => [d.charge_type_id, d.pricing_period_nights, d.min_days]), [[1001, 1, 1], [1002, 7, 7]], "only the pitch type's charge types");
  const cut = await call(client, "get_pricing", { charge_type_id: 1001, max_results: 3 });
  assert.deepEqual([cut.data.count, cut.data.complete], [3, false], "a charge-type-filtered list cut by max_results is not complete");
  assert.match(cut.data.note, /^Stopped after 3 records; more exist\./);
  const whole = await call(client, "get_pricing", { charge_type_id: 1002, max_results: 5 });
  assert.deepEqual([whole.data.count, whole.data.complete, whole.data.note], [5, true, undefined], "exactly max_results matches is complete");
});

await check("list_bookings pages by cursor to the end and passes every documented filter through exactly", async () => {
  let n = requests.length;
  const { data } = await call(client, "list_bookings");
  assert.equal(data.count, fx.bookings.length);
  assert.equal(data.complete, true);
  const pages = since(n);
  assert.equal(pages.length, 4, "10 bookings in pages of 3");
  assert.equal(pages[0].query.cursor, undefined);
  assert.ok(pages.slice(1).every((r) => r.query.cursor), "later pages come from the next link's cursor");
  const filters = {
    after: "2026-08-01", before: "2026-09-01 11:50:35", modified_after: "2026-09-02", modified_before: "2026-10-01",
    arrive: "2027-07-10", arrive__gt: "2027-07-01", arrive__gte: "2027-07-10", arrive__lt: "2027-07-31", arrive__lte: "2027-07-10",
    depart: "2027-07-13", depart__gt: "2027-07-12", depart__gte: "2027-07-13", depart__lt: "2027-07-14", depart__lte: "2027-07-13",
    first_name: "sa", last_name: "ev", campsite: "meadow-farm", external_id: "EXT-B2",
  };
  for (const [k, v] of Object.entries(filters)) {
    n = requests.length;
    await call(client, "list_bookings", { [k]: v });
    assert.deepEqual(since(n)[0].query, { [k]: v, page_size: "100" }, `filter ${k}`);
    if (k === "before") assert.match(since(n)[0].rawQuery, /before=2026-09-01%2011%3A50%3A35/, "a space in a datetime is sent as %20, as in the guide");
  }
  n = requests.length;
  const confirmed = await call(client, "list_bookings", { status: "confirmed", pitch: 5001 });
  assert.deepEqual(since(n)[0].query, { status: "3", pitch: "5001", page_size: "100" }, "status sent as its documented key, pitch as its ID");
  assert.deepEqual(confirmed.data.bookings.map((b) => b.pretty_id), ["TESTBK01"]);
  // The filter names are taken from the guide, not from this test: the backticked names in "Filtering
  // bookings", the query parameters of its example URLs, and external_id from "Filtering API GET
  // requests". They must be exactly the tool's filter inputs, and each one was sent above.
  const section = guide.slice(guide.indexOf("### Filtering bookings"), guide.indexOf("#### GET booking example"));
  const fromGuide = new Set([...section.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).concat([...section.matchAll(/[?&]([a-z_]+)=/g)].map((m) => m[1])));
  // `slug` there is the campsite field the `campsite` filter takes, not a filter of its own.
  assert.match(section, /filter on `campsite`, using the `slug` field/);
  fromGuide.delete("slug");
  assert.match(guide, /Examples of filter options include:[^\n]*\*external_id\*/);
  fromGuide.add("external_id");
  const { tools } = await client.listTools();
  const inputs = Object.keys(tools.find((t) => t.name === "list_bookings").inputSchema.properties).filter((k) => k !== "max_results" && k !== "include_contact_details");
  assert.deepEqual(inputs.sort(), [...fromGuide].sort(), "the tool's filters are exactly the documented booking filters");
  assert.deepEqual([...Object.keys(filters), "status", "pitch"].sort(), [...fromGuide].sort(), "every documented filter was sent above");
  const cut = await call(client, "list_bookings", { max_results: 2 });
  assert.deepEqual([cut.data.count, cut.data.complete], [2, false]);
  assert.match(cut.data.note, /^Stopped after 2 records; more exist\./);
  const combined = await call(client, "list_bookings", { first_name: "sa", last_name: "ev", arrive: "2027-07-10", modified_after: "2026-09-02" });
  assert.deepEqual(combined.data.bookings.map((b) => b.pretty_id), ["TESTBK01"]);
  assert.ok(requests.at(-1).path === "/rest/api/booking/");
});

await check("bookings: guest contact details redacted by default, returned on request; card details never", async () => {
  const { data, text } = await call(client, "list_bookings", { arrive: "2027-07-10" });
  const sam = data.bookings.find((b) => b.pretty_id === "TESTBK01");
  assert.equal(sam.guest_name, "Sam Evans");
  assert.deepEqual(sam.party, { adults: 2, children: 1, infants: 1, dogs: 1 });
  assert.equal(sam.special_requests, "Arriving late, call [phone redacted] or mail [email redacted]");
  assert.deepEqual(sam.extras, [{ name: "Dog", quantity: 1, price: "9.00 GBP" }]);
  assert.deepEqual([sam.amounts.total, sam.amounts.remainder, sam.payment_status, sam.payment_due_date], ["96.00 GBP", "86.40 GBP", "pending", "2027-06-10"]);
  assert.equal(sam.email, undefined);
  const lee = data.bookings.find((b) => b.pretty_id === "TESTBK04");
  assert.equal(lee.group_name, "Chen family ([email redacted])");
  assert.equal(lee.special_requests, "Office [phone redacted], mobile [phone redacted] or [phone redacted]", "bracketed area code, +44 (0) and 00 forms");
  assert.equal(data.bookings.find((b) => b.pretty_id === "TESTBK03").cancellation_reason, "Customer cancelled by phone from [phone redacted]");
  assert.ok(!/@example\.(com|net)/.test(text), "no guest email in the default output");
  for (const s of ["07700 900123", "+44 7700 900789", "07700 900456", "01632 960777", "960555", "900888", "900999", "2 Test Road", "TE2 3ST", "TE57", "Alex Evans", "4,1"]) assert.ok(!text.includes(s), `${s} leaked by default`);
  noSecretsIn(text, "bookings");
  const full = await call(client, "list_bookings", { arrive: "2027-07-10", include_contact_details: true });
  const samFull = full.data.bookings.find((b) => b.pretty_id === "TESTBK01");
  assert.deepEqual([samFull.email, samFull.telephone, samFull.address, samFull.car_registration_number, samFull.child_ages], ["sam.evans@example.com", "07700 900123", "2 Test Road, Testville, Testshire, TE2 3ST, GB", "TE57 SAM", "4,1"]);
  assert.equal(samFull.special_requests, fx.bookings[0].special_requests);
  noSecretsIn(full.text, "bookings with contact details");
});

await check("bookings: what a campsite requires in special requests (registration, party names) and other typed details, by default and on request", async () => {
  // Pitch type 201 has require_car_registration and require_party_names set: the guide says those go
  // "in the special requests field", which is returned by default.
  assert.deepEqual([fx.pitchTypes[2].require_car_registration, fx.pitchTypes[2].require_party_names], [true, true]);
  const { data, text } = await call(client, "list_bookings", { arrive: "2027-07-25" });
  const kim = data.bookings.find((b) => b.pretty_id === "TESTBK09");
  assert.equal(
    kim.special_requests,
    "Vehicle registration [registration redacted]. Party: Kim Park, Lou Park. Please post the gate code to 3 Test Street, [postcode redacted]. Card [card number redacted] if needed. Mobile [phone redacted]",
    "registration, postcode, card and a mobile without its 0 are redacted; names and the street are not (documented in the README)",
  );
  assert.equal(kim.unit, "Van reg [registration redacted]");
  assert.equal(kim.car_registration_number, undefined);
  for (const s of ["TE68", "TE3 4ST", "4111", "7700900123"]) assert.ok(!text.includes(s), `${s} leaked by default`);
  const full = await call(client, "list_bookings", { arrive: "2027-07-25", include_contact_details: true });
  const kimFull = full.data.bookings.find((b) => b.pretty_id === "TESTBK09");
  assert.equal(kimFull.special_requests, fx.bookings[8].special_requests.replace("4111 1111 1111 1111", "[card number redacted]"), "a card number is redacted even on request");
  assert.equal(kimFull.unit, "Van reg TE68 XYZ");
  assert.ok(!full.text.includes("4111"));
});

await check("list_arrivals: who arrives on a date, confirmed and reserved only by default, with totals", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_arrivals", { date: "2027-07-10" });
  assert.deepEqual(since(n).map((r) => r.query.arrive), ["2027-07-10", "2027-07-10"], "arrive filter kept across pages");
  assert.deepEqual(data.bookings.map((b) => [b.pretty_id, b.status]), [["TESTBK02", "reserved"], ["TESTBK01", "confirmed"], ["TESTBK04", "confirmed"]]);
  assert.deepEqual(data.totals, { adults: 6, children: 1, infants: 1, dogs: 2 });
  assert.match(data.note, /1 booking\(s\) with other statuses \(cancelled\) not listed/);
  const all = await call(client, "list_arrivals", { date: "2027-07-10", include_all_statuses: true, campsite: "meadow-farm" });
  assert.equal(all.data.arrivals, 4);
  assert.equal(requests.at(-1).query.campsite, "meadow-farm");
  assert.ok(!all.text.includes("@example"));
  // "Confirmed" (the response table's example spelling) counts as confirmed; a missing party.dogs is
  // not counted as 0 (dogs is a prerelease addition and the server pins 2023-08-25).
  const mixed = await call(client, "list_arrivals", { date: "2027-07-25" });
  assert.deepEqual(mixed.data.bookings.map((b) => [b.pretty_id, b.status]), [["TESTBK10", "confirmed"], ["TESTBK09", "Confirmed"]]);
  assert.deepEqual(mixed.data.totals, { adults: 4, children: 0, infants: 0, dogs: 2 });
  assert.match(mixed.data.note, /no dog count for 1 of these bookings .*so the dog total counts only the others/);
  const none = await call(client, "list_arrivals", { date: "2027-07-25", campsite: "hilltop-glamping" });
  assert.deepEqual(none.data.bookings.map((b) => b.pretty_id), ["TESTBK09"]);
  assert.equal(none.data.totals.dogs, null);
  assert.match(none.data.note, /so the number of dogs is unknown/);
});

await check("list_allocations: a 429 is retried after Retry-After, then two pages of 100 and the pitch type filter", async () => {
  arm({ method: "GET", path: "/allocation/", status: 429, headers: { "Retry-After": "1" }, body: { detail: "Request was throttled. Expected available in 1 second." } });
  const n = requests.length;
  const { data } = await call(client, "list_allocations", { pitch_type_id: 102 });
  const tries = since(n);
  assert.equal(tries.length, 3, "one 429, then two pages");
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s (waited ${gap} ms)`);
  assert.equal(data.count, 31);
  assert.deepEqual(data.allocation_days[0], { id: data.allocation_days[0].id, date: "2027-07-01", pitch_type_id: 102, max_allocation: 1, pitches_to_sell: 1, has_availability: true });
  const oneDay = await call(client, "list_allocations", { date: "2027-07-16", pitch_type_id: 101 });
  assert.equal(requests.at(-1).query.date, "2027-07-16");
  assert.deepEqual(oneDay.data.allocation_days.map((d) => d.pitches_to_sell), [0]);
  disarm();
  const cut = await call(client, "list_allocations", { pitch_type_id: 102, max_results: 5 });
  assert.deepEqual([cut.data.count, cut.data.complete], [5, false], "a pitch-type-filtered list cut by max_results is not complete");
  assert.match(cut.data.note, /^Stopped after 5 records; more exist\./);
  const control = await call(client, "list_allocations", { max_results: 5 });
  assert.deepEqual([control.data.count, control.data.complete], [5, false]);
});

await check("list pages: a 200 that is JSON but not a list is an error, and an empty page with a next link is followed", async () => {
  arm({ method: "GET", path: "/allocation/", status: 200, body: { detail: "something odd" } });
  let n = requests.length;
  const odd = await call(client, "list_allocations", {});
  assert.ok(odd.res.isError, "not reported as an empty list");
  assert.match(odd.text, /^Pitchup returned 200 for GET \/allocation\/ but the body was not a list \(no results array; keys: detail\)/);
  assert.equal(since(n).length, 1);
  disarm();
  arm({ method: "GET", path: "/allocation/", status: 200, body: { next: `${base}/rest/api/allocation/?page=2&page_size=100`, previous: null, results: [] } });
  n = requests.length;
  const empty = await call(client, "list_allocations", { max_results: 3000 });
  assert.deepEqual(since(n).map((r) => r.query.page ?? "1"), ["1", "2"], "the next link after an empty page is followed");
  assert.deepEqual([empty.data.count, empty.data.complete], [fx.allocations.length - 100, true]);
  disarm();
});

await check("check_availability: every night checked, missing and sold-out nights named, arrival-day rules shown", async () => {
  let n = requests.length;
  const good = await call(client, "check_availability", { pitch_type_id: 101, arrive: "2027-07-10", depart: "2027-07-13" });
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), ["GET /rest/api/pitchtype/101/", "GET /rest/api/allocation/", "GET /rest/api/arrival/"]);
  assert.deepEqual([since(n)[1].query.after, since(n)[1].query.before], ["2027-07-09", "2027-07-13"], "window one day wider, since after/before inclusiveness is undocumented");
  assert.equal(good.data.allocation_ok_every_night, true);
  assert.deepEqual(good.data.per_night.map((x) => [x.date, x.pitches_to_sell]), [["2027-07-10", 1], ["2027-07-11", 3], ["2027-07-12", 3]]);
  assert.deepEqual(good.data.arrival_days_on_arrival_date.map((d) => d.charge_type_id), [1001, 1002]);
  const bad = await call(client, "check_availability", { pitch_type_id: 101, arrive: "2027-07-14", depart: "2027-07-18" });
  assert.equal(bad.data.allocation_ok_every_night, false);
  assert.deepEqual(bad.data.nights_without_allocation_day, ["2027-07-15"]);
  assert.deepEqual(bad.data.nights_with_nothing_left_to_sell, ["2027-07-16"]);
  n = requests.length;
  const backwards = await call(client, "check_availability", { pitch_type_id: 101, arrive: "2027-07-14", depart: "2027-07-14" });
  assert.ok(backwards.res.isError);
  const tooLong = await call(client, "check_availability", { pitch_type_id: 101, arrive: "2027-06-01", depart: "2027-08-31" });
  assert.ok(tooLong.res.isError);
  assert.match(tooLong.text, /longer than 90 nights/);
  assert.equal(requests.length, n, "refused before any call");
  const longest = await call(client, "check_availability", { pitch_type_id: 101, arrive: "2027-06-01", depart: "2027-08-30" });
  assert.ok(!longest.res.isError, longest.text);
  assert.equal(longest.data.nights, 90, "exactly 90 nights is checked");
  assert.equal(longest.data.allocation_complete, true);
  // If Pitchup ignored after/before and kept paging, the fetch stops at 30 pages and says so.
  arm({ method: "GET", path: "/allocation/", status: 200, times: 40, body: { next: `${base}/rest/api/allocation/?page=2&page_size=100`, previous: null, results: [] } });
  n = requests.length;
  const partial = await call(client, "check_availability", { pitch_type_id: 101, arrive: "2027-07-10", depart: "2027-07-13" });
  disarm();
  assert.equal(since(n).filter((r) => r.path === "/rest/api/allocation/").length, 30, "at most 30 allocation pages");
  assert.deepEqual([partial.data.allocation_complete, partial.data.allocation_ok_every_night], [false, null]);
  assert.match(partial.data.note, /^Pitchup had more allocation days than the 0 read, so nights listed without an allocation day may simply not have been read\./);
});

await check("list_extras with variable prices", async () => {
  const { data } = await call(client, "list_extras", { include_variable_prices: true });
  assert.deepEqual(data.extras.map((e) => [e.name, e.price, e.pricing_type]), [["Dog", "3.00 GBP", "per_period"], ["Extra car", "5.00 GBP", "per_stay"], ["Firewood", undefined, "per_item"]]);
  assert.equal(data.extras[1].description, "Book by phone: [phone redacted].");
  assert.deepEqual(data.variable_prices.map((p) => [p.extra_id, p.date, p.price]), [[301, "2027-07-12", "4.00 GBP"], [301, "2027-07-13", "4.00 GBP"]]);
  assert.deepEqual(since(requests.length - 2).map((r) => r.path), ["/rest/api/extra/", "/rest/api/extraprice/"]);
  const capped = await call(client, "list_extras", { include_variable_prices: true, max_results: 1 });
  assert.deepEqual([capped.data.extras.length, capped.data.complete, capped.data.variable_prices.length, capped.data.variable_prices_complete], [1, false, 1, false], "max_results also caps the variable prices");
});

const allocBodySchema = spec.paths["/rest/api/allocation/"].post.requestBody.content["application/json"].schema;
await check("set_allocation reads the pitch type, then posts documented allocation-day bodies (one object, or a list)", async () => {
  let n = requests.length;
  const one = await call(client, "set_allocation", { pitch_type_id: 101, days: [{ date: "2027-08-01", max_allocation: 2 }] });
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), ["GET /rest/api/pitchtype/101/", "POST /rest/api/allocation/"]);
  const body = requests.at(-1).body;
  validate(allocBodySchema, body, "POST /allocation/ body");
  assert.deepEqual(body, { date: "2027-08-01", max_allocation: 2, pitchtype: fx.pitchTypes[0].url });
  assert.equal(requests.at(-1).contentType, "application/json");
  assert.deepEqual(one.data.allocation_days.map((d) => [d.date, d.max_allocation]), [["2027-08-01", 2]]);
  n = requests.length;
  const many = await call(client, "set_allocation", { pitch_type_id: 102, days: [{ date: "2027-08-01", max_allocation: 0 }, { date: "2027-08-02", max_allocation: 1 }] });
  const list = requests.at(-1).body;
  assert.ok(Array.isArray(list) && list.length === 2);
  list.forEach((x) => validate(allocBodySchema, x, "POST /allocation/ list item"));
  assert.equal(many.data.allocation_days.length, 2);
  n = requests.length;
  const dup = await call(client, "set_allocation", { pitch_type_id: 102, days: [{ date: "2027-08-01", max_allocation: 0 }, { date: "2027-08-01", max_allocation: 1 }] });
  assert.ok(dup.res.isError);
  assert.equal(requests.length, n, "a repeated date is refused before any call");
});

await check("set_pitch_type_allocation and set_pricing post bodies that validate against the documented request schemas", async () => {
  const ptSchema = spec.paths["/rest/api/pitchtype/{pk}/allocation/"].post.requestBody.content["application/json"].schema;
  const r1 = await call(client, "set_pitch_type_allocation", { pitch_type_id: 101, start: "2027-08-01", end: "2027-08-31", max_allocation: 3 });
  assert.equal(requests.at(-1).path, "/rest/api/pitchtype/101/allocation/");
  validate(ptSchema, requests.at(-1).body, "pitch type allocation body");
  assert.deepEqual(requests.at(-1).body, { max_allocation: 3, start: "2027-08-01", end: "2027-08-31" });
  assert.equal(r1.data.task_id, "00000000-0000-4000-8000-000000000001");
  await call(client, "set_pitch_type_allocation", { pitch_type_id: 101, start: "2027-08-01", end: "2027-08-02", allocation: 1 });
  validate(ptSchema, requests.at(-1).body, "pitch type allocation body (allocation)");
  assert.deepEqual(requests.at(-1).body, { allocation: 1, start: "2027-08-01", end: "2027-08-02" });
  const n = requests.length;
  for (const bad of [{ start: "2027-08-01", end: "2027-08-02" }, { start: "2027-08-01", end: "2027-08-02", allocation: 1, max_allocation: 1 }, { start: "2027-08-05", end: "2027-08-02", allocation: 1 }]) {
    assert.ok((await call(client, "set_pitch_type_allocation", { pitch_type_id: 101, ...bad })).res.isError, JSON.stringify(bad));
  }
  assert.equal(requests.length, n, "invalid ranges refused before any call");
  const pricingSchema = spec.paths["/rest/api/chargetype/{chargetype_id}/pricing/"].post.requestBody.content["application/json"].schema;
  const r2 = await call(client, "set_pricing", { charge_type_id: 1001, start: "2027-08-01", end: "2027-08-31", weekdays: [6, 5], price_pitch: "26.50", price_adult: "5.00", min_days: 2, max_days: 14, pricing_period: 1, closed_to_arrival: true, closed_to_departure: false });
  const body = requests.at(-1).body;
  validate(pricingSchema, body, "pricing body");
  validate(component("ChargeTypePricingBase"), body, "pricing body vs ChargeTypePricingBase");
  assert.deepEqual(body, { start: "2027-08-01", end: "2027-08-31", weekdays: [5, 6], price_pitch: "26.50", price_adult: "5.00", min_days: 2, max_days: 14, pricing_period: 1, is_soft_close: true, closed_to_departure: false });
  assert.ok(guide.includes("is_soft_close") && guide.includes("closed_to_departure"), "the two rule fields are documented in the guide");
  assert.equal(r2.data.task_id, "00000000-0000-4000-8000-000000000002");
  const m = requests.length;
  assert.ok((await call(client, "set_pricing", { charge_type_id: 1001, start: "2027-08-01", end: "2027-08-31" })).res.isError, "nothing to change");
  assert.ok((await call(client, "set_pricing", { charge_type_id: 1001, start: "2027-08-01", end: "2027-08-31", price_pitch: "£26" })).res.isError, "price must be a decimal string");
  assert.match((await call(client, "set_pricing", { charge_type_id: 1001, start: "2027-08-01", end: "2027-08-31", min_days: 7, max_days: 3 })).text, /min_days is greater than max_days/);
  assert.equal(requests.length, m);
});

await check("update_charge_type reads the charge type, then PUTs the whole documented body; nothing is ever deleted", async () => {
  const n = requests.length;
  const { data } = await call(client, "update_charge_type", { charge_type_id: 1002, is_active: false });
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), ["GET /rest/api/chargetype/1002/", "PUT /rest/api/chargetype/1002/"]);
  const body = requests.at(-1).body;
  validate(spec.paths["/rest/api/chargetype/{chargetype_id}/"].put.requestBody.content["application/json"].schema, body, "PUT body");
  assert.deepEqual(body, { name: "Weekly", description: "Saturday to Saturday", pitchtype: fx.chargeTypes[1].pitchtype, is_active: false });
  assert.deepEqual([data.charge_type.is_active, data.charge_type.status], [false, "inactive"]);
  assert.ok(!requests.some((r) => r.method === "DELETE" || r.method === "PATCH"), "no DELETE or PATCH is ever sent");
});

await check("bad IDs and dates are rejected before any API call; unknown IDs give a clear 404", async () => {
  const before = requests.length;
  for (const [tool, args] of [
    ["get_campsite", { slug: "../booking" }],
    ["get_campsite", { slug: "has space" }],
    ["get_pitch_type", { pitch_type_id: -1 }],
    ["get_pitch_type", { pitch_type_id: 1.5 }],
    ["get_charge_type", { charge_type_id: "1001/pricing" }],
    ["list_bookings", { arrive: "2027-02-30" }],
    ["list_bookings", { after: "yesterday" }],
    ["list_bookings", { status: "paid" }],
    ["list_arrivals", { date: "10/07/2027" }],
    ["set_allocation", { pitch_type_id: 101, days: [] }],
  ]) {
    const bad = await client.callTool({ name: tool, arguments: args });
    assert.ok(bad.isError, `${tool} should reject ${JSON.stringify(args)}`);
  }
  assert.equal(requests.length, before, "no request for invalid input");
  const missing = await call(client, "get_charge_type", { charge_type_id: 999999 });
  assert.ok(missing.res.isError);
  assert.match(missing.text, /^Not found: \/chargetype\/999999\/\. Check the ID or slug \(list tools show them\)\. Not found\.$/);
  const missingSite = await call(client, "get_campsite", { slug: "nowhere" });
  assert.match(missingSite.text, /Not found: \/campsite\/nowhere\//);
});

await check("a 400 is passed on with Pitchup's message, redacted and without the key; 429 waits for fractional and absent Retry-After; a persistent 429 gives up after 3 attempts; a Retry-After above the cap gives up at once", async () => {
  arm({ method: "POST", path: "/chargetype/1001/pricing/", status: 400, body: { non_field_errors: ["Prices must be in the campsites currency"], price_pitch: ["Contact support@pitchup.example or 01632 960999"] } });
  const r400 = await call(client, "set_pricing", { charge_type_id: 1001, start: "2027-08-01", end: "2027-08-02", price_pitch: "1.00" });
  assert.ok(r400.res.isError);
  assert.match(r400.text, /^Pitchup refused POST \/chargetype\/1001\/pricing\/ \(400\)\. Prices must be in the campsites currency; price_pitch: Contact \[email redacted\] or \[phone redacted\]$/);
  disarm();
  const echo = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`field${i}`, [`bad value ${i}, header was Token ${API_KEY}`]]));
  arm({ method: "PUT", path: "/chargetype/1001/", status: 400, body: echo });
  const scrubbed = await call(client, "update_charge_type", { charge_type_id: 1001, name: "Nightly" });
  assert.ok(scrubbed.res.isError);
  assert.ok(!scrubbed.text.includes(API_KEY), "the API key is scrubbed from error messages");
  assert.equal((scrubbed.text.match(/Token \[redacted\]/g) ?? []).length, 6, "at most six messages are passed on");
  disarm();
  for (const [header, min, max] of [["0.5", 450, 1400], [undefined, 1900, 2900]]) {
    arm({ method: "GET", path: "/extra/", status: 429, headers: header ? { "Retry-After": header } : {}, body: { detail: "Request was throttled." } });
    const m = requests.length;
    assert.ok(!(await call(client, "list_extras")).res.isError);
    const gap = since(m)[1].t - since(m)[0].t;
    assert.ok(gap >= min && gap < max, `Retry-After ${header ?? "absent"}: waited ${gap} ms`);
    disarm();
  }
  // No Retry-After: 2 s before the second attempt, 4 s before the third, then give up.
  arm({ method: "GET", path: "/extra/", status: 429, times: 5, body: { detail: "Request was throttled." } });
  let n = requests.length;
  const persistent = await call(client, "list_extras");
  assert.ok(persistent.res.isError);
  const tries = since(n);
  assert.equal(tries.length, 3);
  const gaps = [tries[1].t - tries[0].t, tries[2].t - tries[1].t];
  assert.ok(gaps[0] >= 1900 && gaps[0] < 2900 && gaps[1] >= 3900 && gaps[1] < 4900, `fallback waits of 2 s then 4 s (waited ${gaps.join(", ")} ms)`);
  assert.match(persistent.text, /rate limit reached \(the limit is not documented\)/);
  disarm();
  arm({ method: "GET", path: "/extra/", status: 429, headers: { "Retry-After": "600" }, body: { detail: "Request was throttled." } });
  n = requests.length;
  const long = await call(client, "list_extras");
  assert.equal(since(n).length, 1);
  assert.match(long.text, /asked to wait 600 seconds before retrying GET \/extra\/ \(HTTP 429\)/);
  disarm();
});

await check("an HTTP-date Retry-After is honoured", async () => {
  // HTTP-dates have 1 s resolution, so aim at a whole second 4 to 5 s ahead: after the first request's
  // round trip the wait is 3.5 to 5 s, clearly apart from both "retry at once" and the 2 s fallback.
  arm({ method: "GET", path: "/extra/", status: 429, headers: { "Retry-After": new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() }, body: { detail: "Request was throttled." } });
  const n = requests.length;
  const { res } = await call(client, "list_extras");
  assert.ok(!res.isError);
  const tries = since(n);
  assert.equal(tries.length, 2);
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 3000 && gap < 5600, `retry should wait until the given date (waited ${gap} ms)`);
  disarm();
});

await check("gateway errors: a GET is retried, a write is not (a 429 on a write is); a GET failing 3 times gives advice without the HTML; a non-JSON 200 is an error", async () => {
  arm({ method: "GET", path: "/extraprice/", status: 502, headers: { "Retry-After": "0" } });
  let n = requests.length;
  const retried = await call(client, "list_extras", { include_variable_prices: true });
  assert.ok(!retried.res.isError, retried.text);
  assert.equal(since(n).filter((r) => r.path === "/rest/api/extraprice/").length, 2);
  disarm();
  arm({ method: "POST", path: "/chargetype/1001/pricing/", status: 429, headers: { "Retry-After": "0" }, body: { detail: "Request was throttled." } });
  n = requests.length;
  const limitedWrite = await call(client, "set_pricing", { charge_type_id: 1001, start: "2027-08-01", end: "2027-08-02", price_pitch: "1.00" });
  assert.ok(!limitedWrite.res.isError, limitedWrite.text);
  assert.equal(since(n).length, 2, "a 429 on a write is retried once (a rate-limited request is assumed not processed)");
  disarm();
  arm({ method: "POST", path: "/pitchtype/101/allocation/", status: 503, headers: { "Retry-After": "0" } });
  n = requests.length;
  const write = await call(client, "set_pitch_type_allocation", { pitch_type_id: 101, start: "2027-08-01", end: "2027-08-02", max_allocation: 1 });
  assert.ok(write.res.isError);
  assert.equal(since(n).length, 1, "a write is never retried after a gateway error");
  assert.match(write.text, /returned 503 for POST \/pitchtype\/101\/allocation\/\. The request was not retried because it may already have been processed/);
  disarm();
  arm({ method: "GET", path: "/extra/", status: 503, times: 3, headers: { "Retry-After": "0" } });
  const down = await call(client, "list_extras");
  assert.match(down.text, /returned 503 for GET \/extra\/ 3 times in a row\. The service may be unavailable; try again in a few minutes\.$/);
  assert.ok(!down.text.includes("<html>"));
  disarm();
  set({ htmlOn200: true });
  const html = await call(client, "list_extras");
  assert.ok(html.res.isError);
  assert.match(html.text, /returned 200 for GET \/extra\/ but the body was not JSON \(text\/html, \d+ bytes\)\. Check PITCHUP_BASE_URL/);
  assert.ok(!html.text.includes("support@"), "the page body is not quoted");
  disarm();
});

await check("a next link on another host is not followed, so the key never leaves the configured host", async () => {
  set({ foreignNext: true });
  const n = requests.length;
  const { res, text } = await call(client, "get_pricing", {});
  assert.ok(res.isError);
  assert.equal(since(n).length, 1, "only the first page was fetched");
  assert.match(text, /next-page link for \/arrival\/ on another host \(https:\/\/elsewhere\.example\.test/);
  disarm();
});

await check("every request used the Token header, the pinned API version and a documented method and path", async () => {
  const documented = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).filter((m) => m !== "parameters").map((m) => ({ m: m.toUpperCase(), re: new RegExp("^" + p.replace(/\{[^}]+\}/g, "[^/]+") + "$") })));
  // GET /rest/api/pitchtype/ is documented in the guide's text (checked in step 2), not in `paths`.
  documented.push({ m: "GET", re: /^\/rest\/api\/pitchtype\/$/ });
  assert.ok(requests.length > 60);
  for (const r of requests) {
    assert.equal(r.auth, `Token ${API_KEY}`);
    assert.equal(r.accept, "application/json; version=2023-08-25");
    assert.ok(documented.some((t) => t.m === r.method && t.re.test(r.path)), `undocumented call ${r.method} ${r.path}`);
  }
  const used = new Set(requests.map((r) => `${r.method} ${r.path.replace(/\/\d+\//g, "/{id}/").replace(/\/campsite\/[a-z-]+\//, "/campsite/{slug}/")}`));
  assert.deepEqual([...used].sort(), [
    "GET /rest/api/", "GET /rest/api/allocation/", "GET /rest/api/arrival/", "GET /rest/api/booking/", "GET /rest/api/campsite/", "GET /rest/api/campsite/{slug}/",
    "GET /rest/api/chargetype/", "GET /rest/api/chargetype/{id}/", "GET /rest/api/extra/", "GET /rest/api/extraprice/", "GET /rest/api/pitch/", "GET /rest/api/pitchtype/", "GET /rest/api/pitchtype/{id}/",
    "POST /rest/api/allocation/", "POST /rest/api/chargetype/{id}/pricing/", "POST /rest/api/pitchtype/{id}/allocation/", "PUT /rest/api/chargetype/{id}/",
  ]);
});
await client.close();

await check("writes are off when PITCHUP_ALLOW_WRITES is unset, and when it is 'false'", async () => {
  for (const value of [null, "false"]) {
    const ro = await connect(API_KEY, value);
    const { tools } = await ro.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), READ_TOOLS, `writes exposed with PITCHUP_ALLOW_WRITES ${value === null ? "unset" : `= "${value}"`}`);
    await ro.close();
  }
});

await check("a wrong API key gives an actionable error; a key pasted with its 'Token ' prefix is sent once", async () => {
  const bad = await connect(WRONG_KEY, null);
  const n = requests.length;
  const { res, text } = await call(bad, "list_campsites");
  assert.equal(since(n).length, 1, "a 401 is not retried");
  assert.ok(res.isError);
  assert.match(text, /^Pitchup rejected the API key \(401\)\. Check PITCHUP_API_KEY: it is the key under My details in the Manager Portal, and Sandbox and Live keys are different \(this server is using PITCHUP_BASE_URL, http:\/\/127\.0\.0\.1:\d+\)\. Invalid token\.$/);
  assert.ok(!text.includes(WRONG_KEY));
  await bad.close();
  const prefixed = await connect(`Token ${API_KEY}`, null);
  const ok = await call(prefixed, "api_root");
  assert.ok(!ok.res.isError, ok.text);
  assert.equal(requests.at(-1).auth, `Token ${API_KEY}`);
  await prefixed.close();
});

await check("environment rules: sandbox by default, live on request, bad values refused (checked without any network call)", async () => {
  const { readConfig, BASE_URLS } = await import(`${root}dist/config.js`);
  assert.deepEqual(BASE_URLS, { sandbox: spec.servers[0].url, live: spec.servers[1].url });
  assert.equal(readConfig({ PITCHUP_API_KEY: "k-test" }).baseUrl, "https://www.sandbox.pitchup.com");
  assert.equal(readConfig({ PITCHUP_API_KEY: "k-test", PITCHUP_ENV: "live" }).baseUrl, "https://www.pitchup.com");
  assert.equal(readConfig({ PITCHUP_API_KEY: "k-test", PITCHUP_API_VERSION: "prerelease" }).apiVersion, "prerelease");
  assert.throws(() => readConfig({}), /PITCHUP_API_KEY is not set/);
  assert.throws(() => readConfig({ PITCHUP_API_KEY: "k-test", PITCHUP_ENV: "production" }), /PITCHUP_ENV must be "sandbox" or "live"/);
  assert.throws(() => readConfig({ PITCHUP_API_KEY: "k-test", PITCHUP_BASE_URL: `https://${["user", "pw"].join(":")}@example.test` }), /must not contain a username or password/);
  assert.throws(() => readConfig({ PITCHUP_API_KEY: "k-test", PITCHUP_API_VERSION: "latest" }), /PITCHUP_API_VERSION/);
  assert.equal(readConfig({ PITCHUP_API_KEY: "k-test", PITCHUP_ALLOW_WRITES: "false" }).allowWrites, false);
});

mock.server.close();
console.log(`\n${passed} checks passed, ${requests.length} API calls made against the mock, ${((Date.now() - started) / 1000).toFixed(1)} s.`);
