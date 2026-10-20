# airbnb-axi

`airbnb-axi` is a lightweight command-line tool and agent skill for searching Airbnb listings and evaluating stays against specific requirements.

It provides structured pricing, amenities, policies, and photo references, with source metadata and explicit uncertainty. Saved captures support offline replay and repeatable evaluation. Built on Node.js with no runtime dependencies.

## Install

Node.js 18 or later is required.

```sh
git clone https://github.com/djahlor/airbnb-axi.git
cd airbnb-axi
npm test
npm link
airbnb-axi doctor
```

Install directly from GitHub:

```sh
npm install --global github:djahlor/airbnb-axi
```

The reusable agent instructions are in [`skills/airbnb-axi`](skills/airbnb-axi/SKILL.md). Copy or link that directory into the skills folder used by your agent host.

## CLI

```sh
airbnb-axi search "Helsinki, Finland" \
  --checkin 2026-11-02 --checkout 2026-11-09 \
  --adults 1 --currency EUR --pages 2 --json

airbnb-axi listing 123456789 \
  --checkin 2026-11-02 --checkout 2026-11-09 \
  --adults 1 --currency EUR --json

airbnb-axi assess evidence.json --json
```

The dates and listing ID are syntax examples. They are not a current quote, availability claim, or recommendation. Run `airbnb-axi help` for every option.

Use `--save capture.json` to retain response evidence and `--from-file capture.json` to replay it without a network request. `--raw` includes the decoded source payload. Default text output is compact; `--json` keeps the structured evidence and limitations.

## Evidence and requirement boundaries

| Requirement | Evidence used | What remains limited |
|---|---|---|
| Search result | Public deferred page payload, request context, bounded pagination | A bounded search is not exhaustive; provider pages and access rules can change |
| Price | Airbnb's displayed labels and available breakdown fields | Requested currency is not proof of observed currency; fee and tax completeness may be unknown; price-filter semantics are unverified |
| Availability | Dated search evidence or a separately inspected rendered booking panel | Dates in a request URL or listing payload do not prove that a stay can be booked |
| Amenities and rules | Included, excluded, unknown, description, and policy fields from the listing payload | Missing data stays unknown; page schema changes produce an explicit error |
| Visual requirements | Caller-recorded observations tied to a photo, listing, timestamp, and criterion | The CLI does not view pixels or authenticate observations; captions and URLs are not visual proof |
| Replay provenance | Capture metadata, SHA-256 body hashes, input binding, and source URL | Raw HTML without capture metadata has unknown acquisition time and unverified stay context |

Required conditions must be `met` before a stay enters a verified shortlist. `unknown`, `not_met`, and `conflict` remain disqualifying until resolved. Ordinary dining furniture can satisfy a basic seated-laptop requirement when the evidence shows a stable surface, laptop space, compatible seating, and legroom together.

The provider respects robots rules by default. `--ignore-robots` is an explicit option inherited from the upstream interface. It does not bypass authentication, access denials, or challenge pages.

## Test

```sh
npm ci
npm test
npm pack --dry-run
```

The public suite contains 48 offline tests. It uses generated payloads, two clearly synthetic HTML fixtures, stubbed network responses, loopback HTTP transport, and CLI subprocesses. It makes no live Airbnb request. GitHub Actions is configured to run the suite on Node.js 20, 22, and 24. See [RESULTS.md](RESULTS.md) for the method and limits.

## License

MIT licensed. See [LICENSE](LICENSE) for terms and [NOTICE](NOTICE) for third-party acknowledgments.

`airbnb-axi` is independent software and is not affiliated with Airbnb, Inc. It supports search and evaluation; booking and host communication are outside its scope.
