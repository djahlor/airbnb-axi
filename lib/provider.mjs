import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import {
  AccessDeniedError,
  AirbnbAxiError,
  InputError,
  PartialPaginationError,
  RobotsDeniedError,
  SchemaError,
  TimeoutError,
} from "./errors.mjs";
import { extractDeferredPayload, normalizeListingPage, normalizeSearchPage } from "./normalize.mjs";

const BASE_URL = "https://www.airbnb.com";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const GEOCODER_USER_AGENT = "airbnb-axi/0.1 (+https://github.com/openbnb-org/mcp-server-airbnb)";
const PROPERTY_TYPE_IDS = {
  entire_home: "1",
  private_room: "2",
  shared_room: "3",
  hotel_room: "4",
};
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

function inputError(message, code, details) {
  return new InputError(message, { code, ...(details === undefined ? {} : { details }) });
}

function requireDate(value, name) {
  if (value == null) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw inputError(`${name} must use YYYY-MM-DD.`, "INVALID_DATE", { field: name });
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw inputError(`${name} is not a calendar date.`, "INVALID_DATE", { field: name });
}

function requireInteger(value, name, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw inputError(`${name} must be an integer from ${min} to ${max}.`, "INVALID_GUEST_COUNT", { field: name, value });
  }
}

function validateShared(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw inputError("Input must be an object.", "INVALID_INPUT_OBJECT");
  const normalized = {
    ...input,
    adults: input.adults ?? 1,
    children: input.children ?? 0,
    infants: input.infants ?? 0,
    pets: input.pets ?? 0,
    currency: input.currency ?? "EUR",
  };
  requireDate(normalized.checkin, "checkin");
  requireDate(normalized.checkout, "checkout");
  if (Boolean(normalized.checkin) !== Boolean(normalized.checkout)) throw inputError("checkin and checkout must be supplied together.", "INCOMPLETE_DATE_RANGE");
  if (normalized.checkin && normalized.checkout && normalized.checkout <= normalized.checkin) {
    throw inputError("checkout must be later than checkin.", "INVALID_DATE_RANGE");
  }
  requireInteger(normalized.adults, "adults", { min: 1, max: 16 });
  requireInteger(normalized.children, "children", { min: 0, max: 16 });
  requireInteger(normalized.infants, "infants", { min: 0, max: 5 });
  requireInteger(normalized.pets, "pets", { min: 0, max: 5 });
  if (!/^[A-Z]{3}$/.test(normalized.currency)) throw inputError("currency must be a three-letter uppercase code.", "INVALID_CURRENCY");
  return normalized;
}

export function validateSearchInput(input) {
  const normalized = validateShared(input);
  if (typeof normalized.location !== "string" || !normalized.location.trim()) throw inputError("location is required.", "LOCATION_REQUIRED");
  normalized.location = normalized.location.trim();
  normalized.pages = normalized.pages ?? 1;
  if (!Number.isInteger(normalized.pages) || normalized.pages < 1 || normalized.pages > 10) throw inputError("pages must be an integer from 1 to 10.", "INVALID_PAGE_COUNT");
  for (const field of ["minPrice", "maxPrice"]) {
    if (normalized[field] != null && (!Number.isFinite(normalized[field]) || normalized[field] < 0)) {
      throw inputError(`${field} must be a non-negative number.`, "INVALID_PRICE", { field });
    }
  }
  if (normalized.minPrice != null && normalized.maxPrice != null && normalized.minPrice > normalized.maxPrice) {
    throw inputError("minPrice cannot exceed maxPrice.", "INVALID_PRICE_RANGE");
  }
  if (normalized.propertyType != null && !Object.hasOwn(PROPERTY_TYPE_IDS, normalized.propertyType)) {
    throw inputError(`propertyType must be one of: ${Object.keys(PROPERTY_TYPE_IDS).join(", ")}.`, "INVALID_PROPERTY_TYPE");
  }
  if (normalized.cursor != null && (typeof normalized.cursor !== "string" || normalized.cursor.length > 4096)) throw inputError("cursor must be a string up to 4096 characters.", "INVALID_CURSOR");
  if (normalized.placeId != null && (typeof normalized.placeId !== "string" || !normalized.placeId.trim())) throw inputError("placeId must be a non-empty string.", "INVALID_PLACE_ID");
  return normalized;
}

