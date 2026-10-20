import { SchemaError } from "./errors.mjs";

function decodeEntities(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function visiblePageText(html) {
  return decodeEntities(html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function hasRenderedChallengeEvidence(html) {
  const visible = visiblePageText(html);
  return /\b(?:captcha|access denied|unusual traffic|automated requests)\b|verify (?:you are|that you're) human/i.test(visible);
}

export function extractDeferredPayload(html) {
  if (typeof html !== "string" || html.length === 0) {
    throw new SchemaError("Airbnb response body is empty.", { code: "EMPTY_RESPONSE" });
  }
  const scriptPattern = /<script\b[^>]*\bid=(?:["']data-deferred-state-0["']|data-deferred-state-0)[^>]*>([\s\S]*?)<\/script\s*>/i;
  const match = scriptPattern.exec(html);
  if (!match) {
    const denied = hasRenderedChallengeEvidence(html);
    throw new SchemaError(
      denied ? "Airbnb returned a challenge page instead of listing data." : "Airbnb deferred data script was not found; the page shape may have changed.",
      { code: denied ? "CHALLENGE_PAGE" : "DEFERRED_DATA_MISSING" },
    );
  }
  const text = match[1].trim();
  try {
    return JSON.parse(text);
  } catch (rawCause) {
    const decoded = decodeEntities(text);
    if (decoded !== text) {
      try {
        return JSON.parse(decoded);
      } catch {
        // Report the original text and parse failure below.
      }
    }
    throw new SchemaError("Airbnb deferred data is not valid JSON.", {
      code: "DEFERRED_DATA_INVALID_JSON",
      details: { preview: text.slice(0, 160) },
      cause: rawCause,
    });
  }
}

function walk(root, visitor, { maxNodes = 100_000 } = {}) {
  const stack = [root];
  const seen = new Set();
  let count = 0;
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (++count > maxNodes) throw new SchemaError("Airbnb payload is too large to inspect safely.", { code: "PAYLOAD_TOO_LARGE" });
    const result = visitor(value);
    if (result !== undefined) return result;
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return undefined;
}

function findSearchResults(payload) {
  const direct = payload?.niobeClientData?.[0]?.[1]?.data?.presentation?.staysSearch?.results;
  if (Array.isArray(direct?.searchResults)) return direct;
  const found = walk(payload, (value) => {
    if (Array.isArray(value.searchResults) && value.paginationInfo && typeof value.paginationInfo === "object") return value;
    return undefined;
  });
  if (!found) throw new SchemaError("Search results were not found in Airbnb's payload.", { code: "SEARCH_RESULTS_MISSING" });
  return found;
}

function findSections(payload) {
  const direct = payload?.niobeClientData?.[0]?.[1]?.data?.presentation?.stayProductDetailPage?.sections?.sections;
  if (Array.isArray(direct)) return direct;
  const found = walk(payload, (value) => {
    if (Array.isArray(value.sections) && value.sections.some((entry) => entry && typeof entry.sectionId === "string")) return value.sections;
    return undefined;
  });
  if (!found) throw new SchemaError("Listing sections were not found in Airbnb's payload.", { code: "LISTING_SECTIONS_MISSING" });
  return found;
}

function findPdpPresentation(payload) {
  const direct = payload?.niobeClientData?.find?.((entry) => entry?.[1]?.data?.node?.pdpPresentation)?.[1]?.data?.node?.pdpPresentation;
  if (direct) return direct;
  return walk(payload, (value) => value.pdpPresentation && typeof value.pdpPresentation === "object" ? value.pdpPresentation : undefined) ?? null;
}

function decodeListingId(value) {
  if (value == null) return null;
  const raw = String(value);
  if (/^\d+$/.test(raw)) return raw;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const match = /(?:StayListing|Listing|DemandStayListing):([^:]+)/.exec(decoded);
    const id = match?.[1] ?? null;
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function stringAt(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const joined = value.map((item) => stringAt(item)).filter(Boolean).join(", ");
      if (joined) return joined;
    }
    if (value && typeof value === "object" && typeof value.body === "string" && value.body.trim()) return value.body.trim();
    if (value && typeof value === "object" && typeof value.text === "string" && value.text.trim()) return value.text.trim();
    if (value && typeof value === "object" && typeof value.localizedStringWithTranslationPreference === "string" && value.localizedStringWithTranslationPreference.trim()) return value.localizedStringWithTranslationPreference.trim();
    if (value && typeof value === "object" && typeof value.localizedString === "string" && value.localizedString.trim()) return value.localizedString.trim();
  }
  return null;
}

function lineValues(value) {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  return items.map((item) => stringAt(item)).filter(Boolean);
}

function stripHtml(value) {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function normalizePrice(source, requestedCurrency = null) {
  const display = source?.structuredDisplayPrice;
  const primary = stringAt(display?.primaryLine?.accessibilityLabel, display?.primaryLine?.price, display?.primaryLine);
  const secondary = stringAt(display?.secondaryLine?.accessibilityLabel, display?.secondaryLine?.price, display?.secondaryLine);
  const labels = uniqueStrings([primary, secondary]);
  const nightlyLabel = labels.find((label) => /(?:per|a)\s+night|nightly/i.test(label)) ?? null;
  const totalLabel = labels.find((label) => /\btotal\b/i.test(label)) ?? null;
  const explanationTitle = stringAt(display?.explanationData?.title);
  const priceDetails = display?.explanationData?.priceDetails;
  const detailGroups = Array.isArray(priceDetails) ? priceDetails : priceDetails ? [priceDetails] : [];
  const detailItems = detailGroups.flatMap((group) => Array.isArray(group?.items) ? group.items : []);
  const currencyText = [...labels, ...detailItems.map((item) => stringAt(item?.priceString))].filter(Boolean).join(" ");
  const observedCurrency = currencyText.includes("€") ? "EUR" : currencyText.includes("£") ? "GBP" : null;
  return {
    labels,
    nightly: nightlyLabel ? { raw: nightlyLabel, meaning: "per_night" } : null,
    total: totalLabel ? { raw: totalLabel, meaning: "stay_total" } : null,
    explanationTitle,
    breakdown: detailItems.map((item) => ({
      description: stringAt(item?.description),
      price: stringAt(item?.priceString),
    })).filter((item) => item.description || item.price),
    feeCompleteness: "unknown",
    currency: {
      requested: requestedCurrency ?? null,
      observed: observedCurrency,
      certainty: observedCurrency ? "symbol" : "unknown",
    },
    note: "Raw Airbnb labels are preserved. Fee and tax completeness is unknown unless the label explicitly says so.",
  };
}

function imageUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value) && /(?:muscache\.com|airbnb\.|\/pictures\/|\.(?:jpe?g|png|webp)(?:\?|$))/i.test(value) ? value : null;
}

function collectPhotos(root) {
  const photos = [];
  const byUrl = new Set();
  walk(root, (value) => {
    const url = imageUrl(value.baseUrl) ?? imageUrl(value.picture) ?? imageUrl(value.url) ?? imageUrl(value.large);
    if (url && !byUrl.has(url)) {
      byUrl.add(url);
      photos.push({
        id: value.id == null ? null : String(value.id),
        url,
        caption: stringAt(value.caption, value.accessibilityLabel, value.alt, value.title),
        evidence: "listing_payload",
      });
    }
    return undefined;
  });
  return photos.map((photo) => Object.fromEntries(Object.entries(photo).filter(([, value]) => value !== null)));
}

function normalizeAmenity(item, groupTitle) {
  const title = stringAt(item?.title, item?.name);
  if (!title) return null;
  return {
    id: item?.id == null ? null : String(item.id),
    title,
    subtitle: stringAt(item?.subtitle),
    group: groupTitle || null,
    available: item?.available === true ? true : item?.available === false ? false : null,
    evidence: "listing_claim",
  };
}

function amenityGroupsFrom(sections, pdp) {
  const candidates = [];
  for (const section of sections) {
    const groups = section?.section?.seeAllAmenitiesGroups;
    if (Array.isArray(groups)) candidates.push(...groups);
  }
  if (Array.isArray(pdp?.amenities?.seeAllAmenitiesGroups)) candidates.push(...pdp.amenities.seeAllAmenitiesGroups);
  const items = [];
  const seen = new Set();
  for (const group of candidates) {
    const groupTitle = stringAt(group?.title) ?? "Other";
    for (const item of Array.isArray(group?.amenities) ? group.amenities : []) {
      const normalized = normalizeAmenity(item, groupTitle);
      if (!normalized) continue;
      const availability = /not included|unavailable/i.test(groupTitle) ? false : normalized.available;
      const result = { ...normalized, available: availability };
      const key = `${groupTitle}\u0000${result.title}\u0000${String(result.available)}`;
      if (!seen.has(key)) {
        seen.add(key);
        items.push(result);
      }
    }
  }
  const clean = (item) => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null));
  return {
    included: items.filter((item) => item.available === true).map(clean),
    excluded: items.filter((item) => item.available === false).map(clean),
    unknown: items.filter((item) => item.available === null).map(clean),
  };
}

function paginationFrom(value, currentCursor = null) {
  const pageCursors = Array.isArray(value?.pageCursors) ? value.pageCursors.filter((cursor) => typeof cursor === "string" && cursor) : [];
  let cursorFromPages = null;
  if (pageCursors.length) {
    if (currentCursor) {
      const currentIndex = pageCursors.indexOf(currentCursor);
      if (currentIndex < 0) {
        throw new SchemaError("The requested pagination cursor is absent from Airbnb's response.", {
          code: "PAGINATION_CURSOR_NOT_FOUND",
          details: { cursor: currentCursor, returnedCursorCount: pageCursors.length },
        });
      }
      cursorFromPages = pageCursors[currentIndex + 1] ?? null;
    } else {
      cursorFromPages = pageCursors[1] ?? null;
    }
  }
  const nextCursor = stringAt(value?.nextPageCursor, value?.nextCursor, value?.cursor, cursorFromPages) ?? null;
  const hasNextPage = typeof value?.hasNextPage === "boolean" ? value.hasNextPage : Boolean(nextCursor);
  if (hasNextPage && !nextCursor) {
    throw new SchemaError("Airbnb reports another search page but did not provide a usable cursor.", {
      code: "PAGINATION_CURSOR_MISSING",
      details: { returnedCursorCount: pageCursors.length },
    });
  }
  return { nextCursor, hasNextPage, raw: value ?? {} };
}

export function normalizeSearchPage(payload, context = {}) {
  const results = findSearchResults(payload);
  const listings = results.searchResults.map((result, index) => {
    const id = decodeListingId(result?.demandStayListing?.id ?? result?.listing?.id ?? result?.id);
    if (!id) throw new SchemaError(`Search result ${index + 1} has no usable listing ID.`, { code: "LISTING_ID_MISSING" });
    const title = stringAt(
      result?.demandStayListing?.description?.name,
      result?.demandStayListing?.description,
      result?.title,
    );
    const subtitle = stringAt(result?.subtitle, result?.structuredContent?.secondaryLine, result?.structuredContent?.mapSecondaryLine);
    return {
      id,
      url: `https://www.airbnb.com/rooms/${id}`,
      title,
      subtitle,
      location: result?.demandStayListing?.location ?? null,
      ratingLabel: stringAt(result?.avgRatingA11yLabel),
      badges: (Array.isArray(result?.badges) ? result.badges : []).map((badge) => stringAt(badge?.text, badge)).filter(Boolean),
      price: normalizePrice(result, context.inputs?.currency ?? null),
      qualifiers: {
        primary: lineValues(result?.structuredContent?.primaryLine ?? result?.structuredContent?.mapPrimaryLine),
        secondary: lineValues(result?.structuredContent?.secondaryLine ?? result?.structuredContent?.mapSecondaryLine),
      },
      photos: collectPhotos(result),
      listingParameters: result?.listingParamOverrides ?? null,
      rawQualifiers: result?.structuredContent ?? null,
    };
  });
  return {
    kind: "airbnb_search_page",
    inputs: context.inputs ?? {},
    source: {
      url: context.sourceUrl ?? null,
      retrievedAt: context.retrievedAt ?? null,
      sha256: context.sha256 ?? null,
      payload: "public_page_deferred_state",
    },
    listings,
    pagination: paginationFrom(results.paginationInfo, context.inputs?.cursor ?? null),
  };
}

function descriptionsFrom(sections) {
  const descriptions = [];
  for (const entry of sections) {
    if (!/DESCRIPTION/i.test(entry?.sectionId ?? "")) continue;
    const section = entry.section ?? {};
    const items = Array.isArray(section.items) ? section.items : [];
    for (const item of items) {
      const html = item?.html?.htmlText;
      const text = stripHtml(html) ?? stringAt(item?.subtitle, item?.title);
      if (text) descriptions.push({
        sectionId: entry.sectionId,
        ...(stringAt(item?.title) ? { title: stringAt(item.title) } : {}),
        text,
        ...(typeof html === "string" ? { html } : {}),
      });
    }
    const html = section?.htmlDescription?.htmlText;
    const text = stripHtml(html) ?? stringAt(section?.description, section?.subtitle, section?.title);
    if (!items.length && text) descriptions.push({ sectionId: entry.sectionId, text, ...(typeof html === "string" ? { html } : {}) });
  }
  return descriptions;
}

function payloadListingId(payload) {
  const found = walk(payload, (value) => {
    for (const key of ["listingId", "roomId"]) {
      if (/^\d+$/.test(String(value?.[key] ?? ""))) return String(value[key]);
    }
    return undefined;
  });
  return found ?? null;
}

function ruleDetail(description) {
  return stringAt(
    description,
    description?.content?.localizedStringWithTranslationPreference,
    description?.content?.localizedString,
    description?.content?.source,
  );
}

function rulesFrom(sections, pdp) {
  const rules = [];
  for (const entry of sections) {
    if (!/(?:POLICIES|RULES)/i.test(entry?.sectionId ?? "")) continue;
    for (const group of Array.isArray(entry?.section?.houseRulesSections) ? entry.section.houseRulesSections : []) {
      const items = (Array.isArray(group?.items) ? group.items : []).map((item) => ({
        title: stringAt(item?.title, item),
        detail: ruleDetail(item?.description),
      })).filter((item) => item.title).map((item) => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null)));
      if (items.length || stringAt(group?.title)) rules.push({ title: stringAt(group?.title), items, source: "section" });
    }
  }
  for (const group of Array.isArray(pdp?.rules?.groupItems) ? pdp.rules.groupItems : []) {
    const items = (Array.isArray(group?.items) ? group.items : []).map((item) => ({
      title: stringAt(item?.title),
      detail: ruleDetail(item?.description),
    })).filter((item) => item.title).map((item) => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null)));
    if (items.length || stringAt(group?.title)) rules.push({ title: stringAt(group?.title), items, source: "pdp.rules" });
  }
  return rules;
}

