# Core C

A minimal, portable core for writing C programs that run unchanged on every
major platform — Linux, macOS, Windows, and the web (WebAssembly) — without
depending on the C standard library, the C runtime, or libc.

Every interaction with the host system flows through a single narrow header,
[`platform/platform.h`](platform/platform.h) (fewer than 20 functions), and
everything else in the project — and in repositories built on top of it — is
written against that one interface. Porting to a new host means writing one
new `platform/platform_<host>.c`.

Everything in this repository is built `-nostdlib -nostdinc -fno-builtin`. The
project consists of two parts:

* **`platform/`** — the *only* place where the program talks to the host
  system. The `platform.h` interface is implemented separately for each
  backend:
    * Linux — raw syscalls
    * macOS — `libSystem.dylib`
    * Windows — `kernel32.dll`
    * WebAssembly — WASI imports
* **`base/`** — a self-contained, strictly platform-independent C library
  built on top of `platform.h`: arenas, scratch allocators, a buddy allocator,
  formatting, I/O helpers, strings, hash tables, vectors, math, asserts.

Higher-level pieces — a C standard library subset, graphics APIs, and
applications — live in **separate repositories** built on top of this core.
This repository is just the core.

## Motivation

The POSIX API has over 1,000 functions. The interface this project exposes to
the system has fewer than 20. Modern security and sandboxing — pioneered by
WASI — work best with a *deny-by-default*, capability-oriented API surface
that is small enough to actually reason about.

We want:

1. **A single, narrow system interface.** Every system call goes through
   `platform.h`. No ambient authority, no hidden globals, no surprise
   dependencies on libc internals.
2. **Real portability, not emulation.** The same C source compiles to native
   Linux/macOS/Windows binaries *and* to WebAssembly. WebAssembly is a
   first-class target, not an afterthought: programs built here run in
   `wasmtime` / `wasmer` and in the browser out of the box.
3. **No standard library in the core.** `-nostdlib`/`-nostdinc` means the
   produced binaries have no runtime dependency on libc or any C runtime.
   Native builds use direct syscalls (Linux) or the documented OS shared
   libraries (macOS `libSystem`, Windows `kernel32`); the WASM build uses
   WASI imports.
4. **Layered, replaceable.** A C standard library subset, container types,
   formatting, graphics, etc. are *layers above* this core, in separate
   repositories. They use only `platform.h` plus `base/`.

Compared with Emscripten, we tightly control the API: there are no
unnecessary calls back and forth with JavaScript, and the same code paths run
natively. Compared with linking against libc, we pay for exactly the system
features we use.

WASI is the design inspiration for the interface, but it is just one backend.
The names in `platform.h` are deliberately platform-neutral
(`platform_fd_write`, `platform_heap_grow`, …) — porting the project to a new
host means writing a single new `platform/platform_<host>.c` file.

For background on WASI, see for example the WASI C API:
<https://github.com/WebAssembly/wasi-libc/blob/main/libc-bottom-half/headers/public/wasi/api.h>.

## Build & test

All builds are driven by [pixi](https://pixi.sh).

```bash
pixi run -e linux   test_linux       # Linux native
pixi run -e macos   test_macos       # macOS native (on macOS only)
pixi run -e windows test_windows     # Windows native (on Windows only, MSVC)
pixi run -e wasm    test_wasm        # WebAssembly via wasmtime
pixi run -e js      test_node        # same .wasm, run via Node.js
```

The same `corec_test.wasm` runs in `wasmtime`, in Node, and in any modern
browser. `platform/js/wasi.js` is the JS counterpart of
`platform/platform_wasm.c`: it implements the `wasi_snapshot_preview1`
imports in pure JavaScript and exposes a small host-friendly API.
Sample hosts that consume it live in `examples/js/`.

To try the browser runner locally:

```bash
pixi run -e js serve_browser   # starts http.server on :8000
# then open http://localhost:8000/examples/js/index.html
```

The page provides text inputs for argv and stdin, mirrors stdout/stderr to
`<pre>` panels and to the JS console, and shows the program's exit code.

Run `pixi task list` to see all available tasks with descriptions.

## Layout

* `platform/platform.h` — the platform-independent system interface.
* `platform/platform_{linux,macos,windows,wasm}.c` — per-backend
  implementations.
* `platform/js/wasi.js` — JS counterpart of `platform_wasm.c`: implements
  the `wasi_snapshot_preview1` imports in pure JavaScript so the same
  `.wasm` artifact runs under `wasmtime`, under `node`, and in the
  browser.
* `examples/js/` — sample hosts that embed `wasi.js`: a Node.js runner
  (`run_node.js`) and a browser page (`index.html`).
* `base/` — self-contained utilities built on top of `platform.h`.
* `test_base.c`, `test_base.h`, `test_base_only.c` — the test suite that
  exercises `base/` and the platform layer on every backend.

## Continuous Integration

GitHub Actions runs the full test suite — native binary, WebAssembly via
`wasmtime`, and the same `.wasm` under Node.js — on Linux, macOS, and Windows
on every push and PR. See `.github/workflows/CI.yml`.

## Contributing / extending

A few conventions worth knowing before submitting changes:

* **Stay inside the sandbox.** Code in `base/` and `platform/` is built with
  `-nostdlib -nostdinc -fno-builtin`. Do not include `<stdio.h>`, `<string.h>`,
  etc. Use what `base/` and `platform/platform.h` provide; if something is
  missing, add it to `base/`.
* **Adding a platform call.** Add the prototype to `platform/platform.h`, then
  implement it in **all four** backends in the same change:
  `platform/platform_{linux,macos,windows,wasm}.c`. CI will only catch a
  missing implementation on the platforms where it is exercised.
* **Adding a new backend.** Drop in a new `platform/platform_<host>.c` that
  implements every function in `platform.h`, add a feature/environment block
  to `pixi.toml`, and add a row to `.github/workflows/CI.yml`.
* **Tests.** All tests live in `test_base.c`. Add a `test_<topic>()` function,
  declare it in `test_base.h`, and call it from `test_base()` in `test_base.c`.
  If a test creates files on disk, add their names to `.gitignore` next to the
  existing `test_*.txt` block.
