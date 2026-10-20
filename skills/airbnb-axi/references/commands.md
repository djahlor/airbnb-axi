# Commands and evidence

Run `airbnb-axi --help` for the installed options.

| Job | Command |
|---|---|
| Search a place | `airbnb-axi search "place" --checkin YYYY-MM-DD --checkout YYYY-MM-DD --adults 1 --currency EUR` |
| Inspect a stay | `airbnb-axi listing <id-or-airbnb-url> --checkin YYYY-MM-DD --checkout YYYY-MM-DD --adults 1 --currency EUR --json` |
| Check recorded requirements | `airbnb-axi assess evidence.json --json` |
| Check runtime | `airbnb-axi doctor` |

Use `--json` for structured results and `--raw` to inspect underlying evidence. Use `--save capture.json` to preserve a reproducible capture, and `--from-file capture.json` for offline replay. A replay is historical data, not a fresh quote.

Search controls include guest counts, property type, price bounds, place ID, cursor and bounded page count. Check returned warnings and coverage. Paging limits and duplicates matter when ranking. Do not treat one page as an exhaustive search.

The provider respects robots rules by default. `--ignore-robots` is an explicit optional override matching the upstream tool; it is not a way to bypass login, challenge pages or denied access.

If the CLI stops at a robots rule or network failure, inspect the same public page in an available browser and retain the URL, observation time and exact stay context. Do not keep retrying the failed route or invent an empty search result. A saved browser HTML file can be inspected with `--from-file`, but it has unverified acquisition context unless captured with that metadata. Stop at an actual login requirement, access denial or challenge.

Interpret successful output by its stated evidence:

- Search preserves the request context, quoted price labels, listing IDs and links, and whether more results remain.
- Listing output contains descriptions, policies, amenity availability, photo references and source provenance. Photo references are not visual observations.
- Assessment output contains `eligible`, overall status, individual requirement statuses, source observations and limitations. `eligible: false` means a required condition is failed or unresolved.
- Errors and partial results identify the affected operation. Do not fabricate a price, an amenity, or a completion claim to fill a gap.
