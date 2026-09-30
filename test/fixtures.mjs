// Fake Pitchup data shaped like the schemas and examples in Pitchup's OpenAPI document (validated in
// e2e.mjs). Every name, email, phone number, token and ID here is invented; phone numbers are in the
// ranges Ofcom reserves for drama (01632 960xxx, 07700 900xxx). Resource links use the sandbox host.
export const HOST = "https://www.sandbox.pitchup.com";
const API = `${HOST}/rest/api`;
const link = (resource, id) => `${API}/${resource}/${id}/`;
const money = (amount) => ({ amount, currency: "GBP" });
const stamp = "2026-09-01T10:00:00.000000Z";

// Dates: fixed future dates, so the suite does not depend on today's date.
const day = (start, n) => new Date(Date.parse(`${start}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const range = (start, end) => {
  const out = [];
  for (let d = start; d <= end; d = day(d, 1)) out.push(d);
  return out;
};

// ---- API root (GET /rest/api/, spec schema: object of resource links) ----
export const root = Object.fromEntries(["allocation", "arrival", "booking", "campsite", "chargetype", "extra", "extraprice", "pitch", "pitchtype"].map((r) => [r, `${API}/${r}/`]));

// ---- Campsites (CampsiteBase) ----
const mkCampsite = (id, slug, name, state, pitchtypes, extra = {}) => ({
  url: link("campsite", slug),
  id,
  name,
  slug,
  state,
  pitchtypes: pitchtypes.map((p) => link("pitchtype", p)),
  currency: "GBP",
  categories: ["tents", "tourers"],
  first_available_date: "2027-06-01",
  has_availability: state === "bookable",
  hierarchy_text: "Testville, Testshire, England, UK",
  languages: ["en-gb"],
  max_child_age: 15,
  max_infant_age: 2,
  path: "uk/england/testshire/testville/",
  rate_count: 12,
  rating: "9.1",
  no_terms: false,
  notices: "Gate code changes weekly. Call the warden on 07700 900111 after 6pm.",
  refund_policy: "within",
  terms: "",
  useful_info: "Questions: warden@meadow-farm.example",
  email: `bookings@${slug}.example`,
  owner_email: `owner@${slug}.example`,
  point: "SRID=4326;POINT (-1.5 52.5)",
  address1: "1 Test Lane",
  address2: "",
  postcode: "TE1 2ST",
  tel: "01632 960001",
  secondary_phone: "01632 960002",
  fax: "",
  timezone: "Europe/London",
  website: `https://${slug}.example`,
  twitter: "",
  youtube: "",
  arrival_time: "",
  camping_arrival_time_from: "14:00:00",
  camping_arrival_time_to: "20:00:00",
  camping_depart_time_from: "11:00:00",
  campsiteopeningdate_set: "[[\"2027-03-15\", \"2027-10-31\"]]",
  camping_require_estimated_time_of_arrival: true,
  onsite_arrival_time_from: "15:00:00",
  onsite_arrival_time_to: "20:00:00",
  onsite_depart_time_from: "10:00:00",
  onsite_require_estimated_time_of_arrival: false,
  open_all_year: "false",
  use_camping_arrival_depart_times: true,
  use_onsite_arrival_depart_times: true,
  advance_when: "before",
  balance_taken: "stripe",
  cancellation_policy: "Full refund up to 14 days before arrival.",
  card_types: ["visa", "mastercard"],
  payment_advance_days: 7,
  payment_email: `payments@${slug}.example`,
  payment_post_days: 0,
  payment_refund_days: 1,
  payment_refund_days_after: 0,
  payment_timing: "arrive",
  payment_type: 4,
  stripe_token: "tok_campsite_test_not_real",
  vat_rate: "0.200",
  booking_reminder_email: true,
  hide_availability: false,
  thermometer_other: "",
  last_modified: stamp,
  version: 1000000000000001,
  primary_photo: `https://${slug}.example/photo.jpg`,
  full_address: "1 Test Lane, Testville, Testshire, TE1 2ST",
  ...extra,
});
export const campsites = [
  mkCampsite(11, "meadow-farm", "Meadow Farm Camping", "bookable", [101, 102]),
  mkCampsite(12, "hilltop-glamping", "Hilltop Glamping", "settingup", [201], { useful_info: "", notices: "" }),
];

