# Requirement evidence

Give each criterion a unique ID across the packet. For example, use `accommodation_private` and `sauna_private`, not `private` for both. Otherwise evidence about one feature could be applied to another. The CLI rejects reused criterion IDs.

Evaluate observable conditions rather than matching a keyword.

| Status | Meaning | Verified shortlist |
|---|---|---|
| `met` | Each condition has positive, relevant evidence without contradiction | Allowed |
| `not_met` | At least one necessary condition has explicit negative evidence | Excluded |
| `unknown` | Evidence is missing, too vague, expired or about another property | Excluded |
| `conflict` | Relevant sources disagree | Excluded pending resolution |

Keep preferences separate from required conditions. A missing preference can lower rank without disqualifying a verified match.

## Workspace example and exception

Photo A shows a narrow table next to a doorway and folding chairs hung on a wall. It does not show a compatible seated position or establish sufficient laptop space and legroom. Record what is visible. The work requirement stays unknown. Do not claim that the property has no workspace.

Photo B clearly shows a stable dining table with laptop-sized usable space, a compatible chair and legroom. This can meet a request for a table to work on. Do not reject it for lacking an office chair. A standing desk can meet a standing-work request; it does not automatically satisfy a seated-work request.

A specific listing sentence describing a desk, chair and usable legroom is text evidence, not visual verification. A generic workspace amenity is insufficient for these physical conditions. Stronger claims require stronger evidence: Wi-Fi speed requires a measurement or explicit quoted claim; full-day comfort cannot be established from an attractive photograph.

## Assessment packet

Save a packet outside the skill. Use the real listing ID consistently and actual source locations. Each observation is the caller's recorded finding.

```json
{
  "listing_id": "123456789",
  "requirements": [
    {
      "id": "workspace",
      "required": true,
      "criteria": ["stable_surface", "laptop_space", "compatible_seat", "legroom"]
    }
  ],
  "evidence": [
    {
      "id": "photo-work-area",
      "listing_id": "123456789",
      "method": "visual",
      "observed_at": "2026-11-01T12:00:00Z",
      "source": {
        "type": "photo",
        "file": "/absolute/path/to/inspected-photo.png"
      },
      "observations": [
        {"criterion": "stable_surface", "value": "yes", "detail": "A freestanding table is visible."},
        {"criterion": "laptop_space", "value": "unknown", "detail": "The usable depth is unclear."},
        {"criterion": "compatible_seat", "value": "unknown", "detail": "No chair is shown in a seated position at this table."},
        {"criterion": "legroom", "value": "unknown", "detail": "The seating arrangement is not demonstrated."}
      ]
    }
  ]
}
```

The example is invented and demonstrates an unknown result. Replace the date, ID, source and observations with actual evidence. `source` needs `type` (`photo`, `listing`, `host`) plus a URL or file. Never invent a host statement.

Methods are `visual`, `specific_text`, and `amenity_label`. The default accepted methods are visual observations and specific text. A requirement may explicitly permit an amenity label for a simple listing claim, but that never proves the physical workspace conditions. Observation values are `yes`, `no`, and `unknown`. Different listing IDs, expired evidence and conflicting observations cannot produce a verified match.

`as_of` can freeze an assessment's date for replay. `expires_at` marks evidence validity; `max_age_hours` on a requirement enforces an explicit freshness limit. Do not change dates to make stale evidence pass. These fields do not make a captured price live.

The CLI validates and aggregates the packet. It does not authenticate the source or inspect the image. A successful JSON check proves the recorded decision is consistent with the recorded observations; source inspection is still necessary.
