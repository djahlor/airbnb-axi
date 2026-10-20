#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { AirbnbAxiError, InputError } from "../lib/errors.mjs";
import { createProvider, parseReplayInput } from "../lib/provider.mjs";

const HELP = `airbnb-axi: evidence-preserving Airbnb search and listing parser

Usage:
  airbnb-axi search <location> [options]
  airbnb-axi listing <id-or-Airbnb-url> [options]
  airbnb-axi assess <packet.json> [--requirements <json-or-file>] [--json]
  airbnb-axi doctor [--json]
  airbnb-axi help

Search options:
  --checkin YYYY-MM-DD       --checkout YYYY-MM-DD
  --adults N                 --children N
  --infants N                --pets N
  --min-price N              --max-price N
  --property-type TYPE       entire_home, private_room, shared_room, hotel_room
  --place-id ID              --cursor CURSOR
  --pages N                  bounded to 1..10 (default 1)
  --currency EUR             default EUR

Shared options:
  --from-file <capture|html> replay without network access
  --ignore-robots            explicit robots.txt override
  --raw                      include decoded source payloads in output
  --save <capture.json>      save response evidence, including source HTML
  --json                     emit complete JSON

The Airbnb price filter basis is unverified by the public page payload. Returned price
labels retain Airbnb's own wording; fee and tax completeness remains unknown unless explicitly stated.`;

const VALUE_FLAGS = new Map([
  ["--checkin", "checkin"], ["--checkout", "checkout"],
  ["--adults", "adults"], ["--children", "children"], ["--infants", "infants"], ["--pets", "pets"],
  ["--min-price", "minPrice"], ["--max-price", "maxPrice"],
  ["--property-type", "propertyType"], ["--place-id", "placeId"],
  ["--cursor", "cursor"], ["--pages", "pages"], ["--currency", "currency"],
  ["--save", "save"], ["--from-file", "fromFile"], ["--requirements", "requirements"],
]);
const NUMBER_FIELDS = new Set(["adults", "children", "infants", "pets", "minPrice", "maxPrice", "pages"]);
const BOOLEAN_FLAGS = new Map([["--json", "json"], ["--raw", "raw"], ["--ignore-robots", "ignoreRobots"]]);

function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = equals > 0 ? token.slice(0, equals) : token;
    if (BOOLEAN_FLAGS.has(flag)) {
      if (equals > 0) throw new InputError(`${flag} does not take a value.`, { code: "UNEXPECTED_FLAG_VALUE" });
      options[BOOLEAN_FLAGS.get(flag)] = true;
      continue;
    }
    if (VALUE_FLAGS.has(flag)) {
      const value = equals > 0 ? token.slice(equals + 1) : argv[++index];
      if (value == null || value === "" || (equals < 0 && value.startsWith("--"))) {
        throw new InputError(`${flag} requires a value.`, { code: "MISSING_FLAG_VALUE" });
      }
      const field = VALUE_FLAGS.get(flag);
      if (NUMBER_FIELDS.has(field)) {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new InputError(`${flag} must be numeric.`, { code: "INVALID_NUMBER", details: { flag, value } });
        options[field] = number;
      } else {
        options[field] = value;
      }
      continue;
    }
    if (token.startsWith("--")) throw new InputError(`Unknown option: ${token}`, { code: "UNKNOWN_OPTION" });
    positional.push(token);
  }
  return { positional, options };
}

