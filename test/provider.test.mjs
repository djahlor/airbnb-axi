import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { promisify } from "node:util";
import test from "node:test";

import {
  buildListingUrl,
  buildSearchUrl,
  createProvider,
  nativeFetch,
  parseReplayInput,
  validateListingInput,
  validateSearchInput,
} from "../lib/provider.mjs";
import {
  extractDeferredPayload,
  normalizeListingPage,
  normalizeSearchPage,
} from "../lib/normalize.mjs";
import {
  AccessDeniedError,
  AirbnbAxiError,
  InputError,
  PartialPaginationError,
  RobotsDeniedError,
  SchemaError,
  TimeoutError,
} from "../lib/errors.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = new URL("..", import.meta.url);

const searchResult = ({ id = "101", cursor = "next-1" } = {}) => ({
  niobeClientData: [["Search", {
    data: {
      presentation: {
        staysSearch: {
          results: {
            searchResults: [{
              demandStayListing: {
                id: Buffer.from(`StayListing:${id}`).toString("base64"),
                description: { name: "Canal loft" },
                location: { city: "Amsterdam" },
              },
              structuredContent: {
                primaryLine: { body: "Canal loft" },
                secondaryLine: { body: "2 beds" },
              },
              structuredDisplayPrice: {
                primaryLine: { accessibilityLabel: "€240 total" },
                secondaryLine: { accessibilityLabel: "€120 per night" },
                explanationData: {
                  title: "Price details",
                  priceDetails: { items: [{ description: "2 nights", priceString: "€240" }] },
                },
              },
              contextualPictures: [{
                picture: {
                  id: "photo-1",
                  picture: "https://a0.muscache.com/im/pictures/example.jpg",
                  caption: "Dining room with table",
                },
              }],
            }],
            paginationInfo: { nextPageCursor: cursor, hasNextPage: Boolean(cursor) },
          },
        },
      },
    },
  }]],
});

const listingResult = () => ({
  niobeClientData: [
    ["StayProductDetailPage", {
      data: {
        presentation: {
          stayProductDetailPage: {
            sections: {
              sections: [
                { sectionId: "LOCATION_DEFAULT", section: { __typename: "LocationSection" } },
                { sectionId: "DESCRIPTION_DEFAULT", section: { htmlDescription: { htmlText: "<p>Quiet home.</p>" } } },
                { sectionId: "DESCRIPTION_MODAL", section: { title: "About this space", items: [{ title: "The space", html: { htmlText: "Private Finnish sauna.<br />Paid parking €4/hour." } }] } },
                { sectionId: "PHOTO_TOUR_SCROLLABLE_MODAL", section: { mediaItems: [{ id: "section-photo", baseUrl: "https://a0.muscache.com/im/pictures/section.jpg", accessibilityLabel: "Kitchen" }] } },
                { sectionId: "POLICIES_DEFAULT", section: { title: "House rules", houseRulesSections: [{ title: "Checking in", items: [{ title: "After 3:00 PM" }] }] } },
                { sectionId: "AMENITIES_DEFAULT", section: { __typename: "AmenitiesSection" } },
              ],
            },
          },
        },
      },
    }],
    ["PdpPresentation", {
      data: {
        node: {
          pdpPresentation: {
            listingId: "101",
            location: { subtitle: "Amsterdam, Netherlands", latitude: 52.37, longitude: 4.89, isExactLocation: false },
            amenities: {
              title: "What this place offers",
              seeAllAmenitiesGroups: [{
                title: "Heating and cooling",
                amenities: [
                  { id: "ac", title: "Air conditioning", available: false, subtitle: "Not provided" },
                  { id: "heat", title: "Heating", available: true },
                  { id: "unknown", title: "Ceiling fan" },
                ],
              }],
            },
            highlights: [{ title: "Great location", subtitle: "Guests loved the area" }],
            rules: {
              title: "House rules",
              groupItems: [{ title: "During your stay", items: [{ title: "No smoking", description: { text: "Inside the home" } }] }],
            },
            photos: [{ id: "pdp-photo", baseUrl: "https://a0.muscache.com/im/pictures/pdp.jpg", caption: "Living room" }],
          },
        },
      },
    }],
  ],
});

