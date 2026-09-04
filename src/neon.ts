import type { CredentialReference } from "./credentials";
import { listCredentialReferences } from "./credentials";
import { listEnvironmentProfiles } from "./environments";
import type { CredentialSecretAdapter } from "./keychain";
import { MacOSKeychainAdapter, withCredentialSecret } from "./keychain";
import type { Store } from "./persistence";

export const NEON_API_BASE_URL = "https://console.neon.tech/api/v2";
export const NEON_REQUEST_TIMEOUT_MS = 5_000;
export const NEON_MAX_RESPONSE_BYTES = 256 * 1024;

export type NeonFetch = (url: string, init: RequestInit) => Promise<Response>;
export type NeonAvailability = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
export type NeonFreshness = "CURRENT" | "STALE" | "UNKNOWN";

export type NeonFailureKind =
  | "CREDENTIAL_UNAVAILABLE"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "HTTP_401"
  | "HTTP_403"
  | "HTTP_404"
  | "HTTP_429"
  | "HTTP_5XX"
  | "HTTP_ERROR"
  | "NON_JSON"
  | "MALFORMED_JSON"
  | "OVERSIZED_RESPONSE"
  | "UNEXPECTED_SCHEMA"
  | "IDENTITY_MISMATCH"
  | "CONFIGURATION_ERROR";

export interface NeonProjectMetadata {
  regionId?: string;
  platformId?: string;
  pgVersion?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface NeonProjectConfig {
  environmentProfileId: string;
  workspaceId: string;
  environmentName: string;
  projectId: string;
  credential: CredentialReference;
}

export interface NeonProjectSnapshot {
  providerProjectId: string;
  name: string | null;
  status: string | null;
  observedAt: string;
  checkedAt: string;
  sourceEndpoint: string;
  metadata: NeonProjectMetadata;
}

export interface NeonProjectObservation {
  environmentProfileId: string;
  workspaceId: string;
  environmentName: string;
  configuredProjectId: string;
  providerProjectId: string | null;
  name: string | null;
  status: string | null;
  observedAt: string | null;
  checkedAt: string | null;
  availability: NeonAvailability;
  freshness: NeonFreshness;
  sourceEndpoint: string;
  metadata: NeonProjectMetadata;
  failureKind: NeonFailureKind | null;
}

export interface NeonObservationOptions {
  credentialAdapter?: CredentialSecretAdapter;
  fetchImpl?: NeonFetch;
  checkedAt?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class NeonObservationError extends Error {
  constructor(
    public readonly kind: NeonFailureKind,
    public readonly availability: Exclude<NeonAvailability, "AVAILABLE">,
    message: string,
  ) {
    super(message);
    this.name = "NeonObservationError";
  }
}

function projectEndpoint(projectId: string): string {
  return `${NEON_API_BASE_URL}/projects/${projectId}`;
}

function requireProjectId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9-]{1,60}$/.test(value)) {
    throw new NeonObservationError("CONFIGURATION_ERROR", "UNKNOWN", "NEON_PROJECT_ID must be a valid Neon project ID.");
  }
  return value;
}

function safeOptionalString(value: unknown, maxLength = 255): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new NeonObservationError("UNEXPECTED_SCHEMA", "UNKNOWN", "Neon project response has an unexpected schema.");
  }
  return value;
}

function safeMetadataString(value: unknown, maxLength = 255): string | undefined {
  const result = safeOptionalString(value, maxLength);
  return result === null ? undefined : result;
}

function safePgVersion(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 100) {
    throw new NeonObservationError("UNEXPECTED_SCHEMA", "UNKNOWN", "Neon project response has an unexpected schema.");
  }
  return Number(value);
}

function checkedAt(options: NeonObservationOptions): string {
  const value = options.checkedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(value))) {
    throw new NeonObservationError("CONFIGURATION_ERROR", "UNKNOWN", "Neon observation time is invalid.");
  }
  return value;
}

function boundedPositive(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new NeonObservationError("CONFIGURATION_ERROR", "UNKNOWN", "Neon observation bound is invalid.");
  }
  return value;
}