function printSearch(result) {
  const requested = result.requestedInputs ?? result.inputs;
  const inputsVerified = result.inputBinding !== "unverified";
  const lines = [
    `Search: ${inputsVerified ? result.inputs.location : "not recorded in replay evidence"}`,
    inputsVerified
      ? `Stay: ${result.inputs.checkin ?? "not specified"} to ${result.inputs.checkout ?? "not specified"}; guests: ${result.inputs.adults} adults, ${result.inputs.children} children, ${result.inputs.infants} infants, ${result.inputs.pets} pets; currency requested: ${result.inputs.currency}`
      : "Evidence inputs: not recorded in this replay",
    `Price filter: ${result.priceFilter.min ?? "none"} to ${result.priceFilter.max ?? "none"}; basis unverified by the provider payload`,
    `Coverage: ${result.coverage.pagesFetched}/${result.coverage.pagesRequested} page(s), ${result.coverage.uniqueListings} unique, ${result.coverage.duplicatesRemoved} duplicate(s) removed`,
    `More: ${result.coverage.moreAvailable ? "yes" : "no"}; truncated: ${result.coverage.truncated ? "yes" : "no"}; stop: ${result.coverage.stopReason}`,
  ];
  if (!inputsVerified) lines.push(`Requested replay context (unverified): ${requested.checkin ?? "not specified"} to ${requested.checkout ?? "not specified"}; ${requested.adults} adults, ${requested.children} children, ${requested.infants} infants, ${requested.pets} pets; ${requested.currency}`);
  if (result.coverage.nextCursor) lines.push(`Next cursor: ${result.coverage.nextCursor}`);
  if (result.geocoding) lines.push(`Region: ${result.geocoding.method}; ${result.geocoding.regionUncertainty}`);
  for (const source of result.sources) lines.push(`Retrieved: ${source.retrievedAt ?? "saved replay"}; SHA-256: ${source.sha256}; source: ${source.url}`);
  for (const [index, listing] of result.listings.entries()) {
    lines.push("", `${index + 1}. ${listing.title ?? "Untitled listing"} (${listing.id})`, `   ${listing.url}`);
    if (listing.subtitle) lines.push(`   ${listing.subtitle}`);
    if (listing.qualifiers?.primary?.length) lines.push(`   Primary facts: ${listing.qualifiers.primary.join("; ")}`);
    if (listing.qualifiers?.secondary?.length) lines.push(`   Secondary facts: ${listing.qualifiers.secondary.join("; ")}`);
    if (listing.ratingLabel) lines.push(`   Rating: ${listing.ratingLabel}`);
    if (listing.price.labels.length) lines.push(`   Price labels: ${listing.price.labels.join(" | ")}`);
    if (listing.price.breakdown.length) lines.push(`   Price breakdown: ${listing.price.breakdown.map((item) => `${item.description ?? "Unlabelled"} = ${item.price ?? "unpriced"}`).join("; ")}`);
    lines.push(`   Fee/tax completeness: ${listing.price.feeCompleteness}`);
    if (listing.photos.length) lines.push(`   Photos: ${listing.photos.length} URL(s) with captions where supplied; images were not visually verified.`);
  }
  return lines.join("\n");
}

function printListing(result) {
  const requested = result.requestedInputs ?? result.inputs;
  const inputsVerified = !["payload_id_only", "unverified"].includes(result.inputBinding);
  const lines = [
    `Listing ${result.id}`,
    `${result.url}`,
    inputsVerified
      ? `Stay: ${result.inputs.checkin ?? "not specified"} to ${result.inputs.checkout ?? "not specified"}; guests: ${result.inputs.adults} adults, ${result.inputs.children} children, ${result.inputs.infants} infants, ${result.inputs.pets} pets; currency requested: ${result.inputs.currency}`
      : "Evidence stay inputs: not recorded in this replay",
    `Retrieved: ${result.source.retrievedAt ?? "unknown for replay"}`,
    `Source SHA-256: ${result.source.sha256}`,
  ];
  if (!inputsVerified) lines.push(`Requested replay context (unverified): ${requested.checkin ?? "not specified"} to ${requested.checkout ?? "not specified"}; ${requested.adults} adults, ${requested.children} children, ${requested.infants} infants, ${requested.pets} pets; ${requested.currency}`);
  for (const description of result.descriptions) lines.push("", `Description: ${description.text}`);
  const amenityLabel = (item) => `${item.title}${item.subtitle ? ` (${item.subtitle})` : ""}`;
  lines.push("", `Amenities included (${result.amenities.included.length}): ${result.amenities.included.map(amenityLabel).join(", ") || "none listed"}`);
  lines.push(`Amenities excluded (${result.amenities.excluded.length}): ${result.amenities.excluded.map(amenityLabel).join(", ") || "none listed"}`);
  lines.push(`Amenities uncertain (${result.amenities.unknown.length}): ${result.amenities.unknown.map(amenityLabel).join(", ") || "none listed"}`);
  for (const rule of result.rules) {
    const items = rule.items.map((item) => `${item.title}${item.detail ? ` (${item.detail})` : ""}`);
    lines.push(`Rules ${rule.title ?? ""}: ${items.join("; ")}`);
  }
  lines.push("", `Workspace: ${result.workspace.status}. ${result.workspace.evidence}`);
  lines.push(`Availability: ${result.availability.status}. ${result.availability.evidence}`);
  if (result.workspace.amenityHints.length) lines.push(`Workspace amenity hints: ${result.workspace.amenityHints.map((item) => item.title).join(", ")} (listing claims only)`);
  if (result.photos.length) {
    lines.push("", `Photos (${result.photos.length}; URLs/captions from the payload, not visual verification):`);
    for (const photo of result.photos) lines.push(`- ${photo.url}${photo.caption ? ` | ${photo.caption}` : ""}`);
  }
  return lines.join("\n");
}

