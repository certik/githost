#include "githost.h"
#include "out.h"
#include "util.h"

#include <base/numconv.h>

/* ANSI colors matching the zinc/green/amber web UI. */
#define C_RESET   "\033[0m"
#define C_BOLD    "\033[1m"
#define C_DIM     "\033[2m"
#define C_GREEN   "\033[32m"
#define C_BGREEN  "\033[1;32m"
#define C_AMBER   "\033[33m"
#define C_BAMBER  "\033[1;33m"
#define C_RED     "\033[31m"
#define C_CYAN    "\033[36m"
#define C_PURPLE  "\033[35m"
#define C_GRAY    "\033[90m"

static const char *S(bool color, const char *code)
{
    return color ? code : "";
}

int64_t gh_now_ms(const gh_pr_list *list)
{
    int64_t max_u = 0;
    size_t i;
    if (!list) {
        return 0;
    }
    for (i = 0; i < list->count; i++) {
        if (list->items[i].updated_at > max_u) {
            max_u = list->items[i].updated_at;
        }
    }
    /* Prefer "just after newest update" so relative times stay non-negative. */
    return max_u > 0 ? max_u : 0;
}

int gh_pr_priority(const gh_pr *pr)
{
    enum gh_test_status t = pr->quick.status;
    enum gh_test_status n = pr->exhaustive.status;

    if (t == GH_TEST_PASSED) {
        if (n == GH_TEST_PASSED) {
            return (pr->mergeable == GH_MERGEABLE_FALSE)
                       ? GH_PRI_PASSED_CONFLICT
                       : GH_PRI_PASSED;
        }
        if (n == GH_TEST_RUNNING) {
            return GH_PRI_EXH_RUNNING;
        }
        if (n == GH_TEST_QUEUED) {
            return GH_PRI_EXH_QUEUED;
        }
        if (n == GH_TEST_SKIPPED) {
            return GH_PRI_EXH_SKIPPED;
        }
        if (n == GH_TEST_FAILED) {
            return GH_PRI_EXH_FAILED;
        }
        return GH_PRI_EXH_NOT_RUN;
    }
    if (t == GH_TEST_RUNNING) {
        return GH_PRI_QUICK_RUNNING;
    }
    if (t == GH_TEST_QUEUED || t == GH_TEST_NULL) {
        return GH_PRI_QUICK_QUEUED;
    }
    if (t == GH_TEST_SKIPPED) {
        return GH_PRI_QUICK_SKIPPED;
    }
    if (t == GH_TEST_FAILED) {
        return GH_PRI_QUICK_FAILED;
    }
    return GH_PRI_OTHER;
}

const char *gh_priority_label(int key)
{
    switch (key) {
    case GH_PRI_PASSED:
        return "Quick + Exhaustive passed";
    case GH_PRI_PASSED_CONFLICT:
        return "Quick + Exhaustive passed (merge conflict)";
    case GH_PRI_EXH_RUNNING:
        return "Quick passed · Exhaustive running";
    case GH_PRI_EXH_QUEUED:
        return "Quick passed · Exhaustive queued";
    case GH_PRI_EXH_SKIPPED:
        return "Quick passed · Exhaustive skipped";
    case GH_PRI_EXH_NOT_RUN:
        return "Quick passed · Exhaustive not run";
    case GH_PRI_EXH_FAILED:
        return "Quick passed · Exhaustive failed";
    case GH_PRI_QUICK_RUNNING:
        return "Quick running";
    case GH_PRI_QUICK_QUEUED:
        return "Quick queued / not run";
    case GH_PRI_QUICK_SKIPPED:
        return "Quick skipped";
    case GH_PRI_QUICK_FAILED:
        return "Quick failed";
    default:
        return "Other";
    }
}

const char *gh_test_status_name(enum gh_test_status s)
{
    switch (s) {
    case GH_TEST_QUEUED:
        return "queued";
    case GH_TEST_RUNNING:
        return "running";
    case GH_TEST_PASSED:
        return "passed";
    case GH_TEST_FAILED:
        return "failed";
    case GH_TEST_SKIPPED:
        return "skipped";
    default:
        return "not queued";
    }
}

