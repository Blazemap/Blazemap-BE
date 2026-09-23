import { Router } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { callbackOAuth, getSession, requestPasswordReset, requestPasswordResetCallback, resetPassword, sendVerificationEmail, signInEmail, signInSocial, signOut, verifyEmail } from 'better-auth/api';
import { z } from 'zod';
import * as validation from '../types/index.js';
import { env } from './env.js';
import { publicPerimeterSchema } from '../utils/geometry.js';

type Schema = z.core.JSONSchema.BaseSchema;
type Parameter = { name: string; in: 'query' | 'path' | 'header'; required: boolean; schema: Schema; description?: string };
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
function schema(value: z.ZodType, description?: string): Schema {
  const result = z.toJSONSchema(value, { target: 'draft-2020-12', io: 'input' });
  delete result.$schema;
  return { ...result, ...(description ? { description } : {}) };
}
function query(value: z.ZodType): Parameter[] {
  const result = schema(value);
  return Object.entries(result.properties ?? {}).map(([name, property]) => ({ name, in: 'query', required: result.required?.includes(name) ?? false, schema: property as Schema }));
}
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const array = (items: Schema): Schema => ({ type: 'array', items });
const string: Schema = { type: 'string' };
const boolean: Schema = { type: 'boolean' };
const dateTime: Schema = { type: 'string', format: 'date-time' };
const nullable = (value: Schema): Schema => ({ anyOf: [value, { type: 'null' }] });
const { idSchema, reasonSchema, timeSchema, latitudeSchema, longitudeSchema } = validation;
const pairRule = 'Latitude and longitude must both be numbers or both be absent/null.';
const observationRule = 'Observation/verification timestamps accept ISO 8601 with UTC or an offset and must not exceed server time by more than five minutes.';
const publicationRule = 'New WARNING writes are unavailable in the initial workflow; nearby confirmed-fire notifications are generated from authorized confirmation and location consent, not generic information writes. Body is plain text or Markdown without HTML. Source URLs use HTTP or HTTPS. Region IDs must be unique and verified. APPROVED_INCIDENT_POINT requires publicLatitude, publicLongitude, caseId and privacyReview. APPROVED_INCIDENT_PERIMETER requires caseId and privacyReview and freezes the confirmed case perimeter, observation time, source, computed spherical area and revision at publish time; no latest private geometry is read publicly. REGION_ONLY requires at least one region. Other modes discard public coordinates.';
const point = z.tuple([longitudeSchema, latitudeSchema]);
const ring = z.array(point).min(4).max(10000);
const geometry = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('Point'), coordinates: point }),
  z.strictObject({ type: z.literal('LineString'), coordinates: z.array(point).min(2).max(10000) }),
  z.strictObject({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1).max(100) }),
  z.strictObject({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ring).min(1).max(100)).min(1).max(100) }),
]);
const layer = z.strictObject({
  name: z.string().trim().min(3).max(200), kind: z.enum(validation.featureKinds), provider: z.string().trim().min(3).max(200), sourceUrl: z.url({ protocol: /^https:$/ }).max(2000),
  license: z.string().trim().min(3).max(1000), attribution: z.string().trim().min(3).max(1000), coverage: z.string().trim().min(3).max(1000), version: z.string().trim().min(1).max(100), sourceDate: timeSchema, verifiedAt: timeSchema, reason: reasonSchema,
  features: z.array(z.strictObject({ sourceId: idSchema, kind: z.enum(validation.featureKinds), name: z.string().max(200).nullish(), geometry, regionId: idSchema.nullish(), attributes: z.record(z.string().max(100), z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])).default({}) })).max(200),
});
const region = z.strictObject({ name: z.string().trim().min(2).max(200), level: z.number().int().min(1).max(4), code: z.string().trim().min(2).max(32), timezone: z.enum(['Asia/Pontianak', 'Asia/Makassar', 'Asia/Jakarta']), parentId: idSchema.nullish(), datasetId: idSchema, verifiedAt: timeSchema, reason: reasonSchema });
const candidateQuery = z.strictObject({ maxDistanceMeters: z.coerce.number().int().min(1).max(100000), hours: z.coerce.number().positive().max(168) });
const pageQuery = validation.paginationSchema.pick({ page: true, pageSize: true });
const feedQuery = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), pageSize: z.coerce.number().int().min(1).max(10).default(10) });
const notificationQuery = z.object({ cursor: idSchema.optional(), pageSize: z.coerce.number().int().min(1).max(10).default(10) });
const searchQuery = validation.paginationSchema.pick({ search: true });
const filterQuery = validation.paginationSchema.omit({ type: true });
const reportQuery = filterQuery.extend({ reviewStatus: z.enum(validation.reviewStatuses).optional() });
const caseQuery = filterQuery.extend({ handlingStatus: z.enum(validation.handlingStatuses).optional(), verificationStatus: z.enum(validation.verificationStatuses).optional(), priority: z.enum(validation.priorities).optional() });
const password = z.string().min(12).max(128).meta({ format: 'password', writeOnly: true });
const emailLogin = signInEmail();
const googleLogin = signInSocial();
const sessionEndpoint = getSession();
const schemas: Record<string, Schema> = {
  ReportInput: schema(validation.reportSchema, `${pairRule} ${observationRule} Latitude and longitude are required keys but may both be null when a verified regionId is supplied. Observation types and attachment IDs must be unique. Attachments must belong to the caller and be finalized, unexpired and unattached. Reusing an idempotencyKey with different normalized content returns 409.`),
  ReportUpdateInput: schema(validation.updateSchema, 'kind defaults to CLARIFICATION. Up to five unique finalized private photo attachments may accompany an update. Only ADMIN may use REQUEST; it also changes reviewStatus to NEEDS_DETAILS. Updates are visible to the reporter and authorized administrators.'),
  ReportProgressInput: schema(validation.progressSchema, 'Adds an owner-visible progress description and up to five private evidence images. Attachments must be finalized, unexpired, unattached and owned by the administrator. Retrying the same idempotency key with changed content returns 409.'),
  ReportActionInput: schema(validation.reportActionSchema, 'Records only IN_PROGRESS, REVIEWED, or DECLINED report review actions. Fire confirmation is case-only and requires an assigned team field result plus a validated perimeter.'),
  UploadIntentInput: schema(validation.uploadSchema, 'Filename must have no path separators or control characters; extension must match contentType, case-insensitively. Maximum size is 5 MiB. Finalization verifies bytes, MIME, decodability, no animation, and a 20-million-pixel decode limit.'),
  CaseInput: schema(validation.caseSchema, `${pairRule} A supplied regionId must be verified.`),
  CaseFromReportsInput: schema(validation.caseFromReportsSchema, 'Creates one unverified case from 2–100 unique, currently unlinked reports in one transaction. Hotspots cannot be included.'),
  CasePatchInput: schema(validation.casePatchSchema, 'Two exclusive variants: existing priority/handlingStatus, or perimeter + perimeterObservedAt + perimeterSource + authorityReference. Both require reason and matching version. Perimeter requires an email-verified active ADMIN with canConfirmIncidents and CONFIRMED_FIRE, at most 1000 total positions, closed rings, at least 3 distinct vertices, no repeats except closure, no self-intersections, nonzero area and contained disjoint holes. Longitude span >=180 degrees is unsupported. Atomically increments version/contextRevision/perimeterRevision, clears latestAnalysisId and audits; never publishes. RESPONDING requires CONFIRMED_FIRE; CLOSED requires all assignments completed or cancelled.'),
  PublicPerimeter: schema(publicPerimeterSchema, 'Frozen approved publication snapshot only. Area is computed on a sphere of radius 6371008.8m in hectares, subtracting holes; display estimate, not a cadastral measurement.'),
  ReportTriage: object({ level: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'UNKNOWN'] }, reasonCodes: array(string), missingData: array(string), evaluatedAt: dateTime, ruleVersion: { type: 'string', const: 'report-triage-1' }, satelliteMatch: nullable(object({ distanceMeters: { type: 'number' }, acquiredAt: dateTime }, ['distanceMeters', 'acquiredAt'])), settlementMatch: nullable(object({ name: nullable(string), distanceMeters: { type: 'number' } }, ['name', 'distanceMeters'])) }, ['level', 'reasonCodes', 'missingData', 'evaluatedAt', 'ruleVersion', 'satelliteMatch', 'settlementMatch']),
  FieldUpdateInput: schema(validation.fieldSchema, `${pairRule} ${observationRule} Attachment IDs must be unique, owned by the caller, finalized, unexpired and unattached.`),
  VerificationInput: schema(validation.verificationSchema, 'New CONFIRMED_FIRE input is version, observationId, decisionNote, perimeter, and boundaryUsesObservationSourceTime. The observation must belong to the case, be VISIBLE_FIRE, contain an incident point, and retain persisted provenance. When boundaryUsesObservationSourceTime=true, omit duplicate perimeter source/time; otherwise send both. APPLICATION_ADMIN_ROLE is server-derived. The owner-visible decision note, verification, boundary, audit, version/context revision, and analysis invalidation commit atomically. Legacy verification payloads remain accepted; NOT_FIRE and INCONCLUSIVE remain available through that compatibility variant.'),
  ReportReviewInput: schema(validation.reviewSchema, 'At least one of reviewStatus or caseId is required. A null caseId unlinks the report. Linking new evidence to CLOSED or NOT_FIRE cases requires reopening/correcting the case first.'),
  AssignmentInput: schema(validation.assignmentSchema, 'Case must not be CLOSED or NOT_FIRE. A case may have multiple active assignments to different teams; each team may have only one active assignment globally. Team must be active, non-sample, with an AVAILABLE operational update no older than 24 hours. reason is audited; idempotencyKey retries return the original assignment and changed content returns 409.'),
  AssignmentPatchInput: schema(validation.assignmentPatchSchema, 'version must match. COMPLETED requires a fieldUpdateId linked to this assignment, case and team. COMPLETED and CANCELLED assignments are immutable. reason is audited.'),
  TeamInput: schema(validation.teamSchema, 'reason is audited; idempotencyKey retries return the original team and changed content returns 409.'),
  TeamPatchInput: schema(validation.teamPatchSchema, 'version must match. Active assignments prevent team deactivation. reason is audited.'),
  EquipmentInput: schema(validation.equipmentSchema, 'reason is audited; idempotencyKey retries return the original equipment and changed content returns 409.'),
  EquipmentPatchInput: schema(validation.equipmentPatchSchema, 'version must match. A non-null team must be active. reason is audited.'),
  OperationalFeatureInput: schema(validation.operationalFeatureSchema, 'Creates an operator-verified access point or water-source point with coordinates, source, observation time, initial condition, audited reason and idempotency key. An access point does not establish whole-route usability.'),
  OperationalUpdateInput: schema(validation.operationalSchema, `${observationRule} condition must belong to the selected subjectType in Enums.operationalConditions. FEATURE road conditions require ROAD; water conditions require WATER_SOURCE or RIVER. Sample and unverified features accept UNKNOWN only, do not invalidate case analysis, and cannot assert availability or routing. reason is audited; idempotencyKey retries return the original update and changed content returns 409.`),
  PublicationInput: schema(validation.publicationSchema, publicationRule),
  PublicationPatchInput: { ...schema(validation.publicationSchema, `All fields are optional and merged with the stored publication before full validation. ${publicationRule} Updating a DRAFT edits it; updating PUBLISHED creates a replacement draft. Other states cannot be replaced.`), required: [] },
  CompletionReportDraftInput: schema(validation.reportDraftSchema, 'Saves one versioned rich-text draft per confirmed case. bodyRich accepts only doc, paragraph, heading levels 2/3, bold, italic, HTTPS links, bullet/ordered lists, list items and blockquotes within node, depth and text limits. The server derives searchable plain text. Private evidence and IDs are never copied into the body.'),
  CompletionReportPublishInput: schema(validation.reportPublishSchema, 'Publishes only the reviewed current draft after rechecking draft revision, closed case version, privacy approval, factual HTTPS sources, optional expiry, verified regions and any approved perimeter. Retry after a successful publish is idempotent.'),
  OutcomePublicationInput: schema(validation.outcomePublicationSchema, 'Explicit completed-News opt-in. Exactly one target is required: a declined report, or a confirmed CLOSED case with expectedCaseVersion and saved perimeter. The public text is plain text; private notes and evidence are never copied. The case/report state is locked and rechecked before publication.'),
  PublishInput: schema(validation.publishSchema, 'Only DRAFT can be published. expectedUpdatedAt must exactly match the reviewed publication revision. Confirmed outcomes and APPROVED_INCIDENT_PERIMETER drafts must also provide the reviewed expectedCaseVersion. At least one factual source is required. validUntil, when present, must be in the future. WARNING is rejected here; use the controlled warning action endpoint. Referenced regions must remain verified.'),
  WarningSaveInput: schema(validation.warningSaveSchema, 'Controlled informational warning, never an evacuation order. Requires verified affected regions, factual sources and future validUntil. Edits require expectedUpdatedAt; editing PUBLISHED creates a replacement draft. Optional references require actual verified non-sample ROAD or DESIGNATED_LOCATION records and the latest operational update no older than 24 hours. No route is inferred. Idempotent and audited.'),
  WarningActionInput: schema(validation.warningActionSchema, 'Explicit confirm=true and reviewed expectedUpdatedAt required. Publish requires authorityReference and rechecks regions, validity and operational evidence. Withdraw requires reason. Same-key retries are idempotent; different content conflicts. ADMIN grants canPublishInformation.'),
  ReasonInput: schema(validation.withdrawalSchema),
  SettingsInput: schema(validation.settingsSchema, `${observationRule} Only source and verifiedAt are required; other fields may be omitted or null.`),
  AdminUserPatchInput: schema(validation.adminUserPatchSchema, 'Updates only name, role or active state. Email and verification are read-only. Authority changes require a mandate, revoke target sessions, prevent self-lockout and preserve at least one active verified ADMIN.'),
  LayerInput: schema(layer, `${observationRule} sourceUrl must use HTTPS. Feature sourceId values must be unique. Coordinates use [longitude, latitude]; polygon rings must repeat their first point at the end. Supplied feature regions must be verified. Empty features is allowed.`),
  RegionInput: schema(region, `${observationRule} datasetId must reference a verified BOUNDARY layer. A supplied parent must be verified and exactly one level above.`),

  MediaApprovalInput: schema(z.strictObject({ attachmentId: idSchema, sourceAttachmentId: idSchema, publicationUseBasis: reasonSchema, redactionReview: reasonSchema }), 'Publication must be DRAFT. sourceAttachmentId is attached, unrevoked private evidence. attachmentId is a separately uploaded, finalized, unexpired derivative owned by the caller, with a different ID and digest. Approved output is re-encoded as WebP and limited to 5 MiB.'),
  SyncInput: schema(z.strictObject({}), 'FIRMS uses server-configured area and products. Send {}. No credentials or source URLs are accepted.'),
  EmailSignupInput: schema(z.object({ name: z.string(), email: z.email(), password, image: z.string().optional(), callbackURL: z.string().optional(), rememberMe: z.boolean().optional() }), 'name is required but has no configured minimum length. callbackURL must pass trusted-origin validation. role, active and capability fields are server-controlled and cannot be supplied to elevate privileges.'),
  EmailLoginInput: schema(emailLogin.options.body.extend({ email: z.email(), password: z.string().meta({ format: 'password', writeOnly: true }) }), 'Email must be verified and the account active. Login does not impose the signup password-length constraint on submitted credentials. Callback URLs must pass trusted-origin checks.'),
  GoogleLoginInput: schema(googleLogin.options.body.extend({ provider: z.literal('google') }), 'Google must be configured. Only citizen registration sends requestSignUp: true; login omits it or sends false. New accounts are always USER with no admin capabilities. Government login requires an already linked Google identity and a separately provisioned ADMIN account; matching email alone does not link accounts. Google email must be verified. Callback URLs must be trusted. additionalParams cannot override reserved OAuth fields such as state, nonce, scope, client_id, redirect_uri, response_type or PKCE fields.'),
  SendVerificationInput: schema(sendVerificationEmail.options.body),
  PasswordResetRequestInput: schema(requestPasswordReset.options.body),
  PasswordResetInput: schema(resetPassword.options.body.extend({ newPassword: password }), 'A nonempty reset token must be supplied in the body or query; a truthy body token takes precedence. Reset revokes existing sessions.'),
  SignOutInput: schema(signOut.options.body),
  OAuthCallbackInput: schema(callbackOAuth.options.body, 'Provider-managed callback. Success requires the authorization code and matching stored OAuth state/cookie; error callbacks may omit code. POST merges body and query, with query taking precedence, then redirects to GET.'),
  Error: object({ message: string, code: string, errors: array(object({ path: string, message: string }, ['path', 'message'])) }, ['message', 'code']),
  AuthError: object({ message: string, code: string }),
  PageMeta: object({ total: { type: 'integer', minimum: 0 }, page: { type: 'integer', minimum: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100 } }, ['total', 'page', 'pageSize']),
  Enums: object(Object.fromEntries(Object.entries(validation.enums).map(([key, value]) => [key, Array.isArray(value) ? array({ type: 'string', enum: value }) : object(Object.fromEntries(Object.entries(value).map(([subject, conditions]) => [subject, array({ type: 'string', enum: conditions })])), Object.keys(value))])), Object.keys(validation.enums)),
  User: object({ id: string, name: string, email: { type: 'string', format: 'email' }, emailVerified: boolean, image: nullable(string), createdAt: dateTime, updatedAt: dateTime, role: { type: 'string', enum: [...validation.roles], readOnly: true }, active: { ...boolean, readOnly: true }, canConfirmIncidents: { ...boolean, readOnly: true }, canPublishInformation: { ...boolean, readOnly: true } }, ['id', 'name', 'email', 'emailVerified', 'createdAt', 'updatedAt', 'role', 'active', 'canConfirmIncidents', 'canPublishInformation']),
  Session: object({ id: string, userId: string, token: string, expiresAt: dateTime, createdAt: dateTime, updatedAt: dateTime, ipAddress: nullable(string), userAgent: nullable(string) }, ['id', 'userId', 'token', 'expiresAt', 'createdAt', 'updatedAt']),
  Notification: object({ id: string, reportId: nullable(string), publicationId: nullable(string), caseId: nullable(string), type: string, title: string, message: string, createdAt: dateTime, readAt: nullable(dateTime) }, ['id', 'reportId', 'publicationId', 'caseId', 'type', 'title', 'message', 'createdAt', 'readAt']),
  Download: object({ url: { type: 'string', format: 'uri', description: 'Short-lived signed object-storage URL, valid for 60 seconds.' } }, ['url']),
  UploadIntent: object({ id: string, uploadUrl: { type: 'string', format: 'uri' }, method: { const: 'PUT', type: 'string' }, headers: object({ 'Content-Type': { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'] }, 'If-None-Match': { type: 'string', const: '*' } }, ['Content-Type', 'If-None-Match']) }, ['id', 'uploadUrl', 'method', 'headers']),
};
const json = (value: Schema) => ({ 'application/json': { schema: value } });
const response = (description: string, value: Schema) => ({ description, content: json(value) });
const cookieSecurity = [{ sessionCookie: [] as string[] }];
const paths: Record<string, Record<string, unknown>> = {};
function operation(method: 'get' | 'post' | 'patch', path: string, summary: string, options: { body?: string; query?: Parameter[]; description?: string; status?: number; list?: boolean; data?: Schema; meta?: Schema; capability?: 'canConfirmIncidents' | 'canPublishInformation'; limit?: number; avatarUpload?: boolean } = {}) {
  const access = path.startsWith('/public/') ? 'public' : path.startsWith('/admin/') ? 'admin' : 'user';
  const data = options.data ?? { description: 'Service result. Fields depend on the selected resource and projection.' };
  const result = options.list ? object({ data: array(data), meta: options.meta ?? ref('PageMeta') }, ['data', 'meta']) : object({ data }, ['data']);
  const parameters: Parameter[] = [...path.matchAll(/\{([^}]+)\}/g)].map(match => ({ name: match[1]!, in: 'path', required: true, schema: schema(z.string().min(1).max(128)) }));
  if (path.includes('{source}')) parameters[0]!.schema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[Ff][Ii][Rr][Mm][Ss]$', description: 'FIRMS, case-insensitive.' };
  parameters.push(...(options.query ?? []));
  if (method !== 'get') parameters.push({ name: 'Origin', in: 'header', required: true, schema: string, description: `Must match a configured frontend/backend trusted origin. Content-Type must be ${options.avatarUpload ? 'image/jpeg' : 'application/json'}.` });
  if (options.avatarUpload) parameters.push({ name: 'X-Blazemap-Expected-Updated-At', in: 'header', required: true, schema: dateTime, description: 'Must match the current reviewed user revision.' }, { name: 'X-Blazemap-Audit-Reason', in: 'header', required: true, schema: { type: 'string', minLength: 5, maxLength: 300 }, description: 'Percent-encoded audit reason.' });
  paths[`/api${path}`] ??= {};
  paths[`/api${path}`]![method] = {
    operationId: `${method}${path.replace(/[{}]/g, '').split('/').filter(Boolean).map(part => part.split('-').map(word => word[0]!.toUpperCase() + word.slice(1)).join('')).join('')}`,
    summary, tags: [access === 'public' ? 'Public' : access === 'admin' ? 'Admin' : 'User'],
    description: [options.description, access === 'user' ? 'Requires an active USER or ADMIN session; resource ownership checks still apply.' : access === 'admin' ? 'Requires an active, email-verified ADMIN session. ADMIN grants all operational capabilities; USER grants none.' : '', options.capability ? `${options.capability} is an effective capability granted by the ADMIN role.` : '', options.limit ? `Additional shared route limit: ${options.limit} requests per minute.` : ''].filter(Boolean).join(' '),
    'x-access': access, ...(access !== 'public' ? { 'x-roles': access === 'admin' ? ['ADMIN'] : ['USER', 'ADMIN'] } : {}), ...(options.capability ? { 'x-capability': options.capability } : {}),
    security: access === 'public' ? [] : cookieSecurity,
    ...(parameters.length ? { parameters } : {}),
    ...(options.body ? { requestBody: { required: true, content: json(ref(options.body)) } } : options.avatarUpload ? { requestBody: { required: true, content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } } } : {}),
    responses: {
      [options.status ?? 200]: response(options.status === 201 ? 'Created' : 'Success', result),
      '400': response('Invalid request or service validation failed', ref('Error')),
      ...(access !== 'public' ? { '401': response('Missing/invalid session or inactive account', ref('Error')), '403': response('Role, capability, ownership or origin denied', ref('Error')) } : {}),
      '404': response('Resource not found or not visible', ref('Error')),
      ...(method !== 'get' ? { '409': response('State, revision, idempotency or reference conflict', ref('Error')), '413': response(options.avatarUpload ? 'JPEG exceeds 1 MiB' : 'JSON request exceeds 512 KiB', ref('Error')), '415': response(options.avatarUpload ? 'JPEG request required' : 'JSON request required', ref('Error')) } : {}),
      '429': response('Rate limit exceeded', ref('Error')),
      '503': response('Database or required integration unavailable', ref('Error')),
      '500': response('Request could not be completed', ref('Error')),
    },
  };
}
operation('get', '/public/status', 'Get service availability', { description: 'Runs before databaseGuard. Database/integration failure is reported in the 200 response data without exposing credentials.', data: object({ database: { type: 'string', enum: ['connected', 'unavailable'] }, sources: array(object({ id: string, name: string, status: string, message: string, lastSuccessAt: dateTime }, ['id', 'name', 'status'])), uploadsAvailable: boolean, emailAvailable: boolean, googleAvailable: boolean }, ['database', 'sources', 'uploadsAvailable', 'emailAvailable', 'googleAvailable']) });
operation('get', '/public/site', 'Get verified site profile', { description: 'Returns null until a verified site profile exists.', data: nullable({ type: 'object' }) });
operation('get', '/public/information', 'List published information', { list: true, query: query(validation.informationQuerySchema), description: 'Only already-published PUBLISHED items are listed. active=true excludes expired items and undated WARNING items; active defaults to false.' });
operation('get', '/public/information/{slug}', 'Get public information by slug', { description: 'Previously published PUBLISHED, SUPERSEDED and WITHDRAWN records remain readable; unpublished/future records are hidden.' });
operation('get', '/public/regions', 'List verified regions', { query: query(searchQuery), data: array({ type: 'object' }), description: 'Returns up to 100 verified regions, ordered by name; not paginated.' });
operation('get', '/public/enums', 'Get application enums', { data: ref('Enums') });
operation('get', '/public/media/{id}', 'Get approved public media URL', { data: ref('Download'), description: 'Requires approved, unrevoked media attached to a current PUBLISHED, unexpired publication. Returns a URL, not image bytes.' });
operation('get', '/map', 'Get role-scoped map projection', { query: query(z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() })), description: 'to defaults to server time; from defaults to 48 hours before to. Range must be ordered, at most 31 days, and to no more than five minutes in the future. Both roles receive at most 2,000 NASA FIRMS observations and PUBLISHED confirmed incident points/perimeters from frozen privacy-reviewed snapshots. USER additionally receives only own private reports, deduplicated against an associated public case. ADMIN receives every authorized private report with triage and confirmed linked cases with valid saved private perimeters; public projections for those private polygon cases are removed to avoid duplicates.' });
operation('get', '/feed', 'List citizen feed', { list: true, query: query(feedQuery), description: 'USER only. Server-merges own private reports with PUBLISHED confirmed incidents in reverse chronological order, page size at most 10. Publications associated with any own report are removed to prevent duplicate private/public cards. No other private report is returned.' });
operation('get', '/notifications', 'List own notifications', { list: true, query: query(notificationQuery), data: ref('Notification'), meta: object({ pageSize: { type: 'integer', minimum: 1, maximum: 10 }, unreadCount: { type: 'integer', minimum: 0 }, nextCursor: nullable(string) }, ['pageSize', 'unreadCount', 'nextCursor']), description: 'Returns only the current account’s persistent notifications, newest first. USER receives own-report and opted-in nearby events; ADMIN receives new-report and citizen follow-up events. Cursor ownership is validated.' });
operation('patch', '/notifications/{id}/read', 'Mark own notification read', { description: 'Idempotently marks one notification read only when it belongs to the current user.' });
operation('post', '/notifications/read-all', 'Mark all own notifications read', { description: 'Marks all unread notifications belonging to the current user. No other account is affected.' });
operation('get', '/reports', 'List own reports', { list: true, query: query(reportQuery), description: 'Even an ADMIN using this route sees only their own reports.' });
operation('post', '/reports', 'Create a report', { body: 'ReportInput', status: 201, limit: 30 });
operation('get', '/reports/{id}', 'Get own report', { description: 'Returns only reports owned by the current actor and updates visible to the reporter.' });
operation('post', '/reports/{id}/updates', 'Add a report update', { body: 'ReportUpdateInput', status: 201, limit: 30, description: 'USER must own the report; ADMIN may update any report.' });
operation('post', '/uploads/intents', 'Create an image upload intent', { body: 'UploadIntentInput', data: ref('UploadIntent'), status: 201, limit: 30, description: 'Maximum 30 intents per actor per hour. PUT bytes directly to the returned storage URL within five minutes using the returned headers, then finalize. The intent expires after one hour; this API does not accept multipart uploads.' });
operation('post', '/uploads/{id}/finalize', 'Finalize an owned upload', { data: object({ id: string }, ['id']), limit: 30, description: 'No request body is consumed; still send application/json and a trusted Origin. Caller must own the intent, including ADMIN. READY/ATTACHED retries return the ID without reprocessing.' });
operation('get', '/uploads/{id}/download', 'Get private attachment download URL', { data: ref('Download'), description: 'USER may download owned READY/ATTACHED, unrevoked images; ADMIN may download any eligible image. Returns a URL, not bytes.' });
operation('get', '/admin/enums', 'Get admin enums', { data: ref('Enums') });

