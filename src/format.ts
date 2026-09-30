// Turn Pitchup API records into compact objects an assistant can read quickly.
// Field names follow the schemas and examples in Pitchup's OpenAPI document (CampsiteBase, the
// GET /pitchtype/{pk}/ response, PitchBase, ChargeTypeBase, the GET /arrival/ response, AllocationBase,
// ExtraBase, ExtraPriceBase, BookingBase and the POST /booking/ response).

type Rec = Record<string, any>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic (the same as the other servers in this series, plus UK
// mobiles written without their leading 0). Four shapes, digits optionally separated by a space, dot
// or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional "(0)" trunk prefix, then 6-14 digits;
//   bracketed UK area code: "(0...)" then 5-10 digits;
//   UK national: "0" then 8-10 more digits;
//   UK mobile without its 0: "7" then exactly 9 more digits (7700 900123).
// Bounded by characters other than letters, digits, "_" and "-", so numeric IDs, dates, decimal
// amounts and hyphenated references are left alone. Any other 9-11 digit string starting with 0, and
// any 10-digit number starting with 7, is redacted too; the raw text is available with include_contact_details.
const PHONE = /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(0\))?(?:[ .-]?\d){6,14}|\(0\d{0,4}\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10}|7(?:[ .-]?\d){9})(?![\w-])/g;
// Payment card numbers typed into free text: 13 to 19 digits starting with 1-9, optionally grouped
// with spaces or hyphens. Redacted always, even with include_contact_details, because payment data is
// never returned. Runs after the phone match, so a phone number already replaced is not counted here.
const CARD = /(?<![\w-])[1-9](?:[ -]?\d){12,18}(?![\w-])/g;
// UK postcodes (SW1A 2AA, TE1 2ST) and current-format UK vehicle registrations (AB12 CDE), upper case
// only, as a heuristic for the postal address and the vehicle registration a guest may type into
// special requests (a campsite can require the registration and the party's names there:
// require_car_registration and require_party_names on the pitch type). Street names, older
// registration formats and people's names are not detected.
const POSTCODE = /(?<![\w-])(?:[A-Z]{1,2}\d[A-Z\d]?|GIR) ?\d[A-Z]{2}(?![\w-])/g;
const REGISTRATION = /(?<![\w-])[A-Z]{2}\d{2} ?[A-Z]{3}(?![\w-])/g;

const redactCards = (text: string) => text.replace(CARD, "[card number redacted]");
const redactString = (text: string) =>
  redactCards(text.replace(EMAIL, "[email redacted]").replace(PHONE, "[phone redacted]"))
    .replace(REGISTRATION, "[registration redacted]")
    .replace(POSTCODE, "[postcode redacted]");

/**
 * Inside free text, replace email addresses, phone-number-like sequences, UK postcodes and
 * current-format UK vehicle registrations unless contact details were requested. Card-number-like
 * sequences are replaced in every case.
 */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text === "" || text === "null") return undefined; // the spec's examples use the string "null" for empty values
  return includeContact ? redactCards(text) : redactString(text);
}

const str = (v: unknown) => (v === undefined || v === null || v === "" || v === "null" ? undefined : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || v === "null" || !Number.isFinite(n) ? undefined : n;
};
const bool = (v: unknown) => (typeof v === "boolean" ? v : v === "true" || v === "True" ? true : v === "false" || v === "False" ? false : undefined);

/** Last path segment of a resource link such as https://www.pitchup.com/rest/api/pitchtype/21298/ */
export function idFromUrl(link: unknown): string | undefined {
  if (typeof link !== "string" || !link) return undefined;
  try {
    return new URL(link, "https://x.invalid").pathname.split("/").filter(Boolean).pop();
  } catch {
    return undefined;
  }
}
const ids = (links: unknown) => (Array.isArray(links) ? links.map(idFromUrl).filter((x): x is string => !!x) : typeof links === "string" ? [idFromUrl(links)].filter((x): x is string => !!x) : []);
const numId = (link: unknown) => num(idFromUrl(link));