function htmlFor(value) {
  return `<!doctype html><script id="data-deferred-state-0" type="application/json">${JSON.stringify(value).replaceAll("<", "\\u003c")}</script>`;
}

test("input validation rejects impossible dates and guest counts before I/O", () => {
  assert.throws(
    () => validateSearchInput({ location: "Paris", checkin: "2026-12-10", checkout: "2026-12-09", adults: 1 }),
    (error) => error instanceof InputError && error.code === "INVALID_DATE_RANGE",
  );
  assert.throws(
    () => validateSearchInput({ location: "Paris", adults: 0, children: -1 }),
    (error) => error instanceof InputError && error.code === "INVALID_GUEST_COUNT",
  );
  assert.throws(
    () => validateListingInput({ id: "javascript:alert(1)", adults: 1 }),
    (error) => error instanceof InputError && error.code === "INVALID_LISTING_ID",
  );
});

test("URL builders preserve dates, guests, currency and price filter meaning", () => {
  const searchUrl = new URL(buildSearchUrl({
    location: "Paris, France", checkin: "2026-12-10", checkout: "2026-12-12",
    adults: 2, children: 1, infants: 1, pets: 1, minPrice: 100, maxPrice: 300,
    propertyType: "entire_home", placeId: "ChIJD7fiBh9u5kcRYJSMaMOCCwQ", currency: "EUR",
  }));
  assert.equal(searchUrl.pathname, "/s/Paris--France/homes");
  assert.equal(searchUrl.searchParams.get("checkin"), "2026-12-10");
  assert.equal(searchUrl.searchParams.get("checkout"), "2026-12-12");
  assert.equal(searchUrl.searchParams.get("adults"), "2");
  assert.equal(searchUrl.searchParams.get("children"), "1");
  assert.equal(searchUrl.searchParams.get("infants"), "1");
  assert.equal(searchUrl.searchParams.get("pets"), "1");
  assert.equal(searchUrl.searchParams.get("price_min"), "100");
  assert.equal(searchUrl.searchParams.get("price_max"), "300");
  assert.equal(searchUrl.searchParams.get("currency"), "EUR");
  assert.deepEqual(searchUrl.searchParams.getAll("l2_property_type_ids[]"), ["1"]);

  const listingUrl = new URL(buildListingUrl({ id: "https://www.airbnb.com/rooms/12345?foo=bar", checkin: "2026-12-10", checkout: "2026-12-12", adults: 2, currency: "EUR" }));
  assert.equal(listingUrl.pathname, "/rooms/12345");
  assert.equal(listingUrl.searchParams.get("check_in"), "2026-12-10");
  assert.equal(listingUrl.searchParams.get("check_out"), "2026-12-12");
  assert.equal(listingUrl.searchParams.get("currency"), "EUR");
});

test("extractDeferredPayload reports a changed page shape", () => {
  assert.throws(() => extractDeferredPayload("<html><h1>Airbnb</h1></html>"), SchemaError);
  assert.throws(() => extractDeferredPayload('<script id="data-deferred-state-0">{broken</script>'), SchemaError);
});

test("extractDeferredPayload parses valid JSON before considering HTML entity decoding", () => {
  const payload = extractDeferredPayload('<script id="data-deferred-state-0">{"description":"Rock &quot; Roll"}</script>');
  assert.equal(payload.description, "Rock &quot; Roll");
});

test("challenge detection ignores captcha configuration when usable deferred data exists", async () => {
  const fixtures = [
    ["synthetic-search-with-recaptcha-config.html", "synthetic-search"],
    ["synthetic-listing-with-recaptcha-config.html", "synthetic-listing"],
  ];
  for (const [name, expectedFixture] of fixtures) {
    const html = await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
    assert.equal(extractDeferredPayload(html).fixture, expectedFixture, name);
  }

  const provider = createProvider({
    disableGeocoding: true,
    fetchImpl: async () => new Response(`${htmlFor(listingResult())}<script>window.recaptchaConfig = { captcha: true }</script>`, { status: 200 }),
  });
  const listing = await provider.listing({ id: "101", adults: 1, ignoreRobots: true });
  assert.equal(listing.id, "101");
});