operation('get', '/admin/layers', 'List map layers', { data: array({ type: 'object' }), description: 'Up to 100 layers, newest imports first; not paginated.' });
operation('post', '/admin/layers', 'Import a verified map layer', { body: 'LayerInput', status: 201, capability: 'canPublishInformation' });
operation('get', '/admin/regions', 'List verified operator regions', { query: query(z.object({ search: z.string().trim().max(200).optional() })), data: array({ type: 'object' }), description: 'Returns up to 100 verified administrative regions. Weather uses case coordinates independently of region mappings.' });
operation('post', '/admin/regions', 'Register a verified region', { body: 'RegionInput', status: 201, capability: 'canPublishInformation' });
operation('get', '/admin/features', 'List map features', { list: true, query: query(filterQuery) });
operation('get', '/admin/hotspots', 'List hotspot observations', { list: true, query: query(pageQuery), description: 'Newest map indicators first. Hotspots cannot be associated with or create cases.' });
operation('get', '/admin/cases', 'List cases', { list: true, query: query(caseQuery), description: 'Government-only worklist. Confirmed cases include their validated current private perimeter and revision for the separate internal map source; unconfirmed cases expose no perimeter.' });
operation('post', '/admin/cases', 'Create a case', { body: 'CaseInput', status: 201 });
operation('post', '/admin/cases/from-reports', 'Create one case from selected reports', { body: 'CaseFromReportsInput', status: 201, limit: 30, description: 'Locks all selected reports in deterministic order, rejects already-linked reports, and links the entire selection atomically. Hotspots are not accepted.' });
operation('get', '/admin/cases/{id}', 'Get case detail and evidence', { description: 'Adds nullable perimeter metadata and fieldUpdates provenance/sourceReportId. weather and windContext use Google Weather current conditions at case coordinates with CASE_COORDINATES or UNAVAILABLE basis, source attribution, nullable issue time, valid/fetch/usable timestamps and unavailable reason. No region mapping or containment is inferred.' });
operation('patch', '/admin/cases/{id}', 'Update case priority, handling or confirmed perimeter', { body: 'CasePatchInput', description: 'The perimeter variant additionally requires verified email and canConfirmIncidents. Returns existing case fields plus perimeter, perimeterObservedAt, perimeterSource, perimeterRevision and areaHectares for that variant. Version conflict returns 409 VERSION_CONFLICT.' });