static int parse_int_strict(const char *name, int *out)
{
    int neg = 0;
    int v = 0;
    const char *p = name;
    if (!p || !*p) {
        return -1;
    }
    if (*p == '-') {
        neg = 1;
        p++;
    }
    if (!gh_isdigit((unsigned char)*p)) {
        return -1;
    }
    while (gh_isdigit((unsigned char)*p)) {
        v = v * 10 + (*p - '0');
        p++;
    }
    if (*p != '\0') {
        return -1;
    }
    *out = neg ? -v : v;
    return 0;
}

int gh_parse_group_name(const char *name)
{
    int v;
    if (!name || !name[0]) {
        return -2;
    }
    if (parse_int_strict(name, &v) == 0) {
        return v;
    }
    if (base_strcmp(name, "passed") == 0) {
        return GH_PRI_PASSED;
    }
    if (base_strcmp(name, "conflict") == 0 ||
        base_strcmp(name, "merge-conflict") == 0) {
        return GH_PRI_PASSED_CONFLICT;
    }
    if (base_strcmp(name, "exhaustive-running") == 0 ||
        base_strcmp(name, "exh-running") == 0) {
        return GH_PRI_EXH_RUNNING;
    }
    if (base_strcmp(name, "exhaustive-queued") == 0 ||
        base_strcmp(name, "exh-queued") == 0) {
        return GH_PRI_EXH_QUEUED;
    }
    if (base_strcmp(name, "exhaustive-skipped") == 0 ||
        base_strcmp(name, "exh-skipped") == 0) {
        return GH_PRI_EXH_SKIPPED;
    }
    if (base_strcmp(name, "exhaustive-not-run") == 0 ||
        base_strcmp(name, "exh-not-run") == 0) {
        return GH_PRI_EXH_NOT_RUN;
    }
    if (base_strcmp(name, "exhaustive-failed") == 0 ||
        base_strcmp(name, "exh-failed") == 0) {
        return GH_PRI_EXH_FAILED;
    }
    if (base_strcmp(name, "quick-running") == 0) {
        return GH_PRI_QUICK_RUNNING;
    }
    if (base_strcmp(name, "quick-queued") == 0) {
        return GH_PRI_QUICK_QUEUED;
    }
    if (base_strcmp(name, "quick-skipped") == 0) {
        return GH_PRI_QUICK_SKIPPED;
    }
    if (base_strcmp(name, "quick-failed") == 0) {
        return GH_PRI_QUICK_FAILED;
    }
    if (base_strcmp(name, "other") == 0) {
        return GH_PRI_OTHER;
    }
    return -2;
}

/*
 * Fixed 80-column list layout (visible glyphs; ANSI codes excluded):
 *
 *   #12028 title (44)                          author (12)  5h  ✓ ○ ✓ ✓
 *   |----7| |-------------44--------------| |----12----| |4| |----7----|
 *   icons = "M R Q E" (merge, local review, quick, exhaustive)
 *   + spaces between fields + 2-space indent = 80
 */
#define GH_COLS      80
#define GH_W_INDENT  2
#define GH_W_NUM     7
#define GH_W_TITLE   44
#define GH_W_AUTHOR  12
#define GH_W_AGE     4
#define GH_W_ICONS   7

static void pad_spaces(int n)
{
    while (n-- > 0) {
        gh_putchar(' ');
    }
}

/* Print up to `width` chars of `s`, left-aligned, space-padded to `width`. */
static void print_field_left(const char *s, int width)
{
    int i = 0;
    if (!s) {
        s = "";
    }
    while (s[i] && i < width) {
        gh_putchar(s[i]);
        i++;
    }
    pad_spaces(width - i);
}

/* Right-align `s` in `width` (truncate from the left if longer). */
static void print_field_right(const char *s, int width)
{
    int n;
    int start;
    int i;
    if (!s) {
        s = "";
    }
    n = (int)base_strlen(s);
    if (n > width) {
        start = n - width;
        for (i = start; i < n; i++) {
            gh_putchar(s[i]);
        }
        return;
    }
    pad_spaces(width - n);
    gh_print(s);
}