/** Price object {amount, currency} (or the "10.00 GBP" string the guide's tables describe) as "10.00 GBP". */
export function money(p: unknown): string | undefined {
  if (p && typeof p === "object") {
    const { amount, currency } = p as Rec;
    return amount === undefined || amount === null ? undefined : [String(amount), currency].filter(Boolean).join(" ");
  }
  return str(p);
}

// ---- Campsite (CampsiteBase) ----
// The campsite's own email, phone, postal address and the manager's email are only returned with
// include_contact_details. Payment settings (payment_email, stripe_token, card_types and the
// payment_* timings) are never returned.
export function campsite(c: Rec, includeContact: boolean, detail = false) {
  const base = {
    id: num(c.id),
    slug: str(c.slug),
    name: redactContacts(c.name, includeContact),
    state: str(c.state),
    currency: str(c.currency),
    categories: Array.isArray(c.categories) ? c.categories : undefined,
    pitch_type_ids: ids(c.pitchtypes).map(Number),
    has_availability: bool(c.has_availability),
    first_available_date: str(c.first_available_date),
    location: str(c.hierarchy_text),
    timezone: str(c.timezone),
    last_modified: str(c.last_modified),
  };
  const contact = includeContact
    ? {
        email: str(c.email),
        owner_email: str(c.owner_email),
        telephone: str(c.tel),
        secondary_phone: str(c.secondary_phone),
        address: str(c.full_address) ?? ([c.address1, c.address2, c.postcode].map(str).filter(Boolean).join(", ") || undefined),
        postcode: str(c.postcode),
      }
    : {};
  if (!detail) return { ...base, ...contact };
  return {
    ...base,
    website: str(c.website),
    languages: Array.isArray(c.languages) ? c.languages : undefined,
    max_child_age: num(c.max_child_age),
    max_infant_age: num(c.max_infant_age),
    open_all_year: bool(c.open_all_year),
    opening_dates: c.campsiteopeningdate_set && c.campsiteopeningdate_set !== "null" ? c.campsiteopeningdate_set : undefined,
    camping_arrival: [str(c.camping_arrival_time_from), str(c.camping_arrival_time_to)].some(Boolean) ? { from: str(c.camping_arrival_time_from), to: str(c.camping_arrival_time_to) } : undefined,
    camping_depart_by: str(c.camping_depart_time_from),
    onsite_arrival: [str(c.onsite_arrival_time_from), str(c.onsite_arrival_time_to)].some(Boolean) ? { from: str(c.onsite_arrival_time_from), to: str(c.onsite_arrival_time_to) } : undefined,
    onsite_depart_by: str(c.onsite_depart_time_from),
    rating: str(c.rating),
    rating_count: num(c.rate_count),
    vat_rate: str(c.vat_rate),
    hide_availability: bool(c.hide_availability),
    notices: redactContacts(c.notices, includeContact),
    useful_info: redactContacts(c.useful_info, includeContact),
    cancellation_policy: redactContacts(c.cancellation_policy, includeContact),
    refund_policy: str(c.refund_policy),
    ...contact,
  };
}

// ---- Pitch type (GET /pitchtype/{pk}/ results item) ----
export function pitchType(p: Rec, includeContact = false) {
  return {
    id: num(p.id),
    name: redactContacts(p.name, includeContact),
    slug: str(p.slug),
    status: str(p.status),
    is_active: bool(p.is_active),
    campsite: idFromUrl(p.campsite),
    categories: Array.isArray(p.categories) ? p.categories : undefined,
    subcategories: Array.isArray(p.subcategories) ? p.subcategories : undefined,
    capacity: num(p.capacity),
    persons_included: num(p.persons_included),
    pricing_method: p.pricing_method === 1 || p.pricing_method === "1" ? "per pitch" : p.pricing_method === 2 || p.pricing_method === "2" ? "per person" : str(p.pricing_method),
    pitch_count: num(p.pitch_count),
    max_pitches_to_sell: num(p.max_pitches_to_sell),
    has_availability: bool(p.has_availability),
    lead_price: num(p.lead_price),
    lead_price_nights: num(p.lead_price_nights),
    bedrooms: num(p.bedrooms),
    ground_type: str(p.ground_type),
    dimensions: redactContacts(p.dimensions, includeContact),
    facilities: {
      shared_toilets: bool(p.has_shared_toilets),
      no_toilets: bool(p.has_no_toilets),
      shared_showers: bool(p.has_shared_showers),
      no_showers: bool(p.has_no_showers),
    },
    description: redactContacts(p.description, includeContact),
    // The guide's list example uses `pitch` on one record and `pitches` on the other.
    charge_type_ids: ids(p.chargetypes).map(Number),
    pitch_ids: ids(p.pitches ?? p.pitch).map(Number),
    last_modified: str(p.last_modified),
  };
}