// ---- Pitch types (GET /pitchtype/{pk}/ results item; every key it lists as required) ----
const mkPitchType = (id, campsite, name, chargetypes, pitches, extra = {}) => ({
  activation_requested: false,
  allocation: `${API}/pitchtype/${id}/allocation/`,
  bedrooms: 0,
  campsite: link("campsite", campsite),
  capacity: 6,
  cars_included: 1,
  categories: ["tents"],
  chargetypes: chargetypes.map((c) => link("chargetype", c)),
  custom_dimensions: "",
  description: "Level grass with a 16A hook-up.",
  dimensions: "10.0m width x 10.0m length",
  dimensions_type: 2,
  dimensions_unit: "metre",
  dimensionsh_dec: "10.00",
  dimensionsw_dec: "10.00",
  disable_booking_within_hours: 0,
  enforce_special_requests: false,
  ground_type: "Grass",
  has_availability: true,
  has_no_showers: false,
  has_no_toilets: false,
  has_shared_showers: true,
  has_shared_toilets: true,
  id,
  is_active: true,
  is_byo: true,
  last_modified: stamp,
  lead_price: 24,
  lead_price_nights: 1,
  max_pitches_to_sell: pitches.length,
  name,
  one_unit_per_pitch: true,
  original_name: "",
  persons_included: 2,
  pitch_count: pitches.length,
  pitches: pitches.map((p) => link("pitch", p)),
  pricing_method: 1,
  require_car_registration: false,
  require_party_names: false,
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  specific_name: "",
  status: "active",
  subcategories: ["electric-grass-pitch"],
  twin_axle_accepted: true,
  url: link("pitchtype", id),
  ...extra,
});
export const pitchTypes = [
  mkPitchType(101, "meadow-farm", "Electric grass pitch - Meadow Farm", [1001, 1002], [5001, 5002, 5003]),
  mkPitchType(102, "meadow-farm", "Bell tent - Meadow Farm", [1003], [5004], { is_byo: false, categories: ["rent-a-tent"], subcategories: ["bell-tent"], capacity: 4, ground_type: null, lead_price: null, description: "Sleeps four. Ask about cots: 01632 960003." }),
  // This site asks guests to put their vehicle registration and party names in special requests
  // (require_car_registration / require_party_names: "should be included in the special requests field").
  mkPitchType(201, "hilltop-glamping", "Shepherd's hut - Hilltop Glamping", [2001], [5101], { is_byo: false, bedrooms: 1, categories: ["lodges"], subcategories: ["shepherds-hut"], capacity: 2, pricing_method: 2, require_car_registration: true, require_party_names: true }),
];

// ---- Pitches (PitchBase / POST /pitch/ response) ----
const mkPitch = (id, pitchtype, name, extra = {}) => ({
  url: link("pitch", id),
  id,
  pitchtype: link("pitchtype", pitchtype),
  name,
  is_available: true,
  notes: "",
  priority: 1,
  calendar_feed: "",
  calendar_feeds: [],
  calendar_status: "SUCCESS",
  external_id: `EXT-P${id}`,
  pitchup_calendar_feed: `${HOST}/supplier2/pitch/bookings/${id}:SIGNATURE-not-real.ics`,
  ...extra,
});
export const pitches = [
  mkPitch(5001, 101, "Pitch 1", {
    notes: "By the tap. Warden mobile 07700 900222.",
    calendar_feed: "https://calendar.example.test/feed/pitch1?token=cal-test-token-not-real",
    calendar_feeds: ["https://calendar.example.test/feed/pitch1-extra"],
  }),
  mkPitch(5002, 101, "Pitch 2", { priority: 2 }),
  mkPitch(5003, 101, "Pitch 3", { priority: 3, is_available: false }),
  mkPitch(5004, 102, "Bell tent A"),
  mkPitch(5101, 201, "The Hut"),
];