operation('post', '/admin/cases/{id}/field-updates', 'Record a field update', { body: 'FieldUpdateInput', status: 201 });
operation('post', '/admin/cases/{id}/verify', 'Record an authoritative verification', { body: 'VerificationInput', capability: 'canConfirmIncidents' });
operation('post', '/admin/cases/{id}/analyze', 'Analyze case evidence', { limit: 6, description: 'No body is consumed. Requires configured AI service and observations. At most 50 context sources and 128 KiB context; running/recent analyses are rejected. Output is advisory and does not grant authority or confirm a fire.' });
operation('post', '/admin/cases/{id}/assignments', 'Assign another available team to a case', { body: 'AssignmentInput', status: 201, description: 'Creates one assignment per request. Repeat with the refreshed case version to assign additional distinct available teams to the same case.' });
operation('patch', '/admin/assignments/{id}', 'Update an assignment', { body: 'AssignmentPatchInput' });
const triageDescription = 'Existing report fields plus triage (admin list/detail only, not own-report routes). Deterministic advisory triage never verifies or publishes. Requires explicit TRIAGE_HOTSPOT_RADIUS_METERS, TRIAGE_HOTSPOT_WINDOW_HOURS and TRIAGE_SETTLEMENT_RADIUS_METERS; missing/invalid policy gives UNKNOWN. Observer-position and DEMO reports are UNKNOWN. Nearby time-matched non-demo NASA FIRMS evidence gives CRITICAL even with unknown settlement coverage; a verified nearby Point/Polygon settlement gives HIGH despite missing satellite coverage. MEDIUM requires current successful FIRMS coverage of the full symmetric time window and radius, plus verified complete settlement spatial/time coverage. Otherwise UNKNOWN. Context is loaded in four batch queries, not per report; truncation prevents MEDIUM. Match fields describe nearby matches only; missingData remains explicit even for CRITICAL/HIGH. See README for coverage metadata and reason codes.';
operation('get', '/admin/reports', 'List all reports', { list: true, query: query(reportQuery), description: triageDescription, data: object({ triage: ref('ReportTriage') }, ['triage']) });
operation('get', '/admin/reports/{id}', 'Get any report and its updates', { description: triageDescription, data: object({ triage: ref('ReportTriage') }, ['triage']) });
operation('get', '/admin/reports/{id}/candidates', 'Suggest candidate cases', { list: true, query: query(candidateQuery), limit: 6, description: 'Both query parameters are required; unknown query keys are rejected. Only reports with incident-estimate coordinates are eligible. Suggestions never automatically associate evidence; narrow the time window if more than 500 candidates match. Returns eligibility metadata, not pagination.', meta: object({ eligible: boolean, reason: nullable(string), maxDistanceMeters: { type: 'integer' }, hours: { type: 'number' }, automaticAssociation: { const: false, type: 'boolean' }, basis: string, limitation: string }, ['eligible', 'reason', 'maxDistanceMeters', 'hours', 'automaticAssociation', 'basis', 'limitation']) });
operation('post', '/admin/reports/{id}/case', 'Create and link an unverified case atomically', { status: 201, limit: 30, description: 'Requires a reason string of 5–2000 characters. Locks the report; retries return its existing linked case. Observer coordinates are never used as incident coordinates. No verification, publication or AI calls are performed.' });
operation('patch', '/admin/reports/{id}', 'Review or associate a report', { body: 'ReportReviewInput' });
operation('post', '/admin/reports/{id}/action', 'Record one atomic report action', { body: 'ReportActionInput', status: 201, limit: 30, description: 'The reduced confirmation path takes one owner-visible decision note, one reviewed observation, the required polygon, and optional photos. A citizen incident estimate can be explicitly reviewed and reused with persisted REVIEWED_CITIZEN_ESTIMATE provenance; observer position is never reused as the incident point. No polygon centroid is computed. Does not publish News.' });
operation('post', '/admin/reports/{id}/progress', 'Add private report progress', { body: 'ReportProgressInput', status: 201, limit: 30, description: 'Creates one chronological progress entry atomically with any attached evidence. Visible only to the report owner and administrators.' });
operation('post', '/admin/reports/{id}/updates', 'Add an administrator report update', { body: 'ReportUpdateInput', status: 201 });
operation('get', '/admin/completion-reports', 'List confirmed cases for editorial reports', { list: true, query: query(validation.reportQueueQuerySchema), description: 'Server-paginated editorial queue. Confirmed active cases may prepare drafts; only closed cases may publish. QUEUE excludes cases with an existing draft or published completion report.' });
operation('get', '/admin/completion-reports/{id}', 'Get confirmed case editorial context', { description: 'Returns one confirmed case with evidence metadata, linked reports, perimeter metadata and the current draft/publication. Government only.' });
operation('post', '/admin/completion-reports', 'Save confirmed case News draft', { body: 'CompletionReportDraftInput', status: 201, capability: 'canPublishInformation', limit: 30 });
operation('post', '/admin/completion-reports/{id}/publish', 'Publish closed case report', { body: 'CompletionReportPublishInput', capability: 'canPublishInformation', limit: 30, description: 'The path ID is the publication draft ID. Explicit publication is required before citizen News includes the report.' });
operation('get', '/admin/monitoring/summary', 'Get monitoring summary', { description: 'Returns one current-state snapshot of stored case, report, operations and publication counts. Counts are operational records, not real-time sensor readings or automatic fire confirmation.' });
operation('get', '/admin/users', 'List users', { list: true, query: query(validation.paginationSchema.pick({ page: true, pageSize: true, search: true }).extend({ role: z.enum(validation.roles).optional(), active: z.enum(['true', 'false']).optional(), emailVerified: z.enum(['true', 'false']).optional() })), description: 'Returns a paginated, searchable and filterable administrative projection of account identity, profile image reference, role, activation, verification and effective capabilities. Sessions, credentials, tokens and password material are never returned.' });
operation('get', '/admin/users/{id}/avatar', 'Get a private user avatar', { description: 'Returns private JPEG bytes only to an active verified ADMIN. Google-hosted avatars remain referenced by the safe account projection and are not proxied.' });
operation('post', '/admin/users/{id}/avatar', 'Replace a user profile photo', { avatarUpload: true, limit: 6, description: 'Accepts one validated 512 × 512 JPEG up to 1 MiB, checks the reviewed user revision, stores it privately, deletes the previous private avatar after commit and writes an audit log.' });
operation('get', '/admin/users/{id}', 'Get user administration detail', { description: 'Returns only the safe administrative projection, including the validated profile image reference. Sessions, credentials, tokens and password material are never returned.' });
operation('patch', '/admin/users/{id}', 'Update user access', { body: 'AdminUserPatchInput', description: 'Updates name, role or active state with optimistic concurrency, audit logging, self-lockout and last-admin protection. Authority changes revoke target sessions.' });
operation('get', '/admin/operations', 'Get operational overview', { description: 'Returns teams, equipment (300), access/water features (300), operational updates (1,000), assignments, freshness, sample markers, authority flags and derived available counts. Sample records and unverified map features never count as available or authoritative.' });
operation('get', '/admin/teams/{id}', 'Get team operational detail', { description: 'Returns one production team, performance, latest condition and up to 100 recent condition updates.' });
operation('get', '/admin/equipment/{id}', 'Get equipment operational detail', { description: 'Returns one production equipment record, owner candidates, current assignment and up to 100 recent condition updates.' });
operation('get', '/admin/assignments/{id}', 'Get assignment operational detail', { description: 'Returns one production assignment with immutable case/team context, lifecycle timestamps and latest field result.' });
operation('get', '/admin/operational-features/{id}', 'Get access or water operational detail', { description: 'Returns one production access, water or designated-location feature and up to 100 recent condition updates.' });
operation('post', '/admin/teams', 'Create a team', { body: 'TeamInput', status: 201, limit: 30 });
operation('patch', '/admin/teams/{id}', 'Update a team', { body: 'TeamPatchInput', limit: 30 });
operation('post', '/admin/equipment', 'Create equipment', { body: 'EquipmentInput', status: 201, limit: 30 });
operation('patch', '/admin/equipment/{id}', 'Update equipment', { body: 'EquipmentPatchInput', limit: 30 });
operation('post', '/admin/operational-features', 'Create an operational access or water point', { body: 'OperationalFeatureInput', status: 201, limit: 30 });
operation('post', '/admin/operational-updates', 'Record an operational condition', { body: 'OperationalUpdateInput', status: 201, limit: 30 });
operation('post', '/admin/information/{id}/media', 'Approve a reviewed media derivative', { body: 'MediaApprovalInput', status: 201, capability: 'canPublishInformation' });
operation('post', '/admin/media/{id}/revoke', 'Revoke public media', { body: 'ReasonInput', capability: 'canPublishInformation' });
operation('post', '/admin/outcomes/publish', 'Publish a declined report outcome to News', { body: 'OutcomePublicationInput', status: 201, capability: 'canPublishInformation', limit: 30, description: 'Concise explicit publication path for declined reports only. Decline publishes no location. CLOSED cases must use the versioned completion News workflow. Idempotent per administrator and key.' });
operation('get', '/admin/information', 'List editorial information', { list: true, query: query(validation.informationQuerySchema), description: 'Includes all publication states unless active=true applies current-publication filtering.' });
operation('post', '/admin/information', 'Create an information draft', { body: 'PublicationInput', status: 201 });
operation('get', '/admin/information/{id}', 'Get editorial information by ID');
operation('patch', '/admin/information/{id}', 'Edit a draft or create a replacement draft', { body: 'PublicationPatchInput' });
operation('post', '/admin/information/{id}/publish', 'Publish a reviewed draft', { body: 'PublishInput', capability: 'canPublishInformation' });
operation('post', '/admin/information/{id}/withdraw', 'Withdraw published information', { body: 'ReasonInput', capability: 'canPublishInformation', description: 'Only PUBLISHED information can be withdrawn. Associated public media is revoked.' });
operation('get', '/admin/settings', 'Get site settings', { data: nullable({ type: 'object' }), description: 'Includes unverified settings and provenance, or null when absent.' });
operation('patch', '/admin/settings', 'Update verified site settings', { body: 'SettingsInput', capability: 'canPublishInformation' });
operation('post', '/admin/integrations/{source}/sync', 'Synchronize an external source', { body: 'SyncInput', limit: 6, description: 'FIRMS only. Uses server-side configuration and source-specific freshness/rate limits. No source credentials are returned.' });

