/*
 * HTTPS via libcurl. This is the only githost translation unit that includes
 * a third-party header (curl/curl.h); that header may pull C library headers.
 * The rest of githost stays on base/ + platform/ only.
 */

#include "githost.h"
#include "out.h"

#include <base/numconv.h>
#include <platform/platform.h>

#include <curl/curl.h>

void gh_http_global_init(void)
{
    curl_global_init(CURL_GLOBAL_DEFAULT);
}

void gh_http_global_cleanup(void)
{
    curl_global_cleanup();
}

void *gh_arena_grow(Arena *arena, void *old, size_t old_count, size_t new_count,
                    size_t elem_size)
{
    void *p = arena_alloc(arena, new_count * elem_size);
    if (old && old_count > 0) {
        size_t n = old_count < new_count ? old_count : new_count;
        base_memcpy(p, old, n * elem_size);
    }
    return p;
}

void gh_buf_init(gh_buf *b, Arena *arena)
{
    b->arena = arena;
    b->data = NULL;
    b->len = 0;
    b->cap = 0;
}

static int buf_grow(gh_buf *b, size_t need)
{
    size_t ncap = b->cap ? b->cap : 4096;
    while (ncap < need) {
        if (ncap > (SIZE_MAX / 2)) {
            return -1;
        }
        ncap *= 2;
    }
    b->data = (char *)gh_arena_grow(b->arena, b->data, b->len, ncap, 1);
    b->cap = ncap;
    return 0;
}

static size_t write_cb(char *ptr, size_t size, size_t nmemb, void *userdata)
{
    gh_buf *b = (gh_buf *)userdata;
    size_t n = size * nmemb;
    if (n == 0) {
        return 0;
    }
    if (buf_grow(b, b->len + n + 1) != 0) {
        return 0;
    }
    base_memcpy(b->data + b->len, ptr, n);
    b->len += n;
    b->data[b->len] = '\0';
    return n;
}

/* Build Cookie header value: accept raw session id or full "gh_session=…". */
static void cookie_header(const char *cookie, char *buf, size_t buflen)
{
    if (!cookie || !cookie[0]) {
        buf[0] = '\0';
        return;
    }
    if (base_strstr(cookie, "gh_session=") != NULL) {
        base_snprintf(buf, buflen, "%s", cookie);
    } else {
        base_snprintf(buf, buflen, "gh_session=%s", cookie);
    }
}

static int http_perform(Arena *arena, const char *url, const char *cookie,
                        const char *post_json, gh_buf *out, long *http_code)
{
    CURL *curl;
    CURLcode rc;
    long code = 0;
    char cookie_buf[512];
    struct curl_slist *headers = NULL;

    if (http_code) {
        *http_code = 0;
    }
    gh_buf_init(out, arena);

    curl = curl_easy_init();
    if (!curl) {
        gh_eprintf("githost: curl_easy_init failed\n");
        return -1;
    }

    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT,
                     "githost/" GITHOST_VERSION);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, out);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 60L);

    if (cookie && cookie[0]) {
        cookie_header(cookie, cookie_buf, sizeof(cookie_buf));
        curl_easy_setopt(curl, CURLOPT_COOKIE, cookie_buf);
    }

    if (post_json) {
        headers = curl_slist_append(headers, "Content-Type: application/json");
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, post_json);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)base_strlen(post_json));
    }

    rc = curl_easy_perform(curl);
    if (headers) {
        curl_slist_free_all(headers);
    }
    if (rc != CURLE_OK) {
        gh_eprintf("githost: HTTP request failed: %s\n",
                   curl_easy_strerror(rc));
        curl_easy_cleanup(curl);
        return -1;
    }

    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
    if (http_code) {
        *http_code = code;
    }
    curl_easy_cleanup(curl);

    /* Non-2xx is still a completed transfer; callers inspect *http_code.
     * Only hard-fail on transport errors (above). Empty body → "". */
    if (!out->data) {
        if (buf_grow(out, 1) != 0) {
            return -1;
        }
        out->data[0] = '\0';
        out->len = 0;
    }
    if (code < 200 || code >= 300) {
        /* Keep stderr noise for real failures; poll-pending uses 200. */
        if (code != 401 && code != 404) {
            gh_eprintf("githost: HTTP %ld for %s\n", code, url);
            if (out->data && out->len > 0) {
                size_t show = out->len > 200 ? 200 : out->len;
                gh_eprintf("githost: body: %.*s\n", (int)show, out->data);
            }
        }
        return -1;
    }
    return 0;
}

int gh_http_get(Arena *arena, const char *url, gh_buf *out, long *http_code)
{
    return http_perform(arena, url, NULL, NULL, out, http_code);
}

int gh_http_get_auth(Arena *arena, const char *url, const char *cookie,
                     gh_buf *out, long *http_code)
{
    return http_perform(arena, url, cookie, NULL, out, http_code);
}

int gh_http_post_json(Arena *arena, const char *url, const char *cookie,
                      const char *json_body, gh_buf *out, long *http_code)
{
    return http_perform(arena, url, cookie, json_body, out, http_code);
}

int gh_read_file(Arena *arena, const char *path, char **out, size_t *out_len)
{
    platform_fd_t fd;
    size_t cap = 4096;
    size_t len = 0;
    char *buf;
    iovec_t iov;
    size_t nread;
    int rc;

    if (out_len) {
        *out_len = 0;
    }
    *out = NULL;

    fd = platform_path_open(path, base_strlen(path), PLATFORM_RIGHTS_READ, 0);
    if (fd < 0) {
        gh_eprintf("githost: cannot open %s\n", path);
        return -1;
    }

    buf = (char *)arena_alloc(arena, cap);
    for (;;) {
        if (len + 1024 >= cap) {
            size_t ncap = cap * 2;
            char *nbuf = (char *)gh_arena_grow(arena, buf, len, ncap, 1);
            buf = nbuf;
            cap = ncap;
        }
        iov.iov_base = buf + len;
        iov.iov_len = cap - len - 1;
        nread = 0;
        rc = platform_fd_read(fd, &iov, 1, &nread);
        if (rc != 0) {
            platform_fd_close(fd);
            gh_eprintf("githost: read failed for %s\n", path);
            return -1;
        }
        if (nread == 0) {
            break;
        }
        len += nread;
    }
    platform_fd_close(fd);
    buf[len] = '\0';
    *out = buf;
    if (out_len) {
        *out_len = len;
    }
    return 0;
}