static void relative_time(int64_t updated_ms, int64_t now_ms, char *buf,
                          size_t buflen)
{
    int64_t sec;
    if (now_ms <= 0) {
        now_ms = updated_ms;
    }
    sec = (now_ms - updated_ms) / 1000;
    if (sec < 0) {
        sec = 0;
    }
    /* Compact forms so AGE fits in GH_W_AGE (4). */
    if (sec < 45) {
        base_snprintf(buf, buflen, "now");
        return;
    }
    if (sec < 3600) {
        base_snprintf(buf, buflen, "%lldm", (long long)(sec / 60));
        return;
    }
    if (sec < 86400) {
        base_snprintf(buf, buflen, "%lldh", (long long)(sec / 3600));
        return;
    }
    if (sec < 86400 * 7) {
        base_snprintf(buf, buflen, "%lldd", (long long)(sec / 86400));
        return;
    }
    if (sec < 86400L * 30) {
        base_snprintf(buf, buflen, "%lldw",
                      (long long)(sec / (86400 * 7)));
        return;
    }
    if (sec < 86400L * 365) {
        base_snprintf(buf, buflen, "%lldmo",
                      (long long)(sec / (86400L * 30)));
        return;
    }
    base_snprintf(buf, buflen, "%lldy",
                  (long long)(sec / (86400L * 365)));
}

static void print_test_icon(enum gh_test_status st, bool color)
{
    switch (st) {
    case GH_TEST_PASSED:
        gh_printf("%s✓%s", S(color, C_GREEN), S(color, C_RESET));
        break;
    case GH_TEST_FAILED:
        gh_printf("%s✗%s", S(color, C_RED), S(color, C_RESET));
        break;
    case GH_TEST_RUNNING:
        gh_printf("%s◉%s", S(color, C_CYAN), S(color, C_RESET));
        break;
    case GH_TEST_QUEUED:
        gh_printf("%s●%s", S(color, C_AMBER), S(color, C_RESET));
        break;
    case GH_TEST_SKIPPED:
        gh_printf("%s–%s", S(color, C_GRAY), S(color, C_RESET));
        break;
    default:
        gh_printf("%s○%s", S(color, C_GRAY), S(color, C_RESET));
        break;
    }
}

static void print_merge_icon(const gh_pr *pr, bool color)
{
    if (pr->mergeable == GH_MERGEABLE_FALSE) {
        gh_printf("%s!%s", S(color, C_AMBER), S(color, C_RESET));
    } else if (pr->mergeable == GH_MERGEABLE_TRUE) {
        gh_printf("%s✓%s", S(color, C_GREEN), S(color, C_RESET));
    } else {
        gh_printf("%s?%s", S(color, C_GRAY), S(color, C_RESET));
    }
}

/* Same symbols as the SPA Rev column: ✓ approve, ✗ request changes, ○ comment, · none. */
static void print_review_icon(const gh_pr *pr, bool color)
{
    switch (pr->local_review.verdict) {
    case GH_REVIEW_APPROVE:
        gh_printf("%s✓%s", S(color, C_GREEN), S(color, C_RESET));
        break;
    case GH_REVIEW_REQUEST_CHANGES:
        gh_printf("%s✗%s", S(color, C_RED), S(color, C_RESET));
        break;
    case GH_REVIEW_COMMENT:
        gh_printf("%s○%s", S(color, C_CYAN), S(color, C_RESET));
        break;
    default:
        gh_printf("%s·%s", S(color, C_GRAY), S(color, C_RESET));
        break;
    }
}

static const char *gh_review_verdict_name(enum gh_review_verdict v)
{
    switch (v) {
    case GH_REVIEW_APPROVE:
        return "APPROVE";
    case GH_REVIEW_COMMENT:
        return "COMMENT";
    case GH_REVIEW_REQUEST_CHANGES:
        return "REQUEST_CHANGES";
    default:
        return NULL;
    }
}

