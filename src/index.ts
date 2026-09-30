#!/usr/bin/env node
// Pitchup.com MCP server: lets Claude, ChatGPT and other MCP clients work with a campsite's
// Pitchup.com supplier account (pitch types, pitches, prices, allocation, extras, bookings).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PitchupClient, PitchupError } from "./client.js";
import { readConfig, ConfigError, type Config } from "./config.js";
import * as fmt from "./format.js";

let config: Config;
try {
  config = readConfig(process.env);
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : String(err));
  process.exit(1);
}
const envLabel = config.env === "custom" ? "PITCHUP_BASE_URL" : `the ${config.env} environment`;
const api = new PitchupClient(config.apiKey, config.baseUrl, config.apiVersion, envLabel);

const server = new McpServer(
  { name: "pitchup", version: "0.1.0" },
  {
    instructions: [
      "Tools for a campsite's Pitchup.com supplier account: campsites, pitch types, pitches, charge types, prices (arrival days), allocation, extras and bookings.",
      "Campsites are identified by slug; pitch types, pitches and charge types by numeric ID; bookings by an 8-character pretty_id.",
      "Prices live on arrival days (get_pricing); how many pitches can still be sold per night lives on allocation days (list_allocations, check_availability).",
      "Typical flow for 'who is arriving today?': list_arrivals with today's date. For 'what came in since yesterday?': list_bookings with modified_after.",
      "Guest emails, phone numbers, addresses, vehicle registrations and party member names (the structured booking fields) are only returned with include_contact_details. Free text such as special requests is returned by default with emails, phone numbers, UK postcodes and UK registrations redacted; campsites can ask guests to write their vehicle registration and party names there, and names and street addresses in free text are not redacted. Card and payment-processor details are never returned.",
      `This server talks to ${envLabel} (${config.baseUrl}) using API version ${config.apiVersion}.`,
    ].join("\n"),
  },
);