function listingId(value) {
  const raw = String(value ?? "").trim();
  if (/^\d+$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (!/(?:^|\.)airbnb\.(?:com|[a-z]{2}(?:\.[a-z]{2})?)$/i.test(url.hostname)) return null;
    const match = /^\/rooms\/(\d+)(?:\/|$)/.exec(url.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function validateListingInput(input) {
  const normalized = validateShared(input);
  const id = listingId(normalized.id);
  if (!id) throw inputError("listing must be a numeric ID or Airbnb room URL.", "INVALID_LISTING_ID");
  return { ...normalized, id };
}

function addGuests(url, input) {
  url.searchParams.set("adults", String(input.adults ?? 1));
  url.searchParams.set("children", String(input.children ?? 0));
  url.searchParams.set("infants", String(input.infants ?? 0));
  url.searchParams.set("pets", String(input.pets ?? 0));
}

export function buildSearchUrl(input, geocoding = null) {
  const value = validateSearchInput(input);
  const slug = value.location.replace(/,\s*/g, "--").replace(/\s+/g, "-");
  const url = new URL(`/s/${encodeURIComponent(slug).replaceAll("%2D", "-")}/homes`, BASE_URL);
  if (value.placeId) url.searchParams.set("place_id", value.placeId);
  if (geocoding?.boundingBox) {
    for (const key of ["ne_lat", "ne_lng", "sw_lat", "sw_lng"]) url.searchParams.set(key, geocoding.boundingBox[key]);
  }
  if (value.checkin) url.searchParams.set("checkin", value.checkin);
  if (value.checkout) url.searchParams.set("checkout", value.checkout);
  addGuests(url, value);
  if (value.minPrice != null) url.searchParams.set("price_min", String(value.minPrice));
  if (value.maxPrice != null) url.searchParams.set("price_max", String(value.maxPrice));
  if (value.propertyType) url.searchParams.append("l2_property_type_ids[]", PROPERTY_TYPE_IDS[value.propertyType]);
  if (value.cursor) url.searchParams.set("cursor", value.cursor);
  url.searchParams.set("currency", value.currency);
  return url.toString();
}

export function buildListingUrl(input) {
  const value = validateListingInput(input);
  const url = new URL(`/rooms/${value.id}`, BASE_URL);
  if (value.checkin) url.searchParams.set("check_in", value.checkin);
  if (value.checkout) url.searchParams.set("check_out", value.checkout);
  addGuests(url, value);
  url.searchParams.set("currency", value.currency);
  return url.toString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function headersForHtml() {
  return {
    "user-agent": USER_AGENT,
    "accept-language": "en-US,en;q=0.9",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "cache-control": "no-cache",
  };
}

export function nativeFetch(input, options = {}, redirectCount = 0) {
  let url;
  try {
    url = new URL(input);
  } catch (cause) {
    return Promise.reject(new AirbnbAxiError("Request URL is invalid.", { code: "INVALID_REQUEST_URL", cause }));
  }
  const request = url.protocol === "https:" ? httpsRequest : url.protocol === "http:" ? httpRequest : null;
  if (!request) return Promise.reject(new AirbnbAxiError(`Unsupported request protocol: ${url.protocol}`, { code: "UNSUPPORTED_PROTOCOL" }));
  if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new DOMException("The operation was aborted", "AbortError"));

  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", headers: options.headers, signal: options.signal }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location && options.redirect !== "manual") {
        response.resume();
        if (options.redirect === "error") {
          reject(new AirbnbAxiError("Request was redirected but redirects are disabled.", { code: "REDIRECT_DENIED", details: { url: url.toString(), status, location } }));
          return;
        }
        if (redirectCount >= MAX_REDIRECTS) {
          reject(new AirbnbAxiError(`Request exceeded ${MAX_REDIRECTS} redirects.`, { code: "REDIRECT_LIMIT", details: { url: url.toString(), status, location } }));
          return;
        }
        let redirectUrl;
        try {
          redirectUrl = new URL(location, url);
        } catch (cause) {
          reject(new AirbnbAxiError("Request returned an invalid redirect location.", { code: "REDIRECT_INVALID", details: { url: url.toString(), status, location }, cause }));
          return;
        }
        nativeFetch(redirectUrl, options, redirectCount + 1).then(resolve, reject);
        return;
      }

      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new AirbnbAxiError(`Response exceeded ${MAX_RESPONSE_BYTES} bytes.`, { code: "RESPONSE_TOO_LARGE", details: { url: url.toString(), limit: MAX_RESPONSE_BYTES } }));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          for (const item of Array.isArray(value) ? value : value == null ? [] : [value]) headers.append(name, String(item));
        }
        const body = chunks.length ? Buffer.concat(chunks) : null;
        resolve(new Response(body, { status, statusText: response.statusMessage, headers }));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function fetchText(fetchImpl, url, { timeoutMs, headers = headersForHtml() } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: "follow" });
    if ([401, 403, 407, 429].includes(response.status)) {
      throw new AccessDeniedError(`Airbnb request was denied with HTTP ${response.status}.`, { code: response.status === 429 ? "RATE_LIMITED" : "ACCESS_DENIED", details: { status: response.status, url } });
    }
    if (!response.ok) throw new AirbnbAxiError(`Airbnb request failed with HTTP ${response.status}.`, { code: "HTTP_ERROR", details: { status: response.status, url } });
    return { body: await response.text(), response };
  } catch (error) {
    if (error instanceof AirbnbAxiError) throw error;
    if (error?.name === "AbortError" || /abort|timeout/i.test(error?.message ?? "")) {
      throw new TimeoutError(`Request timed out after ${timeoutMs}ms.`, { details: { url, timeoutMs }, cause: error });
    }
    throw new AirbnbAxiError(`Network request failed: ${error?.message ?? String(error)}`, { code: "NETWORK_ERROR", details: { url }, cause: error });
  } finally {
    clearTimeout(timer);
  }
}

