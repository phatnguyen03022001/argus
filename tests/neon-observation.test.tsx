import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test } from "vitest";
import type { CredentialSecretAdapter } from "../src/keychain";

const roots: string[] = [];
const originalHome = process.env.HOME;
const originalProjectId = process.env.NEON_PROJECT_ID;
const runtimeApiKey = `neon-runtime-${randomBytes(32).toString("hex")}`;
const projectId = "quiet-field-123456";

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function fakeCredentialAdapter(secret = runtimeApiKey): CredentialSecretAdapter {
  return {
    consume(_reference, consumer) {
      consumer(Buffer.from(secret));
      return "AVAILABLE";
    },
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function createConfiguredProfile(dataRoot: string, workspaceRoot: string) {
  const api = await import("../src/workspace-store");
  const store = api.openStore({ dataRoot });
  const workspace = api.createWorkspace(store, { label: "Neon workspace", root: workspaceRoot });
  const credential = api.createCredentialReference(store, {
    externalSystem: "Neon",
    keychainService: `argus.neon.${randomUUID()}`,
    keychainAccount: "primary",
  });
  const profile = api.createEnvironmentProfile(store, {
    workspaceId: workspace.id,
    environmentName: "production",
    label: "Production",
    settings: [{ key: "NEON_PROJECT_ID", value: projectId }],
    credentialBindings: [{ key: "NEON_API_KEY", credentialReferenceId: credential.id }],
  });
  store.close();
  return { api, workspace, credential, profile };
}

afterEach(async () => {
  process.env.HOME = originalHome;
  if (originalProjectId === undefined) delete process.env.NEON_PROJECT_ID;
  else process.env.NEON_PROJECT_ID = originalProjectId;
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Neon project observation", () => {
  test("resolves only explicit active EnvironmentProfile configuration and never process or branch inference", async () => {
    const dataRoot = await tempDir("argus-neon-config-");
    const workspaceRoot = await tempDir("argus-neon-workspace-");
    const { api, profile, credential } = await createConfiguredProfile(dataRoot, workspaceRoot);
    const neon = await import("../src/neon");
    const store = api.openStore({ dataRoot });

    expect(neon.resolveNeonProjectConfig(store, profile.id)).toMatchObject({
      environmentProfileId: profile.id,
      workspaceId: profile.workspaceId,
      environmentName: "production",
      projectId,
      credential: { id: credential.id },
    });

    process.env.NEON_PROJECT_ID = "process-env-must-not-win";
    const missing = api.createEnvironmentProfile(store, {
      workspaceId: profile.workspaceId,
      environmentName: "missing",
      settings: [],
      credentialBindings: [{ key: "NEON_API_KEY", credentialReferenceId: credential.id }],
    });
    expect(() => neon.resolveNeonProjectConfig(store, missing.id)).toThrow(/NEON_PROJECT_ID/);

    const malformed = api.createEnvironmentProfile(store, {
      workspaceId: profile.workspaceId,
      environmentName: "malformed",
      settings: [{ key: "NEON_PROJECT_ID", value: "INVALID PROJECT" }],
      credentialBindings: [{ key: "NEON_API_KEY", credentialReferenceId: credential.id }],
    });
    expect(() => neon.resolveNeonProjectConfig(store, malformed.id)).toThrow(/NEON_PROJECT_ID/);

    const missingBinding = api.createEnvironmentProfile(store, {
      workspaceId: profile.workspaceId,
      environmentName: "missing-binding",
      settings: [{ key: "NEON_PROJECT_ID", value: projectId }],
      credentialBindings: [],
    });
    expect(() => neon.resolveNeonProjectConfig(store, missingBinding.id)).toThrow(/NEON_API_KEY/);

    api.archiveEnvironmentProfile(store, profile.id, profile.version);
    expect(() => neon.resolveNeonProjectConfig(store, profile.id)).toThrow(/active environment profile/i);
    store.close();
  });

  test("uses one bounded GET with Bearer auth and normalizes only safe project metadata", async () => {
    const dataRoot = await tempDir("argus-neon-adapter-");
    const workspaceRoot = await tempDir("argus-neon-adapter-workspace-");
    const { api, profile } = await createConfiguredProfile(dataRoot, workspaceRoot);
    const neon = await import("../src/neon");
    const store = api.openStore({ dataRoot });
    const config = neon.resolveNeonProjectConfig(store, profile.id);
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedRedirect = "";
    let authorizationDigest = "";
    const expectedAuthorizationDigest = createHash("sha256").update(`Bearer ${runtimeApiKey}`).digest("hex");

    const snapshot = await neon.observeNeonProject(config, {
      credentialAdapter: fakeCredentialAdapter(),
      checkedAt: "2026-09-04T13:00:00.000Z",
      fetchImpl: async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedMethod = String(init.method);
        capturedRedirect = String(init.redirect);
        const headers = new Headers(init.headers);
        authorizationDigest = createHash("sha256").update(headers.get("authorization") ?? "").digest("hex");
        return jsonResponse({
          project: {
            id: projectId,
            name: "Argus Neon",
            status: "ready",
            region_id: "aws-ap-southeast-1",
            platform_id: "aws",
            pg_version: 17,
            created_at: "2026-09-01T00:00:00Z",
            updated_at: "2026-09-04T12:59:00Z",
            connection_uri: `postgres://user:${runtimeApiKey}@example.invalid/db`,
            password: runtimeApiKey,
          },
        });
      },
    });

    expect(capturedUrl).toBe(`https://console.neon.tech/api/v2/projects/${projectId}`);
    expect(capturedMethod).toBe("GET");
    expect(capturedRedirect).toBe("error");
    expect(authorizationDigest).toBe(expectedAuthorizationDigest);
    expect(snapshot).toEqual({
      providerProjectId: projectId,
      name: "Argus Neon",
      status: "ready",
      observedAt: "2026-09-04T13:00:00.000Z",
      checkedAt: "2026-09-04T13:00:00.000Z",
      sourceEndpoint: `https://console.neon.tech/api/v2/projects/${projectId}`,
      metadata: {
        regionId: "aws-ap-southeast-1",
        platformId: "aws",
        pgVersion: 17,
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-04T12:59:00Z",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(runtimeApiKey);
    expect(JSON.stringify(snapshot)).not.toContain("connection_uri");
    expect(JSON.stringify(snapshot)).not.toContain("password");
    store.close();
  });

  test("normalizes provider failures without leaking transport bodies or overwriting a known-good observation", async () => {
    const dataRoot = await tempDir("argus-neon-stale-");
    const workspaceRoot = await tempDir("argus-neon-stale-workspace-");
    const { api, profile } = await createConfiguredProfile(dataRoot, workspaceRoot);
    const neon = await import("../src/neon");
    const store = api.openStore({ dataRoot });
    const successFetch = async () => jsonResponse({ project: { id: projectId, name: "Known good", status: "ready", region_id: "aws-us-east-2" } });
    const current = await neon.refreshNeonProjectObservation(store, profile.id, {
      credentialAdapter: fakeCredentialAdapter(),
      checkedAt: "2026-09-04T13:01:00.000Z",
      fetchImpl: successFetch,
    });
    expect(current.availability).toBe("AVAILABLE");
    expect(current.freshness).toBe("CURRENT");

    const statusCases = [401, 403, 404, 429, 500, 503];
    for (const status of statusCases) {
      const stale = await neon.refreshNeonProjectObservation(store, profile.id, {
        credentialAdapter: fakeCredentialAdapter(),
        checkedAt: `2026-09-04T13:${String(status % 60).padStart(2, "0")}:00.000Z`,
        fetchImpl: async () => new Response(`transport-body-${runtimeApiKey}`, { status, headers: { "content-type": "text/plain" } }),
      });
      expect(stale).toMatchObject({
        providerProjectId: projectId,
        name: "Known good",
        availability: "UNAVAILABLE",
        freshness: "STALE",
      });
      expect(JSON.stringify(stale)).not.toContain(runtimeApiKey);
    }

    const shapeFailures: Array<{ name: string; fetchImpl: (url: string, init: RequestInit) => Promise<Response>; kind: string }> = [
      { name: "non-json", kind: "NON_JSON", fetchImpl: async () => new Response("nope", { status: 200, headers: { "content-type": "text/plain" } }) },
      { name: "malformed-json", kind: "MALFORMED_JSON", fetchImpl: async () => new Response("{", { status: 200, headers: { "content-type": "application/json" } }) },
      { name: "unexpected-schema", kind: "UNEXPECTED_SCHEMA", fetchImpl: async () => jsonResponse({ nope: true }) },
      { name: "identity-mismatch", kind: "IDENTITY_MISMATCH", fetchImpl: async () => jsonResponse({ project: { id: "other-project-123" } }) },
      { name: "oversized", kind: "OVERSIZED_RESPONSE", fetchImpl: async () => jsonResponse({ project: { id: projectId, name: "x".repeat(4096) } }) },
    ];
    for (const item of shapeFailures) {
      const stale = await neon.refreshNeonProjectObservation(store, profile.id, {
        credentialAdapter: fakeCredentialAdapter(),
        checkedAt: "2026-09-04T14:00:00.000Z",
        maxResponseBytes: item.name === "oversized" ? 512 : undefined,
        fetchImpl: item.fetchImpl,
      });
      expect(stale.failureKind).toBe(item.kind);
      expect(stale.providerProjectId).toBe(projectId);
      expect(stale.name).toBe("Known good");
      expect(stale.freshness).toBe("STALE");
    }

    const network = await neon.refreshNeonProjectObservation(store, profile.id, {
      credentialAdapter: fakeCredentialAdapter(),
      checkedAt: "2026-09-04T14:01:00.000Z",
      fetchImpl: async () => { throw new Error(`network ${runtimeApiKey}`); },
    });
    expect(network.failureKind).toBe("NETWORK_ERROR");
    expect(JSON.stringify(network)).not.toContain(runtimeApiKey);

    const timeout = await neon.refreshNeonProjectObservation(store, profile.id, {
      credentialAdapter: fakeCredentialAdapter(),
      checkedAt: "2026-09-04T14:02:00.000Z",
      timeoutMs: 5,
      fetchImpl: async (_url: string, init: RequestInit) => await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    });
    expect(timeout.failureKind).toBe("TIMEOUT");

    const unavailableCredential: CredentialSecretAdapter = { consume() { return "UNAVAILABLE"; } };
    const credentialFailure = await neon.refreshNeonProjectObservation(store, profile.id, {
      credentialAdapter: unavailableCredential,
      checkedAt: "2026-09-04T14:03:00.000Z",
      fetchImpl: async () => { throw new Error("must not be called"); },
    });
    expect(credentialFailure.failureKind).toBe("CREDENTIAL_UNAVAILABLE");
    expect(credentialFailure.name).toBe("Known good");
    expect(credentialFailure.freshness).toBe("STALE");

    const rows = store.db.prepare("SELECT * FROM provider_observations").all();
    expect(JSON.stringify(rows)).not.toContain(runtimeApiKey);
    expect(JSON.stringify(rows)).not.toContain("transport-body");
    store.close();
  });

  test("persists and recovers normalized observation while UI exposes explicit refresh only", async () => {
    const dataRoot = await tempDir("argus-neon-ui-");
    const restoredRoot = await tempDir("argus-neon-restore-");
    const workspaceRoot = await tempDir("argus-neon-ui-workspace-");
    process.env.HOME = dataRoot;
    const { api, profile } = await createConfiguredProfile(dataRoot, workspaceRoot);
    const neon = await import("../src/neon");
    const store = api.openStore({ dataRoot });
    const refreshed = await neon.refreshNeonProjectObservation(store, profile.id, {
      credentialAdapter: fakeCredentialAdapter(),
      checkedAt: "2026-09-04T15:00:00.000Z",
      fetchImpl: async () => jsonResponse({ project: { id: projectId, name: "UI project", status: "ready", pg_version: 17 } }),
    });
    expect(refreshed).toMatchObject({ availability: "AVAILABLE", freshness: "CURRENT", name: "UI project" });
    const exported = api.exportState(store);
    expect(exported).not.toContain(runtimeApiKey);
    store.close();

    const restored = api.openStore({ dataRoot: restoredRoot });
    api.restoreState(restored, exported);
    expect(neon.listNeonProjectObservations(restored)).toEqual([
      expect.objectContaining({
        environmentProfileId: profile.id,
        providerProjectId: projectId,
        name: "UI project",
        availability: "AVAILABLE",
        freshness: "CURRENT",
      }),
    ]);
    restored.close();

    const app = await import("../src/workspace-app");
    const ui = await import("../src/workspace-home");
    const home = app.loadWorkspaceHome({ dataRoot, credentialAdapter: fakeCredentialAdapter() });
    const markup = renderToStaticMarkup(ui.WorkspaceHome(home));
    expect(markup).toContain("Neon project observation");
    expect(markup).toContain("Neon workspace");
    expect(markup).toContain("production");
    expect(markup).toContain(projectId);
    expect(markup).toContain("UI project");
    expect(markup).toContain("AVAILABLE");
    expect(markup).toContain("CURRENT");
    expect(markup).toContain("Refresh Neon project");
    expect(markup).not.toContain(runtimeApiKey);
    expect(markup).not.toMatch(/create neon|update neon|delete neon|start neon|stop neon|provider manager|connection string/i);
  });

  test("keeps a runtime-random API key out of durable and observable surfaces", async () => {
    const dataRoot = await tempDir("argus-neon-secret-");
    const workspaceRoot = await tempDir("argus-neon-secret-workspace-");
    const { api, profile } = await createConfiguredProfile(dataRoot, workspaceRoot);
    const neon = await import("../src/neon");
    const store = api.openStore({ dataRoot });
    await neon.refreshNeonProjectObservation(store, profile.id, {
      credentialAdapter: fakeCredentialAdapter(),
      checkedAt: "2026-09-04T16:00:00.000Z",
      fetchImpl: async () => jsonResponse({ project: { id: projectId, name: "Secret proof" } }),
    });
    expect(JSON.stringify(store.db.prepare("SELECT * FROM provider_observations").all())).not.toContain(runtimeApiKey);
    expect(JSON.stringify(neon.listNeonProjectObservations(store))).not.toContain(runtimeApiKey);
    expect(JSON.stringify(api.listAuditEntries(store))).not.toContain(runtimeApiKey);
    expect(api.exportState(store)).not.toContain(runtimeApiKey);
    expect((await readFile(store.dbPath)).includes(Buffer.from(runtimeApiKey))).toBe(false);
    store.close();

    const app = await import("../src/workspace-app");
    const ui = await import("../src/workspace-home");
    expect(renderToStaticMarkup(ui.WorkspaceHome(app.loadWorkspaceHome({ dataRoot, credentialAdapter: fakeCredentialAdapter() })))).not.toContain(runtimeApiKey);

    const diff = await new Promise<string>((resolve, reject) => {
      import("node:child_process").then(({ spawnSync }) => {
        const result = spawnSync("git", ["diff", "--no-ext-diff", "HEAD", "--"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
        if (result.status !== 0) reject(new Error("git diff failed"));
        else resolve(result.stdout);
      });
    });
    expect(diff).not.toContain(runtimeApiKey);
    const reportPath = path.resolve(__dirname, "..", ".agent", "tasks", "TASK-0008", "report.yaml");
    if (existsSync(reportPath)) expect(await readFile(reportPath, "utf8")).not.toContain(runtimeApiKey);
  });
});
