# githost PR review instructions (shared by all agents)

You are performing a **code review of a single GitHub pull request** for the
githost / LFortran workflow.

Your **only deliverable** is one JSON file on disk. Do not open a PR, do not
post to GitHub, do not call `githost review submit` unless the user prompt
explicitly says to.

## Output contract

Write **exactly one** file at the path given in the task prompt
(`OUT_PATH`). The file must be valid JSON matching **`githost.review/v1`**:

```json
{
  "schema": "githost.review/v1",
  "pr": 0,
  "headSha": "",
  "verdict": "COMMENT",
  "summary": "",
  "comments": [
    {
      "path": "relative/path.ext",
      "line": 1,
      "body": "markdown"
    }
  ],
  "meta": {
    "model": "your-agent-name"
  }
}
```

### Field rules

| Field | Rule |
|---|---|
| `schema` | Always `"githost.review/v1"` |
| `pr` | Integer PR number from the task |
| `headSha` | Exact head commit SHA from the task (do not invent) |
| `verdict` | One of `COMMENT`, `APPROVE`, `REQUEST_CHANGES` |
| `summary` | Markdown overall assessment (required, can be short) |
| `comments` | Array (may be empty). Each item needs `path`, `line` (≥1), `body` |
| `comments[].startLine` | Optional; multi-line range end is `line` |
| `comments[].side` | Optional; default `RIGHT` (the PR / new-file side) |
| `meta.model` | Free-form id for you (e.g. `claude`, `grok`, `copilot`, `codex`, `pi`) |

### Quality bar

- Prefer a few high-signal comments over noisy nits.
- Inline `path`/`line` must refer to the **new file side** of the PR diff.
- If you are unsure, use `verdict: "COMMENT"` and say so in `summary`.
- Do **not** wrap the JSON in markdown fences in the file.
- Do **not** write any other review artifact.

## How to gather context

Use the repo tools available to you. Typical sequence:

1. `gh pr view <N> --json title,author,baseRefName,headRefName,headRefOid,body,url`
2. `gh pr diff <N>`
3. Optionally `gh pr checkout <N>` or read specific files at the PR head. Do this
   only in the working directory the task placed you in (a dedicated source
   checkout) — that is where you may freely switch branches.
4. Write `OUT_PATH` (an absolute path) with the JSON document.

If `gh` is unavailable, use whatever git / filesystem context the task provides.

## After writing the file

Stop. The human (or `githost-review --submit`) uploads with:

```bash
githost review submit <N> --file <OUT_PATH>
```