// ---- Charge types (ChargeTypeBase and the GET /chargetype/{id}/ response) ----
const mkChargeType = (id, pitchtype, name, extra = {}) => ({
  name,
  description: "",
  pitchtype: link("pitchtype", pitchtype),
  is_active: true,
  url: link("chargetype", id),
  id,
  status: "active",
  last_modified: stamp,
  has_availability: true,
  pricing: `${API}/chargetype/${id}/pricing/`,
  ...extra,
});
export const chargeTypes = [
  mkChargeType(1001, 101, "Standard", { description: "Nightly rate" }),
  mkChargeType(1002, 101, "Weekly", { description: "Saturday to Saturday" }),
  mkChargeType(1003, 102, "Standard"),
  mkChargeType(2001, 201, "Standard", { is_active: false, status: "inactive", has_availability: false }),
];

// ---- Arrival days (GET /arrival/ results item) ----
let arrivalId = 70000;
const mkArrival = (chargetype, date, price, extra = {}) => ({
  url: link("arrival", ++arrivalId),
  id: arrivalId,
  charge_type: link("chargetype", chargetype),
  date,
  price: money(price),
  price_adult: money("5.00"),
  price_child: money("2.50"),
  price_infant: money("0.00"),
  min_days: 1,
  max_days: 14,
  pricing_period: 1,
  pitches_to_sell: 3,
  pitches_sold: 0,
  has_availability: true,
  last_modified: stamp,
  status: "active",
  status_changed: stamp,
  closed_to_departure: false,
  is_soft_close: false,
  ...extra,
});
export const arrivals = [
  // Nightly Standard for pitch type 101 from May to September: 153 days, so the list spans three pages of 100.
  ...range("2027-05-01", "2027-09-30").map((d) => mkArrival(1001, d, "24.00", d === "2027-07-11" ? { is_soft_close: true } : {})),
  // Weekly tariff on Saturdays in July.
  ...["2027-07-03", "2027-07-10", "2027-07-17", "2027-07-24", "2027-07-31"].map((d) => mkArrival(1002, d, "150.00", { pricing_period: 7, min_days: 7, max_days: 7 })),
  ...range("2027-07-01", "2027-07-31").map((d) => mkArrival(1003, d, "65.00", { min_days: 2 })),
  ...range("2027-07-01", "2027-07-31").map((d) => mkArrival(2001, d, "0.00", { price_adult: money("45.00"), status: d === "2027-07-20" ? "disabled" : "active" })),
];

// ---- Allocation days (AllocationBase) ----
let allocationId = 80000;
const mkAllocation = (pitchtype, date, max, left) => ({
  url: link("allocation", ++allocationId),
  id: allocationId,
  date,
  max_allocation: max,
  pitchtype: link("pitchtype", pitchtype),
  pitches_to_sell: left,
  has_availability: left > 0,
});
export const allocations = [
  // 2027-07-15 has no allocation day for 101 and 2027-07-16 has nothing left to sell.
  ...range("2027-06-01", "2027-09-30")
    .filter((d) => d !== "2027-07-15")
    .map((d) => mkAllocation(101, d, 3, d === "2027-07-16" ? 0 : d === "2027-07-10" ? 1 : 3)),
  ...range("2027-07-01", "2027-07-31").map((d) => mkAllocation(102, d, 1, 1)),
  ...range("2027-07-01", "2027-07-31").map((d) => mkAllocation(201, d, 1, 1)),
];

