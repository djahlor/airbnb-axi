# Verification results

## Public, reproducible checks

The standalone public suite runs with Node's built-in test runner and no runtime npm dependencies.

```sh
npm ci
npm test
```

The latest local export run used Node.js 26.9.0 on macOS and returned 48 passed and 0 failed. GitHub Actions is configured for Node.js 20, 22, and 24, but this pre-publication export has no public CI receipt yet. These 48 tests cover:

- input validation, URL construction, typed errors, and bounded redirects;
- public-page deferred-state extraction and search/listing normalization;
- pagination, deduplication, partial results, prices, amenities, policies, and photos;
- capture replay, hash and input-context checks, and ambiguous replay rejection;
- requirement assessment, conflicting evidence, evidence expiry, and CLI behavior.

The suite is offline. Network behavior is represented by injected responses and a loopback HTTP server. CLI cases run the real executable as a subprocess. The two HTML files under `test/fixtures` are deliberately small, labelled synthetic documents. They cover the regression where ordinary reCAPTCHA configuration must not be mistaken for a rendered challenge page when usable deferred data exists.

The source project's suite also had 48 tests, but the public suite is not claimed to be byte-for-byte identical. One regression previously read four private saved pages. The export replaces those pages with two synthetic fixtures and keeps the provider-level generated-payload assertion. No raw private page capture, screenshot, browser receipt, chat, or runtime telemetry is included.

## Private packet-reading study

A separate private evaluation ran 15 fresh sessions, five per evidence representation, against the same frozen 24-field answer key. Review found that the photo-count field was ambiguous: 15 literal image URLs represented 14 distinct photos after grouping a resized variant. The headline below excludes that field and reports the remaining 23. The original answers and 24-field grades were retained; this scoring adjustment did not involve new model runs.

| Evidence representation | Source facts recovered in each run | Median reported input + output tokens |
|---|---:|---:|
| Existing MCP output | 21 / 23 | 38,000 |
| Compact CLI output | 23 / 23 | 36,540 |
| Relevant raw response trees | 23 / 23 | 159,200 |

The compact packet's median reported token total was 3.84% lower than the baseline packet. Every run passed the critical unsupported-claim checks. The baseline's 21/23 result reflects two fields absent from that packet, not a general model-accuracy score.

This was a packet-reading study. Performers made zero tool calls, so it does not establish end-to-end MCP savings, transport speed, discovery overhead, live-search reliability, or booking accuracy. The private native run receipts and raw private source captures are not included here, so those study figures cannot be independently reproduced from this export. They are reported as historical evaluation results, not as public test results.

## Remaining limits

- Airbnb can change its public HTML and payload structure or restrict automated access.
- Live availability, prices, taxes, and fees can change after retrieval.
- Price-filter basis remains unverified by the provider payload.
- Photo references require separate visual inspection; the assessor only checks supplied observations.
- Synthetic fixtures verify parser behavior around a known page-shell pattern, not current production HTML compatibility.