function highlightsFrom(sections, pdp) {
  const values = [];
  for (const entry of sections) {
    if (!/HIGHLIGHTS/i.test(entry?.sectionId ?? "")) continue;
    for (const item of Array.isArray(entry?.section?.highlights) ? entry.section.highlights : []) {
      const title = stringAt(item?.title);
      if (title) values.push({ title, subtitle: stringAt(item?.subtitle) });
    }
  }
  for (const item of Array.isArray(pdp?.highlights) ? pdp.highlights : []) {
    const title = stringAt(item?.title);
    if (title) values.push({ title, subtitle: stringAt(item?.subtitle) });
  }
  const seen = new Set();
  return values.filter((item) => {
    const key = `${item.title}\u0000${item.subtitle ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((item) => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null)));
}

export function normalizeListingPage(payload, context = {}) {
  const sections = findSections(payload);
  const pdp = findPdpPresentation(payload);
  const amenities = amenityGroupsFrom(sections, pdp);
  const amenityHints = [...amenities.included, ...amenities.unknown]
    .filter((item) => /work|desk|office|table/i.test(`${item.title} ${item.subtitle ?? ""}`))
    .map((item) => ({ title: item.title, available: item.available ?? null, evidence: "amenity_label" }));
  const pdpPhotos = collectPhotos({
    photos: pdp?.photos,
    heroMedia: pdp?.heroMedia,
    mediaTour: pdp?.mediaTour,
    sleepingArrangements: pdp?.sleepingArrangements,
    bathroomsTour: pdp?.bathroomsTour,
  });
  const sectionPhotos = collectPhotos(sections.map((entry) => entry?.section?.mediaItems).filter(Boolean));
  const photoUrls = new Set();
  const photos = [...pdpPhotos, ...sectionPhotos].filter((photo) => {
    if (photoUrls.has(photo.url)) return false;
    photoUrls.add(photo.url);
    return true;
  });
  return {
    kind: "airbnb_listing",
    id: context.listingId == null ? payloadListingId(payload) : String(context.listingId),
    url: context.sourceUrl ?? null,
    inputs: context.inputs ?? {},
    source: {
      url: context.sourceUrl ?? null,
      retrievedAt: context.retrievedAt ?? null,
      sha256: context.sha256 ?? null,
      payload: "public_page_deferred_state",
    },
    descriptions: descriptionsFrom(sections),
    rules: rulesFrom(sections, pdp),
    amenities,
    highlights: highlightsFrom(sections, pdp),
    photos,
    location: (() => {
      const section = sections.find((entry) => /LOCATION/i.test(entry?.sectionId ?? ""))?.section;
      const hasSectionFacts = section && Object.keys(section).some((key) => key !== "__typename" && section[key] != null);
      return hasSectionFacts ? { ...(pdp?.location ?? {}), ...section } : pdp?.location ?? null;
    })(),
    workspace: {
      status: "unknown",
      amenityHints,
      evidence: "No visual or specific-text workspace assessment was performed.",
    },
    availability: {
      status: "unknown",
      evidence: "Requested dates in a page request do not prove the listing is bookable for those dates.",
    },
    sections: sections.map((entry) => ({ sectionId: entry?.sectionId ?? null, section: entry?.section ?? null })),
  };
}