function robotsRulesFor(content, targetAgent = "*") {
  const groups = [];
  let agents = [];
  let rules = [];
  const flush = () => {
    if (agents.length) groups.push({ agents, rules });
    agents = [];
    rules = [];
  };
  for (const sourceLine of content.split(/\r?\n/)) {
    const line = sourceLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "user-agent") {
      if (rules.length) flush();
      agents.push(value.toLowerCase());
    } else if ((name === "allow" || name === "disallow") && agents.length) {
      rules.push({ type: name, path: value });
    }
  }
  flush();
  const agent = targetAgent.toLowerCase();
  const exact = groups.filter((group) => group.agents.some((value) => value !== "*" && agent.includes(value)));
  return (exact.length ? exact : groups.filter((group) => group.agents.includes("*"))).flatMap((group) => group.rules);
}

function robotsAllows(content, url) {
  const path = `${url.pathname}${url.search}`;
  const matching = robotsRulesFor(content, USER_AGENT).filter((rule) => {
    if (!rule.path) return false;
    const anchored = rule.path.endsWith("$");
    const source = (anchored ? rule.path.slice(0, -1) : rule.path)
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*");
    return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
  });
  const specificity = (rule) => rule.path.replace(/[*$]/g, "").length;
  matching.sort((a, b) => specificity(b) - specificity(a) || (a.type === "allow" ? -1 : 1));
  return matching[0]?.type !== "disallow";
}

const PHOTON_PRIORITY = { country: 1, state: 2, county: 3, city: 4, district: 5, locality: 6, street: 7, house: 8, other: 9 };

function expandedBox(extent) {
  const [swLng, neLat, neLng, swLat] = extent.map(Number);
  if ([swLng, neLat, neLng, swLat].some((value) => !Number.isFinite(value))) return null;
  const latPadding = Math.max((neLat - swLat) * 0.25, 0.1);
  const lngPadding = Math.max((neLng - swLng) * 0.25, 0.1);
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  return {
    sw_lat: clamp(swLat - latPadding, -90, 90).toFixed(7),
    ne_lat: clamp(neLat + latPadding, -90, 90).toFixed(7),
    sw_lng: clamp(swLng - lngPadding, -180, 180).toFixed(7),
    ne_lng: clamp(neLng + lngPadding, -180, 180).toFixed(7),
  };
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const { body } = await fetchText(fetchImpl, url, {
    timeoutMs,
    headers: { "user-agent": GEOCODER_USER_AGENT, accept: "application/json" },
  });
  return JSON.parse(body);
}

