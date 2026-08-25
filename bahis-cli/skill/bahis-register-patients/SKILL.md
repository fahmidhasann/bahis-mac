---
name: bahis-register-patients
description: Register 1-50 fictional BAHIS patients via the bahis CLI. No VM.
version: 2.0.0
author: Taohid
license: MIT
metadata:
  hermes:
    tags: [BAHIS, CLI, Synthetic Data, Patient Registry, Veterinary]
    related_skills: []
---

# BAHIS patient registration

Register the requested dummy records immediately after explicit invocation. Treat an explicit invocation with a valid count as authorization to write that batch to the configured BAHIS registry. Do not show a preview or ask for another confirmation.

## When to Use

Use this skill only when explicitly invoked to register dummy or fictional patients in the BAHIS Patient Registry, with a count from 1 through 50. It writes through the `bahis` CLI using realistic Bengali owner names, current form taxonomies and privacy-safe patterns sampled from the oldest human-entered records.

Do not use it for real patient data, UI draft entry, registry review, editing, deletion or synchronization.

This skill needs no virtual machine, desktop app or screen automation. Every write goes through the CLI.

## The command

```
bahis
```

One command, every machine. npm puts `bahis` on `PATH` when the CLI is installed, on macOS,
Windows and Linux alike, so nothing in this file is machine- or OS-specific. If `bahis` is not
found, the CLI has not been installed on that machine; say so and stop rather than guessing at
a path.

**Read stdout, not stderr.** Every command prints JSON to stdout and nothing else. Warnings and errors go to stderr as `{"error": ..., "command": ...}`.

**Check the exit code before trusting a result:**

| Code | Meaning |
|---|---|
| `0` | success; for a batch, every record verified |
| `1` | error. For `validate` and `submit` this means nothing was written |
| `2` | the batch reached the server but not every record verified — retryable |

## Boundaries

- Accept exactly one integer count from 1 through 50. Stop without writing anything when the count is missing, ambiguous, below 1 or above 50.
- Create fictional records only. Refuse real owner or patient data.
- Use the `bahis` CLI only. Do not drive the BAHIS desktop app or any UI, and do not press Submit or Sync Data.
- Never create replacement records for failed or unverified UUIDs.

## Required workflow

1. Run `bahis status`.
2. Continue only when `databaseFound`, `authenticated`, `productionWritesEnabled`, `serverReachable`, `formCompatible` and `semanticChoiceValidation` are all true, and the exit code is 0. `semanticChoiceValidation` proves the installed build checks generated and server-returned dropdown values against the current location and taxonomy choices; treat a missing or false value as unsafe and stop before writing. `formCompatible` reflects the form live on the server, which is what actually gates a write.
   Entries in `warnings` are advisory: report them, but do not stop for them. A condition serious enough to block a write always shows as a false gate above. A warning that the *cached* form is out of date is expected and harmless — records are always built from the live form; it only means the desktop app should sync.
3. Run `bahis context` with no species filter.
4. Run `bahis summary --limit 200 --order oldest`. The oldest usable records were entered by human enumerators, so they are the most natural templates. Pass `--order` explicitly rather than relying on the default.
5. Generate exactly the requested number of records under the rules below, and write them to a JSON file as a plain array.
6. Create a unique request ID matching `bahis-skill-YYYYMMDD-HHmmss-XXXXXX`, using Dhaka local time and six random ASCII letters or digits. Preserve this ID and the complete record payload unchanged for the rest of the run.
7. Run `bahis validate --file <path> --request-id <id>`. This runs every check `submit` runs and writes nothing. Continue only on exit 0 with `invalid: 0`. On any invalid record, fix the named records and validate again — never submit a batch that failed validation.
8. Run `bahis submit --file <path> --request-id <id>` once.
9. On exit 0, stop. On exit 2, run `bahis retry <batchId>` once with the returned batch ID.
10. If records remain unverified, run `bahis verify <batchId>` once. Do not retry again.
11. Report the batch ID plus requested, accepted, verified, unresolved and failed counts. Identify unresolved record indexes and UUIDs without exposing generated owner names unless the user asks.

If status, context or summary exits non-zero, or returns malformed output or missing required fields, stop before writing. Do not infer missing values.

## Record generation rules

### Record shape

