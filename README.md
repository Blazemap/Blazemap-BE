# Blazemap Backend

The application API for Blazemap's forest and land fire awareness and human-review system in Kalimantan, Indonesia. Website served by the separate frontend: [blazemap.my.id](https://blazemap.my.id/). Source code: [Blazemap-BE](https://github.com/Blazemap/Blazemap-BE).

## What it does

Manages accounts, citizen reports, private evidence, case verification, team assignments, approved publications, and source integrations. NASA FIRMS satellite detections and AI outputs are supporting context, not automatic fire confirmations. Government access and authority to confirm or publish require separately provisioned permissions.

## Technology stack

| Area | Technology |
| --- | --- |
| Runtime | Node.js 24, TypeScript |
| API and validation | Express 5, Zod, OpenAPI 3.1 and Swagger UI |
| Database | PostgreSQL, Prisma 7 |
| Authentication | Better Auth, optional Google OAuth |
| Media and notifications | S3-compatible private storage, SMTP |
| Context sources | NASA FIRMS, Google Weather, Photon place search, OpenStreetMap, internal AI service |

## Installation and local development

Prerequisites: Node.js 24, npm, PostgreSQL, and a separate [frontend](https://github.com/Blazemap/Blazemap-FE) if you need to use the browser UI.

```bash
npm ci
```

Copy `.env.example` to `.env` and fill in the values required for the features you intend to use. For a working local API, configure `DATABASE_URL`, `BETTER_AUTH_SECRET` (at least 32 characters), `BETTER_AUTH_URL` (for example `http://localhost:3000`), and `FRONTEND_URL` (your frontend origin). Email/password registration and reset additionally require SMTP delivery; Google sign-in requires both Google OAuth credentials. Production application origins must use HTTPS. Do not commit `.env`, database certificates, access keys, or credentials.

| Feature | Additional configuration |
| --- | --- |
| Verified PostgreSQL TLS / container runtime | `DATABASE_CA_PEM` (required by `docker-entrypoint.sh`) |
| FIRMS ingestion and assessed triage | `FIRMS_MAP_KEY`, `FIRMS_PRODUCTS`, `FIRMS_AREA`; explicitly configured `TRIAGE_HOTSPOT_RADIUS_METERS`, `TRIAGE_HOTSPOT_WINDOW_HOURS`, `TRIAGE_SETTLEMENT_RADIUS_METERS` |
| On-demand case weather | `GOOGLE_MAPS_SERVER_KEY`; optional `PROVIDER_TIMEOUT_MS` |
| AI analysis | `AI_SERVICE_URL` and matching `AI_SERVICE_TOKEN` from the AI service; optional `AI_AUTO_REANALYZE` |
| Private uploads | `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; optional `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` |
| Email delivery | `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`; `SMTP_PASSWORD` if `SMTP_USER` is set |
| Spatial import | `SPATIAL_IMPORT_USER_AGENT` with operator contact; optional `OSM_GEOFABRIK_URL` |

`src/config/env.ts` documents the complete runtime configuration, including optional `PHOTON_URL`, `AI_COORDINATE_PRECISION_DECIMALS`, and server/proxy settings. Missing provider credentials leave their respective features unavailable; they do not turn uncertain evidence into a verified result.

Review the migration SQL and use a disposable database first. When the target database is ready, apply migrations deliberately (this command changes the database):

```bash
npm run db:deploy
npm run db:generate
npm run dev
```

`npm run dev` runs the API at `http://localhost:3000` unless `PORT` is changed. `GET /health` returns 503 when the database is not ready; `GET /api/public/status` exposes public service status. Do not run provisioning, seed, sync, import, or cleanup commands as part of routine installation: those are separate operational actions that may write data or call external services.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development API with `tsx watch` |
| `npm run lint` | Check source and configured tests with ESLint |
| `npm run typecheck` | Check TypeScript without emitting files |
| `npm test` | Run the repository's check scripts |
| `npm run db:validate` | Validate the Prisma schema without migrating |
| `npm run build` | Generate the Prisma client and compile to `dist/` |
| `npm start` | Run the compiled API |

## Technical documentation

- `src/app.ts` sets up security headers, CORS, rate limits, database readiness, authentication, and the `/api` router. `src/modules/api/api.routes.ts` lists public, signed-in user, and admin-only endpoints.
- The local reference-only Swagger UI is at `http://localhost:3000/api/docs`; OpenAPI 3.1 JSON is at `http://localhost:3000/api/openapi.json`. The Swagger UI does not execute write requests.
- `src/config/auth.ts` configures verified-email cookie sessions, optional Google identity, and role/capability defaults. Google sign-in does not grant admin authority.
- `prisma/schema.prisma` and `prisma/migrations/` hold the database model and migration history. `src/modules/reports/triage.ts` evaluates report context; `src/modules/admin/` handles case decisions, operations, and publication approvals.
- `src/modules/integrations/` handles FIRMS ingestion, Google Weather, and AI analysis. `src/modules/uploads/` enforces access to media; `src/modules/spatial/` handles spatial ingestion.
- `Dockerfile` builds with Node.js 24. The runtime entrypoint requires `DATABASE_URL` and `DATABASE_CA_PEM` and starts the API on port 3000; it does **not** apply database migrations automatically.

## Related repositories

[Organization](https://github.com/Blazemap) · [Frontend](https://github.com/Blazemap/Blazemap-FE) · [AI service](https://github.com/Blazemap/Blazemap-AI)

## Report triage and confirmed perimeters

All routes below have an `/api` prefix and retain existing session, origin, and permission checks. The confirmed-perimeter migration is in `prisma/migrations/`; its deployment status depends on the target database. Review migration history and SQL before applying any migrations. No perimeter update automatically publishes a case.

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

`missingData` remains populated on CRITICAL/HIGH when coverage is missing. Codes include the three environment names, `INCIDENT_COORDINATES`, `OBSERVATION_TIME`, `SATELLITE_COVERAGE`, `SETTLEMENT_COVERAGE`, and `SETTLEMENT_GEOMETRY`. `reasonCodes` include `POLICY_NOT_CONFIGURED`, `DEMO_EXCLUDED`, `INCIDENT_LOCATION_UNKNOWN`, `OBSERVATION_TIME_INVALID`, `SATELLITE_SPATIOTEMPORAL_MATCH`, `SETTLEMENT_NEARBY`, `COVERED_NO_NEARBY_MATCH`, and `INSUFFICIENT_COVERAGE`. If source context exceeds the query safety caps, the endpoint returns 503 `TRIAGE_CONTEXT_TOO_LARGE` instead of a partial assessment.

Successful FIRMS runs now record `scope.observedFrom`/`observedTo` alongside existing `area` and `products`. Only a currently configured FIRMS source with its latest terminal run successful within one hour can establish negative coverage. Its box must cover the full search radius and its recorded time interval the full symmetric window. Legacy runs without explicit time bounds, failed/stale runs and historical gaps cannot establish MEDIUM. Positive spatial/time matches remain usable independently of negative coverage.

Settlement negative coverage requires a verified, non-DEMO SETTLEMENT layer with `coverage` containing a JSON string of this shape (values must represent actual reviewed dataset coverage, never guessed):

```ts
{ bbox: [west, south, east, north], validFrom: ISO8601, validTo: ISO8601, complete: true }
```

The box must contain the entire settlement search radius; dates must cover the report and remain current, and sourceDate must not postdate the report. Free-text regional labels, mere feature presence, and region membership do not prove coverage. Valid nearby settlements can establish HIGH without complete negative coverage. Unsupported/malformed Polygon geometry is ignored as evidence and prevents MEDIUM. Query safety caps are 10,000 hotspots, 10,000 settlements and 1,000 layers; exceeding a cap returns 503 without a partial assessment.

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

## Current weather and source synchronization

Case weather is requested on demand at case coordinates using the configured Google Weather provider. Without a valid provider key or case coordinates, current weather and downwind attention remain unavailable; they are not inferred from historical forecasts. The `sources:sync` command and source watcher currently support FIRMS ingestion, not a BMKG cron or forecast-region selection workflow. Review the requested source and environment before running a sync against any database.

## OpenStreetMap spatial ingestion

`npm run sources:osm -- --dry-run` validates the configured official Geofabrik Kalimantan source, MD5 manifest, `Last-Modified` date, and 2 GiB download cap without downloading or writing the dataset. `npm run sources:osm` downloads to a private temporary directory, verifies the MD5 while streaming, performs bounded two-pass PBF extraction, imports batches, and always removes temporary data. `SPATIAL_IMPORT_USER_AGENT` is required and must include operator contact; `OSM_GEOFABRIK_URL` defaults to `https://download.geofabrik.de/asia/indonesia/kalimantan-latest.osm.pbf`.

The import stores only tagged settlement, facility, and water-source nodes plus selected road and river ways. Buildings, forest, peatland, polygons, and relations are not imported. Each layer is capped at 50,000 records, line assembly retains at most 2,000,000 referenced node coordinates, and extracted NDJSON is capped at 1 GiB. Layer metadata uses provider `OpenStreetMap`, license `ODbL 1.0`, attribution `© OpenStreetMap contributors`, the Geofabrik source URL and date, and the MD5 as version. Layers remain unverified and coverage is explicitly incomplete, so nearby settlement points may support positive triage only after operator verification; absence never establishes negative coverage.

For a dedicated Railway cron service, use start command `node dist/spatial-sync.js`, UTC schedule `0 3 * * *`, one replica, and limits no higher than 1 CPU and 1 GB memory. Configure `DATABASE_URL`, `DATABASE_CA_PEM`, and `SPATIAL_IMPORT_USER_AGENT=Blazemap/1.0 (+https://blazemap.my.id)`. Do not enable the schedule until the dry run passes; the first full production import is intentionally operator-controlled.

Notification and publication behavior is governed by the current implementation under `src/modules/notifications/` and `src/modules/admin/`. Do not treat notifications, weather context, or AI suggestions as official warnings, fire confirmations, arrival-time predictions, or evacuation instructions.