// ---- Extras (ExtraBase) and extra prices (ExtraPriceBase) ----
export const extras = [
  { url: link("extra", 301), id: 301, name: "Dog", slug: "meadow-farm-dog", price: money("3.00"), pricing_period: 1, status: "active", chargetypes: [link("chargetype", 1001), link("chargetype", 1003)], campsite: link("campsite", "meadow-farm"), description: "Dogs on leads please.", compulsory: false, is_active: true, pricing_type: "per_period", max: 2 },
  { url: link("extra", 302), id: 302, name: "Extra car", slug: "meadow-farm-extra-car", price: money("5.00"), pricing_period: 1, status: "active", chargetypes: [link("chargetype", 1001)], campsite: link("campsite", "meadow-farm"), description: "Book by phone: 01632 960003.", compulsory: false, is_active: true, pricing_type: "per_stay", max: 1 },
  { url: link("extra", 303), id: 303, name: "Firewood", slug: "meadow-farm-firewood", pricing_period: 1, status: "disabled", chargetypes: [], campsite: link("campsite", "meadow-farm"), description: "", compulsory: false, is_active: false, pricing_type: "per_item", max: 5 },
];
export const extraPrices = [
  { url: link("extraprice", 401), id: 401, price: money("4.00"), day: link("arrival", 70042), extra: link("extra", 301), pricing_type: "per_period", name: "Dog", date: "2027-07-12", chargetype: link("chargetype", 1001) },
  { url: link("extraprice", 402), id: 402, price: money("4.00"), day: link("arrival", 70043), extra: link("extra", 301), pricing_type: "per_period", name: "Dog", date: "2027-07-13", chargetype: link("chargetype", 1001) },
];

