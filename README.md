# Blazemap Backend

The application API for Blazemap's forest and land fire awareness and decision-support system in Kalimantan, Indonesia.

## Purpose

Provides authentication, report and case management, private evidence storage, satellite and weather integrations, and human-reviewed coordination.

## Tech Stack

| Area | Technology |
| --- | --- |
| Runtime | Node.js 24, TypeScript |
| API | Express 5, Zod |
| Database | PostgreSQL, Prisma 7 |
| Authentication | Better Auth, Google OAuth |
| Storage | S3-compatible object storage |
| Documentation | Swagger UI, OpenAPI 3.1 |

API reference: `/api/docs` · OpenAPI document: `/api/openapi.json`.

## Related Repositories

[Organization](https://github.com/Blazemap) · [Frontend](https://github.com/Blazemap/Blazemap-FE) · [AI](https://github.com/Blazemap/Blazemap-AI)

Government access and operational authority require separately provisioned permissions.

## Report triage and confirmed perimeters

All routes below have `/api` prefix and retain existing session, origin and permission checks. Migration `20260917000000_confirmed_perimeter` adds four case columns and the publication enum value only. It is intentionally not applied by this change; review and deploy it separately before running the updated API. No backfill, reset or automatic publication occurs.

### Admin report triage

`GET /admin/reports` (`data[]`) and `GET /admin/reports/:id` (`data`) preserve existing fields and add:

```ts
triage: {
  level: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'UNKNOWN';
  reasonCodes: string[];
  missingData: string[];
  evaluatedAt: string;
  ruleVersion: 'report-triage-1';
  satelliteMatch: { distanceMeters: number; acquiredAt: string } | null;
  settlementMatch: { name: string | null; distanceMeters: number } | null;
}
```

Own-report routes never include triage. Four bounded context queries are shared across a page, with one evaluation timestamp; no queries run per report. No AI, verification, association or priority writes occur.

Explicit positive finite environment values are required for `TRIAGE_HOTSPOT_RADIUS_METERS`, `TRIAGE_HOTSPOT_WINDOW_HOURS`, and `TRIAGE_SETTLEMENT_RADIUS_METERS`. There are no production defaults. Missing/invalid policy, observer-position coordinates, absent incident coordinates and DEMO reports yield UNKNOWN. The time window is symmetric around `observedAt`, inclusive at its configured boundaries.

- CRITICAL: real NASA FIRMS hotspot within distance and time thresholds, even if settlement coverage is unknown.
- HIGH: verified non-DEMO settlement Point/Polygon within radius, even if satellite coverage is missing.
- MEDIUM: neither match, with complete proven spatial/time coverage for both sources and no invalid/truncated context.
- UNKNOWN: insufficient coverage; no detections never implies safety.

`missingData` remains populated on CRITICAL/HIGH when coverage is missing. Codes: the three environment names, `INCIDENT_COORDINATES`, `OBSERVATION_TIME`, `SATELLITE_COVERAGE`, `SETTLEMENT_COVERAGE`, `SETTLEMENT_GEOMETRY`, `TRUNCATED_CONTEXT`. `reasonCodes`: `POLICY_NOT_CONFIGURED`, `DEMO_EXCLUDED`, `INCIDENT_LOCATION_UNKNOWN`, `OBSERVATION_TIME_INVALID`, `SATELLITE_SPATIOTEMPORAL_MATCH`, `SETTLEMENT_NEARBY`, `COVERED_NO_NEARBY_MATCH`, `INSUFFICIENT_COVERAGE`.

Successful FIRMS runs now record `scope.observedFrom`/`observedTo` alongside existing `area` and `products`. Only a currently configured FIRMS source with its latest terminal run successful within one hour can establish negative coverage. Its box must cover the full search radius and its recorded time interval the full symmetric window. Legacy runs without explicit time bounds, failed/stale runs and historical gaps cannot establish MEDIUM. Positive spatial/time matches remain usable independently of negative coverage.

Settlement negative coverage requires a verified, non-DEMO SETTLEMENT layer with `coverage` containing a JSON string of this shape (values must represent actual reviewed dataset coverage, never guessed):

```ts
{ bbox: [west, south, east, north], validFrom: ISO8601, validTo: ISO8601, complete: true }
```

The box must contain the entire settlement search radius; dates must cover the report and remain current, and sourceDate must not postdate the report. Free-text regional labels, mere feature presence, and region membership do not prove coverage. Valid nearby settlements can establish HIGH without complete negative coverage. Unsupported/malformed Polygon geometry is ignored as evidence and prevents MEDIUM. Query safety caps are 10,000 hotspots, 10,000 settlements and 1,000 layers; detected truncation prevents MEDIUM.

### Confirmed perimeter PATCH

`PATCH /admin/cases/:id` accepts this exclusive variant; do not mix with priority/handling fields:

```ts
{
  version: number;
  perimeter: { type: 'Polygon'; coordinates: [number, number][][] };
  perimeterObservedAt: string;
  perimeterSource: string;
  reason: string;
  authorityReference: string;
}
```

Requires an active, email-verified ADMIN with `canConfirmIncidents=true` and case `CONFIRMED_FIRE`. Coordinates are `[longitude, latitude]`. A maximum of 1,000 total positions (including closure positions) is a safety cap, not a fixed shape. Rings must close, contain at least three distinct vertices, have nonzero area, and have no repeated nonclosing vertices or intersections. Holes must be contained and disjoint. Longitude spans >=180 degrees are conservatively unsupported. Future time tolerance remains the existing five minutes. Source length is 3–300, reason 5–2000, authority reference 3–500 characters.

The case/user are locked, version is checked (`409 VERSION_CONFLICT`), perimeter revision/version/contextRevision increment together, latest analysis is invalidated, and `CASE_PERIMETER_UPDATED` audit stores before/after geometry and provenance plus reason/authorityReference in the same transaction. Failed audit rolls back the update. Existing verified point, handling, field-update and verification routes remain unchanged; setting perimeter never publishes it.

`GET /admin/cases/:id` adds `perimeter`, `perimeterObservedAt`, `perimeterSource` (nullable), `perimeterRevision` (initially 0), and nullable computed `areaHectares`, preserving evidence collections. Perimeter PATCH returns those fields plus existing case fields. Area uses spherical geodesic display calculation with radius 6,371,008.8m, subtracting holes; it is not a cadastral measurement.

### Explicit public approval

Draft create/edit accepts `publicLocationMode: 'APPROVED_INCIDENT_PERIMETER'` only with `caseId` and explicit `privacyReview`. Existing publish request remains `{ expectedUpdatedAt, authorityReference }` with `canPublishInformation`. Publish locks the case, requires confirmed status and valid audited perimeter metadata, and freezes the perimeter geometry, observation time, source, computed area and revision in `publicCaseSnapshot.publicPerimeter`.

`GET /map` case items optionally add the following only in approved perimeter mode with a valid snapshot:

```ts
publicPerimeter: {
  geometry: { type: 'Polygon'; coordinates: [number, number][][] };
  observedAt: string;
  source: string;
  areaHectares: number;
  revision: number;
}
```

Later private perimeter/point edits cannot change published geometry. Invalid/legacy snapshots omit publicPerimeter; other modes never expose it. Existing point/withheld behavior and publication withdrawal/expiry filters remain unchanged. Field updates continue through `POST /admin/cases/:id/field-updates`, verification through `POST /admin/cases/:id/verify`.

Offline checks: `node --import tsx triage.check.mjs`, `node --import tsx perimeter.check.mjs`, `node --import tsx reports.check.mjs`, and `node --import tsx integrations.check.mjs`. New checks use mocks only, including authorization, version conflict, audit rollback, snapshot isolation, topology, area, missing-data combinations and constant-query batching.

## BMKG forecast runtime

BMKG synchronization is a one-shot command for a dedicated UTC Railway cron service: `node dist/sync.js BMKG`, scheduled with `0 */6 * * *`. The long-running `dist/watch.js` process polls FIRMS only. `BMKG_POLL_INTERVAL_MS=21600000` is the six-hour freshness guard and should match the cron interval.

A BMKG sync processes only verified administrative level IV regions with stored ADM4 codes and active cases. Cases with coordinates but no selected region remain unmapped; coordinates are never converted to ADM4 without an imported, verified boundary dataset. Operators select a verified mapping through `PATCH /admin/cases/:id/forecast-region`.

## OpenStreetMap spatial ingestion

`npm run sources:osm -- --dry-run` validates the configured official Geofabrik Kalimantan source, MD5 manifest, `Last-Modified` date, and 2 GiB download cap without downloading or writing the dataset. `npm run sources:osm` downloads to a private temporary directory, verifies the MD5 while streaming, performs bounded two-pass PBF extraction, imports batches, and always removes temporary data. `SPATIAL_IMPORT_USER_AGENT` is required and must include operator contact; `OSM_GEOFABRIK_URL` defaults to `https://download.geofabrik.de/asia/indonesia/kalimantan-latest.osm.pbf`.

The import stores only tagged settlement, facility, and water-source nodes plus selected road and river ways. Buildings, forest, peatland, polygons, and relations are not imported. Each layer is capped at 50,000 records, line assembly retains at most 2,000,000 referenced node coordinates, and extracted NDJSON is capped at 1 GiB. Layer metadata uses provider `OpenStreetMap`, license `ODbL 1.0`, attribution `© OpenStreetMap contributors`, the Geofabrik source URL and date, and the MD5 as version. Layers remain unverified and coverage is explicitly incomplete, so nearby settlement points may support positive triage only after operator verification; absence never establishes negative coverage.

For a dedicated Railway cron service, use start command `node dist/spatial-sync.js`, UTC schedule `0 3 * * *`, one replica, and limits no higher than 1 CPU and 1 GB memory. Configure `DATABASE_URL`, `DATABASE_CA_PEM`, and `SPATIAL_IMPORT_USER_AGENT=Blazemap/1.0 (+https://blazemap.my.id)`. Do not enable the schedule until the dry run and offline checks pass; the first full production import is intentionally operator-controlled.

Owner notifications are factual information alerts only. A linked active case can create one idempotent notification per stored forecast and report when the current regional forecast changes wind direction by at least 45 degrees, changes rain context, or crosses explicitly configured `BMKG_NOTIFY_WIND_SPEED_KMH` / `BMKG_NOTIFY_HUMIDITY_PERCENT` thresholds. The threshold variables have no defaults. No first forecast creates a change alert. Notifications are limited to report owners and never imply live sensing, fire confirmation, spread perimeter, arrival time, warning, evacuation or operational instruction.
