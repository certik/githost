/**
 * Integration tests for PUT /api/prs/:n/tests/:kind and the test-run join in
 * GET /api/prs.
 *
 * Also asserts the PR state badge contract — the API surfaces (state, draft,
 * merged) for every PR so the SPA can render the correct label
 * (Draft / Ready for review / Merged / Closed). The frontend's pure rendering
 * logic is straightforward; we test the API contract here so any future
 * regression in field selection is caught.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/worker";
import { resetDbs } from "../helpers/db";
import { createSession } from "../helpers/session";
import { seedPr } from "../helpers/fixtures";

beforeEach(resetDbs);

async function fetchSelf(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  return worker.fetch(req, env, ctx);
}

async function putStatus(cookie: string, number: number, kind: string, body: unknown): Promise<Response> {
  return fetchSelf(`https://example.com/api/prs/${number}/tests/${kind}`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface ApiPr {
  id: number;
  number: number;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  htmlUrl: string;
  quickTest: { status: string; logUrl: string | null; headSha: string | null } | null;
  exhaustiveTest: { status: string } | null;
}

async function getPrs(cookie: string): Promise<ApiPr[]> {
  const res = await fetchSelf("https://example.com/api/prs", { headers: { cookie } });
  const body = await res.json<{ items: ApiPr[] }>();
  return body.items;
}

describe("PUT /api/prs/:n/tests/:kind", () => {
  it("requires a session", async () => {
    const res = await fetchSelf("https://example.com/api/prs/1/tests/quick", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "passed" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects unknown kind", async () => {
    const { cookie } = await createSession();
    await seedPr({ id: 100, number: 1 });
    const res = await putStatus(cookie, 1, "smoke", { status: "passed" });
    expect(res.status).toBe(400);
  });

  it("rejects invalid status", async () => {
    const { cookie } = await createSession();
    await seedPr({ id: 100, number: 1 });
    const res = await putStatus(cookie, 1, "quick", { status: "yeet" });
    expect(res.status).toBe(400);
  });

  it("404s when the PR is unknown", async () => {
    const { cookie } = await createSession();
    const res = await putStatus(cookie, 9999, "quick", { status: "passed" });
    expect(res.status).toBe(404);
  });

  it("upserts on repeat calls (same key, new status)", async () => {
    const { cookie } = await createSession();
    await seedPr({ id: 100, number: 1, title: "first" });

    const r1 = await putStatus(cookie, 1, "quick", { status: "queued", headSha: "abc" });
    expect(r1.status).toBe(200);

    const r2 = await putStatus(cookie, 1, "quick", { status: "passed", headSha: "abc", logUrl: "https://ex" });
    expect(r2.status).toBe(200);

    const items = await getPrs(cookie);
    const pr = items.find((p) => p.number === 1);
    expect(pr?.quickTest).toMatchObject({ status: "passed", logUrl: "https://ex", headSha: "abc" });
  });

  it("supports both kinds independently", async () => {
    const { cookie } = await createSession();
    await seedPr({ id: 100, number: 1 });
    await putStatus(cookie, 1, "quick", { status: "passed" });
    await putStatus(cookie, 1, "exhaustive", { status: "failed" });

    const items = await getPrs(cookie);
    const pr = items.find((p) => p.number === 1);
    expect(pr?.quickTest?.status).toBe("passed");
    expect(pr?.exhaustiveTest?.status).toBe("failed");
  });

  it("accepts each of the four valid statuses", async () => {
    const { cookie } = await createSession();
    await seedPr({ id: 100, number: 1 });
    for (const status of ["queued", "running", "passed", "failed"] as const) {
      const res = await putStatus(cookie, 1, "quick", { status });
      expect(res.status).toBe(200);
      const items = await getPrs(cookie);
      expect(items.find((p) => p.number === 1)?.quickTest?.status).toBe(status);
    }
  });
});

describe("GET /api/prs test-run join", () => {
  it("returns nulls when no test rows exist", async () => {
    const { cookie } = await createSession();
    await seedPr({ id: 100, number: 1, title: "untested" });
    const items = await getPrs(cookie);
    const pr = items.find((p) => p.number === 1);
    expect(pr?.quickTest).toBeNull();
    expect(pr?.exhaustiveTest).toBeNull();
  });

  it("doesn't leak runs from other PRs", async () => {
    const { cookie } = await createSession();
    await seedPr({ id: 100, number: 1 });
    await seedPr({ id: 101, number: 2 });
    await putStatus(cookie, 1, "quick", { status: "passed" });
    const items = await getPrs(cookie);
    expect(items.find((p) => p.number === 1)?.quickTest?.status).toBe("passed");
    expect(items.find((p) => p.number === 2)?.quickTest).toBeNull();
  });
});

describe("GET /api/prs state fields (Draft / Ready / Merged / Closed contract)", () => {
  it("returns draft=true for a draft PR", async () => {
    const { cookie } = await createSession();
    await seedPr({ id: 100, number: 1, draft: true });
    const items = await getPrs(cookie);
    const pr = items.find((p) => p.number === 1);
    expect(pr?.state).toBe("open");
    expect(pr?.draft).toBe(true);
    expect(pr?.merged).toBe(false);
  });
  it("returns draft=false, state=open for a 'ready for review' PR", async () => {
    const { cookie } = await createSession();
    await seedPr({ id: 100, number: 1, draft: false, state: "open" });
    const items = await getPrs(cookie);
    const pr = items.find((p) => p.number === 1);
    expect(pr?.state).toBe("open");
    expect(pr?.draft).toBe(false);
    expect(pr?.merged).toBe(false);
  });

  it("returns merged=true for a merged PR", async () => {
    const { cookie } = await createSession();
    await seedPr({ id: 100, number: 1, state: "closed", merged: true });
    const items = await getPrs(cookie);
    const pr = items.find((p) => p.number === 1);
    expect(pr?.state).toBe("closed");
    expect(pr?.merged).toBe(true);
  });

  it("returns state=closed, merged=false for a closed-not-merged PR", async () => {
    const { cookie } = await createSession();
    await seedPr({ id: 100, number: 1, state: "closed", merged: false });
    const items = await getPrs(cookie);
    const pr = items.find((p) => p.number === 1);
    expect(pr?.state).toBe("closed");
    expect(pr?.merged).toBe(false);
  });
});

describe("GET /api/prs htmlUrl field (link to upstream GitHub PR)", () => {
  it("constructs htmlUrl from UPSTREAM_OWNER/REPO + PR number", async () => {
    // Test config: UPSTREAM_OWNER=testorg, UPSTREAM_REPO=testrepo
    const { cookie } = await createSession();
    await seedPr({ id: 100, number: 11488 });
    const items = await getPrs(cookie);
    const pr = items.find((p) => p.number === 11488);
    expect(pr?.htmlUrl).toBe("https://github.com/testorg/testrepo/pull/11488");
  });
});
