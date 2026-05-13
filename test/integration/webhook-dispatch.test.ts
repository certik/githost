/**
 * Integration tests for the webhook → sync-job fanout in consumer.ts.
 *
 * Specifically asserts that:
 *   - pull_request events → sync.pr (existing behavior, kept here for safety)
 *   - check_run / check_suite / workflow_run events → sync.pr for any PRs
 *     whose head_sha matches the event's head_sha
 *   - The dispatch handles both shapes:
 *       (a) payload.{check_run,check_suite,workflow_run}.pull_requests[] populated
 *       (b) pull_requests[] empty, we look up by head_sha in the mirror DB
 *
 * Drives the dispatch function directly (no HMAC, no signing, no Hono) so the
 * tests focus on the fan-out logic.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { dispatch } from "../../src/jobs/consumer";
import { resetDbs } from "../helpers/db";
import { mswServer } from "../msw-server";
import { seedPr } from "../helpers/fixtures";

const OWNER = "testorg";
const REPO = "testrepo";
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

beforeEach(resetDbs);

/**
 * Tracker for sync.pr invocations: we mock GitHub /pulls/:n and record
 * which numbers get requested. dispatch's webhook handler enqueues
 * sync.pr → syncPr → calls our mock; this is how we know fan-out worked.
 */
function trackSyncPrCalls(): number[] {
  const calls: number[] = [];
  mswServer.use(
    http.post("https://api.github.com/app/installations/:id/access_tokens", () => {
      return HttpResponse.json({ token: "v1.test", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }),
    http.get(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/:number`, ({ params }) => {
      const n = parseInt(String(params.number), 10);
      calls.push(n);
      // Return a minimal PR payload that syncPr can upsert.
      return HttpResponse.json({
        id: 100 + n, number: n, state: "open", draft: false, merged: false,
        title: `PR ${n}`, body: null,
        user: { id: 1, login: "alice", avatar_url: null, html_url: null, type: "User" },
        head: { ref: "feat", sha: `sha-${n}` },
        base: { ref: "main", sha: "base-sha", repo: { id: 1, owner: { login: OWNER }, name: REPO, default_branch: "main" } },
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
        closed_at: null, merged_at: null, labels: [],
      });
    }),
    http.get(`https://api.github.com/repos/${OWNER}/${REPO}/commits/:sha/check-runs`, () => {
      return HttpResponse.json({ total_count: 0, check_runs: [] });
    }),
  );
  return calls;
}

describe("webhook fan-out: check_run / check_suite / workflow_run", () => {
  it("dispatches sync.pr for each PR listed in check_run.pull_requests", async () => {
    const calls = trackSyncPrCalls();

    await dispatch({
      type: "github.webhook",
      event: "check_run",
      deliveryId: "d1",
      payload: {
        repository: { id: 1 },
        check_run: {
          head_sha: "sha-42",
          pull_requests: [{ number: 42 }, { number: 43 }],
        },
      },
    }, env, ctx);

    // dispatch's fan-out uses ctx.waitUntil; in tests the no-op ctx means we
    // must await the underlying ops synchronously. Our dispatch awaits the
    // handleWebhook function directly, so by the time it returns, the
    // runJob calls have been fired (waitUntil promises started). Give them a
    // tick to land their fetches.
    await new Promise((r) => setTimeout(r, 50));

    expect(calls.sort()).toEqual([42, 43]);
  });

  it("dispatches the same way for check_suite events", async () => {
    const calls = trackSyncPrCalls();
    await dispatch({
      type: "github.webhook",
      event: "check_suite",
      deliveryId: "d2",
      payload: {
        repository: { id: 1 },
        check_suite: { head_sha: "sha-99", pull_requests: [{ number: 99 }] },
      },
    }, env, ctx);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([99]);
  });

  it("dispatches the same way for workflow_run events", async () => {
    const calls = trackSyncPrCalls();
    await dispatch({
      type: "github.webhook",
      event: "workflow_run",
      deliveryId: "d3",
      payload: {
        repository: { id: 1 },
        workflow_run: { head_sha: "sha-77", pull_requests: [{ number: 77 }] },
      },
    }, env, ctx);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([77]);
  });

  it("falls back to head_sha lookup in mirror DB when pull_requests[] is empty", async () => {
    // Seed a PR. Match the mock's id formula (100+number) so the upsert is
    // a true no-op upsert (won't trip the (repo_id, number) unique index).
    await seedPr({ id: 100 + 555, number: 555, headSha: "sha-orphan" });
    const calls = trackSyncPrCalls();

    await dispatch({
      type: "github.webhook",
      event: "check_run",
      deliveryId: "d4",
      payload: {
        repository: { id: 1 },
        check_run: { head_sha: "sha-orphan", pull_requests: [] },
      },
    }, env, ctx);
    await new Promise((r) => setTimeout(r, 50));

    expect(calls).toEqual([555]);
  });

  it("no-ops when head_sha matches nothing in our mirror", async () => {
    const calls = trackSyncPrCalls();
    await dispatch({
      type: "github.webhook",
      event: "check_run",
      deliveryId: "d5",
      payload: {
        repository: { id: 1 },
        check_run: { head_sha: "sha-unknown", pull_requests: [] },
      },
    }, env, ctx);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
  });

  it("ignores events with no repository (cant fan out)", async () => {
    const calls = trackSyncPrCalls();
    await dispatch({
      type: "github.webhook",
      event: "check_run",
      deliveryId: "d6",
      payload: { check_run: { head_sha: "sha-1", pull_requests: [{ number: 1 }] } },
    }, env, ctx);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
  });
});

describe("webhook fan-out: pull_request still works (regression guard)", () => {
  it("dispatches sync.pr for a pull_request event", async () => {
    const calls = trackSyncPrCalls();
    await dispatch({
      type: "github.webhook",
      event: "pull_request",
      deliveryId: "d7",
      payload: { repository: { id: 1 }, pull_request: { number: 7 } },
    }, env, ctx);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([7]);
  });
});