// ---- Pitch (PitchBase, POST /pitch/ response) ----
// `pitchup_calendar_feed` is a signed link to a feed of confirmed bookings that carries the guests'
// names, telephone numbers, emails and addresses (guide, "The feed we give you"), and the external
// `calendar_feed(s)` links often carry their own access tokens: all are only returned on request.
export function pitch(p: Rec, includeContact: boolean) {
  const feeds = Array.isArray(p.calendar_feeds) ? p.calendar_feeds : typeof p.calendar_feeds === "string" && p.calendar_feeds ? [p.calendar_feeds] : [];
  return {
    id: num(p.id),
    name: redactContacts(p.name, includeContact),
    pitch_type_id: numId(p.pitchtype),
    is_available: bool(p.is_available),
    status: str(p.status),
    priority: num(p.priority),
    external_id: str(p.external_id),
    notes: redactContacts(p.notes, includeContact),
    calendar_status: str(p.calendar_status),
    external_calendar_feeds: [p.calendar_feed, ...feeds].filter((x) => typeof x === "string" && x).length,
    ...(includeContact ? { calendar_feed: str(p.calendar_feed), calendar_feeds: feeds.length ? feeds : undefined, pitchup_calendar_feed: str(p.pitchup_calendar_feed) } : {}),
  };
}

// ---- Charge type (ChargeTypeBase) ----
export function chargeType(c: Rec) {
  return {
    id: num(c.id),
    name: redactContacts(c.name, false),
    description: redactContacts(c.description, false),
    pitch_type_id: numId(c.pitchtype),
    is_active: bool(c.is_active),
    status: str(c.status),
    has_availability: bool(c.has_availability),
    last_modified: str(c.last_modified),
  };
}

// ---- Arrival day (GET /arrival/ results item) ----
export function arrivalDay(a: Rec) {
  return {
    id: num(a.id ?? a.pk),
    date: str(a.date),
    charge_type_id: numId(a.charge_type),
    status: str(a.status),
    price_pitch: money(a.price),
    price_adult: money(a.price_adult),
    price_child: money(a.price_child),
    price_infant: money(a.price_infant),
    pricing_period_nights: num(a.pricing_period),
    min_days: num(a.min_days),
    max_days: num(a.max_days),
    closed_to_arrival: bool(a.is_soft_close),
    closed_to_departure: bool(a.closed_to_departure),
    pitches_to_sell: num(a.pitches_to_sell),
    pitches_sold: num(a.pitches_sold),
    has_availability: bool(a.has_availability),
    last_modified: str(a.last_modified),
  };
}

// ---- Allocation day (AllocationBase) ----
export function allocationDay(a: Rec) {
  return {
    id: num(a.id),
    date: str(a.date),
    pitch_type_id: numId(a.pitchtype),
    max_allocation: num(a.max_allocation),
    pitches_to_sell: num(a.pitches_to_sell ?? a.allocation),
    has_availability: bool(a.has_availability),
  };
}

// ---- Extras (ExtraBase, ExtraPriceBase) ----
export function extra(e: Rec) {
  return {
    id: num(e.id ?? e.pk),
    name: redactContacts(e.name, false),
    slug: str(e.slug),
    status: str(e.status),
    is_active: bool(e.is_active),
    compulsory: bool(e.compulsory),
    pricing_type: str(e.pricing_type),
    price: money(e.price),
    pricing_period_days: num(e.pricing_period),
    max_quantity: num(e.max),
    charge_type_ids: ids(e.chargetypes).map(Number),
    campsite: idFromUrl(e.campsite),
    description: redactContacts(e.description, false),
  };
}

