// Minimal Pitchup.com supplier API client used by the MCP tools.
// Docs: https://docs.pitchup.com/api/  Spec: https://docs.pitchup.com/api/pitchup-api-openapi.yaml
import { redactContacts } from "./format.js";

export class PitchupError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "PitchupError";
  }
}

// "Pagination": list resources carry `next` and `previous` links ("These links can be null to
// indicate no more results in that direction") and `results`; some examples also carry `count`.
export interface ListPage<T> {
  count?: number;
  next?: string | null;
  previous?: string | null;
  results?: T[];
}

export type Query = Record<string, string | number | undefined>;

// A 429 means the request was not processed, so it is safe to repeat for any method. A 502/503/504
// from a gateway does not prove the upstream did not process the request, so those are only retried
// for GET: the write endpoints used here start background jobs, and repeating one after a gateway
// error could queue the same job twice.
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
// Longest single wait honoured from Retry-After. The MCP SDK's default request timeout is 60 s, so
// the whole retry budget (at most two waits) stays well under it; a longer Retry-After makes the
// call give up at once with the wait time in the message.
export const MAX_RETRY_AFTER_S = 10;
// "Pagination": "You can set `page_size` to a maximum of 100".
export const PAGE_SIZE = 100;
export const API_PREFIX = "/rest/api";

export class PitchupClient {
  private readonly origin: string;
  private readonly accept: string;
  // Pitchup does not document a rate limit. Space requests at about four per second so a tool call
  // that pages through a list stays polite; 429s are retried using Retry-After.
  private nextSlot = 0;
  private readonly minIntervalMs = 250;

  constructor(private readonly apiKey: string, baseUrl: string, apiVersion: string, private readonly envLabel: string) {
    this.origin = new URL(baseUrl).origin;
    // "Versioning": the version is given in the Accept header, e.g. `application/json; version=2018-06-18`.
    this.accept = `application/json; version=${apiVersion}`;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /** Never let the API key reach a tool result, whatever an error body echoes. */
  private scrub(text: string): string {
    return this.apiKey.length >= 4 ? text.split(this.apiKey).join("[redacted]") : text;
  }

  /** Build a URL under /rest/api. Filter values are encoded with %20 for spaces, as in the guide's `after=2020-02-07%2011:50:35`. */
  url(path: string, query: Query = {}): string {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    return `${this.origin}${API_PREFIX}${path}${qs ? "?" + qs : ""}`;
  }

  async request<T = any>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    return this.send<T>(method, this.url(path, opts.query), path, opts.body);
  }

  get<T = any>(path: string, query?: Query) {
    return this.request<T>("GET", path, { query });
  }

  private async send<T>(method: string, url: string, label: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            // securitySchemes.ApiKey: "Your API key, sent as `Authorization: Token <key>`".
            Authorization: `Token ${this.apiKey}`,
            Accept: this.accept,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        throw new PitchupError(`Could not reach Pitchup at ${this.origin}: ${(err as Error).message}`);
      }

