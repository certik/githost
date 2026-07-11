#pragma once

/*
 * Small freestanding utilities for githost (candidates for upstreaming to corec).
 * Headers only include base/ — no C standard library.
 */

#include <base/arena.h>
#include <base/types.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Compare callback: return <0, 0, >0 like strcmp. `ctx` is an optional cookie. */
typedef int (*gh_cmp_fn)(const void *a, const void *b, void *ctx);

/* In-place sort of `n` elements of `elem_size` bytes at `base`. */
void gh_qsort(void *base, size_t n, size_t elem_size, gh_cmp_fn cmp, void *ctx);

int gh_isspace(int c);
int gh_isdigit(int c);
int gh_atoi(const char *s);

/* Look up KEY in the platform environment; returns NULL if missing.
 * Result points into `arena` (copied "VALUE" substring). */
const char *gh_getenv(Arena *arena, const char *key);

#ifdef __cplusplus
}
#endif