function httpFailure(status: number): NeonObservationError {
  if (status === 401) return new NeonObservationError("HTTP_401", "UNAVAILABLE", "Neon project observation was unauthorized.");
  if (status === 403) return new NeonObservationError("HTTP_403", "UNAVAILABLE", "Neon project observation was forbidden.");
  if (status === 404) return new NeonObservationError("HTTP_404", "UNAVAILABLE", "Configured Neon project was not found.");
  if (status === 429) return new NeonObservationError("HTTP_429", "UNAVAILABLE", "Neon project observation was rate limited.");
  if (status >= 500 && status <= 599) return new NeonObservationError("HTTP_5XX", "UNAVAILABLE", "Neon project observation is temporarily unavailable.");
  return new NeonObservationError("HTTP_ERROR", "UNAVAILABLE", `Neon project observation failed with HTTP status ${status}.`);
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw new NeonObservationError("NON_JSON", "UNKNOWN", "Neon project response was not JSON.");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new NeonObservationError("OVERSIZED_RESPONSE", "UNKNOWN", "Neon project response exceeded the size limit.");
  }
  if (!response.body) throw new NeonObservationError("MALFORMED_JSON", "UNKNOWN", "Neon project response was malformed JSON.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new NeonObservationError("OVERSIZED_RESPONSE", "UNKNOWN", "Neon project response exceeded the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new NeonObservationError("MALFORMED_JSON", "UNKNOWN", "Neon project response was malformed JSON.");
  }
}

export function resolveNeonProjectConfig(store: Store, environmentProfileId: string): NeonProjectConfig {
  const profile = listEnvironmentProfiles(store, { includeArchived: true })
    .find((candidate) => candidate.id === environmentProfileId);
  if (!profile || profile.archivedAt !== null) {
    throw new NeonObservationError("CONFIGURATION_ERROR", "UNKNOWN", "Active environment profile not found for Neon observation.");
  }

  const projectSetting = profile.settings.find((setting) => setting.key === "NEON_PROJECT_ID");
  const projectId = requireProjectId(projectSetting?.value);
  const apiKeyBinding = profile.credentialBindings.find((binding) => binding.key === "NEON_API_KEY");
  if (!apiKeyBinding) {
    throw new NeonObservationError("CONFIGURATION_ERROR", "UNAVAILABLE", "NEON_API_KEY credential binding is required.");
  }
  const credential = listCredentialReferences(store, { includeArchived: true })
    .find((candidate) => candidate.id === apiKeyBinding.credentialReferenceId);
  if (!credential || credential.archivedAt !== null) {
    throw new NeonObservationError("CONFIGURATION_ERROR", "UNAVAILABLE", "NEON_API_KEY must reference an active credential reference.");
  }

  return {
    environmentProfileId: profile.id,
    workspaceId: profile.workspaceId,
    environmentName: profile.environmentName,
    projectId,
    credential,
  };
}

