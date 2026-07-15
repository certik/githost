#pragma once

/*
 * githost public types and API.
 * Only base/ headers — no C standard library.
 */

#include <base/arena.h>
#include <base/mem.h>
#include <base/types.h>

#define GITHOST_DEFAULT_URL "https://githost.ondrej-c3a.workers.dev"
#define GITHOST_VERSION "0.1.0"

/* Priority buckets mirror the web UI (function p0 / m0 in the SPA). */
enum gh_priority {
    GH_PRI_PASSED = 0,
    GH_PRI_PASSED_CONFLICT = 1,
    GH_PRI_EXH_RUNNING = 2,
    GH_PRI_EXH_QUEUED = 3,
    GH_PRI_EXH_SKIPPED = 4,
    GH_PRI_EXH_NOT_RUN = 5,
    GH_PRI_EXH_FAILED = 6,
    GH_PRI_QUICK_RUNNING = 10,
    GH_PRI_QUICK_QUEUED = 20,
    GH_PRI_QUICK_SKIPPED = 25,
    GH_PRI_QUICK_FAILED = 30,
    GH_PRI_OTHER = 99
};

enum gh_test_status {
    GH_TEST_NULL = 0,
    GH_TEST_QUEUED,
    GH_TEST_RUNNING,
    GH_TEST_PASSED,
    GH_TEST_FAILED,
    GH_TEST_SKIPPED
};

enum gh_mergeable {
    GH_MERGEABLE_NULL = 0,
    GH_MERGEABLE_TRUE,
    GH_MERGEABLE_FALSE
};

/* Latest local AI review on the PR (mirrors SPA localReview). */
enum gh_review_verdict {
    GH_REVIEW_NONE = 0, /* no review yet */
    GH_REVIEW_APPROVE,
    GH_REVIEW_COMMENT,
    GH_REVIEW_REQUEST_CHANGES
};

typedef struct {
    enum gh_test_status status;
    char head_sha[48];
    char log_url[512];
} gh_test_run;

typedef struct {
    enum gh_review_verdict verdict;
    char status[16]; /* "ready" / "posted" when present */
} gh_local_review;

typedef struct {
    int64_t id;
    int number;
    char title[256];
    char state[16];          /* "open" / "closed" */
    bool draft;
    bool merged;
    enum gh_mergeable mergeable;
    char mergeable_state[32];
    char head_ref[128];
    char base_ref[64];
    int64_t created_at;      /* ms since epoch */
    int64_t updated_at;
    char author_login[64];
    char html_url[256];
    gh_test_run quick;
    gh_test_run exhaustive;
    gh_local_review local_review; /* GH_REVIEW_NONE if API sent null / omitted */
} gh_pr;

typedef struct {
    gh_pr *items;
    size_t count;
    size_t capacity;
    int limit;
    int offset;
} gh_pr_list;

/* Growable byte buffer backed by an arena (old chunks are abandoned). */
typedef struct {
    Arena *arena;
    char *data;
    size_t len;
    size_t cap;
} gh_buf;

void gh_buf_init(gh_buf *b, Arena *arena);
void gh_http_global_init(void);
void gh_http_global_cleanup(void);
int gh_http_get(Arena *arena, const char *url, gh_buf *out, long *http_code);
/* Authenticated GET (Cookie: gh_session=… or full Cookie header value). */
int gh_http_get_auth(Arena *arena, const char *url, const char *cookie,
                     gh_buf *out, long *http_code);
/* POST application/json with optional session cookie. */
int gh_http_post_json(Arena *arena, const char *url, const char *cookie,
                      const char *json_body, gh_buf *out, long *http_code);

/* Read an entire file into arena memory (NUL-terminated). */
int gh_read_file(Arena *arena, const char *path, char **out, size_t *out_len);

void gh_pr_list_init(gh_pr_list *list);
int gh_pr_list_parse(Arena *arena, const char *json, gh_pr_list *list);

int gh_pr_priority(const gh_pr *pr);
const char *gh_priority_label(int key);
const char *gh_test_status_name(enum gh_test_status s);

typedef struct {
    bool color;
    bool show_drafts;
    bool show_closed;
    bool unreviewed_only;
    int filter_priority;     /* -1 = all ready groups */
    bool json_out;
    int64_t now_ms;          /* wall-ish clock for relative times; 0 = derive */
} gh_display_opts;

void gh_display_pr_list(Arena *arena, const gh_pr_list *list,
                        const gh_display_opts *opts);
void gh_display_pr(const gh_pr *pr, bool color, int64_t now_ms);
int gh_parse_group_name(const char *name); /* priority key or -2 on error */

/* Arena-backed array growth: allocates a new larger block and copies. */
void *gh_arena_grow(Arena *arena, void *old, size_t old_count, size_t new_count,
                    size_t elem_size);

/* Best-effort "now" in ms; uses newest PR timestamp if wall clock unavailable. */
int64_t gh_now_ms(const gh_pr_list *list);

/* Browser login: open /auth/cli-login, receive session on localhost callback. */
int gh_cmd_login(Arena *arena, const char *base_url, const char *login_name);