static void print_state_badge(const gh_pr *pr, bool color)
{
    if (pr->merged) {
        gh_printf("%sMerged%s", S(color, C_PURPLE), S(color, C_RESET));
    } else if (base_strcmp(pr->state, "closed") == 0) {
        gh_printf("%sClosed%s", S(color, C_GRAY), S(color, C_RESET));
    } else if (pr->draft) {
        gh_printf("%sDraft%s", S(color, C_GRAY), S(color, C_RESET));
    } else {
        gh_printf("%sReady for review%s", S(color, C_GREEN), S(color, C_RESET));
    }
}

static int cmp_updated_desc(const void *a, const void *b, void *ctx)
{
    const gh_pr *pa = *(const gh_pr *const *)a;
    const gh_pr *pb = *(const gh_pr *const *)b;
    (void)ctx;
    if (pa->updated_at < pb->updated_at) {
        return 1;
    }
    if (pa->updated_at > pb->updated_at) {
        return -1;
    }
    return pb->number - pa->number;
}

static int cmp_int_asc(const void *a, const void *b, void *ctx)
{
    int ia = *(const int *)a;
    int ib = *(const int *)b;
    (void)ctx;
    return ia - ib;
}

static void truncate_field(const char *in, char *out, size_t outlen,
                           size_t max_chars)
{
    size_t n;
    if (outlen == 0) {
        return;
    }
    if (!in) {
        out[0] = '\0';
        return;
    }
    n = base_strlen(in);
    if (n <= max_chars) {
        if (n + 1 > outlen) {
            n = outlen - 1;
        }
        base_memcpy(out, in, n);
        out[n] = '\0';
        return;
    }
    if (max_chars < 3 || outlen < 4) {
        size_t keep = max_chars < outlen ? max_chars : outlen - 1;
        base_memcpy(out, in, keep);
        out[keep] = '\0';
        return;
    }
    {
        size_t keep = max_chars - 3;
        if (keep + 4 > outlen) {
            keep = outlen - 4;
        }
        base_memcpy(out, in, keep);
        out[keep] = '.';
        out[keep + 1] = '.';
        out[keep + 2] = '.';
        out[keep + 3] = '\0';
    }
}

static void print_group_header(int key, size_t n, bool color)
{
    const char *label = gh_priority_label(key);
    const char *col = C_GRAY;
    if (key == GH_PRI_PASSED) {
        col = C_BGREEN;
    } else if (key == GH_PRI_PASSED_CONFLICT) {
        col = C_BAMBER;
    } else if (key == GH_PRI_EXH_FAILED || key == GH_PRI_QUICK_FAILED) {
        col = C_RED;
    } else if (key == GH_PRI_EXH_RUNNING || key == GH_PRI_QUICK_RUNNING) {
        col = C_CYAN;
    }

    gh_printf("\n%s%s%s %s(%zu)%s\n", S(color, col), label, S(color, C_RESET),
              S(color, C_GRAY), n, S(color, C_RESET));
}

static void print_rule(bool color, const char *col)
{
    int i;
    gh_print(S(color, col));
    for (i = 0; i < GH_COLS; i++) {
        gh_putchar(0xE2); /* UTF-8 box drawing light horizontal U+2500 ─ */
        gh_putchar(0x94);
        gh_putchar(0x80);
    }
    gh_print(S(color, C_RESET));
    gh_putchar('\n');
}

static void print_table_header(bool color)
{
    /*
     *   #       TITLE                                    AUTHOR        AGE M R Q E
     * matches print_pr_row field widths exactly (80 cols).
     */
    gh_print(S(color, C_DIM));
    pad_spaces(GH_W_INDENT);
    print_field_left("#", GH_W_NUM);
    gh_putchar(' ');
    print_field_left("TITLE", GH_W_TITLE);
    gh_putchar(' ');
    print_field_left("AUTHOR", GH_W_AUTHOR);
    gh_putchar(' ');
    print_field_right("AGE", GH_W_AGE);
    gh_putchar(' ');
    gh_print("M R Q E");
    gh_print(S(color, C_RESET));
    gh_putchar('\n');
}

/*
 * One PR, one line, exactly GH_COLS visible columns:
 *   <indent2><#num7> <title44> <author12> <age4> <M R Q E>
 */
