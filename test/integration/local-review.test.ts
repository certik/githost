/**
 * Local review upload (CLI / agent → app.ai_review).
 *
 * Contract:
 *   - POST /api/prs/:n/reviews requires a session
 *   - Accepts githost.review/v1 JSON
 *   - Stores status=ready so the SPA lists it without the AI job pipeline
 *   - GET /api/prs/:n includes the new review
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
  const ctx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return worker.fetch(req, env, ctx);
}

describe("POST /api/prs/:number/reviews", () => {
  it("returns 401 without a session", async () => {
    await seedPr({ id: 1, number: 42, headSha: "a".repeat(40) });
    const res = await fetchSelf("https://example.com/api/prs/42/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: "githost.review/v1",
        headSha: "a".repeat(40),
        summary: "hi",
        comments: [],
      }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the PR is not mirrored", async () => {
    const { cookie } = await createSession({ login: "alice" });
    const res = await fetchSelf("https://example.com/api/prs/99999/reviews", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        schema: "githost.review/v1",
        headSha: "b".repeat(40),
        summary: "missing pr",
        comments: [],
      }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects missing headSha", async () => {
    await seedPr({ id: 2, number: 7 });
    const { cookie } = await createSession({ login: "bob" });
    const res = await fetchSelf("https://example.com/api/prs/7/reviews", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        schema: "githost.review/v1",
        summary: "no sha",
        comments: [],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toMatch(/headSha/i);
  });

  it("stores a ready review and returns it on GET /api/prs/:n", async () => {
    const sha = "c".repeat(40);
    await seedPr({ id: 3, number: 1001, headSha: sha, title: "seeded pr" });
    const { cookie } = await createSession({ login: "carol" });

    const doc = {
      schema: "githost.review/v1",
      pr: 1001,
      headSha: sha,
      verdict: "REQUEST_CHANGES",
      summary: "Looks good overall, one issue.",
      comments: [
        {
          path: "src/foo.f90",
          line: 42,
          body: "Possible null deref here.",
        },
        {
          path: "tests/bar.f90",
          startLine: 10,
          line: 18,
          side: "RIGHT",
          body: "Add a regression test.",
        },
      ],
      meta: { model: "test-agent/v1" },
    };

    const post = await fetchSelf("https://example.com/api/prs/1001/reviews", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(doc),
    });
    expect(post.status).toBe(201);
    const created = await post.json<{
      id: string;
      status: string;
      verdict: string;
      model: string;
      comments: unknown[];
    }>();
    expect(created.status).toBe("ready");
    expect(created.verdict).toBe("REQUEST_CHANGES");
    expect(created.model).toBe("test-agent/v1");
    expect(created.comments).toHaveLength(2);
    expect(created.id.length).toBeGreaterThan(8);

    const get = await fetchSelf("https://example.com/api/prs/1001", {
      headers: { cookie },
    });
    expect(get.status).toBe(200);
    const detail = await get.json<{
      reviews: Array<{
        id: string;
        status: string;
        summary: string | null;
        commentsJson: string | null;
        headSha: string;
        model: string;
      }>;
    }>();
    const match = detail.reviews.find((r) => r.id === created.id);
    expect(match).toBeTruthy();
    expect(match!.status).toBe("ready");
    expect(match!.summary).toBe(doc.summary);
    expect(match!.headSha).toBe(sha);
    expect(match!.model).toBe("test-agent/v1");
    expect((match as { verdict?: string }).verdict).toBe("REQUEST_CHANGES");
    const parsed = JSON.parse(match!.commentsJson ?? "[]") as Array<{ path: string; line: number }>;
    expect(parsed[0]?.path).toBe("src/foo.f90");
    expect(parsed[0]?.line).toBe(42);

    // List endpoint exposes latest local review for the compact "Rev" column.
    const list = await fetchSelf("https://example.com/api/prs?state=open");
    expect(list.status).toBe(200);
    const listBody = await list.json<{
      items: Array<{
        number: number;
        localReview: { verdict: string; status: string } | null;
      }>;
    }>();
    const row = listBody.items.find((p) => p.number === 1001);
    expect(row?.localReview).toEqual({
      verdict: "REQUEST_CHANGES",
      status: "ready",
    });
  });

  it("list localReview is null when PR has no review", async () => {
    await seedPr({ id: 10, number: 2002, title: "no review yet" });
    const res = await fetchSelf("https://example.com/api/prs");
    const body = await res.json<{
      items: Array<{ number: number; localReview: unknown }>;
    }>();
    const row = body.items.find((p) => p.number === 2002);
    expect(row).toBeTruthy();
    expect(row!.localReview).toBeNull();
  });

  it("rejects body.pr mismatch", async () => {
    await seedPr({ id: 4, number: 55, headSha: "d".repeat(40) });
    const { cookie } = await createSession({ login: "dave" });
    const res = await fetchSelf("https://example.com/api/prs/55/reviews", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        schema: "githost.review/v1",
        pr: 99,
        headSha: "d".repeat(40),
        summary: "wrong",
      }),
    });
    expect(res.status).toBe(400);
  });
});