test("provider stops on a rendered challenge page without usable deferred data", async () => {
  const provider = createProvider({
    fetchImpl: async () => new Response("<!doctype html><title>Access denied</title><h1>Verify you are human</h1><script>loadCaptcha()</script>", { status: 200 }),
  });
  await assert.rejects(
    provider.listing({ id: "101", adults: 1, ignoreRobots: true }),
    (error) => error instanceof AccessDeniedError && error.code === "CHALLENGE_PAGE",
  );
});

test("search normalization tolerates a moved result branch and preserves pricing qualifiers and photos", () => {
  const moved = { changedShape: { data: searchResult().niobeClientData[0][1].data } };
  const page = normalizeSearchPage(moved, {
    sourceUrl: "https://www.airbnb.com/s/Paris--France/homes",
    retrievedAt: "2026-10-20T10:00:00.000Z",
    sha256: "abc",
    inputs: { location: "Paris", checkin: "2026-12-10", checkout: "2026-12-12", adults: 2, currency: "EUR" },
  });
  assert.equal(page.listings[0].id, "101");
  assert.deepEqual(page.listings[0].price.labels, ["€240 total", "€120 per night"]);
  assert.equal(page.listings[0].price.total.raw, "€240 total");
  assert.equal(page.listings[0].price.nightly.raw, "€120 per night");
  assert.equal(page.listings[0].price.feeCompleteness, "unknown");
  assert.deepEqual(page.listings[0].photos, [{ id: "photo-1", url: "https://a0.muscache.com/im/pictures/example.jpg", caption: "Dining room with table", evidence: "listing_payload" }]);
  assert.equal(page.pagination.nextCursor, "next-1");
});

test("search normalization rejects a nonnumeric decoded listing ID", () => {
  const payload = searchResult({ cursor: null });
  payload.niobeClientData[0][1].data.presentation.staysSearch.results.searchResults[0].demandStayListing.id = Buffer.from("StayListing:../../etc/passwd").toString("base64");
  assert.throws(
    () => normalizeSearchPage(payload, { inputs: {} }),
    (error) => error instanceof SchemaError && error.code === "LISTING_ID_MISSING",
  );
});

test("search normalization reads localized titles, result subtitles and structured qualifier arrays", () => {
  const payload = searchResult({ cursor: null });
  const result = payload.niobeClientData[0][1].data.presentation.staysSearch.results.searchResults[0];
  result.demandStayListing.description.name = { localizedStringWithTranslationPreference: "Canal studio" };
  result.subtitle = "Canal studio, Amsterdam";
  result.structuredContent.primaryLine = [{ body: "1 queen bed" }, { body: "1 bath" }];
  result.structuredContent.secondaryLine = [{ body: "Business host" }];
  const listing = normalizeSearchPage(payload, { inputs: {} }).listings[0];
  assert.equal(listing.title, "Canal studio");
  assert.equal(listing.subtitle, "Canal studio, Amsterdam");
  assert.deepEqual(listing.qualifiers, { primary: ["1 queen bed", "1 bath"], secondary: ["Business host"] });
});