// ---- Bookings (the POST /booking/ response schema; see e2e.mjs for BookingBase) ----
// Card and payment-processor fields carry obviously fake values so the suite can prove they never
// appear in any tool output.
export const CARD_SECRETS = ["4242", "ch_test_not_real", "tok_test_not_real", "ch_stripe_test_not_real", "pi-test-data-not-real"];
const mkBooking = (pretty_id, status, arrive, depart, pitchtype, pitch, chargetype, guest, extra = {}) => ({
  url: link("booking", pretty_id),
  id: pretty_id,
  pretty_id,
  status,
  campsite: pitchtype === 201 ? "hilltop-glamping" : "meadow-farm",
  campsite_id: pitchtype === 201 ? 12 : 11,
  arrive,
  depart,
  pitchtype: link("pitchtype", pitchtype),
  pitch: link("pitch", pitch),
  chargetype: link("chargetype", chargetype),
  first_name: guest.first,
  last_name: guest.last,
  email: guest.email,
  telephone: guest.phone,
  address: "2 Test Road",
  city: "Testville",
  county: "Testshire",
  postcode: "TE2 3ST",
  country: "GB",
  adults: guest.adults ?? 2,
  party: { adults: guest.adults ?? 2, children: guest.children ?? 0, infants: guest.infants ?? 0, dogs: guest.dogs ?? 0 },
  child_ages: guest.childAges ?? "",
  names_of_all_party_members: guest.party ?? `${guest.first} ${guest.last}`,
  car_registration_number: guest.car ?? "TE57 ABC",
  arrival_time: "15:00:00",
  estimated_time_of_arrival: "",
  special_requests: "",
  group_name: "",
  type_and_approx_size_of_unit: "Tent 4.8m x 3.3m",
  unit_type: "Tent",
  dimensions_width: "4.8",
  dimensions_depth: "3.3",
  language: "en-gb",
  created: "2026-08-20T09:30:00.000000+01:00",
  modified: "2026-08-20T09:30:00.000000Z",
  viewed_datetime: "2026-08-20T09:31:00.000000Z",
  currency: "GBP",
  currency_preference: "GBP",
  price: money("96.00"),
  accommodation_cost: money("96.00"),
  deposit: money("9.60"),
  remainder: money("86.40"),
  total_paid: money("9.60"),
  balance_due_date: "2027-06-10T09:00:00.000000Z",
  payment_type: "stripe",
  payment_status: { card_details: { type: "visa", number: "4242" }, charge_id: "ch_test_not_real", due_date: "2027-06-10", id: 900001, status: "pending", token_id: "tok_test_not_real" },
  stripe_charge_id: "ch_stripe_test_not_real",
  data: "pi-test-data-not-real",
  hosted_full_payment_when: "deferred_payment",
  extras: [],
  taxes: [{ id: 1, name: "UK VAT (inclusive)", tax_type: { type: "Sales tax", name: "Sales tax" }, amount: money("16.00"), inclusive: true, hidden: true, rate: "0.20000", commissionable: true }],
  vat: "16.00",
  vat_rate: "0.200",
  is_paid: false,
  terms_and_conditions: "Site terms apply.",
  cancellation_policy: "Full refund up to 14 days before arrival.",
  ...extra,
});
const sam = { first: "Sam", last: "Evans", email: "sam.evans@example.com", phone: "07700 900123", adults: 2, children: 1, infants: 1, dogs: 1, childAges: "4,1", party: "Sam Evans, Alex Evans, Kit Evans", car: "TE57 SAM" };
export const bookings = [
  mkBooking("TESTBK01", "confirmed", "2027-07-10", "2027-07-13", 101, 5001, 1001, sam, {
    special_requests: "Arriving late, call 07700 900456 or mail sam.alt@example.com",
    estimated_time_of_arrival: "21:00",
    extras: [{ extra: "Dog", quantity: 1, price: money("9.00") }],
    modified: "2026-09-02T08:00:00.000000Z",
  }),
  mkBooking("TESTBK02", "reserved", "2027-07-10", "2027-07-12", 101, 5002, 1001, { first: "Priya", last: "Shah", email: "priya.shah@example.com", phone: "+44 7700 900789" }, { external_id: "EXT-B2", modified: "2026-09-03T08:00:00.000000Z" }),
  mkBooking("TESTBK03", "cancelled", "2027-07-10", "2027-07-11", 101, 5003, 1001, { first: "Jo", last: "Bloggs", email: "jo@example.com", phone: "07700 900321" }, { cancelled_at: "2026-08-25T12:00:00.000000Z", cancellation_reason: "Customer cancelled by phone from 07700 900321" }),
  mkBooking("TESTBK04", "confirmed", "2027-07-10", "2027-07-14", 102, 5004, 1003, { first: "Lee", last: "Chen", email: "lee.chen@example.net", phone: "01632 960777", dogs: 1 }, { group_name: "Chen family (lee.chen@example.net)", special_requests: "Office (01632) 960555, mobile +44 (0)7700 900888 or 0044 7700 900999" }),
  mkBooking("TESTBK05", "confirmed", "2027-07-11", "2027-07-13", 101, 5003, 1001, { first: "Ana", last: "Silva", email: "ana@example.com", phone: "07700 900654" }),
  mkBooking("TESTBK06", "confirmed", "2027-07-20", "2027-07-22", 201, 5101, 2001, { first: "Tom", last: "Price", email: "tom@example.com", phone: "07700 900987", adults: 1 }),
  mkBooking("TESTBK07", "declined", "2027-08-01", "2027-08-03", 101, 5001, 1001, { first: "Max", last: "Doe", email: "max@example.com", phone: "07700 900555" }),
  mkBooking("TESTBK08", "confirmed", "2027-08-01", "2027-08-08", 101, 5002, 1002, { first: "Eve", last: "Long", email: "eve@example.com", phone: "07700 900444" }),
  // Status written "Confirmed", as in the booking response table's example value, and a party with no
  // `dogs` key, as under the pinned 2023-08-25 version (`dogs` is a prerelease addition). Its pitch
  // type requires the registration and party names in special requests; the guest also typed an
  // address, a card number and a mobile without its leading 0 there (4111 1111 1111 1111 is the
  // well-known test Visa number).
  mkBooking("TESTBK09", "Confirmed", "2027-07-25", "2027-07-27", 201, 5101, 2001, { first: "Kim", last: "Park", email: "kim.park@example.com", phone: "07700 900333" }, {
    party: { adults: 2, children: 0, infants: 0 },
    special_requests: "Vehicle registration TE68 XYZ. Party: Kim Park, Lou Park. Please post the gate code to 3 Test Street, TE3 4ST. Card 4111 1111 1111 1111 if needed. Mobile 7700900123",
    type_and_approx_size_of_unit: "Van reg TE68 XYZ",
  }),
  mkBooking("TESTBK10", "confirmed", "2027-07-25", "2027-07-28", 102, 5004, 1003, { first: "Ben", last: "Hart", email: "ben@example.com", phone: "07700 900222", dogs: 2 }),
];