async function geocode(fetchImpl, location, timeoutMs) {
  let photonFeature = null;
  try {
    const data = await fetchJson(fetchImpl, `https://photon.komoot.io/api/?q=${encodeURIComponent(location)}&limit=5`, Math.min(timeoutMs, 5_000));
    photonFeature = (data?.features ?? []).reduce((best, feature) => {
      if (!best) return feature;
      const a = PHOTON_PRIORITY[best?.properties?.type] ?? PHOTON_PRIORITY.other;
      const b = PHOTON_PRIORITY[feature?.properties?.type] ?? PHOTON_PRIORITY.other;
      return b < a ? feature : best;
    }, null);
    const boundingBox = expandedBox(photonFeature?.properties?.extent ?? []);
    if (boundingBox) {
      return {
        method: "photon",
        query: location,
        displayName: photonFeature?.properties?.name ?? location,
        boundingBox,
        regionUncertainty: "OpenStreetMap bounding box expanded by 25% (minimum 0.1°); it may include nearby areas.",
      };
    }
  } catch {
    // The documented upstream behavior falls back to Nominatim, then Airbnb.
  }
  try {
    const data = await fetchJson(fetchImpl, `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`, Math.min(timeoutMs, 5_000));
    const item = data?.[0];
    const bb = item?.boundingbox;
    const boundingBox = Array.isArray(bb) && bb.length === 4 ? expandedBox([bb[2], bb[1], bb[3], bb[0]]) : null;
    if (boundingBox) {
      return {
        method: "nominatim",
        query: location,
        displayName: item?.display_name?.split(",")?.[0] ?? location,
        boundingBox,
        regionUncertainty: "OpenStreetMap bounding box expanded by 25% (minimum 0.1°); it may include nearby areas.",
      };
    }
  } catch {
    // Airbnb's own location resolution is the final, explicitly disclosed fallback.
  }
  return {
    method: "airbnb_fallback",
    query: location,
    displayName: photonFeature?.properties?.name ?? location,
    boundingBox: null,
    regionUncertainty: "Third-party geocoding did not produce a bounding box. Airbnb will resolve the text and may choose the wrong region.",
  };
}

function replayPagePayload(page) {
  if (page && Object.hasOwn(page, "body") && Object.hasOwn(page, "payload")) {
    throw new SchemaError("Replay page contains both body and payload representations.", { code: "AMBIGUOUS_REPLAY_PAGE" });
  }
  if (page?.payload && typeof page.payload === "object") return page.payload;
  if (page?.body && typeof page.body === "object") return page.body;
  const body = typeof page?.body === "string" ? page.body : String(page ?? "");
  if (/^\s*</.test(body)) return extractDeferredPayload(body);
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new SchemaError("Replay page is neither Airbnb HTML nor JSON.", { code: "INVALID_REPLAY_PAGE", cause });
  }
}

export function parseReplayInput(content) {
  if (typeof content !== "string" || !content.trim()) throw inputError("Replay file is empty.", "EMPTY_REPLAY");
  if (/^\s*</.test(content)) return { pages: [{ body: content, sourceUrl: "file://replay" }], format: "html" };
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw inputError("Replay file is not valid JSON or HTML.", "INVALID_REPLAY", { cause: cause.message });
  }
  if (Array.isArray(parsed?.pages) && parsed.pages.length) {
    return {
      pages: parsed.pages.map((page) => ({ ...page, sourceUrl: page.sourceUrl ?? "file://replay" })),
      format: parsed.format ?? "capture-json",
      ...(parsed.command == null ? {} : { command: parsed.command }),
      ...(parsed.inputs == null ? {} : { inputs: parsed.inputs }),
      ...(parsed.inputBinding == null ? {} : { inputBinding: parsed.inputBinding }),
      ...(parsed.requestedInputs == null ? {} : { requestedInputs: parsed.requestedInputs }),
    };
  }
  return { pages: [{ payload: parsed, sourceUrl: "file://replay" }], format: "payload-json" };
}

function pageEvidence(page, fallbackUrl, now) {
  if (page && Object.hasOwn(page, "body") && Object.hasOwn(page, "payload")) {
    throw new SchemaError("Replay page contains both body and payload representations.", { code: "AMBIGUOUS_REPLAY_PAGE" });
  }
  const body = typeof page.body === "string" ? page.body : JSON.stringify(page.payload ?? page.body ?? null);
  const actualHash = sha256(body);
  if (page.sha256 && page.sha256 !== actualHash) {
    throw new SchemaError("Replay content does not match its recorded SHA-256.", {
      code: "REPLAY_HASH_MISMATCH",
      details: { expected: page.sha256, actual: actualHash, sourceUrl: page.sourceUrl ?? fallbackUrl },
    });
  }
  return {
    sourceUrl: page.sourceUrl ?? fallbackUrl,
    retrievedAt: page.retrievedAt ?? null,
    parsedAt: now().toISOString(),
    sha256: actualHash,
    body,
  };
}

