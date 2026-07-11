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

Local review stubs (upload not implemented yet):

```bash
./build/githost review init 12028
./build/githost review path 12028
```

## Tests (reference diffs)

CLI output is snapshot-tested:

1. `tests/serve_fixture.py` serves a fixed `tests/fixtures/api_prs.json` on an
   ephemeral local port (no Cloudflare, no network).
2. The binary is run with `--url <that base> --no-color`.
3. stdout is compared to `tests/reference/*.txt` with `diff -u`.

Relative timestamps stay stable because the CLI uses `max(updatedAt)` from the
payload as “now”, not wall-clock time.

```bash
# build + run
cmake -S . -B build && cmake --build build
./tests/run_tests.sh ./build/githost

# or via CTest / npm from the repo root
ctest --test-dir build --output-on-failure
npm run test:cli

# after an intentional layout change, refresh snapshots:
UPDATE_REFS=1 ./tests/run_tests.sh ./build/githost
```

CI (`.github/workflows/ci.yml`) runs the same build + `run_tests.sh` on every
PR and push to `main` (Ubuntu, Ninja, libcurl).

Why full-output references rather than field-by-field asserts?

- Grouping, sort order, truncation, and the 80-column grid are the product.
- A single diff catches regressions that partial asserts miss.
- Fixtures are small and hand-written, so failures are readable.

## Layout

```
cli/
  *.c *.h              # CLI sources
  corec/               # vendored certik/corec (base + platform)
  CMakeLists.txt
  tests/
    fixtures/api_prs.json
    reference/         # golden stdout
    serve_fixture.py
    run_tests.sh
```

Update corec by re-copying `base/` and `platform/` from
https://github.com/certik/corec (see `corec/VENDOR.md`).