Each record is one object in a JSON array:

```json
{
  "ownerName": "Rokeya Begum",
  "unionId": "30267215",
  "villageId": "30267215999",
  "species": "goat",
  "patientType": "household",
  "purpose": "milk",
  "herdSize": 4,
  "sickCount": 1,
  "deadCount": 0,
  "clinicalSignIds": ["79"],
  "tentativeDiagnosisIds": ["55"]
}
```

Omit `visitDate` so the CLI uses the current Dhaka date. Do not add fields outside this shape.

### Mandatory choices

Every record must carry these, chosen by the species type of the record's species:

| Species type | Clinical sign (weight loss) | Tentative diagnosis (worm) |
| --- | --- | --- |
| mammal | `79` | `55` (Tape Worm) |
| bird | `279` | `60` (Worm Infestation) |

These are minimums, not an exclusive set: add other clinically plausible signs and diagnoses alongside them. Tape Worm does not exist for any bird species, so birds use Worm Infestation as the equivalent. The CLI rejects any record that omits the required choice for its species type, so never substitute or drop them.

### Herd size ceiling

`herdSize` must not exceed **999** for mammals or **1000000** for birds. The form itself enforces this, so an oversized herd is rejected before upload.

### Everything else

- Use a unique, natural-looking fictional Bengali owner name in Latin script for every record. Vary common one-, two- and three-part Bangladeshi name forms naturally. Examples of style only: `Abdul Malek`, `Rokeya Begum`, `Md. Sohel Rana`, `Shamima Akter`, `Taohid`.
- Never copy owner names from registry history. Never use `Synthetic`, `Dummy`, `Test`, `Sample`, `Placeholder`, `Unknown`, `Owner 01`, numbered labels or similar wording. The CLI rejects these.
- Select every union and village by ID from the current `context` output. Never invent a location or submit a location label.
- Exclude any choice whose label is `Other` or `Others`, even if it appears in context.
- Intersect every summary ID with the current context. Current context always overrides recent history.
- When at least 10 sampled records are usable and the privacy-thresholded summary contains compatible profiles, allocate species by sampled frequency using the largest-remainder method. Break ties by ID. If the batch is smaller than the number of species, use the highest-frequency species first.
- Cycle through compatible location patterns and clinical patterns in descending count order, breaking ties by IDs, rather than repeating only the top pattern. Current context remains the source of truth.
- When fewer than 10 sampled records are usable, the privacy-thresholded aggregates are empty, or no compatible sampled pattern exists, use a balanced variety of current species and locations and choose clinically plausible signs and diagnoses.
- Keep patient type and purpose compatible with species: birds use household or flock; mammals use household or herd; egg is bird-only; milk, working and fibre are mammal-only.
- Keep herd, sick and dead counts close to the selected species profile's sampled min/median/max. Otherwise choose conservative plausible counts. Always keep `sickCount <= herdSize` and `deadCount <= herdSize - sickCount`.
- Prefer repeated sampled clinical combinations for the selected species, then add the mandatory sign and diagnosis above if the pattern lacks them. Otherwise reason from current labels and choose a plausible diagnosis with compatible signs.

## Idempotency and failure handling

- Reuse the original batch ID for retry and verification commands, and keep the records file unchanged.
- Passing the same `--request-id` with different record data is refused. Passing the same ID with identical data is safe: it resolves to the same batch and the same deterministic UUIDs, so a rerun never duplicates records on the server.
- If a command times out before returning a result, rerun it with the same request ID and the identical file; never regenerate names or records for that attempt.
- If `submit` may have written records but returns malformed output or no batch ID, do not submit again. Report the outcome as unknown and all records as unresolved, including the preserved request ID for investigation.
- If retry or verification errors or returns malformed output, stop without another write. Report only counters supported by the last valid response and treat every record not proven verified as unresolved.
- Treat `verified` plus `matched` as success only after the initial status result confirmed `semanticChoiceValidation: true`. Report `missing`, `mismatched`, `draft`, `accepted` or `failed` as unresolved unless a later permitted step verifies it.
- Require requested, accepted, verified and failed counters plus per-record states from a valid response. Never infer successful submission from a timeout or incomplete response.
- Never submit a second newly generated batch to compensate for an incomplete batch.