const READ = { readOnlyHint: true, openWorldHint: true } as const;
// Every write here overwrites existing values (allocation days, prices, charge type fields), so all
// of them are marked destructive; sending the same request twice gives the same end state.
const OVERWRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof PitchupError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}` }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err);
  }
};

// ---- Input rules ----
// Path IDs are typed `number` in the spec (pk, chargetype_id); every example is a positive integer.
const id = (what: string) => z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe(`${what} ID (a positive whole number)`);
// Campsite slugs in the guide's examples: billy_bobs, some-campsite, cambridge_holiday_bookings.
const slug = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, "Campsite slugs are letters, digits, _ and -, e.g. some-campsite");
const realDate = (s: string) => {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates are YYYY-MM-DD").refine(realDate, "Not a real calendar date");
// Booking before/after filters: "It's a datetime filter so you can also use time, for example after=2020-02-07%2011:50:35".
const dateOrTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/, "Use YYYY-MM-DD or YYYY-MM-DD HH:MM[:SS]")
  .refine(realDate, "Not a real calendar date");
const decimal = z.string().regex(/^\d{1,7}(?:\.\d{1,2})?$/, 'Prices are decimal strings such as "10.50"');
const includeContact = z.boolean().default(false);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const listNote = (r: { complete: boolean; items: unknown[] }, how = "narrow the filters or raise max_results") =>
  r.complete ? undefined : `Stopped after ${r.items.length} records; more exist. To see them, ${how}.`;

/**
 * Cut a list that this server filtered itself to max_results. `complete` is true only when Pitchup
 * had nothing more to give and nothing matching was cut off, and the note says which of the two
 * happened.
 */
function capList<T>(r: { complete: boolean; items: unknown[] }, matching: T[], maxResults: number, locallyFiltered: boolean, how = "narrow the filters or raise max_results") {
  const items = matching.slice(0, maxResults);
  const cut = matching.length > maxResults;
  const complete = r.complete && !cut;
  let note: string | undefined;
  if (cut) note = `Stopped after ${items.length} records; more exist. To see them, ${how}.`;
  else if (!r.complete) {
    note = locallyFiltered
      ? `Only the first ${r.items.length} records from Pitchup were read before stopping, and more exist, so further matches may be missing. To see them, ${how}.`
      : listNote(r, how);
  }
  return { items, complete, note };
}

/**
 * GET /pitchtype/{pk}/. The spec documents this response as a list (next/previous/results); a single
 * object is accepted too. Either way the record must carry the ID asked for: a list holding some other
 * pitch type, or an object with another ID, is treated as not found, so no tool ever reports on (or
 * writes to) a pitch type that was not requested.
 */
async function fetchPitchType(pk: number): Promise<Record<string, any>> {
  const res = await api.get(`/pitchtype/${pk}/`);
  const record = res && Array.isArray(res.results) ? res.results.find((p: any) => Number(p?.id) === pk) : res && !Array.isArray(res) && Number(res.id) === pk ? res : undefined;
  if (!record) {
    throw new PitchupError(`Not found: /pitchtype/${pk}/. Pitchup answered, but not with pitch type ${pk}; nothing was done with the record it returned. Check the ID (list_pitch_types shows them).`, 404);
  }
  return record;
}

// ---- Read tools ----

server.registerTool(
  "api_root",
  {
    title: "API root",
    description: "The resources this API key can reach (GET /rest/api/), plus which Pitchup environment and API version this server is using. A quick way to check the key works.",
    inputSchema: {},
    annotations: READ,
  },
  safe(async () => {
    const res = await api.get("/");
    // The guide's example is a one-element array around the object; the spec's schema is the object.
    const root = Array.isArray(res) ? res[0] ?? {} : res;
    return { environment: config.env, base_url: config.baseUrl, api_version: config.apiVersion, writes_enabled: config.allowWrites, resources: Object.keys(root ?? {}).sort() };
  }),
);

server.registerTool(
  "list_campsites",
  {
    title: "List campsites",
    description: "The campsites on this Pitchup account: slug, name, state (settingup, bookable...), currency, categories, pitch type IDs and availability. The campsite's own email, phone and address only with include_contact_details.",
    inputSchema: {
      max_results: z.number().int().min(1).max(500).default(100),
      include_contact_details: includeContact.describe("Include the campsite's email, manager email, phone numbers and postal address"),
    },
    annotations: READ,
  },
  safe(async ({ max_results, include_contact_details }) => {
    const r = await api.list("/campsite/", { maxItems: max_results });
    return { count: r.items.length, complete: r.complete, note: listNote(r), campsites: r.items.map((c) => fmt.campsite(c, include_contact_details)) };
  }),
);

server.registerTool(
  "get_campsite",
  {
    title: "Get a campsite",
    description: "One campsite by slug: state, currency, pitch types, languages, child and infant age limits, arrival and departure times, opening dates, rating, notices and policies. Payment settings are never returned.",
    inputSchema: {
      slug: slug.describe("Campsite slug (from list_campsites)"),
      include_contact_details: includeContact.describe("Include the campsite's email, manager email, phone numbers and postal address, and stop redacting emails, phone numbers, UK postcodes and UK registrations in notices and policies"),
    },
    annotations: READ,
  },
  safe(async ({ slug, include_contact_details }) => ({ campsite: fmt.campsite(await api.get(`/campsite/${slug}/`), include_contact_details, true) })),
);

server.registerTool(
  "list_pitch_types",
  {
    title: "List pitch types",
    description: "Pitch types (for example an electric grass pitch, a bell tent or a static caravan) with capacity, persons included, pricing method, number of pitches, lead price, facilities and the IDs of their charge types and pitches. Optionally only those of one campsite.",
    inputSchema: {
      campsite: slug.optional().describe("Only pitch types of this campsite (slug). Filtered by this server, on the campsite link of each pitch type."),
      max_results: z.number().int().min(1).max(1000).default(200),
    },
    annotations: READ,
  },
  safe(async ({ campsite, max_results }) => {
    // GET /rest/api/pitchtype/ is documented in the guide's "Pitch type" section and linked from the API root.
    const r = await api.list("/pitchtype/", { maxItems: campsite ? 2000 : max_results });
    const all = r.items.map((p) => fmt.pitchType(p));
    const out = capList(r, campsite ? all.filter((p) => p.campsite === campsite) : all, max_results, !!campsite);
    return { count: out.items.length, complete: out.complete, note: out.note, pitch_types: out.items };
  }),
);

server.registerTool(
  "get_pitch_type",
  {
    title: "Get a pitch type",
    description: "One pitch type by ID, with its charge type and pitch IDs, capacity, pricing method and facilities.",
    inputSchema: { pitch_type_id: id("Pitch type") },
    annotations: READ,
  },
  safe(async ({ pitch_type_id }) => ({ pitch_type: fmt.pitchType(await fetchPitchType(pitch_type_id)) })),
);

server.registerTool(
  "list_pitches",
  {
    title: "List pitches",
    description:
      "Individual pitches (units) with their pitch type, name, whether Pitchup may book them, priority, your external ID and calendar sync status. Optionally only one pitch type, or the pitch with a given external_id. Calendar feed links (the Pitchup feed carries guests' contact details) only with include_contact_details.",
    inputSchema: {
      pitch_type_id: id("Pitch type").optional().describe("Only pitches of this pitch type (filtered by this server)"),
      external_id: z.string().min(1).max(200).optional().describe("Your own reference for the pitch; passed to the API as the documented external_id filter"),
      max_results: z.number().int().min(1).max(2000).default(500),
      include_contact_details: includeContact.describe("Include the calendar feed links and unredacted notes"),
    },
    annotations: READ,
  },
  safe(async ({ pitch_type_id, external_id, max_results, include_contact_details }) => {
    const r = await api.list("/pitch/", { query: { external_id }, maxItems: pitch_type_id ? 5000 : max_results, maxPages: pitch_type_id ? 50 : 20 });
    const all = r.items.map((p) => fmt.pitch(p, include_contact_details));
    const out = capList(r, pitch_type_id ? all.filter((p) => p.pitch_type_id === pitch_type_id) : all, max_results, !!pitch_type_id);
    return { count: out.items.length, complete: out.complete, note: out.note, pitches: out.items };
  }),
);

server.registerTool(
  "list_charge_types",
  {
    title: "List charge types",
    description: "Charge types (tariffs such as Standard or Weekly) with their pitch type, active flag and status. Prices for each are read with get_pricing.",
    inputSchema: {
      pitch_type_id: id("Pitch type").optional().describe("Only charge types of this pitch type (filtered by this server)"),
      max_results: z.number().int().min(1).max(1000).default(200),
    },
    annotations: READ,
  },
  safe(async ({ pitch_type_id, max_results }) => {
    const r = await api.list("/chargetype/", { maxItems: pitch_type_id ? 2000 : max_results });
    const all = r.items.map(fmt.chargeType);
    const out = capList(r, pitch_type_id ? all.filter((c) => c.pitch_type_id === pitch_type_id) : all, max_results, !!pitch_type_id);
    return { count: out.items.length, complete: out.complete, note: out.note, charge_types: out.items };
  }),
);

server.registerTool(
  "get_charge_type",
  {
    title: "Get a charge type",
    description: "One charge type by ID.",
    inputSchema: { charge_type_id: id("Charge type") },
    annotations: READ,
  },
  safe(async ({ charge_type_id }) => ({ charge_type: fmt.chargeType(await api.get(`/chargetype/${charge_type_id}/`)) })),
);

server.registerTool(
  "get_pricing",
  {
    title: "Get prices and stay rules",
    description:
      "Prices and stay rules from arrival days (GET /rest/api/arrival/): for each date and charge type, the pitch price and extra adult, child and infant prices, the pricing period, minimum and maximum stay, closed to arrival or departure, status, and pitches sold and left. The API only returns future arrival days. Filter by date (one day) or after/before, and by charge type or pitch type.",
    inputSchema: {
      date: isoDate.optional().describe("One date (documented `date` filter)"),
      after: isoDate.optional().describe("Documented `after` filter, sent as given"),
      before: isoDate.optional().describe("Documented `before` filter, sent as given"),
      charge_type_id: id("Charge type").optional().describe("Only this charge type (filtered by this server)"),
      pitch_type_id: id("Pitch type").optional().describe("Only the charge types of this pitch type (looked up first, then filtered by this server)"),
      max_results: z.number().int().min(1).max(2000).default(500),
    },
    annotations: READ,
  },
  safe(async ({ date, after, before, charge_type_id, pitch_type_id, max_results }) => {
    let wanted: Set<number> | undefined;
    if (pitch_type_id) wanted = new Set(fmt.pitchType(await fetchPitchType(pitch_type_id)).charge_type_ids);
    if (charge_type_id) wanted = wanted ? new Set([...wanted].filter((c) => c === charge_type_id)) : new Set([charge_type_id]);
    const filtered = wanted !== undefined;
    const r = await api.list("/arrival/", { query: { date, after, before }, maxItems: filtered ? 5000 : max_results, maxPages: filtered ? 50 : 20 });
    const days = r.items.map(fmt.arrivalDay).filter((d) => !wanted || (d.charge_type_id !== undefined && wanted.has(d.charge_type_id)));
    const out = capList(r, days, max_results, filtered, "narrow the dates or raise max_results");
    return { count: out.items.length, complete: out.complete, note: out.note, arrival_days: out.items };
  }),
);

const statusNames = Object.keys(fmt.BOOKING_STATUS_KEYS) as [fmt.BookingStatus, ...fmt.BookingStatus[]];
// The booking filters the guide lists under "Filtering bookings" and "Filtering API GET requests".
const bookingFilters = {
  after: dateOrTime.optional().describe("Created after (documented `after`, which filters on the creation date of the booking; whether the given time itself is included is not documented)"),
  before: dateOrTime.optional().describe("Created before (documented `before`; whether the given time itself is included is not documented)"),
  modified_after: dateOrTime.optional().describe("Modified after: new bookings, amendments and cancellations (documented `modified_after`)"),
  modified_before: dateOrTime.optional().describe("Modified before (documented `modified_before`)"),
  arrive: isoDate.optional().describe("Arrival date equals"),
  arrive__gt: isoDate.optional().describe("Arrival date after"),
  arrive__gte: isoDate.optional().describe("Arrival date on or after"),
  arrive__lt: isoDate.optional().describe("Arrival date before"),
  arrive__lte: isoDate.optional().describe("Arrival date on or before"),
  depart: isoDate.optional().describe("Departure date equals"),
  depart__gt: isoDate.optional().describe("Departure date after"),
  depart__gte: isoDate.optional().describe("Departure date on or after"),
  depart__lt: isoDate.optional().describe("Departure date before"),
  depart__lte: isoDate.optional().describe("Departure date on or before"),
  status: z.enum(statusNames).optional().describe("Booking status; sent as its documented numeric key (confirmed = 3, reserved = 7, ...)"),
  first_name: z.string().min(1).max(100).optional().describe("First name contains"),
  last_name: z.string().min(1).max(100).optional().describe("Last name contains"),
  campsite: slug.optional().describe("Campsite slug"),
  pitch: id("Pitch").optional().describe("Pitch ID"),
  external_id: z.string().min(1).max(200).optional().describe("Your own reference for the booking"),
};

server.registerTool(
  "list_bookings",
  {
    title: "List bookings",
    description:
      "Bookings (Pitchup bookings and your Reserved external bookings) with dates, status, lead guest name, party size, pitch, unit, extras, special requests and amounts. Every documented filter is available: creation and modification dates, arrival and departure dates (equals, gt, gte, lt, lte), status, first/last name, campsite, pitch, external_id. Guest emails, phones and addresses only with include_contact_details (in free text, emails, phone numbers, UK postcodes and UK registrations are redacted by default; names and street addresses are not); card details never.",
    inputSchema: {
      ...bookingFilters,
      max_results: z.number().int().min(1).max(2000).default(200),
      include_contact_details: includeContact.describe("Include the structured guest email, telephone, postal address, other party members' names, vehicle registration and children's ages, and stop redacting emails, phone numbers, UK postcodes and UK registrations in free text. Without it, special requests are still returned: campsites can ask guests to write the vehicle registration and party names there, and names and street addresses in free text are not redacted"),
    },
    annotations: READ,
  },
  safe(async ({ max_results, include_contact_details, status, pitch, ...filters }) => {
    const query = { ...filters, status: status ? fmt.BOOKING_STATUS_KEYS[status] : undefined, pitch };
    const r = await api.list("/booking/", { query, maxItems: max_results, maxPages: 40 });
    return { count: r.items.length, complete: r.complete, note: listNote(r), bookings: r.items.map((b) => fmt.booking(b, include_contact_details)) };
  }),
);

// Compared in lower case: the status values list and the 2019-01-21 changelog write `confirmed`, but
// the booking response table's example value is "Confirmed".
const STAYING = new Set(["confirmed", "reserved"]);

server.registerTool(
  "list_arrivals",
  {
    title: "Who arrives on a date",
    description:
      "Guests arriving on one date (bookings with that arrival date), with lead guest name, party size, pitch type and pitch, unit, estimated arrival time and special requests, plus totals. By default only confirmed (Pitchup) and reserved (external) bookings are listed; the rest are counted. The dog total only counts bookings that carry a dog count (the guide lists `party.dogs` as a prerelease addition) and is null when none does. Structured guest contact details only with include_contact_details; special requests are returned with emails, phone numbers, UK postcodes and UK registrations redacted, but names and street addresses in them are not.",
    inputSchema: {
      date: isoDate.describe("Arrival date"),
      campsite: slug.optional().describe("Campsite slug, if the account has several"),
      include_all_statuses: z.boolean().default(false).describe("Also list cancelled, declined, abandoned and other non-staying bookings"),
      include_contact_details: includeContact.describe("Include the structured guest email, telephone, address, party member names, vehicle registration and children's ages, and stop redacting emails, phone numbers, UK postcodes and UK registrations in free text"),
    },
    annotations: READ,
  },
  safe(async ({ date, campsite, include_all_statuses, include_contact_details }) => {
    const r = await api.list("/booking/", { query: { arrive: date, campsite }, maxItems: 2000, maxPages: 40 });
    const all = r.items.map((b) => fmt.booking(b, include_contact_details));
    const arrivals = all.filter((b) => include_all_statuses || STAYING.has(String(b.status ?? "").toLowerCase()));
    arrivals.sort((a, b) => (a.pitch_type_id ?? 0) - (b.pitch_type_id ?? 0) || String(a.guest_name ?? "").localeCompare(String(b.guest_name ?? "")));
    const sum = (k: "adults" | "children" | "infants" | "dogs") => arrivals.reduce((s, b) => s + (b.party[k] ?? 0), 0);
    // `dogs` in `party` is listed under "What's new in version prerelease", and this server pins a
    // dated version by default, so a missing dog count means "not reported", not zero.
    const noDogCount = arrivals.filter((b) => b.party.dogs === undefined).length;
    const skipped = all.length - arrivals.length;
    return {
      date,
      arrivals: arrivals.length,
      totals: { adults: sum("adults"), children: sum("children"), infants: sum("infants"), dogs: arrivals.length > 0 && noDogCount === arrivals.length ? null : sum("dogs") },
      complete: r.complete,
      note:
        [
          skipped ? `${skipped} booking(s) with other statuses (${[...new Set(all.filter((b) => !arrivals.includes(b)).map((b) => b.status))].join(", ")}) not listed; set include_all_statuses to see them.` : "",
          noDogCount
            ? noDogCount === arrivals.length
              ? "Pitchup sent no dog count for these bookings (party.dogs is documented as a prerelease addition), so the number of dogs is unknown."
              : `Pitchup sent no dog count for ${noDogCount} of these bookings (party.dogs is documented as a prerelease addition), so the dog total counts only the others.`
            : "",
          listNote(r) ?? "",
        ]
          .filter(Boolean)
          .join(" ") || undefined,
      bookings: arrivals,
    };
  }),
);

server.registerTool(
  "list_allocations",
  {
    title: "List allocation days",
    description: "Allocation days: for each date and pitch type, the maximum number of pitches Pitchup may sell (max_allocation) and how many are left to sell. A date with no allocation day has no allocation. Filter by date or after/before, and by pitch type.",
    inputSchema: {
      date: isoDate.optional().describe("One date. `date` is named in the guide's general filtering section; not confirmed for allocation days"),
      after: isoDate.optional().describe("Sent as `after`, a filter named in the guide's general filtering section; not confirmed for allocation days, and whether the date itself is included is not documented"),
      before: isoDate.optional().describe("Sent as `before`, a filter named in the guide's general filtering section; not confirmed for allocation days, and whether the date itself is included is not documented"),
      pitch_type_id: id("Pitch type").optional().describe("Only this pitch type (filtered by this server)"),
      max_results: z.number().int().min(1).max(3000).default(500),
    },
    annotations: READ,
  },
  safe(async ({ date, after, before, pitch_type_id, max_results }) => {
    const r = await api.list("/allocation/", { query: { date, after, before }, maxItems: pitch_type_id ? 10000 : max_results, maxPages: pitch_type_id ? 100 : 30 });
    const days = r.items.map(fmt.allocationDay).filter((d) => !pitch_type_id || d.pitch_type_id === pitch_type_id);
    const out = capList(r, days, max_results, !!pitch_type_id, "narrow the dates or raise max_results");
    return { count: out.items.length, complete: out.complete, note: out.note, allocation_days: out.items };
  }),
);

server.registerTool(
  "check_availability",
  {
    title: "Check allocation for a stay",
    description:
      "For one pitch type and a stay (arrive to depart), the allocation of every night and the arrival-day rules on the arrival date for that pitch type's charge types. The guide says a stay is bookable when every night has allocation, a pitch is free for the whole stay and prices cover the period: this tool checks the first and shows the arrival-date rules, but does not reproduce Pitchup's pitch assignment or price calculation.",
    inputSchema: {
      pitch_type_id: id("Pitch type"),
      arrive: isoDate.describe("Arrival date"),
      depart: isoDate.describe("Departure date (the last night is the day before)"),
    },
    annotations: READ,
  },
  safe(async ({ pitch_type_id, arrive, depart }) => {
    const nights: string[] = [];
    for (let d = arrive; d < depart && nights.length <= 90; d = addDays(d, 1)) nights.push(d);
    if (nights.length === 0) throw new PitchupError("depart must be after arrive.");
    if (nights.length > 90) throw new PitchupError("Stays longer than 90 nights are not checked; split the range.");
    const pt = fmt.pitchType(await fetchPitchType(pitch_type_id));
    // Whether `after`/`before` include the given date is not documented, so the window asked for is
    // one day wider on each side and the nights are picked out here.
    // `after`/`before` are named in the guide's general filtering section but not confirmed for
    // allocation days. If Pitchup ignores them, the fetch stops at 30 pages (7.5 s of 250 ms spacing
    // plus response time), to stay within the MCP client's default 60 s timeout, and the result says
    // it is partial.
    const alloc = await api.list("/allocation/", { query: { after: addDays(arrive, -1), before: depart }, maxItems: 3000, maxPages: 30 });
    const byDate = new Map(alloc.items.map(fmt.allocationDay).filter((a) => a.pitch_type_id === pitch_type_id).map((a) => [a.date, a]));
    const perNight = nights.map((date) => {
      const a = byDate.get(date);
      return { date, max_allocation: a?.max_allocation ?? 0, pitches_to_sell: a?.pitches_to_sell ?? 0, has_allocation_day: !!a };
    });
    const arrivalFetch = await api.list("/arrival/", { query: { date: arrive }, maxItems: 2000, maxPages: 20 });
    const arrivalDays = arrivalFetch.items
      .map(fmt.arrivalDay)
      .filter((d) => d.date === arrive && d.charge_type_id !== undefined && pt.charge_type_ids.includes(d.charge_type_id));
    const missing = perNight.filter((n) => !n.has_allocation_day).map((n) => n.date);
    const soldOut = perNight.filter((n) => n.has_allocation_day && !(Number(n.pitches_to_sell) > 0)).map((n) => n.date);
    // A night that was not found may simply not have been read when the allocation list was cut short.
    const unknown = !alloc.complete && missing.length > 0 && soldOut.length === 0;
    return {
      pitch_type: { id: pt.id, name: pt.name, charge_type_ids: pt.charge_type_ids },
      arrive,
      depart,
      nights: nights.length,
      allocation_ok_every_night: unknown ? null : missing.length === 0 && soldOut.length === 0,
      nights_without_allocation_day: missing,
      nights_with_nothing_left_to_sell: soldOut,
      allocation_complete: alloc.complete,
      per_night: perNight,
      arrival_days_on_arrival_date: arrivalDays,
      arrival_days_complete: arrivalFetch.complete,
      note:
        (alloc.complete ? "" : `Pitchup had more allocation days than the ${alloc.items.length} read, so nights listed without an allocation day may simply not have been read. `) +
        (arrivalDays.length === 0 ? (arrivalFetch.complete ? "No arrival day exists on the arrival date for this pitch type's charge types, so Pitchup has no price for a stay starting that day. " : "No arrival day for this pitch type's charge types was found among the arrival days read, and more exist. ") : "") +
        "Pitch-level availability (a single pitch free for every night) and the full price are not checked here.",
    };
  }),
);

server.registerTool(
  "list_extras",
  {
    title: "List extras",
    description: "Extras that can be added to a booking (for example a dog, a cot or an extra car): price, pricing type, pricing period, maximum quantity, compulsory flag and linked charge types. Optionally also the dated prices of extras with variable pricing.",
    inputSchema: {
      include_variable_prices: z.boolean().default(false).describe("Also list dated prices from GET /rest/api/extraprice/"),
      max_results: z.number().int().min(1).max(2000).default(500),
    },
    annotations: READ,
  },
  safe(async ({ include_variable_prices, max_results }) => {
    const r = await api.list("/extra/", { maxItems: max_results });
    const out: Record<string, unknown> = { count: r.items.length, complete: r.complete, note: listNote(r), extras: r.items.map(fmt.extra) };
    if (include_variable_prices) {
      const p = await api.list("/extraprice/", { maxItems: max_results });
      out.variable_prices = p.items.map(fmt.extraPrice);
      out.variable_prices_complete = p.complete;
    }
    return out;
  }),
);

// ---- Write tools (only with PITCHUP_ALLOW_WRITES=true) ----

if (config.allowWrites) {
  server.registerTool(
    "set_allocation",
    {
      title: "Set allocation days",
      description:
        "Set max_allocation (the most pitches Pitchup may sell, including those already booked) for one pitch type on up to 90 dates. Existing allocation days for those dates are overwritten, as documented. Setting 0 stops Pitchup selling that pitch type on that date. Only available when PITCHUP_ALLOW_WRITES=true.",
      inputSchema: {
        pitch_type_id: id("Pitch type"),
        days: z.array(z.object({ date: isoDate, max_allocation: z.number().int().min(0).max(100000) })).min(1).max(90).describe("Dates and the max_allocation for each (at most 90, the documented limit per request)"),
      },
      annotations: OVERWRITE,
    },
    safe(async ({ pitch_type_id, days }) => {
      const dates = new Set(days.map((d) => d.date));
      if (dates.size !== days.length) throw new PitchupError("Not sent: the same date appears twice in days.");
      // The body carries the pitch type as a link; the pitch type's own `url` is used, which also
      // confirms it exists before anything is written.
      const pt = await fetchPitchType(pitch_type_id);
      if (typeof pt.url !== "string" || !pt.url) throw new PitchupError(`Not sent: pitch type ${pitch_type_id} came back without its url.`);
      let ptPath = "";
      try {
        ptPath = new URL(pt.url).pathname;
      } catch {
        /* checked below */
      }
      if (!ptPath.endsWith(`/pitchtype/${pitch_type_id}/`)) throw new PitchupError(`Not sent: pitch type ${pitch_type_id} came back with a url that points to another resource (${pt.url}).`);
      const records = days.map((d) => ({ date: d.date, max_allocation: d.max_allocation, pitchtype: pt.url }));
      // "You can submit a HTTP request containing a list of objects, just send them as a json list."
      const res = await api.request("POST", "/allocation/", { body: records.length === 1 ? records[0] : records });
      const list = Array.isArray(res) ? res : Array.isArray(res?.results) ? res.results : [res];
      return { result: "allocation days saved", allocation_days: list.map(fmt.allocationDay) };
    }),
  );

  server.registerTool(
    "set_pitch_type_allocation",
    {
      title: "Set allocation for a date range",
      description:
        "Set either max_allocation (recommended by Pitchup) or allocation (pitches left to sell) for one pitch type on every date from start to end. Runs as a background job on Pitchup's side and returns its task_id; it should apply within seconds. Overlapping jobs are applied in no guaranteed order. Only available when PITCHUP_ALLOW_WRITES=true.",
      inputSchema: {
        pitch_type_id: id("Pitch type"),
        start: isoDate.describe("First date"),
        end: isoDate.describe("Last date"),
        max_allocation: z.number().int().min(0).max(100000).optional().describe("Maximum pitches Pitchup may sell each day, including booked ones"),
        allocation: z.number().int().min(0).max(100000).optional().describe("Pitches left to sell each day (Pitchup does not recommend this; see its notes on allocation)"),
      },
      annotations: OVERWRITE,
    },
    safe(async ({ pitch_type_id, start, end, max_allocation, allocation }) => {
      if ((max_allocation === undefined) === (allocation === undefined)) throw new PitchupError("Not sent: give exactly one of max_allocation or allocation.");
      if (end < start) throw new PitchupError("Not sent: end is before start.");
      const body = { ...(max_allocation !== undefined ? { max_allocation } : { allocation }), start, end };
      const res = await api.request("POST", `/pitchtype/${pitch_type_id}/allocation/`, { body });
      return { result: "queued", task_id: res?.task_id, start: res?.start ?? start, end: res?.end ?? end, max_allocation: res?.max_allocation, allocation: res?.allocation };
    }),
  );

  server.registerTool(
    "set_pricing",
    {
      title: "Set prices and stay rules for a date range",
      description:
        "Update the prices and stay rules of one charge type on every date from start to end (optionally only some weekdays). Only the fields given are changed, as documented. Prices are decimal strings in the campsite's currency. Runs as a background job and returns its task_id. Only available when PITCHUP_ALLOW_WRITES=true.",
      inputSchema: {
        charge_type_id: id("Charge type"),
        start: isoDate.describe("First date (inclusive)"),
        end: isoDate.describe("Last date (inclusive)"),
        weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional().describe("Days of the week to apply to, Monday = 0 ... Sunday = 6; all days when omitted"),
        price_pitch: decimal.optional().describe("Price per pitch for the pricing period"),
        price_adult: decimal.optional().describe("Price per extra adult"),
        price_child: decimal.optional().describe("Price per extra child"),
        price_infant: decimal.optional().describe("Price per extra infant"),
        pricing_period: z.number().int().min(1).max(365).optional().describe("Number of nights the price covers"),
        min_days: z.number().int().min(1).max(365).optional().describe("Minimum stay for arrivals on these days"),
        max_days: z.number().int().min(1).max(365).optional().describe("Maximum stay for arrivals on these days"),
        closed_to_arrival: z.boolean().optional().describe("Sent as is_soft_close: no arrivals on these days"),
        closed_to_departure: z.boolean().optional().describe("No departures on these days"),
      },
      annotations: OVERWRITE,
    },
    safe(async ({ charge_type_id, start, end, weekdays, closed_to_arrival, ...fields }) => {
      if (end < start) throw new PitchupError("Not sent: end is before start.");
      if (fields.min_days !== undefined && fields.max_days !== undefined && fields.min_days > fields.max_days) throw new PitchupError("Not sent: min_days is greater than max_days.");
      const changes = Object.fromEntries(Object.entries({ ...fields, is_soft_close: closed_to_arrival }).filter(([, v]) => v !== undefined));
      if (Object.keys(changes).length === 0) throw new PitchupError("Not sent: give at least one price or rule to change.");
      const body = { start, end, ...(weekdays ? { weekdays: [...new Set(weekdays)].sort() } : {}), ...changes };
      const res = await api.request("POST", `/chargetype/${charge_type_id}/pricing/`, { body });
      return { result: "queued", task_id: res?.task_id, sent: body };
    }),
  );

  server.registerTool(
    "update_charge_type",
    {
      title: "Update a charge type",
      description:
        "Rename a charge type, change its internal description, or switch its pricing on or off (is_active). The current record is read first and sent back whole with the changes, because the documented update is a PUT. Charge types are never deleted by this server. Only available when PITCHUP_ALLOW_WRITES=true.",
      inputSchema: {
        charge_type_id: id("Charge type"),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).optional().describe("Internal note; not shown to customers"),
        is_active: z.boolean().optional().describe("false disables this charge type's pricing"),
      },
      annotations: OVERWRITE,
    },
    safe(async ({ charge_type_id, name, description, is_active }) => {
      if (name === undefined && description === undefined && is_active === undefined) throw new PitchupError("Not sent: give at least one of name, description or is_active.");
      const cur = await api.get(`/chargetype/${charge_type_id}/`);
      if (typeof cur?.pitchtype !== "string" || typeof cur?.name !== "string") throw new PitchupError(`Not sent: charge type ${charge_type_id} came back without its name or pitch type.`);
      const currentDescription = typeof cur.description === "string" ? cur.description : undefined;
      const body = {
        name: name ?? cur.name,
        ...(description !== undefined ? { description } : currentDescription !== undefined ? { description: currentDescription } : {}),
        pitchtype: cur.pitchtype,
        is_active: is_active ?? Boolean(cur.is_active),
      };
      const res = await api.request("PUT", `/chargetype/${charge_type_id}/`, { body });
      return { result: "updated", charge_type: fmt.chargeType(res ?? {}) };
    }),
  );
}

await server.connect(new StdioServerTransport());
console.error(`Pitchup MCP server running against ${config.baseUrl} (API version ${config.apiVersion}, writes ${config.allowWrites ? "enabled" : "disabled"}).`);
