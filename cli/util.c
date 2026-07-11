#include "util.h"

#include <base/arena.h>
#include <base/mem.h>
#include <platform/platform.h>

int gh_isspace(int c)
{
    return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' ||
           c == '\v';
}

int gh_isdigit(int c)
{
    return c >= '0' && c <= '9';
}

int gh_atoi(const char *s)
{
    int neg = 0;
    int v = 0;
    if (!s) {
        return 0;
    }
    while (gh_isspace((unsigned char)*s)) {
        s++;
    }
    if (*s == '-') {
        neg = 1;
        s++;
    } else if (*s == '+') {
        s++;
    }
    while (gh_isdigit((unsigned char)*s)) {
        v = v * 10 + (*s - '0');
        s++;
    }
    return neg ? -v : v;
}

static void swap_bytes(char *a, char *b, size_t n)
{
    while (n--) {
        char t = *a;
        *a++ = *b;
        *b++ = t;
    }
}

static void insertion_sort(char *base, size_t n, size_t es, gh_cmp_fn cmp,
                           void *ctx)
{
    size_t i, j;
    for (i = 1; i < n; i++) {
        /* Walk j down while base[j] > base[j+1] conceptually: shift. */
        j = i;
        while (j > 0 && cmp(base + (j - 1) * es, base + j * es, ctx) > 0) {
            swap_bytes(base + (j - 1) * es, base + j * es, es);
            j--;
        }
    }
}

/* Lomuto partition; returns pivot index. */
static size_t partition(char *base, size_t lo, size_t hi, size_t es,
                        gh_cmp_fn cmp, void *ctx)
{
    char *pivot = base + hi * es;
    size_t i = lo;
    size_t j;
    for (j = lo; j < hi; j++) {
        if (cmp(base + j * es, pivot, ctx) < 0) {
            swap_bytes(base + i * es, base + j * es, es);
            i++;
        }
    }
    swap_bytes(base + i * es, base + hi * es, es);
    return i;
}

static void qsort_rec(char *base, size_t lo, size_t hi, size_t es, gh_cmp_fn cmp,
                      void *ctx)
{
    size_t p;
    if (hi <= lo) {
        return;
    }
    if (hi - lo + 1 <= 16) {
        insertion_sort(base + lo * es, hi - lo + 1, es, cmp, ctx);
        return;
    }
    p = partition(base, lo, hi, es, cmp, ctx);
    if (p > lo) {
        qsort_rec(base, lo, p - 1, es, cmp, ctx);
    }
    if (p < hi) {
        qsort_rec(base, p + 1, hi, es, cmp, ctx);
    }
}

void gh_qsort(void *base, size_t n, size_t elem_size, gh_cmp_fn cmp, void *ctx)
{
    if (!base || n < 2 || elem_size == 0 || !cmp) {
        return;
    }
    qsort_rec((char *)base, 0, n - 1, elem_size, cmp, ctx);
}

const char *gh_getenv(Arena *arena, const char *key)
{
    size_t count = 0;
    size_t buf_size = 0;
    char **env;
    char *buf;
    size_t key_len;
    size_t i;

    if (!key || !arena) {
        return NULL;
    }
    if (platform_environ_sizes_get(&count, &buf_size) != 0 || count == 0) {
        return NULL;
    }
    env = arena_new_array(arena, char *, count);
    buf = (char *)arena_alloc(arena, buf_size);
    if (platform_environ_get(env, buf) != 0) {
        return NULL;
    }
    key_len = base_strlen(key);
    for (i = 0; i < count; i++) {
        /* "KEY=VALUE" */
        if (base_strncmp(env[i], key, key_len) == 0 && env[i][key_len] == '=') {
            const char *val = env[i] + key_len + 1;
            size_t vlen = base_strlen(val);
            char *copy = (char *)arena_alloc(arena, vlen + 1);
            base_memcpy(copy, val, vlen + 1);
            return copy;
        }
    }
    return NULL;
}