export function extraPrice(e: Rec) {
  return {
    id: num(e.id),
    extra_id: numId(e.extra),
    name: redactContacts(e.name, false),
    date: str(e.date),
    price: money(e.price),
    pricing_type: str(e.pricing_type),
    arrival_day_id: numId(e.day),
    charge_type_id: numId(e.chargetype),
  };
}

// ---- Booking (BookingBase / POST /booking/ response) ----
// "Booking status values": name and the numeric key the `status` filter takes (?status=3).
export const BOOKING_STATUS_KEYS = {
  not_invoiced: 1,
  invoiced: 2,
  confirmed: 3,
  cancelled: 4,
  declined: 5,
  amended: 6,
  reserved: 7,
  cancelled_reallocate: 8,
  error: 9,
  sold_out: 10,
  abandoned: 11,
  calendar_conflict: 12,
} as const;
export type BookingStatus = keyof typeof BOOKING_STATUS_KEYS;

const party = (b: Rec) => {
  const p = b.party && typeof b.party === "object" ? b.party : {};
  return { adults: num(p.adults ?? b.adults), children: num(p.children), infants: num(p.infants), dogs: num(p.dogs) };
};

/**
 * A booking. The lead guest's name, the party size, dates, pitch, unit and amounts are returned by
 * default. Email, telephone, postal address, city, county, postcode, country, the names of the other
 * party members, the vehicle registration and the children's ages (the structured fields) only with
 * include_contact_details. Free text (special requests, unit, group name, cancellation reason, names)
 * is returned with emails, phone numbers, UK postcodes and current-format UK registrations redacted
 * by default; anything else a guest typed there (names of the party, a street address) is returned
 * as written. Card-number-like sequences in free text are always redacted. Card and payment-processor
 * fields (payment_status.card_details, charge_id, token_id, stripe_charge_id, `data`) are never
 * returned, even on request: only the payment status word and due date are.
 */
export function booking(b: Rec, includeContact: boolean) {
  const ps = b.payment_status && typeof b.payment_status === "object" ? b.payment_status : undefined;
  const extras = Array.isArray(b.extras)
    ? b.extras.map((x: any) =>
        x && typeof x === "object"
          ? { name: redactContacts(x.extra ?? x.name, includeContact), quantity: num(x.quantity), price: money(x.price ?? x["extra price"] ?? x.extra_price) }
          : { name: redactContacts(String(x), includeContact) },
      )
    : undefined;
  return {
    pretty_id: str(b.pretty_id ?? b.id),
    status: str(b.status),
    campsite: str(b.campsite),
    arrive: str(b.arrive),
    depart: str(b.depart),
    guest_name: redactContacts([b.first_name, b.last_name].map(str).filter(Boolean).join(" "), includeContact),
    party: party(b),
    pitch_type_id: numId(b.pitchtype),
    pitch_id: numId(b.pitch),
    charge_type_id: numId(b.chargetype),
    arrival_time: str(b.arrival_time),
    estimated_time_of_arrival: str(b.estimated_time_of_arrival),
    unit: redactContacts(b.type_and_approx_size_of_unit, includeContact),
    special_requests: redactContacts(b.special_requests, includeContact),
    group_name: redactContacts(b.group_name, includeContact),
    extras: extras && extras.length ? extras : undefined,
    external_id: str(b.external_id),
    language: str(b.language),
    created: str(b.created),
    modified: str(b.modified),
    cancelled_at: str(b.cancelled_at),
    cancellation_reason: redactContacts(b.cancellation_reason, includeContact),
    amounts: {
      total: money(b.price),
      accommodation: money(b.accommodation_cost),
      deposit: money(b.deposit),
      remainder: money(b.remainder),
      paid: money(b.total_paid),
      balance_due_date: str(b.balance_due_date),
    },
    payment_status: ps ? str(ps.status) : str(b.payment_status),
    payment_due_date: ps ? str(ps.due_date) : undefined,
    ...(includeContact
      ? {
          email: str(b.email),
          telephone: str(b.telephone),
          address: [b.address, b.city, b.county, b.postcode, b.country].map(str).filter(Boolean).join(", ") || undefined,
          names_of_all_party_members: str(b.names_of_all_party_members),
          car_registration_number: str(b.car_registration_number),
          child_ages: str(b.child_ages),
        }
      : {}),
  };
}