function publicInputs(input) {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !["raw", "capture", "replay"].includes(key)));
}

const REPLAY_BINDING_FIELDS = {
  search: ["location", "placeId", "checkin", "checkout", "adults", "children", "infants", "pets", "currency", "cursor", "minPrice", "maxPrice", "propertyType"],
  listing: ["id", "checkin", "checkout", "adults", "children", "infants", "pets", "currency"],
};

function replayBinding(decoded, requested, command) {
  if (decoded.command && decoded.command !== command) {
    throw inputError(`Replay was captured for ${decoded.command}, not ${command}.`, "REPLAY_COMMAND_MISMATCH");
  }
  if (decoded.inputBinding && decoded.inputBinding !== "verified_capture") return null;
  if (!decoded.inputs || typeof decoded.inputs !== "object") return null;
  const captured = publicInputs(decoded.inputs);
  if (command === "listing" && captured.id != null) captured.id = listingId(captured.id);
  for (const field of REPLAY_BINDING_FIELDS[command]) {
    if (!Object.hasOwn(captured, field)) continue;
    const expected = field === "id" ? listingId(captured[field]) : captured[field];
    const actual = field === "id" ? listingId(requested[field]) : requested[field];
    if (String(expected ?? "") !== String(actual ?? "")) {
      throw inputError(`Replay ${field} does not match the requested ${field}.`, "REPLAY_INPUT_MISMATCH", { field, captured: expected, requested: actual });
    }
  }
  return captured;
}

function cursorFromSourceUrl(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    return /^https?:$/.test(url.protocol) ? url.searchParams.get("cursor") : null;
  } catch {
    return null;
  }
}

function resultWithCoverage(pages, input, { raw = false, capture = false, geocoding = null } = {}) {
  const listings = [];
  const seen = new Set();
  let duplicatesRemoved = 0;
  for (const page of pages) {
    for (const listing of page.normalized.listings) {
      if (seen.has(listing.id)) duplicatesRemoved += 1;
      else {
        seen.add(listing.id);
        listings.push(listing);
      }
    }
  }
  const last = pages.at(-1)?.normalized.pagination ?? { nextCursor: null, hasNextPage: false };
  const moreAvailable = Boolean(last.nextCursor);
  const requested = input.pages;
  const stopReason = moreAvailable && pages.length >= requested ? "page_limit" : "exhausted";
  const result = {
    kind: "airbnb_search",
    inputs: publicInputs(input),
    geocoding,
    priceFilter: {
      min: input.minPrice ?? null,
      max: input.maxPrice ?? null,
      basis: "unverified_provider_filter",
      note: "The public page payload does not establish whether Airbnb applied this range per night or to the stay total.",
    },
    listings,
    coverage: {
      pagesRequested: requested,
      pagesFetched: pages.length,
      uniqueListings: listings.length,
      duplicatesRemoved,
      moreAvailable,
      truncated: stopReason === "page_limit",
      nextCursor: last.nextCursor,
      stopReason,
    },
    sources: pages.map((page) => page.normalized.source),
  };
  if (raw) result.rawPages = pages.map((page) => page.payload);
  if (capture) result.capture = { format: "airbnb-axi-capture-v1", command: "search", inputBinding: "verified_capture", inputs: result.inputs, pages: pages.map((page) => page.evidence) };
  return result;
}