test("listing normalization preserves included, excluded and unknown amenities, rules, descriptions and photo captions", () => {
  const listing = normalizeListingPage(listingResult(), {
    listingId: "101", sourceUrl: "https://www.airbnb.com/rooms/101",
    retrievedAt: "2026-10-20T10:00:00.000Z", sha256: "def",
    inputs: { checkin: "2026-12-10", checkout: "2026-12-12", adults: 2 },
  });
  assert.deepEqual(listing.amenities.included.map((x) => x.title), ["Heating"]);
  assert.deepEqual(listing.amenities.excluded.map((x) => x.title), ["Air conditioning"]);
  assert.deepEqual(listing.amenities.unknown.map((x) => x.title), ["Ceiling fan"]);
  assert.match(listing.descriptions[0].text, /Quiet home/);
  assert.deepEqual(listing.descriptions.find((item) => item.title === "The space"), {
    sectionId: "DESCRIPTION_MODAL", title: "The space", text: "Private Finnish sauna.\nPaid parking €4/hour.", html: "Private Finnish sauna.<br />Paid parking €4/hour.",
  });
  assert.equal(listing.rules[0].items[0].title, "After 3:00 PM");
  assert.deepEqual(listing.rules[1], { title: "During your stay", items: [{ title: "No smoking", detail: "Inside the home" }], source: "pdp.rules" });
  assert.deepEqual(listing.photos, [
    { id: "pdp-photo", url: "https://a0.muscache.com/im/pictures/pdp.jpg", caption: "Living room", evidence: "listing_payload" },
    { id: "section-photo", url: "https://a0.muscache.com/im/pictures/section.jpg", caption: "Kitchen", evidence: "listing_payload" },
  ]);
  assert.deepEqual(listing.workspace, { status: "unknown", amenityHints: [], evidence: "No visual or specific-text workspace assessment was performed." });
  assert.deepEqual(listing.availability, { status: "unknown", evidence: "Requested dates in a page request do not prove the listing is bookable for those dates." });
  assert.deepEqual(listing.location, { subtitle: "Amsterdam, Netherlands", latitude: 52.37, longitude: 4.89, isExactLocation: false });
});

test("page cursor arrays advance from the current page instead of reporting exhaustion", () => {
  const payload = searchResult({ cursor: null });
  payload.niobeClientData[0][1].data.presentation.staysSearch.results.paginationInfo = {
    pageCursors: ["offset-0", "offset-18", "offset-36"],
  };
  const first = normalizeSearchPage(payload, { inputs: {} });
  assert.equal(first.pagination.nextCursor, "offset-18");
  assert.equal(first.pagination.hasNextPage, true);
  const second = normalizeSearchPage(payload, { inputs: { cursor: "offset-18" } });
  assert.equal(second.pagination.nextCursor, "offset-36");
  assert.throws(
    () => normalizeSearchPage(payload, { inputs: { cursor: "not-in-response" } }),
    (error) => error instanceof SchemaError && error.code === "PAGINATION_CURSOR_NOT_FOUND",
  );
  payload.niobeClientData[0][1].data.presentation.staysSearch.results.paginationInfo.pageCursors = ["offset-0"];
  assert.equal(normalizeSearchPage(payload, { inputs: {} }).pagination.nextCursor, null);
});

test("search normalization rejects a claimed next page without a usable cursor", () => {
  const payload = searchResult({ cursor: null });
  payload.niobeClientData[0][1].data.presentation.staysSearch.results.paginationInfo = { hasNextPage: true };
  assert.throws(
    () => normalizeSearchPage(payload, { inputs: {} }),
    (error) => error instanceof SchemaError && error.code === "PAGINATION_CURSOR_MISSING",
  );
});

test("search pricing preserves display and precise breakdown values without equating them", () => {
  const payload = searchResult({ cursor: null });
  const price = payload.niobeClientData[0][1].data.presentation.staysSearch.results.searchResults[0].structuredDisplayPrice;
  price.primaryLine = { price: "€974 total" };
  price.secondaryLine = null;
  price.explanationData = {
    title: "Price details",
    priceDetails: [{ items: [
      { description: "7 nights × €123.56", priceString: "€864.90" },
      { description: "Taxes", priceString: "€108.11" },
      { description: "Total", priceString: "€973.01" },
    ] }],
  };
  const page = normalizeSearchPage(payload, { sourceUrl: "https://example.test", retrievedAt: "2026-10-20T10:00:00.000Z", sha256: "abc", inputs: {} });
  assert.deepEqual(page.listings[0].price.labels, ["€974 total"]);
  assert.deepEqual(page.listings[0].price.breakdown, [
    { description: "7 nights × €123.56", price: "€864.90" },
    { description: "Taxes", price: "€108.11" },
    { description: "Total", price: "€973.01" },
  ]);
  assert.equal(page.listings[0].price.total.raw, "€974 total");
  assert.equal(page.listings[0].price.feeCompleteness, "unknown");
  assert.deepEqual(page.listings[0].price.currency, { requested: null, observed: "EUR", certainty: "symbol" });
});