const redirect = { description: 'Redirect to the provider, trusted callback, or configured error page', headers: { Location: { schema: string } } };
function authOperation(method: 'get' | 'post', path: string, summary: string, options: { body?: string; optionalBody?: boolean; query?: Parameter[]; parameters?: Parameter[]; description: string; result?: Schema; redirect?: boolean; redirectOnly?: boolean; optionalSession?: boolean; form?: boolean }) {
  paths[`/api/auth${path}`] ??= {};
  paths[`/api/auth${path}`]![method] = {
    operationId: `auth${method}${path.replace(/[{}]/g, '').split('/').filter(Boolean).map(part => part.split('-').map(word => word[0]!.toUpperCase() + word.slice(1)).join('')).join('')}`,
    summary, tags: ['Auth'], description: options.description, 'x-access': 'auth', security: options.optionalSession ? [{}, ...cookieSecurity] : [],
    parameters: [...(options.parameters ?? []), ...(options.query ?? [])],
    ...(options.body ? { requestBody: { required: !options.optionalBody, content: { ...json(ref(options.body)), ...(options.form ? { 'application/x-www-form-urlencoded': { schema: ref(options.body) } } : {}) } } } : {}),
    responses: {
      ...(!options.redirectOnly ? { '200': response('Better Auth response; not wrapped in data', options.result ?? { type: 'object' }) } : {}),
      ...(options.redirect || options.redirectOnly ? { '302': redirect } : {}),
      '400': response('Invalid authentication request', ref('AuthError')),
      '401': response('Invalid credentials, session or token', ref('AuthError')),
      '403': response('Unverified email, forbidden fields, or origin/CSRF check failed', ref('AuthError')),
      '404': response('Provider or account resource unavailable', ref('AuthError')),
      '422': response('Account could not be created or updated', ref('AuthError')),
      '429': response('Authentication rate limit exceeded', ref('AuthError')),
      '503': response('Database, authentication configuration or email delivery unavailable', ref('AuthError')),
      '500': response('Authentication request failed', ref('AuthError')),
    },
  };
}
authOperation('post', '/sign-up/email', 'Register a citizen with email', { body: 'EmailSignupInput', form: true, description: 'Creates USER only, with active=true and both authority capabilities false. Requires email delivery. Email verification is mandatory; signup does not create a session and returns token:null. Duplicate registration uses a generic response to avoid account enumeration. Administrator authority must be separately provisioned.', result: object({ token: { type: 'null' }, user: ref('User') }, ['token', 'user']) });
authOperation('post', '/sign-in/email', 'Login with email and password', { body: 'EmailLoginInput', form: true, description: 'Requires a verified, active account with a credential identity. Returns a session and sets an HttpOnly cookie. Unverified accounts are sent a verification email when delivery is available.', result: object({ redirect: boolean, token: string, user: ref('User'), url: string }, ['redirect', 'token', 'user']) });
authOperation('post', '/sign-in/social', 'Login or explicitly register with Google', { body: 'GoogleLoginInput', description: 'OAuth2/OIDC identity flow, not bearer authorization for application endpoints. Redirect mode returns a Google authorization URL; idToken mode verifies the supplied Google identity token and returns a cookie session. disableImplicitSignUp=true applies to both branches. Only explicit citizen registration sends requestSignUp:true. Government login needs an already linked/provisioned ADMIN account. No automatic same-email linking, role inference, or ADMIN signup.', result: { oneOf: [object({ url: string, redirect: boolean }, ['url', 'redirect']), object({ token: string, user: ref('User'), redirect: { const: false, type: 'boolean' } }, ['token', 'user', 'redirect'])] } });
for (const method of ['get', 'post'] as const) authOperation(method, '/callback/{id}', 'Complete the Google OAuth callback', { ...(method === 'post' ? { body: 'OAuthCallbackInput', optionalBody: true, form: true } : {}), query: query(callbackOAuth.options.query), parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', enum: ['google'] } }], redirectOnly: true, description: 'Google callback is /api/auth/callback/google. Managed by Better Auth with state, PKCE and identity verification. POST normalizes callback fields into a GET redirect. Successful GET creates the session cookie and redirects; errors redirect to the trusted/configured error callback. Do not call manually. No implicit signup or same-email linking.' });
authOperation('get', '/get-session', 'Get the current cookie session', { optionalSession: true, query: query(sessionEndpoint.options.query), description: 'Returns {session,user} or null without a valid session. Cookie cache is disabled. Query flags use Zod Boolean coercion: any nonempty query string, including "false", is truthy; omit the flags unless enabling them. POST is disabled unless deferred session refresh is configured (not enabled here). Application guards additionally re-read active status and role.', result: nullable(object({ session: ref('Session'), user: ref('User') }, ['session', 'user'])) });
authOperation('post', '/sign-out', 'Logout the current session', { body: 'SignOutInput', optionalBody: true, optionalSession: true, description: 'Deletes the current local session when present and expires auth cookies; also succeeds without a session. Does not globally log the user out of Google.', result: object({ success: { const: true, type: 'boolean' } }, ['success']) });
authOperation('post', '/send-verification-email', 'Send an email verification link', { body: 'SendVerificationInput', optionalSession: true, description: 'Requires email delivery. Responds generically without a session for absent/already-verified accounts; with a session, email must match and remain unverified. Verification token expires after one hour. Callback URL must be trusted.', result: object({ status: boolean }, ['status']) });
authOperation('get', '/verify-email', 'Verify an email address', { query: query(verifyEmail.options.query), redirect: true, description: 'Validates a one-hour email-verification token. Redirects when callbackURL is provided; otherwise returns status and user (possibly null if already verified). Does not automatically sign in; login is still required.', result: object({ status: boolean, user: nullable(ref('User')) }, ['status', 'user']) });
authOperation('post', '/request-password-reset', 'Request a password reset email', { body: 'PasswordResetRequestInput', description: 'Requires email delivery. Uses a generic success response regardless of account existence. redirectTo is optional but, when provided, must be trusted. Reset token expires after one hour.', result: object({ status: boolean, message: string }, ['status', 'message']) });
authOperation('get', '/reset-password/{token}', 'Follow a password reset email link', { query: query(requestPasswordResetCallback.options.query), parameters: [{ name: 'token', in: 'path', required: true, schema: string }], redirectOnly: true, description: 'Provider-generated email link. Requires a nonempty trusted callbackURL for successful redirection. Redirects with the reset token or an invalid-token error; it does not reset the password itself.' });
authOperation('post', '/reset-password', 'Set a new password with a reset token', { body: 'PasswordResetInput', query: query(resetPassword.options.query), description: 'newPassword must contain 12–128 characters. A nonempty token is required in either the body or query, not necessarily both. Consumes the reset token and revokes existing sessions.', result: object({ status: boolean }, ['status']) });

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Blazemap API', version: '1.0.0',
    description: 'Reference-only Swagger UI: execution and external validation are disabled. Covers 57 application operations (7 public, 12 user/session, 38 admin) and 12 relevant Better Auth operations. Application endpoints use HttpOnly cookie sessions, not bearer tokens. USER and ADMIN are the only roles; ADMIN and authority capabilities require audited provisioning. Google OAuth2/OIDC only establishes identity and never grants ADMIN. API guards, origin/CSRF checks, rate limits and validation remain enforced. Application writes require a trusted Origin and application/json (512 KiB limit). The global rate limit is 180 requests/minute; authentication additionally uses 30/minute and Better Auth endpoint-specific limits. Refined cross-field and database constraints are described alongside the generated Zod input schemas; documentation does not replace server validation. No deployment server URL is assumed.',
  },
  tags: [
    { name: 'Public', description: 'No session required; all except status depend on the database.' },
    { name: 'User', description: 'Active USER or ADMIN session; private resources retain ownership restrictions.' },
    { name: 'Admin', description: 'Provisioned ADMIN only, with extra authority capabilities where specified.' },
    { name: 'Auth', description: 'Better Auth email, Google, session, logout, verification and password reset routes. Trusted origins and CSRF protection remain enabled. No OAuth client secrets belong in requests or documentation.' },
  ],
  paths,
  components: {
    securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: `${env.NODE_ENV === 'production' ? '__Secure-' : ''}better-auth.session_token`, description: 'Signed HttpOnly Better Auth session cookie set by login. Production uses __Secure-better-auth.session_token (Secure, SameSite=None); development/test uses better-auth.session_token (SameSite=Lax). Send browser requests with credentials included. Not a bearer token and not manually editable through this reference-only UI.' } },
    schemas,
  },
};
export const swaggerOptions = {
  swaggerUrl: '/api/openapi.json', customSiteTitle: 'Blazemap API — Swagger UI',
  swaggerOptions: { url: '/api/openapi.json', validatorUrl: null, persistAuthorization: false, queryConfigEnabled: false, supportedSubmitMethods: [], docExpansion: 'none', defaultModelsExpandDepth: 0 },
};
export const swaggerRouter = Router();
swaggerRouter.get('/openapi.json', (_req, res) => { res.json(openapi); });
swaggerRouter.use('/docs', helmet.contentSecurityPolicy({ directives: { connectSrc: ["'self'"], imgSrc: ["'self'", 'data:'], frameAncestors: ["'none'"], formAction: ["'none'"], upgradeInsecureRequests: env.NODE_ENV === 'production' ? [] : null } }), swaggerUi.serveFiles(undefined, swaggerOptions), swaggerUi.setup(undefined, swaggerOptions));
