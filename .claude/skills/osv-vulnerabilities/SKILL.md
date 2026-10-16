---
name: osv-vulnerabilities
description: >-
  Domain knowledge for OSV vulnerability data, vulnerability matching, CVSS scoring,
  and the OSV sync pipeline. Use when working with vulnerabilities, OSV data,
  CVSS scores, severity levels, vulnerability scanning, or the osv-sync module.
---

# OSV & Vulnerability Domain Knowledge

## Key Concepts

| Term | Meaning |
|------|---------|
| **OSV** | Open Source Vulnerabilities — standardized vulnerability format |
| **CVSS** | Common Vulnerability Scoring System (v3.1 primary, v4 stored) |
| **Severity** | `NONE | LOW | MEDIUM | HIGH | CRITICAL` |
| **Base PURL** | Versionless PURL used for matching (`pkg:npm/lodash` not `pkg:npm/lodash@4.17.21`) |

## Architecture

The project maintains a **local OSV mirror** in PostgreSQL — no external API calls at query time.

```
OSV Storage (GCS) → osv-sync → `vulnerabilities` + `vulnerability_affected_packages` → `src/matching/` → `component_vulnerabilities`
```

## OSV Sync Module (`server/src/osv-sync/`)

Read `server/src/osv-sync/README.md` first: it is the maintained reference
for bootstrap, incremental sync, scoping and the CLI. The pieces:

| File | Purpose |
|------|---------|
| `cli.ts` | Entry point for the cloud's CronJobs (`--once`, `--full-refresh`, `--bootstrap-if-needed`, `--fill-severity`, `--metrics`) |
| `runtime.ts` | The wired-up sync — every module here assembled around one Postgres client — used by the CLI and by the monolith's in-process scheduler |
| `worker.ts` | `createOsvSyncWorker()`: chooses bootstrap or incremental per cycle |
| `bootstrap.ts` | `runBootstrap()`: build the mirror from `all.zip` (one per ecosystem when scoped) |
| `incremental.ts` | `runIncremental()`: apply changes since the watermark from `modified_id.csv` |
| `ecosystems.ts` | `OSV_ECOSYSTEMS` scope (community default list, everything on the cloud) |
| `config.ts` | Env-based config: poll interval, batch size, advisory lock id, … |
| `parser.ts` | `modified_id.csv` and OSV JSON parsing, `toBasePurl()` |
| `cvss.ts` | CVSS v2/v3/v4 vector parsing, score → label, `extractSeverity()` |
| `severity-fill.ts` | Gives an advisory that publishes no severity the severity of the flaw it describes (`--fill-severity`) |
| `affected-package-repository.ts` | Write side of `vulnerability_affected_packages` |
| `run-repository.ts`, `failure-repository.ts`, `state.ts` | Bookkeeping: `osv_sync_runs`, `osv_sync_failures`, `osv_sync_state` (watermark) |
| `downloader.ts`, `zip-processor.ts` | HTTP with retries; streams `all.zip` without extracting it |
| `rescan.ts` | Decides whether a completed cycle changed what the mirror would answer, and so whether components need re-matching |

## Sync Workflow

### Bootstrap (`runBootstrap`, `bootstrap.ts`)
1. Download `all.zip` from `https://storage.googleapis.com/osv-vulnerabilities/all.zip` (or `<ECOSYSTEM>/all.zip` per scoped ecosystem)
2. Stream the ZIP — parse each JSON, validate, extract severity + affected packages
3. Batch upsert into `vulnerabilities` and `vulnerability_affected_packages`
4. Record the max modified timestamp as the watermark (`osv_sync_state`)

### Incremental (`runIncremental`, `incremental.ts`)
1. Download `modified_id.csv` — format: `modified_timestamp,path`
2. Filter by `modified >= (watermark - overlap window)`; entries outside the ecosystem scope are ignored
3. Download individual JSONs from `https://storage.googleapis.com/osv-vulnerabilities/<ECOSYSTEM>/<ID>.json`
4. Replace affected packages for updated vulns, then re-match the components they touch

### Concurrency Control
- One session advisory lock per run (`OSV_ADVISORY_LOCK_ID`, `config.ts`) — only one sync at a time, so replicas are safe
- A future-dated `modified` upstream must not advance the watermark past now (`clampWatermark`, `state.ts`)

## Database Tables

### OSV Mirror (`server/src/db/schema/osv-mirror.ts`)

Bookkeeping only — the advisories themselves live in the app tables below.

| Table | Purpose |
|-------|---------|
| `osv_sync_state` | Single-row state: watermark, the ecosystems the live generation carries |
| `osv_sync_runs` | One row per completed cycle (tallies, duration) |
| `osv_sync_failures` | Parse/download failure records |

### App Vulnerabilities (`server/src/db/schema/vulnerabilities.ts`)

| Table | Purpose |
|-------|---------|
| `vulnerabilities` | Unified vulnerability records |
| `vulnerability_affected_packages` | Affected packages per vulnerability |
| `component_vulnerabilities` | Component ↔ vulnerability links with match metadata |
| `vulnerability_sync_status` | Sync status per source |