test("provider rejects a repeated pagination cursor and exposes the partial result", async () => {
  const calls = [];
  const provider = createProvider({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(htmlFor(searchResult({ cursor: "same" })), { status: 200, headers: { "content-type": "text/html" } });
    },
    now: () => new Date("2026-10-20T10:00:00.000Z"),
    disableGeocoding: true,
  });
  await assert.rejects(
    provider.search({ location: "Paris", adults: 1, pages: 3, ignoreRobots: true }),
    (error) => {
      assert.ok(error instanceof PartialPaginationError);
      assert.equal(error.code, "REPEATED_CURSOR");
      assert.equal(error.details.partial.coverage.pagesFetched, 2);
      assert.equal(error.details.partial.coverage.failure.code, "REPEATED_CURSOR");
      assert.equal(error.details.partial.listings.length, 1);
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test("provider deduplicates listing IDs and declares bounded coverage", async () => {
  const pages = [searchResult({ id: "101", cursor: "page-2" }), searchResult({ id: "101", cursor: null })];
  let call = 0;
  const provider = createProvider({
    fetchImpl: async () => new Response(htmlFor(pages[call++]), { status: 200, headers: { "content-type": "text/html" } }),
    now: () => new Date("2026-10-20T10:00:00.000Z"),
    disableGeocoding: true,
  });
  const result = await provider.search({ location: "Paris", adults: 1, pages: 2, ignoreRobots: true });
  assert.equal(result.listings.length, 1);
  assert.deepEqual(result.coverage, {
    pagesRequested: 2, pagesFetched: 2, uniqueListings: 1, duplicatesRemoved: 1,
    moreAvailable: false, truncated: false, nextCursor: null, stopReason: "exhausted",
  });
});

test("live pagination normalizes each page against the cursor used for that request", async () => {
  const first = searchResult({ id: "101", cursor: null });
  const second = searchResult({ id: "102", cursor: null });
  for (const payload of [first, second]) payload.niobeClientData[0][1].data.presentation.staysSearch.results.paginationInfo = { pageCursors: ["offset-0", "offset-18", "offset-36"] };
  const calls = [];
  const provider = createProvider({
    disableGeocoding: true,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(htmlFor(calls.length === 1 ? first : second), { status: 200 });
    },
  });
  const result = await provider.search({ location: "Amsterdam", adults: 1, pages: 2, ignoreRobots: true });
  assert.equal(new URL(calls[0]).searchParams.get("cursor"), null);
  assert.equal(new URL(calls[1]).searchParams.get("cursor"), "offset-18");
  assert.equal(result.coverage.nextCursor, "offset-36");
});

test("network access denial, timeout and malformed schema retain typed errors", async () => {
  const denied = createProvider({ fetchImpl: async () => new Response("Forbidden", { status: 403 }) });
  await assert.rejects(denied.listing({ id: "101", adults: 1, ignoreRobots: true }), AccessDeniedError);

  const timeout = createProvider({ fetchImpl: async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; } });
  await assert.rejects(timeout.listing({ id: "101", adults: 1, ignoreRobots: true }), TimeoutError);

  const malformed = createProvider({ fetchImpl: async () => new Response("<html>not data</html>", { status: 200 }) });
  await assert.rejects(malformed.listing({ id: "101", adults: 1, ignoreRobots: true }), SchemaError);
});

test("native transport follows bounded redirects and honors abort signals", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/ok" });
      response.end();
    } else if (request.url === "/loop") {
      response.writeHead(302, { location: "/loop" });
      response.end();
    } else if (request.url === "/bad-redirect") {
      response.writeHead(302, { location: "http://[" });
      response.end();
    } else if (request.url === "/slow") {
      setTimeout(() => response.end("late"), 100);
    } else {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("native-ok");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const response = await nativeFetch(`${base}/redirect`, { redirect: "follow" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "native-ok");
  await assert.rejects(nativeFetch(`${base}/loop`, { redirect: "follow" }), (error) => error instanceof AirbnbAxiError && error.code === "REDIRECT_LIMIT");
  await assert.rejects(nativeFetch(`${base}/bad-redirect`, { redirect: "follow" }), (error) => error instanceof AirbnbAxiError && error.code === "REDIRECT_INVALID");
  await assert.rejects(nativeFetch(`${base}/slow`, { signal: AbortSignal.timeout(10) }), (error) => error?.name === "AbortError");
});

test("provider honors wildcard robots rules before requesting a listing page", async () => {
  const calls = [];
  const provider = createProvider({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response("User-agent: *\nDisallow: /rooms/*\n", { status: 200 });
    },
  });
  await assert.rejects(provider.listing({ id: "101", adults: 1 }), RobotsDeniedError);
  assert.deepEqual(calls, ["https://www.airbnb.com/robots.txt"]);
});