      const retryable = RETRY_ANY_METHOD.has(res.status) || (method === "GET" && RETRY_GET_ONLY.has(res.status));
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          throw new PitchupError(`Pitchup asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${method} ${label} (HTTP ${res.status}). Try again after that.`, res.status);
        }
        // A missing or unparsable header falls back to 2 s then 4 s.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (res.status === 204) return undefined as T;

      const text = await res.text();
      const json = text ? safeJson(text) : undefined;
      if (res.ok) {
        // A 200 with HTML (a proxy, a login page, the browsable API) must not be mistaken for an empty list.
        if (json === undefined || json === null || typeof json !== "object") {
          throw new PitchupError(
            `Pitchup returned ${res.status} for ${method} ${label} but the body was not JSON (${res.headers.get("content-type") ?? "no content type"}, ${text.length} bytes). Check PITCHUP_BASE_URL / PITCHUP_ENV and whether a proxy or login page is in the way.`,
            res.status,
          );
        }
        return json as T;
      }

      // Only a JSON error is passed on, with contact details redacted and the key scrubbed; a raw
      // body (a gateway page) is never quoted.
      const detail = this.scrub(redactContacts(describeError(json), false) ?? "");
      if (res.status === 401 || res.status === 403) {
        throw new PitchupError(
          `Pitchup rejected the API key (${res.status}). Check PITCHUP_API_KEY: it is the key under My details in the Manager Portal, and Sandbox and Live keys are different (this server is using ${this.envLabel}, ${this.origin}).${detail ? " " + detail : ""}`,
          res.status,
        );
      }
      if (res.status === 404) throw new PitchupError(`Not found: ${label}. Check the ID or slug (list tools show them).${detail ? " " + detail : ""}`, 404);
      if (res.status === 429) throw new PitchupError("Pitchup rate limit reached (the limit is not documented). Wait a minute and try again.", 429);
      if (res.status === 400) throw new PitchupError(`Pitchup refused ${method} ${label} (400).${detail ? " " + detail : ""}`, 400);
      if (method !== "GET" && RETRY_GET_ONLY.has(res.status)) {
        throw new PitchupError(
          `Pitchup returned ${res.status} for ${method} ${label}. The request was not retried because it may already have been processed: check the current values with the matching list tool before repeating it.`,
          res.status,
        );
      }
      if (RETRY_GET_ONLY.has(res.status)) {
        throw new PitchupError(`Pitchup returned ${res.status} for ${method} ${label} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.${detail ? " " + detail : ""}`, res.status);
      }
      throw new PitchupError(`Pitchup returned ${res.status} for ${method} ${label}.${detail ? " " + detail : ""}`, res.status);
    }
  }

  /**
   * Fetch a paginated collection. The first request carries the filters and page_size=100; after
   * that the `next` link is followed exactly as given ("these links should be followed, rather than
   * being hard-coded or generated through string concatenation") until it is null, or until
   * maxItems or maxPages is reached. A next link on another host is not followed, so the API key is
   * never sent anywhere but the configured Pitchup host.
   */
  async list<T = any>(path: string, { query = {} as Query, maxItems = 500, maxPages = 20 } = {}): Promise<{ items: T[]; complete: boolean; pages: number }> {
    const items: T[] = [];
    let url = this.url(path, { ...query, page_size: PAGE_SIZE });
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.send<ListPage<T> | T[]>("GET", url, path);
      // A bare array is accepted too (the guide's pitch and language examples are bare arrays). Any
      // other JSON (an error object sent with a 200, for example) is not a list and must not be
      // reported as an empty one.
      if (!Array.isArray(res) && !Array.isArray(res?.results)) {
        const keys = res && typeof res === "object" ? Object.keys(res).slice(0, 6).join(", ") : typeof res;
        throw new PitchupError(
          `Pitchup returned 200 for GET ${path} but the body was not a list (no results array; keys: ${keys || "none"})${items.length ? ` on page ${page}, after ${items.length} records` : ""}. Check PITCHUP_BASE_URL / PITCHUP_ENV and the API version.`,
          200,
        );
      }
      const data: T[] = Array.isArray(res) ? res : (res.results as T[]);
      items.push(...data);
      const next = Array.isArray(res) ? null : res.next;
      if (items.length >= maxItems) return { items: items.slice(0, maxItems), complete: !next && items.length === maxItems, pages: page };
      // An empty page with a next link is followed like any other: the API has said more exist.
      if (!next) return { items, complete: true, pages: page };
      let nextUrl: URL;
      try {
        nextUrl = new URL(next, this.origin);
      } catch {
        throw new PitchupError(`Pitchup returned an unreadable next-page link for ${path}; stopped after ${items.length} records.`);
      }
      if (nextUrl.origin !== this.origin) {
        throw new PitchupError(
          `Pitchup returned a next-page link for ${path} on another host (${nextUrl.origin}, expected ${this.origin}). It was not followed, so the API key was not sent there. Check PITCHUP_ENV / PITCHUP_BASE_URL.`,
        );
      }
      url = nextUrl.toString();
    }
    return { items, complete: false, pages: maxPages };
  }
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Pitchup's error messages, as the guide's troubleshooting table quotes them ("Not found.", "Invalid
 * token.", "Authentication credentials were not provided."), come as {"detail": "..."}. Validation
 * errors are an object of field (or ISO date) to message(s), and a list request can fail per item.
 * At most six messages are passed on.
 */
function describeError(json: any): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const parts: string[] = [];
  const walk = (v: any, key?: string) => {
    if (parts.length >= 6) return;
    if (typeof v === "string") parts.push(key && key !== "detail" && key !== "non_field_errors" ? `${key}: ${v}` : v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(json);
  return parts.length ? parts.join("; ").slice(0, 600) : undefined;
}