export function createProvider({
  fetchImpl,
  now = () => new Date(),
  timeoutMs = 30_000,
  disableGeocoding = process.env.DISABLE_GEOCODING === "true",
} = {}) {
  const transport = fetchImpl ?? nativeFetch;
  if (typeof transport !== "function") throw new TypeError("fetchImpl must be a function");
  let robotsContentPromise;

  async function assertRobots(url, ignoreRobots) {
    if (ignoreRobots) return;
    robotsContentPromise ??= fetchText(transport, `${BASE_URL}/robots.txt`, { timeoutMs: Math.min(timeoutMs, 10_000), headers: { "user-agent": USER_AGENT, accept: "text/plain" } }).then(({ body }) => body);
    let content;
    try {
      content = await robotsContentPromise;
    } catch (cause) {
      throw new RobotsDeniedError("Could not verify Airbnb robots.txt, so the request was not sent.", { code: "ROBOTS_UNAVAILABLE", cause });
    }
    if (!robotsAllows(content, new URL(url))) throw new RobotsDeniedError("Airbnb robots.txt disallows this path for the configured user agent.", { details: { url } });
  }

  async function livePage(url, { ignoreRobots }) {
    await assertRobots(url, ignoreRobots);
    const retrievedAt = now().toISOString();
    const { body } = await fetchText(transport, url, { timeoutMs });
    let payload;
    try {
      payload = extractDeferredPayload(body);
    } catch (error) {
      if (error instanceof SchemaError && error.code === "CHALLENGE_PAGE") {
        throw new AccessDeniedError("Airbnb returned a challenge page instead of listing data.", { code: "CHALLENGE_PAGE", details: { url }, cause: error });
      }
      throw error;
    }
    return { payload, evidence: { sourceUrl: url, retrievedAt, sha256: sha256(body), body } };
  }

  async function search(input) {
    const value = validateSearchInput(input);
    if (value.replay) return searchFromReplay(value, value.replay);
    const geocoding = value.placeId
      ? { method: "place_id", query: value.location, displayName: value.location, boundingBox: null, regionUncertainty: "Airbnb place ID supplied; no third-party geocoding used." }
      : disableGeocoding
        ? { method: "airbnb_fallback", query: value.location, displayName: value.location, boundingBox: null, regionUncertainty: "Third-party geocoding disabled. Airbnb may resolve the text to the wrong region." }
        : await geocode(transport, value.location, timeoutMs);
    const pages = [];
    const cursors = new Set();
    let cursor = value.cursor ?? null;
    for (let index = 0; index < value.pages; index += 1) {
      const pageInput = { ...value, cursor: cursor ?? undefined };
      const url = buildSearchUrl(pageInput, geocoding);
      try {
        const page = await livePage(url, { ignoreRobots: value.ignoreRobots });
        const normalized = normalizeSearchPage(page.payload, {
          sourceUrl: page.evidence.sourceUrl,
          retrievedAt: page.evidence.retrievedAt,
          sha256: page.evidence.sha256,
          inputs: pageInput,
        });
        pages.push({ ...page, normalized });
        const next = normalized.pagination.nextCursor;
        if (!next) break;
        if (cursors.has(next)) {
          const partial = resultWithCoverage(pages, value, { raw: value.raw, capture: value.capture, geocoding });
          partial.coverage = { ...partial.coverage, moreAvailable: true, truncated: true, nextCursor: next, stopReason: "failure", failure: { code: "REPEATED_CURSOR", message: "Airbnb repeated a pagination cursor." } };
          throw new PartialPaginationError("Airbnb repeated a pagination cursor; pagination stopped.", { code: "REPEATED_CURSOR", details: { partial } });
        }
        cursors.add(next);
        cursor = next;
      } catch (error) {
        if (error instanceof PartialPaginationError || pages.length === 0) throw error;
        const partial = resultWithCoverage(pages, value, { raw: value.raw, capture: value.capture, geocoding });
        partial.coverage = { ...partial.coverage, moreAvailable: true, truncated: true, stopReason: "failure", failure: { code: error.code ?? "PAGE_FAILED", message: error.message } };
        throw new PartialPaginationError(`Pagination failed after ${pages.length} page(s): ${error.message}`, { code: "PAGE_FETCH_FAILED", details: { partial, cause: { code: error.code, message: error.message } }, cause: error });
      }
    }
    return resultWithCoverage(pages, value, { raw: value.raw, capture: value.capture, geocoding });
  }

  async function searchFromReplay(input, replay) {
    const value = validateSearchInput(input);
    const decoded = typeof replay === "string" ? parseReplayInput(replay) : replay;
    if (!Array.isArray(decoded?.pages) || !decoded.pages.length) throw inputError("Replay contains no pages.", "EMPTY_REPLAY");
    const capturedInputs = replayBinding(decoded, value, "search");
    const pages = decoded.pages.slice(0, value.pages).map((page) => {
      const evidence = pageEvidence(page, "file://replay", now);
      const payload = replayPagePayload(page);
      const pageCursor = cursorFromSourceUrl(evidence.sourceUrl);
      const evidenceInputs = capturedInputs ? { ...capturedInputs, ...(pageCursor ? { cursor: pageCursor } : {}) } : pageCursor ? { cursor: pageCursor } : {};
      return {
        payload,
        evidence,
        normalized: normalizeSearchPage(payload, {
          sourceUrl: evidence.sourceUrl,
          retrievedAt: evidence.retrievedAt,
          sha256: evidence.sha256,
          inputs: evidenceInputs,
        }),
      };
    });
    const result = resultWithCoverage(pages, value, { raw: value.raw, capture: value.capture, geocoding: { method: "replay", regionUncertainty: "The saved source response is replayed; no current location resolution was performed." } });
    result.requestedInputs = publicInputs(value);
    result.inputs = capturedInputs ?? {};
    result.inputBinding = capturedInputs ? "verified_capture" : "unverified";
    if (value.capture) {
      result.capture = {
        format: "airbnb-axi-capture-v1",
        command: "search",
        inputBinding: result.inputBinding,
        ...(capturedInputs ? { inputs: capturedInputs } : { requestedInputs: result.requestedInputs }),
        pages: pages.map((page) => page.evidence),
      };
    }
    if (pages.length < value.pages && result.coverage.moreAvailable) {
      result.coverage = {
        ...result.coverage,
        truncated: true,
        stopReason: "failure",
        failure: { code: "REPLAY_PAGES_MISSING", message: `Replay contains ${pages.length} page(s), but ${value.pages} were requested.` },
      };
      throw new PartialPaginationError("Replay ended before the requested page limit.", { code: "REPLAY_PAGES_MISSING", details: { partial: result } });
    }
    return result;
  }

  async function listing(input) {
    const value = validateListingInput(input);
    if (value.replay) return listingFromReplay(value, value.replay);
    const url = buildListingUrl(value);
    const page = await livePage(url, { ignoreRobots: value.ignoreRobots });
    const normalized = normalizeListingPage(page.payload, {
      listingId: value.id,
      sourceUrl: page.evidence.sourceUrl,
      retrievedAt: page.evidence.retrievedAt,
      sha256: page.evidence.sha256,
      inputs: publicInputs(value),
    });
    if (value.raw) normalized.raw = page.payload;
    if (value.capture) normalized.capture = { format: "airbnb-axi-capture-v1", command: "listing", inputBinding: "verified_capture", inputs: publicInputs(value), pages: [page.evidence] };
    return normalized;
  }

  async function listingFromReplay(input, replay) {
    const value = validateListingInput(input);
    const decoded = typeof replay === "string" ? parseReplayInput(replay) : replay;
    const capturedInputs = replayBinding(decoded, value, "listing");
    const page = decoded?.pages?.[0];
    if (!page) throw inputError("Replay contains no listing page.", "EMPTY_REPLAY");
    const evidence = pageEvidence(page, "file://replay", now);
    const payload = replayPagePayload(page);
    const normalized = normalizeListingPage(payload, {
      listingId: capturedInputs?.id ?? null,
      sourceUrl: evidence.sourceUrl,
      retrievedAt: evidence.retrievedAt,
      sha256: evidence.sha256,
      inputs: capturedInputs ?? {},
    });
    if (!normalized.id) throw new SchemaError("Listing ID was not found in replay payload or capture metadata.", { code: "REPLAY_LISTING_ID_MISSING" });
    if (normalized.id !== value.id) throw inputError("Replay listing ID does not match the requested listing ID.", "REPLAY_INPUT_MISMATCH", { field: "id", captured: normalized.id, requested: value.id });
    normalized.requestedInputs = publicInputs(value);
    normalized.inputs = capturedInputs ?? { id: normalized.id };
    normalized.inputBinding = capturedInputs ? "verified_capture" : "payload_id_only";
    if (value.raw) normalized.raw = payload;
    if (value.capture) normalized.capture = {
      format: "airbnb-axi-capture-v1",
      command: "listing",
      inputBinding: normalized.inputBinding,
      ...(capturedInputs ? { inputs: capturedInputs } : { inputs: { id: normalized.id }, requestedInputs: normalized.requestedInputs }),
      pages: [evidence],
    };
    return normalized;
  }

  return { search, listing, searchFromReplay, listingFromReplay };
}