test("parseReplayInput accepts capture JSON and raw HTML without network access", () => {
  const html = htmlFor(searchResult({ cursor: null }));
  assert.deepEqual(parseReplayInput(JSON.stringify({ format: "airbnb-axi-capture-v1", pages: [{ body: html, sourceUrl: "https://example.test" }] })), {
    pages: [{ body: html, sourceUrl: "https://example.test" }], format: "airbnb-axi-capture-v1",
  });
  assert.deepEqual(parseReplayInput(html), { pages: [{ body: html, sourceUrl: "file://replay" }], format: "html" });
  const capture = parseReplayInput(JSON.stringify({ format: "airbnb-axi-capture-v1", command: "search", inputs: { location: "Paris", checkin: "2026-12-10" }, pages: [{ body: html }] }));
  assert.equal(capture.command, "search");
  assert.deepEqual(capture.inputs, { location: "Paris", checkin: "2026-12-10" });
});

test("listing replay omits the embedded replay body from normalized inputs", async () => {
  const replay = parseReplayInput(htmlFor(listingResult()));
  const provider = createProvider();
  const result = await provider.listing({ id: "101", adults: 1, replay });
  assert.equal(Object.hasOwn(result.inputs, "replay"), false);
  assert.deepEqual(result.inputs, { id: "101" });
  assert.equal(result.inputBinding, "payload_id_only");
  assert.equal(result.source.retrievedAt, null);
  assert.equal(result.requestedInputs.id, "101");
});

test("saving an unbound replay cannot promote requested context to verified evidence", async () => {
  const provider = createProvider({ now: () => new Date("2026-10-20T10:00:00.000Z") });
  const searchReplay = parseReplayInput(htmlFor(searchResult({ cursor: null })));
  const firstSearch = await provider.search({
    location: "Paris", checkin: "2026-12-10", checkout: "2026-12-12", adults: 2,
    pages: 1, replay: searchReplay, capture: true,
  });
  assert.equal(firstSearch.capture.inputBinding, "unverified");
  assert.equal(Object.hasOwn(firstSearch.capture, "inputs"), false);
  assert.equal(firstSearch.capture.requestedInputs.checkin, "2026-12-10");
  const secondSearchReplay = parseReplayInput(JSON.stringify(firstSearch.capture));
  const secondSearch = await provider.search({
    location: "Berlin", checkin: "2027-01-03", checkout: "2027-01-05", adults: 1,
    pages: 1, replay: secondSearchReplay,
  });
  assert.equal(secondSearch.inputBinding, "unverified");
  assert.deepEqual(secondSearch.inputs, {});

  const listingReplay = parseReplayInput(htmlFor(listingResult()));
  const firstListing = await provider.listing({
    id: "101", checkin: "2026-12-10", checkout: "2026-12-12", adults: 2,
    replay: listingReplay, capture: true,
  });
  assert.equal(firstListing.capture.inputBinding, "payload_id_only");
  assert.deepEqual(firstListing.capture.inputs, { id: "101" });
  assert.equal(firstListing.capture.requestedInputs.checkin, "2026-12-10");
  const secondListingReplay = parseReplayInput(JSON.stringify(firstListing.capture));
  const secondListing = await provider.listing({
    id: "101", checkin: "2027-01-03", checkout: "2027-01-05", adults: 1,
    replay: secondListingReplay,
  });
  assert.equal(secondListing.inputBinding, "payload_id_only");
  assert.deepEqual(secondListing.inputs, { id: "101" });
});