## Vulnerability Matching (`server/src/matching/`)

`createMatcher(store)` (`match.ts`) over a `CandidateStore`
(`createDrizzleCandidateStore`, `store.ts`); `index.ts` is the public surface.

1. Identity: the component's PURL is parsed and normalised to a canonical
   affected-package key (`identity.ts`: `parsePurl`, `affectedPackageKey`).
   No PURL, no match — there is nothing else to look up by.
2. Candidates: `vulnerability_affected_packages` rows with that key, plus an
   *indirect* pass via the `upstream=` qualifier (a distro binary package
   matched through its source package).
3. Version: `evaluateAffected` (`ranges.ts`) walks the advisory's events with
   the comparator for the ecosystem's scheme (`ecosystem.ts`, `version/`).
   A component with no usable version is dropped before the lookup.

### Version schemes
`ecosystem.ts` maps each OSV ecosystem family to a scheme. Native semver:
`npm`, `crates.io`, `Hex`, `SwiftURL`; an OSV `SEMVER`-typed range is
compared as semver whatever the ecosystem. Everything else has its own
comparator under `version/`.

### Range Event Semantics
- `introduced` — start of affected range
- `fixed` — end (exclusive)
- `last_affected` — last known affected (inclusive)
- `limit` — upper bound (exclusive)

### Match Result

```typescript
interface VulnMatch {
  vulnerabilityId: string;            // internal UUID of the `vulnerabilities` row
  matchType: "direct" | "indirect";   // own identity, or via `upstream=`
  matchedBy: "purl";                  // `cpe` / `name` lookups are reserved, not implemented
  confidence: "exact" | "fuzzy" | "unconfirmed";
  fixedVersion: string | null;
  ecosystem: string | null;
  packageName: string;
  upstream?: { name: string; version: string | null };
}
```

## CVSS Scoring (`cvss.ts`)

### Severity Extraction Order (`extractSeverity`)
Each step only if every earlier one produced nothing; within a step the worst candidate wins:
1. Record-level `severity[]` — CVSS_V3, then CVSS_V4, then CVSS_V2, then the `Ubuntu` priority label
2. Per-entry `affected[].severity[]`, same resolution
3. `database_specific.{severity,urgency,priority}` text label
4. `affected[].ecosystem_specific.*` / `affected[].database_specific.*` (Debian's `urgency` lives here)
5. Heuristic: `MAL-*` IDs → CRITICAL
6. `null` — genuinely unscored

A CVSS vector anywhere beats a text label anywhere, except a publisher's
placeholder vector (`PLACEHOLDER_SCORERS`), which is dropped first. Vectors
are parsed by `parseCvssV2` / `parseCvssV3` / `parseCvssV4`.

### Score-to-Label Mapping
| Score Range | Label |
|-------------|-------|
| 0 | NONE |
| 0.1–3.9 | LOW |
| 4.0–6.9 | MEDIUM |
| 7.0–8.9 | HIGH |
| 9.0–10.0 | CRITICAL |

## Vulnerability Sync Service (`server/src/services/vulnerability-sync.service.ts`)

### Entry Points (`vulnerabilitySyncService`)
- `syncComponentVulnerabilities(componentId)` — one component
- `syncImageVulnerabilities(...)` — every component of one image (the scan job's path)
- `syncAllComponentsVulnerabilities()` — full re-match

### Flow
1. `assertMirrorReadable()` — throws `OsvMirrorNotReadyError` while the mirror is bootstrapping
2. `getMatcher().findVulnerabilitiesBatch(components)` — local lookup, one round-trip
3. Upsert links into `component_vulnerabilities` with `matched_by` (always `purl`) and `match_confidence`

### Match Metadata
- `matchedBy`: always `"purl"`; `"cpe"` and `"name_version"` are reserved columns, never written
- `matchConfidence`: `"exact"` (compared under a real comparator), `"fuzzy"` (a
  comparison had to guess), or `"unconfirmed"` (the package matched but the
  version question was unanswerable)

## What counts as a finding

`src/db/findings.ts` is the single definition, and every surface that reports a
vulnerability count must use it: a finding is a link on a **current** SBOM whose
`match_confidence` is not `unconfirmed`, with advisories that describe the same
CVE collapsed to one. Do not write a new count query — the dashboard, the trend
charts and the workload page each grew their own once, and reported 195, 17 and
14 for the same workload.

Read paths must not re-derive the verdict. `vulnerability_affected_packages`
joins by package *name*, which is weaker than the canonical-key lookup the
matcher used, so re-checking there loses real findings; join it for range and
fix-version display only.

## Conventions

- Factories: `createOsvSyncWorker()` (osv-sync), `createMatcher()` + `createDrizzleCandidateStore()` (matching)
- Logging: `createLogger("osv-sync:worker")`
- Lazy singleton: `getMatcher()` in the vulnerability sync service
- Components without a PURL return no matches (`match.ts`)