function printAssessment(result) {
  const lines = [`Listing ${result.listing_id}`, `Status: ${result.status}; eligible: ${result.eligible ? "yes" : "no"}`];
  for (const requirement of result.requirements ?? []) {
    lines.push(`${requirement.status}: ${requirement.id}`);
    for (const criterion of requirement.criteria ?? []) lines.push(`  ${criterion.criterion}: ${criterion.status}`);
    if (requirement.evidence_ids?.length) lines.push(`  Evidence: ${requirement.evidence_ids.join(", ")}`);
  }
  for (const item of result.evidence ?? []) lines.push(`Evidence ${item.id}: ${item.method} from ${item.source?.type ?? "unknown source"}`);
  if (result.warnings?.length) lines.push(...result.warnings.map((warning) => `Warning: ${warning}`));
  lines.push("Assessment uses the supplied evidence and method labels; it is not independent visual certification.");
  return lines.join("\n");
}

async function loadJson(value, label) {
  if (value === "-") return JSON.parse(await new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  }));
  try {
    return JSON.parse(await readFile(value, "utf8"));
  } catch (fileError) {
    try {
      return JSON.parse(value);
    } catch {
      throw new InputError(`${label} must be a readable JSON file or inline JSON.`, { code: "INVALID_JSON_INPUT", cause: fileError });
    }
  }
}

async function run(argv) {
  const command = argv[0] ?? "help";
  if (argv.slice(1).some((token) => token === "--help" || token === "-h")) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const { positional, options } = parseArgs(argv.slice(1));
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (command === "doctor") {
    const report = {
      ok: typeof globalThis.fetch === "function" && Number(process.versions.node.split(".")[0]) >= 18,
      node: process.version,
      fetch: typeof globalThis.fetch === "function",
      provider: "public Airbnb page payloads",
      networkChecked: false,
      note: "doctor performs no Airbnb request.",
    };
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `airbnb-axi ${report.ok ? "ready" : "not ready"}\nNode ${report.node}; fetch ${report.fetch ? "available" : "missing"}; network not checked\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "assess") {
    if (positional.length !== 1) throw new InputError("assess requires one packet JSON file.", { code: "ASSESS_PACKET_REQUIRED" });
    const packet = await loadJson(positional[0], "assessment packet");
    const requirements = options.requirements ? await loadJson(options.requirements, "requirements") : undefined;
    const module = await import("../lib/assess.mjs");
    const assess = module.assessRequirements ?? module.assess ?? module.assessListing ?? module.default;
    if (typeof assess !== "function") throw new AirbnbAxiError("lib/assess.mjs does not export an assessment function.", { code: "ASSESS_EXPORT_MISSING" });
    const assessed = requirements === undefined ? await assess(packet) : await assess(packet, requirements);
    const result = {
      ...assessed,
      evidence: assessed.evidence ?? packet.evidence ?? [],
      assessmentNotice: "Uses supplied evidence and method labels; no independent visual certification was performed by this CLI.",
    };
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${printAssessment(result)}\n`);
    return;
  }
  if (!["search", "listing"].includes(command)) throw new InputError(`Unknown command: ${command}`, { code: "UNKNOWN_COMMAND" });
  if (positional.length !== 1) throw new InputError(`${command} requires exactly one ${command === "search" ? "location" : "listing ID or URL"}.`, { code: "MISSING_POSITIONAL" });
  let replay;
  if (options.fromFile) {
    replay = parseReplayInput(await readFile(options.fromFile, "utf8"));
    const fileUrl = pathToFileURL(options.fromFile).toString();
    replay.pages = replay.pages.map((page) => ({ ...page, sourceUrl: page.sourceUrl === "file://replay" ? fileUrl : page.sourceUrl }));
  }
  const provider = createProvider();
  const input = {
    ...(command === "search" ? { location: positional[0] } : { id: positional[0] }),
    ...Object.fromEntries(Object.entries(options).filter(([key]) => !["json", "save", "fromFile", "requirements"].includes(key))),
    ...(options.save ? { capture: true } : {}),
    ...(replay ? { replay } : {}),
  };
  const result = command === "search" ? await provider.search(input) : await provider.listing(input);
  if (options.save) {
    if (!result.capture) throw new AirbnbAxiError("Capture data was not produced.", { code: "CAPTURE_MISSING" });
    await writeFile(options.save, `${JSON.stringify(result.capture, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(options.json || options.raw ? `${JSON.stringify(result, null, 2)}\n` : `${command === "search" ? printSearch(result) : printListing(result)}\n`);
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  const output = error instanceof AirbnbAxiError
    ? error.toJSON()
    : { error: { name: error?.name ?? "Error", code: "UNEXPECTED_ERROR", message: error?.message ?? String(error) } };
  const asJson = process.argv.includes("--json") || process.argv.includes("--raw");
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (asJson) process.stdout.write(text);
  else process.stderr.write(`${output.error.code}: ${output.error.message}\n`);
  process.exitCode = error?.exitCode ?? 1;
}