test("listing replay rejects captured input and hash mismatches", async () => {
  const html = htmlFor(listingResult());
  const mismatch = parseReplayInput(JSON.stringify({
    format: "airbnb-axi-capture-v1", command: "listing",
    inputs: { id: "101", checkin: "2026-12-10", checkout: "2026-12-12", adults: 1, children: 0, infants: 0, pets: 0, currency: "EUR" },
    pages: [{ body: html, sourceUrl: "https://www.airbnb.com/rooms/101", retrievedAt: "2026-10-20T10:00:00.000Z" }],
  }));
  const provider = createProvider();
  await assert.rejects(
    provider.listing({ id: "101", checkin: "2026-12-11", checkout: "2026-12-12", adults: 1, replay: mismatch }),
    (error) => error instanceof InputError && error.code === "REPLAY_INPUT_MISMATCH",
  );
  const badHash = structuredClone(mismatch);
  badHash.pages[0].sha256 = "0".repeat(64);
  await assert.rejects(
    provider.listing({ id: "101", checkin: "2026-12-10", checkout: "2026-12-12", adults: 1, replay: badHash }),
    (error) => error instanceof SchemaError && error.code === "REPLAY_HASH_MISMATCH",
  );
});

test("replay rejects competing body and payload representations even with a valid body hash", async () => {
  const body = htmlFor(listingResult());
  const fake = listingResult();
  fake.niobeClientData[1][1].data.node.pdpPresentation.listingId = "999";
  const replay = parseReplayInput(JSON.stringify({
    format: "airbnb-axi-capture-v1",
    pages: [{ body, payload: fake, sha256: createHash("sha256").update(body).digest("hex") }],
  }));
  const provider = createProvider();
  await assert.rejects(
    provider.listing({ id: "101", adults: 1, replay }),
    (error) => error instanceof SchemaError && error.code === "AMBIGUOUS_REPLAY_PAGE",
  );
});

test("search replay reports a missing requested page as partial pagination", async () => {
  const replay = parseReplayInput(htmlFor(searchResult({ cursor: "page-2" })));
  const provider = createProvider();
  await assert.rejects(
    provider.search({ location: "Paris", adults: 1, pages: 2, replay }),
    (error) => error instanceof PartialPaginationError && error.code === "REPLAY_PAGES_MISSING" && error.details.partial.coverage.pagesFetched === 1,
  );
});

test("CLI replays a saved search capture and emits complete JSON coverage", async (t) => {
  const fixtureDir = new URL("./.tmp-provider-test/", projectRoot);
  const fixture = new URL("capture.json", fixtureDir);
  await mkdir(fixtureDir, { recursive: true });
  t.after(() => rm(fixtureDir, { recursive: true, force: true }));
  await writeFile(fixture, JSON.stringify({
    format: "airbnb-axi-capture-v1",
    command: "search",
    inputs: { location: "Paris, France", checkin: "2026-12-10", checkout: "2026-12-12", adults: 2, children: 0, infants: 0, pets: 0, currency: "EUR" },
    pages: [{ body: htmlFor(searchResult({ cursor: null })), sourceUrl: "https://www.airbnb.com/s/Paris--France/homes" }],
  }));
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "bin/airbnb-axi.mjs", "search", "Paris, France", "--from-file", fixture.pathname,
    "--checkin", "2026-12-10", "--checkout", "2026-12-12", "--adults", "2", "--json",
  ], { cwd: projectRoot });
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.inputs.checkin, "2026-12-10");
  assert.equal(result.inputs.checkout, "2026-12-12");
  assert.equal(result.inputs.adults, 2);
  assert.equal(result.coverage.pagesFetched, 1);
  assert.equal(result.listings[0].price.total.raw, "€240 total");
  assert.equal(result.priceFilter.basis, "unverified_provider_filter");
});

