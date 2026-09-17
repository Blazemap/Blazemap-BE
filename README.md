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