static void print_pr_row(const gh_pr *pr, bool color, int64_t now_ms)
{
    char when[16];
    char title[GH_W_TITLE + 1];
    char author[GH_W_AUTHOR + 1];
    char num[16];

    relative_time(pr->updated_at, now_ms, when, sizeof(when));
    truncate_field(pr->title, title, sizeof(title), (size_t)GH_W_TITLE);
    truncate_field(pr->author_login[0] ? pr->author_login : "?", author,
                   sizeof(author), (size_t)GH_W_AUTHOR);
    base_snprintf(num, sizeof(num), "#%d", pr->number);

    pad_spaces(GH_W_INDENT);

    gh_print(S(color, C_GRAY));
    print_field_left(num, GH_W_NUM);
    gh_print(S(color, C_RESET));
    gh_putchar(' ');

    gh_print(S(color, C_BOLD));
    print_field_left(title, GH_W_TITLE);
    gh_print(S(color, C_RESET));
    gh_putchar(' ');

    gh_print(S(color, C_GRAY));
    print_field_left(author, GH_W_AUTHOR);
    gh_print(S(color, C_RESET));
    gh_putchar(' ');

    print_field_right(when, GH_W_AGE);
    gh_putchar(' ');

    print_merge_icon(pr, color);
    gh_putchar(' ');
    print_review_icon(pr, color);
    gh_putchar(' ');
    print_test_icon(pr->quick.status, color);
    gh_putchar(' ');
    print_test_icon(pr->exhaustive.status, color);
    gh_putchar('\n');
}

static void json_escape_print(const char *s)
{
    for (; s && *s; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') {
            gh_putchar('\\');
            gh_putchar((char)c);
        } else if (c == '\n') {
            gh_print("\\n");
        } else if (c == '\r') {
            gh_print("\\r");
        } else if (c == '\t') {
            gh_print("\\t");
        } else if (c < 0x20) {
            gh_printf("\\u%04x", (unsigned)c);
        } else {
            gh_putchar((char)c);
        }
    }
}

static void emit_json_pr(const gh_pr *pr)
{
    gh_printf("    {\n");
    gh_printf("      \"number\": %d,\n", pr->number);
    gh_print("      \"title\": \"");
    json_escape_print(pr->title);
    gh_print("\",\n");
    gh_print("      \"state\": \"");
    json_escape_print(pr->state);
    gh_print("\",\n");
    gh_printf("      \"draft\": %s,\n", pr->draft ? "true" : "false");
    gh_printf("      \"merged\": %s,\n", pr->merged ? "true" : "false");
    gh_printf("      \"mergeable\": %s,\n",
              pr->mergeable == GH_MERGEABLE_TRUE
                  ? "true"
                  : (pr->mergeable == GH_MERGEABLE_FALSE ? "false" : "null"));
    gh_print("      \"authorLogin\": \"");
    json_escape_print(pr->author_login);
    gh_print("\",\n");
    gh_print("      \"htmlUrl\": \"");
    json_escape_print(pr->html_url);
    gh_print("\",\n");
    gh_printf("      \"updatedAt\": %lld,\n", (long long)pr->updated_at);
    gh_printf("      \"priority\": %d,\n", gh_pr_priority(pr));
    gh_printf("      \"priorityLabel\": \"%s\",\n",
              gh_priority_label(gh_pr_priority(pr)));
    gh_printf("      \"quickTest\": \"%s\",\n",
              gh_test_status_name(pr->quick.status));
    gh_printf("      \"exhaustiveTest\": \"%s\",\n",
              gh_test_status_name(pr->exhaustive.status));
    {
        const char *rv = gh_review_verdict_name(pr->local_review.verdict);
        if (rv) {
            gh_printf("      \"localReview\": { \"verdict\": \"%s\" }\n", rv);
        } else {
            gh_print("      \"localReview\": null\n");
        }
    }
    gh_printf("    }");
}

