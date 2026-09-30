// JSON schemas for responses Pitchup documents only in prose. The OpenAPI document lists a 200/201/204
// for every operation and no error response, so the error schema below was written from the guide's
// troubleshooting table, which quotes the messages ("Not found.", "Invalid token.", "Authentication
// credentials were not provided.", "Invalid token header. Token string should not contain spaces.",
// "Method \"PATCH\" not allowed.") without a body shape; the {"detail": "..."} shape is the one the
// prospect research recorded from the live sandbox for a request without a key (401). e2e.mjs checks
// that each message the mock uses is quoted in the spec.
export const ErrorDetail = {
  type: "object",
  properties: { detail: { type: "string", minLength: 1 } },
  required: ["detail"],
  additionalProperties: false,
};

// "Pagination": next and previous "can be null to indicate no more results in that direction", so
// the list envelopes are validated with those links allowed to be null (several list schemas in the
// spec type them as plain strings; two name the previous link `prev`).
export function withNullableLinks(schema) {
  const s = structuredClone(schema);
  for (const k of ["next", "previous", "prev"]) if (s.properties?.[k]) s.properties[k] = { anyOf: [{ type: "string" }, { type: "null" }] };
  if (s.properties?.results) s.properties.results = { type: "array" }; // items are validated one by one with the record schemas
  return s;
}
