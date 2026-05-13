import type { Env } from "../lib/env";
import { eq } from "drizzle-orm";
import { appDb } from "../db/app";
import * as A from "../db/app/schema";
import { mirrorDb } from "../db/mirror";
import * as M from "../db/mirror/schema";

/**
 * AI review job (stub). In production this would:
 *   1. Look up the PR + its current diff (cached in R2, or fetched fresh).
 *   2. Call your LLM of choice (Workers AI / Anthropic / OpenAI / local).
 *   3. Parse the response into per-file comments + an overall summary.
 *   4. Update the ai_review row with status='ready'.
 *
 * The result is NOT posted to GitHub here. A user explicitly opts in via
 * POST /api/prs/:n/post-review.
 */
export async function runAiReview(env: Env, aiReviewId: string): Promise<void> {
  const adb = appDb(env.APP_DB);
  const review = await adb.select().from(A.aiReview).where(eq(A.aiReview.id, aiReviewId)).get();
  if (!review || review.deletedAt) return;
  if (review.status !== "pending") return;

  const mdb = mirrorDb(env.MIRROR_DB);
  const pr = await mdb.select().from(M.pr).where(eq(M.pr.id, review.prId)).get();
  if (!pr) {
    await adb.update(A.aiReview).set({ status: "failed", errorMessage: "pr not found", updatedAt: new Date() }).where(eq(A.aiReview.id, aiReviewId)).run();
    return;
  }

  try {
    // TODO: fetch diff (reuse R2 cache logic), call LLM. Stubbed output:
    const summary = `Stub AI review of #${pr.number} at ${review.headSha.slice(0, 7)}.`;
    const comments: Array<{ path: string; line: number; body: string }> = [];

    await adb.update(A.aiReview).set({
      status: "ready",
      summary,
      commentsJson: JSON.stringify(comments),
      updatedAt: new Date(),
    }).where(eq(A.aiReview.id, aiReviewId)).run();
  } catch (err: any) {
    await adb.update(A.aiReview).set({
      status: "failed",
      errorMessage: String(err?.message ?? err),
      updatedAt: new Date(),
    }).where(eq(A.aiReview.id, aiReviewId)).run();
    throw err;
  }
}