void gh_display_pr(const gh_pr *pr, bool color, int64_t now_ms)
{
    char when[32];
    relative_time(pr->updated_at, now_ms, when, sizeof(when));

    gh_printf("%sPR #%d%s %s\n", S(color, C_BOLD), pr->number,
              S(color, C_RESET), pr->title);
    gh_print("  State:     ");
    print_state_badge(pr, color);
    gh_print("\n");
    gh_printf("  Author:    %s\n", pr->author_login);
    gh_printf("  Branch:    %s → %s\n", pr->head_ref, pr->base_ref);
    gh_printf("  Updated:   %s\n", when);
    gh_print("  Mergeable: ");
    print_merge_icon(pr, color);
    gh_printf(" (%s)\n",
              pr->mergeable_state[0] ? pr->mergeable_state : "unknown");
    gh_print("  Review:    ");
    print_review_icon(pr, color);
    {
        const char *rv = gh_review_verdict_name(pr->local_review.verdict);
        if (rv) {
            gh_printf(" %s", rv);
            if (pr->local_review.status[0]) {
                gh_printf(" (%s)", pr->local_review.status);
            }
        } else {
            gh_print(" no review yet");
        }
    }
    gh_print("\n");
    gh_print("  Quick:     ");
    print_test_icon(pr->quick.status, color);
    gh_printf(" %s", gh_test_status_name(pr->quick.status));
    if (pr->quick.head_sha[0]) {
        gh_printf(" @ %.7s", pr->quick.head_sha);
    }
    gh_print("\n");
    gh_print("  Exhaustive: ");
    print_test_icon(pr->exhaustive.status, color);
    gh_printf(" %s", gh_test_status_name(pr->exhaustive.status));
    if (pr->exhaustive.head_sha[0]) {
        gh_printf(" @ %.7s", pr->exhaustive.head_sha);
    }
    gh_print("\n");
    gh_printf("  Priority:  %s (%d)\n", gh_priority_label(gh_pr_priority(pr)),
              gh_pr_priority(pr));
    if (pr->html_url[0]) {
        gh_printf("  URL:       %s\n", pr->html_url);
    }
    if (pr->quick.log_url[0]) {
        gh_printf("  Quick log: %s\n", pr->quick.log_url);
    }
    if (pr->exhaustive.log_url[0]) {
        gh_printf("  Exh. log:  %s\n", pr->exhaustive.log_url);
    }
}

