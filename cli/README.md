# githost CLI

Pure-C command-line client for the githost PR dashboard. It talks to the same
public `GET /api/prs` JSON API that the web UI uses (no authentication yet),
groups open PRs by review priority, and prints an 80-column color table.

Memory comes from vendored [corec](https://github.com/certik/corec) arenas;
HTTPS uses system libcurl.

## Build

```bash
cd cli
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
./build/githost --help
```

Requirements: CMake ≥ 3.16, a C99 compiler, libcurl.

## Usage

```bash
# Against production (default base URL)
./build/githost
./build/githost pr list --passed
./build/githost pr list --group conflict
./build/githost pr view 12028
./build/githost --no-color pr list --passed

# Against a local githost worker (npm run dev → :8787)
./build/githost --url http://127.0.0.1:8787 pr list

# Against any base URL that serves GET /api/prs
./build/githost --url http://127.0.0.1:9XXX pr list --passed
```

### Local reviews (any agent)

githost does **not** call AI APIs. Any agent writes a `githost.review/v1` JSON
file; the CLI uploads it. Full contract: [`docs/REVIEW.md`](docs/REVIEW.md).

```bash
githost review schema                          # print JSON shape
githost review init 12028                      # template → ~/.githost/reviews/
# …agent edits the JSON…
export GITHOST_SESSION='…'                     # gh_session cookie / id
githost review submit 12028 --file review.v1.json
githost review list 12028                      # confirm on server
```

## Tests (reference diffs against the real Worker)

CLI output is snapshot-tested against the **actual local Worker + D1**, not a
hand-maintained JSON fixture:

1. `npm run dev:seed` applies migrations and loads `scripts/seed-*.sql`
   (fixed epoch-ms timestamps and test-run matrix).
2. `wrangler dev` serves the Worker on port **8799** (override with
   `GITHOST_TEST_PORT`).
3. The binary is run with `--url http://127.0.0.1:8799 --no-color`.
4. stdout is compared to `tests/reference/*.txt` with `diff -u`.

Relative timestamps stay stable because the CLI uses `max(updatedAt)` from the
payload as “now”, and the seed SQL uses fixed `updated_at` values.

```bash
# from repo root (recommended)
cmake -S cli -B cli/build && cmake --build cli/build
./cli/tests/run_tests.sh ./cli/build/githost
# or:
npm run test:cli

# after an intentional CLI layout or seed change:
UPDATE_REFS=1 ./cli/tests/run_tests.sh ./cli/build/githost
```

Optional env:

| Variable | Meaning |
|---|---|
| `GITHOST_TEST_PORT` | wrangler port (default `8799`) |
| `SKIP_SEED=1` | reuse existing local D1 |
| `SKIP_WRANGLER=1` | use an already-running Worker on that port |
| `UPDATE_REFS=1` | rewrite golden files |

Why full-output references rather than field-by-field asserts?

- Grouping, sort order, truncation, and the 80-column grid are the product.
- A single diff catches regressions that partial asserts miss.
- Hitting the real `/api/prs` means Worker serialization changes break CLI CI.

CI (`.github/workflows/ci.yml` job `cli`) runs the same path on every PR and
push to `main`.

## Layout

```
cli/
  *.c *.h              # CLI sources
  corec/               # vendored certik/corec (base + platform)
  CMakeLists.txt
  tests/
    reference/         # golden stdout
    run_tests.sh       # seed + wrangler + diff
```

Update corec by re-copying `base/` and `platform/` from
https://github.com/certik/corec (see `corec/VENDOR.md`).