test("CLI rejects invalid dates before attempting a request", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      "bin/airbnb-axi.mjs", "search", "Paris", "--checkin", "bad", "--checkout", "2026-12-12", "--json",
    ], { cwd: projectRoot }),
    (error) => {
      assert.equal(error.code, 2);
      const output = JSON.parse(error.stdout);
      assert.equal(output.error.code, "INVALID_DATE");
      return true;
    },
  );
});

test("CLI compact listing output renders structured rule details", async (t) => {
  const fixtureDir = new URL("./.tmp-listing-cli-test/", projectRoot);
  const fixture = new URL("listing.html", fixtureDir);
  await mkdir(fixtureDir, { recursive: true });
  t.after(() => rm(fixtureDir, { recursive: true, force: true }));
  await writeFile(fixture, htmlFor(listingResult()));
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "bin/airbnb-axi.mjs", "listing", "101", "--from-file", fixture.pathname,
  ], { cwd: projectRoot });
  assert.equal(stderr, "");
  assert.match(stdout, /Rules Checking in: After 3:00 PM/);
  assert.match(stdout, /Rules During your stay: No smoking \(Inside the home\)/);
  assert.match(stdout, /Amenities excluded \(1\): Air conditioning \(Not provided\)/);
  assert.doesNotMatch(stdout, /\[object Object\]/);
});

test("CLI help and compact search do not claim an unverified price-filter basis", async (t) => {
  const fixtureDir = new URL("./.tmp-search-cli-test/", projectRoot);
  const fixture = new URL("search.html", fixtureDir);
  await mkdir(fixtureDir, { recursive: true });
  t.after(() => rm(fixtureDir, { recursive: true, force: true }));
  await writeFile(fixture, htmlFor(searchResult({ cursor: null })));
  const help = await execFileAsync(process.execPath, ["bin/airbnb-axi.mjs", "help"], { cwd: projectRoot });
  assert.match(help.stdout, /price filter basis is unverified/i);
  assert.doesNotMatch(help.stdout, /per-night filters/i);
  for (const command of ["search", "listing", "assess", "doctor"]) {
    const subcommandHelp = await execFileAsync(process.execPath, ["bin/airbnb-axi.mjs", command, "--help"], { cwd: projectRoot });
    assert.match(subcommandHelp.stdout, /Usage:\n  airbnb-axi search/);
    assert.equal(subcommandHelp.stderr, "");
  }
  const { stdout } = await execFileAsync(process.execPath, [
    "bin/airbnb-axi.mjs", "search", "Paris", "--from-file", fixture.pathname,
    "--checkin", "2026-12-10", "--checkout", "2026-12-12", "--adults", "2", "--children", "1",
    "--currency", "EUR", "--min-price", "100", "--max-price", "300",
  ], { cwd: projectRoot });
  assert.match(stdout, /Evidence inputs: not recorded in this replay/);
  assert.match(stdout, /Requested replay context \(unverified\): 2026-12-10 to 2026-12-12; 2 adults, 1 children, 0 infants, 0 pets; EUR/);
  assert.match(stdout, /Price filter: 100 to 300; basis unverified by the provider payload/);
  assert.match(stdout, /Price breakdown: 2 nights = €240/);
  assert.match(stdout, /Retrieved: .*; SHA-256:/);
});
