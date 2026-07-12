# Agent-agnostic PR reviews (`githost.review/v1`)

Any agent (Grok, Claude, Copilot, Codex, a human, …) can produce a review.
**githost never calls an agent.** The contract is a file on disk:

1. Fetch context however you like (`githost pr view N`, `gh pr diff N`, …).
2. Write a **`githost.review/v1` JSON** document.
3. Upload: `githost review submit N --file review.v1.json`
4. Open the PR in the web UI — it appears under **local reviews**.

No SDKs, no vendor lock-in. If a tool can write a JSON file, it can review.

## Schema

```json
{
  "schema": "githost.review/v1",
  "pr": 12028,
  "headSha": "<PR head commit sha>",
  "verdict": "COMMENT",
  "summary": "Main review body (markdown).",
  "comments": [
    {
      "path": "src/foo.f90",
      "line": 42,
      "body": "Inline note (markdown)."
    },
    {
      "path": "src/foo.f90",
      "startLine": 10,
      "line": 18,
      "side": "RIGHT",
      "body": "Multi-line comment."
    }
  ],
  "meta": {
    "model": "name-of-agent-or-human"
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `schema` | recommended | Must be `githost.review/v1` if present |
| `pr` | optional | If set, must match the PR number in the CLI URL |
| `headSha` | **yes** | Commit the review applies to |
| `verdict` | optional | `COMMENT` (default), `APPROVE`, `REQUEST_CHANGES` |
| `summary` | optional | Top-level review body |
| `comments[]` | optional | Inline notes: `path`, `line`, `body`; optional `startLine`, `side` |
| `meta.model` | optional | Free-form agent id for audit/display |

This maps onto githost’s `ai_review` row (`summary` + `commentsJson`) and is
compatible with GitHub’s “create review” shape for a future publish step.

Print the same blurb anytime:

```bash
githost review schema
```

## CLI commands

```bash
# Template under ~/.githost/reviews/<n>.v1.json
githost review init 12028

# Upload (requires session — see Auth)
githost review submit 12028 --file ~/.githost/reviews/12028.v1.json
# or --url for a local worker:
githost --url http://127.0.0.1:8787 review submit 1001 --file review.v1.json

# List reviews stored for a PR (authenticated)
githost review list 12028
```

## Auth

Upload and list need a session cookie (`gh_session`), same as the web app.

| Method | How |
|---|---|
| Env | `export GITHOST_SESSION='<session-id-or-Cookie-value>'` |
| File | `echo '<session-id>' > ~/.githost/session` |

**Local dev:** open `http://127.0.0.1:8787/auth/dev-login` (with
`DEV_LOGIN_ENABLED=true`), copy the `gh_session` cookie value into
`GITHOST_SESSION` or `~/.githost/session`.

## Suggested agent prompt (copy-paste)

```text
You are reviewing GitHub PR #<N> for repository <owner/repo>.

Produce a single JSON file only, no prose outside JSON, matching:

{
  "schema": "githost.review/v1",
  "pr": <N>,
  "headSha": "<HEAD_SHA>",
  "verdict": "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  "summary": "<markdown overall review>",
  "comments": [
    { "path": "<repo-relative path>", "line": <number>, "body": "<markdown>" }
  ],
  "meta": { "model": "<your-name>" }
}

Rules:
- headSha must be the PR head commit you reviewed.
- Inline comments must use paths and line numbers from the PR diff (new file side).
- Prefer fewer high-value comments over noise.
- Write the file to review.v1.json
```

Then the human (or a script) runs:

```bash
githost review submit <N> --file review.v1.json
```

## Why not Markdown-only?

Markdown is fine as an **authoring** format later. Canonical storage and
upload are JSON so validation, multi-line comments, and GitHub publish stay
unambiguous. Agents are reliable at emitting this small schema.
