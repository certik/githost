# Agent-agnostic PR reviews (`githost.review/v1`)

Any agent (Grok, Claude, Copilot, Codex, Pi, a human, …) can produce a review.
**githost never calls an agent API itself.** The contract is a file on disk.

## One command (recommended)

```bash
# Uses the first agent found on PATH (claude, grok, copilot, codex, pi)
./cli/bin/githost-review 12028

# Pick an agent + upload when done
./cli/bin/githost-review 12028 --agent claude --submit
GITHOST_AGENT=pi ./cli/bin/githost-review 12028 --submit
```

Shared instructions live in **`cli/agents/REVIEW_INSTRUCTIONS.md`** — the same
text is passed to every agent (system prompt or embedded in the user prompt).
You do **not** maintain five different instruction files.

Manual path (if you prefer not to use the launcher):

1. Fetch context (`githost pr view N`, `gh pr diff N --repo …`, …).
2. Write a **`githost.review/v1` JSON** document.
3. Upload: `githost review submit N --file review.v1.json`
4. Open the PR in the web UI — it appears under **local reviews**.

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

## Per-agent notes (launcher already knows these)

| Agent | CLI | How instructions are passed |
|---|---|---|
| Claude Code | `claude -p` | `--append-system-prompt` + task |
| Grok | `grok --print` | `--system-prompt-override` + task |
| Copilot CLI | `copilot -p` | instructions embedded in prompt |
| Codex | `codex exec --full-auto` | combined prompt on stdin |
| Pi | `pi -p` | `--append-system-prompt <file>` + task |

```bash
./cli/bin/githost-review 12028 --agent auto          # first on PATH
./cli/bin/githost-review 12028 --agent grok
./cli/bin/githost-review 12028 --print-prompt        # inspect shared prompt
./cli/bin/githost-review 12028 --dry-run             # which binary would run
```

Default auto order: `GITHOST_AGENT_ORDER` or  
`claude,grok,copilot,codex,pi`.

Upstream repo for `gh` defaults to `UPSTREAM_OWNER`/`UPSTREAM_REPO` in
`wrangler.toml` (lfortran/lfortran), override with `--repo` or `GITHOST_REPO`.

## Why not Markdown-only?

Markdown is fine as an **authoring** format later. Canonical storage and
upload are JSON so validation, multi-line comments, and GitHub publish stay
unambiguous. Agents are reliable at emitting this small schema.