export async function observeNeonProject(
  config: NeonProjectConfig,
  options: NeonObservationOptions = {},
): Promise<NeonProjectSnapshot> {
  const observationTime = checkedAt(options);
  const timeoutMs = boundedPositive(options.timeoutMs, NEON_REQUEST_TIMEOUT_MS, 30_000);
  const maxResponseBytes = boundedPositive(options.maxResponseBytes, NEON_MAX_RESPONSE_BYTES, 1024 * 1024);
  const fetchImpl = options.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
  const credentialAdapter = options.credentialAdapter ?? new MacOSKeychainAdapter();
  const endpoint = projectEndpoint(config.projectId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let pending: Promise<Response> | undefined;

  try {
    let resolution;
    try {
      resolution = withCredentialSecret(
        config.credential,
        { operation: "neon.project.observe" },
        (secret) => {
          const token = Buffer.from(secret).toString("utf8");
          if (!token || token.length > 4096 || /[\u0000\r\n]/u.test(token)) {
            throw new Error("invalid credential material");
          }
          pending = fetchImpl(endpoint, {
            method: "GET",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${token}`,
            },
            redirect: "error",
            signal: controller.signal,
          });
        },
        credentialAdapter,
      );
    } catch {
      throw new NeonObservationError("CREDENTIAL_UNAVAILABLE", "UNAVAILABLE", "Neon API credential is unavailable.");
    }
    if (resolution.availability !== "AVAILABLE" || !pending) {
      throw new NeonObservationError("CREDENTIAL_UNAVAILABLE", "UNAVAILABLE", "Neon API credential is unavailable.");
    }

    let response: Response;
    try {
      response = await pending;
    } catch {
      if (controller.signal.aborted) {
        throw new NeonObservationError("TIMEOUT", "UNAVAILABLE", "Neon project observation timed out.");
      }
      throw new NeonObservationError("NETWORK_ERROR", "UNAVAILABLE", "Neon project observation failed at the network boundary.");
    }

    if (!response.ok) throw httpFailure(response.status);
    const parsed = await readBoundedJson(response, maxResponseBytes);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new NeonObservationError("UNEXPECTED_SCHEMA", "UNKNOWN", "Neon project response has an unexpected schema.");
    }
    const project = (parsed as Record<string, unknown>).project;
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      throw new NeonObservationError("UNEXPECTED_SCHEMA", "UNKNOWN", "Neon project response has an unexpected schema.");
    }
    const raw = project as Record<string, unknown>;
    const providerProjectId = typeof raw.id === "string" && /^[a-z0-9-]{1,60}$/.test(raw.id)
      ? raw.id
      : null;
    if (!providerProjectId) {
      throw new NeonObservationError("UNEXPECTED_SCHEMA", "UNKNOWN", "Neon project response has an unexpected schema.");
    }
    if (providerProjectId !== config.projectId) {
      throw new NeonObservationError("IDENTITY_MISMATCH", "UNKNOWN", "Neon project identity did not match the configured project.");
    }

    const metadata: NeonProjectMetadata = {};
    const regionId = safeMetadataString(raw.region_id);
    const platformId = safeMetadataString(raw.platform_id);
    const pgVersion = safePgVersion(raw.pg_version);
    const createdAt = safeMetadataString(raw.created_at);
    const updatedAt = safeMetadataString(raw.updated_at);
    if (regionId !== undefined) metadata.regionId = regionId;
    if (platformId !== undefined) metadata.platformId = platformId;
    if (pgVersion !== undefined) metadata.pgVersion = pgVersion;
    if (createdAt !== undefined) metadata.createdAt = createdAt;
    if (updatedAt !== undefined) metadata.updatedAt = updatedAt;

    return {
      providerProjectId,
      name: safeOptionalString(raw.name),
      status: safeOptionalString(raw.status, 80),
      observedAt: observationTime,
      checkedAt: observationTime,
      sourceEndpoint: endpoint,
      metadata,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function mapObservationRow(row: Record<string, unknown>): NeonProjectObservation {
  let metadata: NeonProjectMetadata = {};
  try {
    const parsed = JSON.parse(String(row.source_metadata_json)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as NeonProjectMetadata;
  } catch {
    metadata = {};
  }
  return {
    environmentProfileId: String(row.environment_profile_id),
    workspaceId: String(row.workspace_id),
    environmentName: String(row.environment_name),
    configuredProjectId: String(row.configured_resource_id),
    providerProjectId: String(row.resource_id),
    name: row.display_name == null ? null : String(row.display_name),
    status: row.status == null ? null : String(row.status),
    observedAt: String(row.observed_at),
    checkedAt: String(row.checked_at),
    availability: String(row.availability) as NeonAvailability,
    freshness: String(row.freshness) as NeonFreshness,
    sourceEndpoint: String(row.source_endpoint),
    metadata,
    failureKind: row.failure_kind == null ? null : String(row.failure_kind) as NeonFailureKind,
  };
}

function getObservation(store: Store, environmentProfileId: string): NeonProjectObservation | null {
  const row = store.db.prepare(`
    SELECT provider_observations.*, environment_profiles.workspace_id, environment_profiles.environment_name
    FROM provider_observations
    JOIN environment_profiles ON environment_profiles.id = provider_observations.environment_profile_id
    WHERE provider_observations.environment_profile_id = ?
      AND provider_observations.provider = 'neon'
      AND provider_observations.resource_type = 'project'
  `).get(environmentProfileId) as Record<string, unknown> | undefined;
  return row ? mapObservationRow(row) : null;
}

function persistSuccess(store: Store, config: NeonProjectConfig, snapshot: NeonProjectSnapshot): NeonProjectObservation {
  store.db.prepare(`
    INSERT INTO provider_observations (
      environment_profile_id, provider, resource_type, configured_resource_id, resource_id,
      display_name, status, observed_at, checked_at, availability, freshness,
      source_endpoint, source_metadata_json, failure_kind
    ) VALUES (?, 'neon', 'project', ?, ?, ?, ?, ?, ?, 'AVAILABLE', 'CURRENT', ?, ?, NULL)
    ON CONFLICT(environment_profile_id) DO UPDATE SET
      provider = excluded.provider,
      resource_type = excluded.resource_type,
      configured_resource_id = excluded.configured_resource_id,
      resource_id = excluded.resource_id,
      display_name = excluded.display_name,
      status = excluded.status,
      observed_at = excluded.observed_at,
      checked_at = excluded.checked_at,
      availability = excluded.availability,
      freshness = excluded.freshness,
      source_endpoint = excluded.source_endpoint,
      source_metadata_json = excluded.source_metadata_json,
      failure_kind = NULL
  `).run(
    config.environmentProfileId,
    config.projectId,
    snapshot.providerProjectId,
    snapshot.name,
    snapshot.status,
    snapshot.observedAt,
    snapshot.checkedAt,
    snapshot.sourceEndpoint,
    JSON.stringify(snapshot.metadata),
  );
  const result = getObservation(store, config.environmentProfileId);
  if (!result) throw new Error("Neon observation persistence failed.");
  return result;
}

function degradeExisting(
  store: Store,
  environmentProfileId: string,
  at: string,
  error: NeonObservationError,
): NeonProjectObservation | null {
  const previous = getObservation(store, environmentProfileId);
  if (!previous) return null;
  store.db.prepare(`
    UPDATE provider_observations
    SET checked_at = ?, availability = ?, freshness = 'STALE', failure_kind = ?
    WHERE environment_profile_id = ?
  `).run(at, error.availability, error.kind, environmentProfileId);
  return getObservation(store, environmentProfileId);
}

export async function refreshNeonProjectObservation(
  store: Store,
  environmentProfileId: string,
  options: NeonObservationOptions = {},
): Promise<NeonProjectObservation> {
  const at = checkedAt(options);
  let config: NeonProjectConfig;
  try {
    config = resolveNeonProjectConfig(store, environmentProfileId);
  } catch (error) {
    const normalized = error instanceof NeonObservationError
      ? error
      : new NeonObservationError("CONFIGURATION_ERROR", "UNKNOWN", "Neon observation configuration is invalid.");
    const stale = degradeExisting(store, environmentProfileId, at, normalized);
    if (stale) return stale;
    throw normalized;
  }

  try {
    const snapshot = await observeNeonProject(config, { ...options, checkedAt: at });
    return persistSuccess(store, config, snapshot);
  } catch (error) {
    const normalized = error instanceof NeonObservationError
      ? error
      : new NeonObservationError("NETWORK_ERROR", "UNAVAILABLE", "Neon project observation failed.");
    const stale = degradeExisting(store, environmentProfileId, at, normalized);
    if (stale) return stale;
    return {
      environmentProfileId: config.environmentProfileId,
      workspaceId: config.workspaceId,
      environmentName: config.environmentName,
      configuredProjectId: config.projectId,
      providerProjectId: null,
      name: null,
      status: null,
      observedAt: null,
      checkedAt: at,
      availability: normalized.availability,
      freshness: "UNKNOWN",
      sourceEndpoint: projectEndpoint(config.projectId),
      metadata: {},
      failureKind: normalized.kind,
    };
  }
}

export function listNeonProjectObservations(store: Store): NeonProjectObservation[] {
  const rows = store.db.prepare(`
    SELECT provider_observations.*, environment_profiles.workspace_id, environment_profiles.environment_name
    FROM provider_observations
    JOIN environment_profiles ON environment_profiles.id = provider_observations.environment_profile_id
    WHERE provider_observations.provider = 'neon'
      AND provider_observations.resource_type = 'project'
    ORDER BY environment_profiles.workspace_id, environment_profiles.environment_name, provider_observations.environment_profile_id
  `).all() as Record<string, unknown>[];
  return rows.map(mapObservationRow);
}

export function listNeonProjectViews(store: Store): NeonProjectObservation[] {
  const stored = new Map(listNeonProjectObservations(store).map((observation) => [observation.environmentProfileId, observation]));
  const views: NeonProjectObservation[] = [];
  for (const profile of listEnvironmentProfiles(store)) {
    let config: NeonProjectConfig;
    try {
      config = resolveNeonProjectConfig(store, profile.id);
    } catch {
      continue;
    }
    const observation = stored.get(profile.id);
    views.push(observation ?? {
      environmentProfileId: config.environmentProfileId,
      workspaceId: config.workspaceId,
      environmentName: config.environmentName,
      configuredProjectId: config.projectId,
      providerProjectId: null,
      name: null,
      status: null,
      observedAt: null,
      checkedAt: null,
      availability: "UNKNOWN",
      freshness: "UNKNOWN",
      sourceEndpoint: projectEndpoint(config.projectId),
      metadata: {},
      failureKind: null,
    });
  }
  return views;
}