void gh_display_pr_list(Arena *arena, const gh_pr_list *list,
                        const gh_display_opts *opts)
{
    const gh_pr **ready = NULL;
    const gh_pr **drafts = NULL;
    size_t n_ready = 0, n_drafts = 0;
    size_t cap_ready = 0, cap_drafts = 0;
    int *keys = NULL;
    size_t n_keys = 0, cap_keys = 0;
    size_t i, k;
    int64_t now_ms = opts->now_ms;

    if (now_ms <= 0) {
        now_ms = gh_now_ms(list);
    }

    for (i = 0; i < list->count; i++) {
        const gh_pr *pr = &list->items[i];
        bool is_open = (base_strcmp(pr->state, "open") == 0);

        if (!is_open) {
            continue;
        }

        if (pr->draft) {
            if (!opts->show_drafts) {
                continue;
            }
            if (n_drafts >= cap_drafts) {
                size_t ncap = cap_drafts ? cap_drafts * 2 : 16;
                drafts = (const gh_pr **)gh_arena_grow(
                    arena, (void *)drafts, n_drafts, ncap, sizeof(*drafts));
                cap_drafts = ncap;
            }
            drafts[n_drafts++] = pr;
            continue;
        }

        {
            int pri = gh_pr_priority(pr);
            if (opts->filter_priority >= 0 && pri != opts->filter_priority) {
                continue;
            }

            if (n_ready >= cap_ready) {
                size_t ncap = cap_ready ? cap_ready * 2 : 32;
                ready = (const gh_pr **)gh_arena_grow(
                    arena, (void *)ready, n_ready, ncap, sizeof(*ready));
                cap_ready = ncap;
            }
            ready[n_ready++] = pr;

            {
                int found = 0;
                for (k = 0; k < n_keys; k++) {
                    if (keys[k] == pri) {
                        found = 1;
                        break;
                    }
                }
                if (!found) {
                    if (n_keys >= cap_keys) {
                        size_t ncap = cap_keys ? cap_keys * 2 : 16;
                        keys = (int *)gh_arena_grow(arena, keys, n_keys, ncap,
                                                    sizeof(*keys));
                        cap_keys = ncap;
                    }
                    keys[n_keys++] = pri;
                }
            }
        }
    }

    if (opts->json_out) {
        gh_print("{\n  \"items\": [\n");
        for (i = 0; i < n_ready; i++) {
            if (i) {
                gh_print(",\n");
            }
            emit_json_pr(ready[i]);
        }
        if (opts->show_drafts) {
            for (i = 0; i < n_drafts; i++) {
                if (n_ready + i > 0) {
                    gh_print(",\n");
                }
                emit_json_pr(drafts[i]);
            }
        }
        gh_printf("\n  ],\n  \"count\": %zu\n}\n",
                  n_ready + (opts->show_drafts ? n_drafts : 0));
        return;
    }

    gh_printf("%sPull requests%s  %s(review priority · open)%s\n",
              S(opts->color, C_BOLD), S(opts->color, C_RESET),
              S(opts->color, C_GRAY), S(opts->color, C_RESET));

    if (n_ready == 0 && (n_drafts == 0 || !opts->show_drafts)) {
        gh_printf("\n%sNothing here — no matching open PRs.%s\n",
                  S(opts->color, C_GRAY), S(opts->color, C_RESET));
        return;
    }

    gh_printf("\n%sREADY FOR REVIEW%s\n", S(opts->color, C_DIM),
              S(opts->color, C_RESET));

    gh_qsort(keys, n_keys, sizeof(int), cmp_int_asc, NULL);

    for (k = 0; k < n_keys; k++) {
        int key = keys[k];
        const gh_pr **group = NULL;
        size_t ng = 0, cg = 0;

        for (i = 0; i < n_ready; i++) {
            if (gh_pr_priority(ready[i]) != key) {
                continue;
            }
            if (ng >= cg) {
                size_t ncap = cg ? cg * 2 : 16;
                group = (const gh_pr **)gh_arena_grow(
                    arena, (void *)group, ng, ncap, sizeof(*group));
                cg = ncap;
            }
            group[ng++] = ready[i];
        }
        gh_qsort(group, ng, sizeof(*group), cmp_updated_desc, NULL);

        print_group_header(key, ng, opts->color);
        if (key == GH_PRI_PASSED) {
            print_rule(opts->color, C_GREEN);
        } else if (key == GH_PRI_PASSED_CONFLICT) {
            print_rule(opts->color, C_AMBER);
        } else {
            print_rule(opts->color, C_GRAY);
        }
        print_table_header(opts->color);
        for (i = 0; i < ng; i++) {
            print_pr_row(group[i], opts->color, now_ms);
        }
    }

    if (opts->show_drafts) {
        gh_qsort(drafts, n_drafts, sizeof(*drafts), cmp_updated_desc, NULL);
        gh_printf("\n%sDRAFT%s %s(%zu)%s\n", S(opts->color, C_DIM),
                  S(opts->color, C_RESET), S(opts->color, C_GRAY), n_drafts,
                  S(opts->color, C_RESET));
        if (n_drafts == 0) {
            gh_printf("  %sNo drafts.%s\n", S(opts->color, C_GRAY),
                      S(opts->color, C_RESET));
        } else {
            print_table_header(opts->color);
            for (i = 0; i < n_drafts; i++) {
                print_pr_row(drafts[i], opts->color, now_ms);
            }
        }
    }

    gh_printf("\n%s%zu ready · %zu drafts shown · %zu total from API%s\n",
              S(opts->color, C_GRAY), n_ready,
              opts->show_drafts ? n_drafts : 0, list->count,
              S(opts->color, C_RESET));
    if (list->limit > 0 && list->count >= (size_t)list->limit) {
        gh_printf(
            "%s(note: public /api/prs currently returns at most %d items)%s\n",
            S(opts->color, C_GRAY), list->limit, S(opts->color, C_RESET));
    }
}
