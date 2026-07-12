/*
 * Minimal JSON subset parser specialized for /api/prs responses.
 * No heap tree: scans the document and fills gh_pr records.
 */

#include "githost.h"
#include "out.h"
#include "util.h"


void gh_pr_list_init(gh_pr_list *list)
{
    list->items = NULL;
    list->count = 0;
    list->capacity = 0;
    list->limit = 0;
    list->offset = 0;
}

typedef struct {
    const char *p;
    const char *end;
    const char *err;
} jscan;

static void jskip_ws(jscan *s)
{
    while (s->p < s->end && gh_isspace((unsigned char)*s->p)) {
        s->p++;
    }
}

static int jpeek(jscan *s)
{
    jskip_ws(s);
    return s->p < s->end ? (unsigned char)*s->p : -1;
}

static int jexpect(jscan *s, char c)
{
    jskip_ws(s);
    if (s->p >= s->end || *s->p != c) {
        s->err = "unexpected token";
        return -1;
    }
    s->p++;
    return 0;
}

static int jconsume(jscan *s, char c)
{
    jskip_ws(s);
    if (s->p < s->end && *s->p == c) {
        s->p++;
        return 1;
    }
    return 0;
}

/* Decode a JSON string into buf (size buflen). Advances past the string. */
static int jstring(jscan *s, char *buf, size_t buflen)
{
    size_t i = 0;
    jskip_ws(s);
    if (s->p >= s->end || *s->p != '"') {
        s->err = "expected string";
        return -1;
    }
    s->p++;
    while (s->p < s->end && *s->p != '"') {
        unsigned char c = (unsigned char)*s->p++;
        if (c == '\\') {
            if (s->p >= s->end) {
                s->err = "unterminated escape";
                return -1;
            }
            c = (unsigned char)*s->p++;
            switch (c) {
            case '"':
            case '\\':
            case '/':
                break;
            case 'b':
                c = '\b';
                break;
            case 'f':
                c = '\f';
                break;
            case 'n':
                c = '\n';
                break;
            case 'r':
                c = '\r';
                break;
            case 't':
                c = '\t';
                break;
            case 'u': {
                /* Skip 4 hex digits; write '?' for non-ASCII simplicity. */
                unsigned v = 0;
                for (int k = 0; k < 4; k++) {
                    if (s->p >= s->end) {
                        s->err = "bad unicode escape";
                        return -1;
                    }
                    char h = *s->p++;
                    v <<= 4;
                    if (h >= '0' && h <= '9') {
                        v |= (unsigned)(h - '0');
                    } else if (h >= 'a' && h <= 'f') {
                        v |= (unsigned)(h - 'a' + 10);
                    } else if (h >= 'A' && h <= 'F') {
                        v |= (unsigned)(h - 'A' + 10);
                    } else {
                        s->err = "bad unicode escape";
                        return -1;
                    }
                }
                c = (v < 128) ? (unsigned char)v : '?';
                break;
            }
            default:
                s->err = "bad escape";
                return -1;
            }
        }
        if (buf && buflen > 0 && i + 1 < buflen) {
            buf[i++] = (char)c;
        }
    }
    if (s->p >= s->end || *s->p != '"') {
        s->err = "unterminated string";
        return -1;
    }
    s->p++;
    if (buf && buflen > 0) {
        buf[i] = '\0';
    }
    return 0;
}

static int jskip_string(jscan *s)
{
    return jstring(s, NULL, 0);
}

static int jnumber(jscan *s, int64_t *out)
{
    jskip_ws(s);
    const char *start = s->p;
    if (s->p < s->end && (*s->p == '-' || *s->p == '+')) {
        s->p++;
    }
    if (s->p >= s->end || !gh_isdigit((unsigned char)*s->p)) {
        s->err = "expected number";
        return -1;
    }
    while (s->p < s->end && gh_isdigit((unsigned char)*s->p)) {
        s->p++;
    }
    if (s->p < s->end && *s->p == '.') {
        s->p++;
        while (s->p < s->end && gh_isdigit((unsigned char)*s->p)) {
            s->p++;
        }
    }
    if (s->p < s->end && (*s->p == 'e' || *s->p == 'E')) {
        s->p++;
        if (s->p < s->end && (*s->p == '+' || *s->p == '-')) {
            s->p++;
        }
        while (s->p < s->end && gh_isdigit((unsigned char)*s->p)) {
            s->p++;
        }
    }
    if (out) {
        /* Manual decimal parse — avoid strtoll (stdlib). */
        int64_t v = 0;
        int neg = 0;
        const char *q = start;
        if (*q == '-') {
            neg = 1;
            q++;
        } else if (*q == '+') {
            q++;
        }
        while (q < s->p && *q >= '0' && *q <= '9') {
            v = v * 10 + (*q - '0');
            q++;
        }
        *out = neg ? -v : v;
    }
    return 0;
}

static int jskip_value(jscan *s);

static int jskip_object(jscan *s)
{
    if (jexpect(s, '{') != 0) {
        return -1;
    }
    if (jconsume(s, '}')) {
        return 0;
    }
    for (;;) {
        if (jskip_string(s) != 0) {
            return -1;
        }
        if (jexpect(s, ':') != 0) {
            return -1;
        }
        if (jskip_value(s) != 0) {
            return -1;
        }
        if (jconsume(s, '}')) {
            return 0;
        }
        if (jexpect(s, ',') != 0) {
            return -1;
        }
    }
}

static int jskip_array(jscan *s)
{
    if (jexpect(s, '[') != 0) {
        return -1;
    }
    if (jconsume(s, ']')) {
        return 0;
    }
    for (;;) {
        if (jskip_value(s) != 0) {
            return -1;
        }
        if (jconsume(s, ']')) {
            return 0;
        }
        if (jexpect(s, ',') != 0) {
            return -1;
        }
    }
}

static int jskip_value(jscan *s)
{
    int c = jpeek(s);
    if (c == '"') {
        return jskip_string(s);
    }
    if (c == '{') {
        return jskip_object(s);
    }
    if (c == '[') {
        return jskip_array(s);
    }
    if (c == 't') {
        if (s->end - s->p >= 4 && base_memcmp(s->p, "true", 4) == 0) {
            s->p += 4;
            return 0;
        }
        s->err = "bad true";
        return -1;
    }
    if (c == 'f') {
        if (s->end - s->p >= 5 && base_memcmp(s->p, "false", 5) == 0) {
            s->p += 5;
            return 0;
        }
        s->err = "bad false";
        return -1;
    }
    if (c == 'n') {
        if (s->end - s->p >= 4 && base_memcmp(s->p, "null", 4) == 0) {
            s->p += 4;
            return 0;
        }
        s->err = "bad null";
        return -1;
    }
    if (c == '-' || c == '+' || gh_isdigit(c)) {
        return jnumber(s, NULL);
    }
    s->err = "unknown value";
    return -1;
}

static enum gh_test_status parse_test_status(const char *s)
{
    if (!s || !s[0]) {
        return GH_TEST_NULL;
    }
    if (base_strcmp(s, "queued") == 0) {
        return GH_TEST_QUEUED;
    }
    if (base_strcmp(s, "running") == 0) {
        return GH_TEST_RUNNING;
    }
    if (base_strcmp(s, "passed") == 0) {
        return GH_TEST_PASSED;
    }
    if (base_strcmp(s, "failed") == 0) {
        return GH_TEST_FAILED;
    }
    if (base_strcmp(s, "skipped") == 0) {
        return GH_TEST_SKIPPED;
    }
    return GH_TEST_NULL;
}

static void ensure_cap(Arena *arena, gh_pr_list *list)
{
    if (list->count < list->capacity) {
        return;
    }
    size_t ncap = list->capacity ? list->capacity * 2 : 32;
    list->items = (gh_pr *)gh_arena_grow(arena, list->items, list->count, ncap,
                                         sizeof(gh_pr));
    list->capacity = ncap;
}

static int parse_test_run(jscan *s, gh_test_run *run)
{
    base_memset(run, 0, sizeof(*run));
    if (jpeek(s) == 'n') {
        /* null */
        return jskip_value(s);
    }
    if (jexpect(s, '{') != 0) {
        return -1;
    }
    if (jconsume(s, '}')) {
        return 0;
    }
    for (;;) {
        char key[64];
        if (jstring(s, key, sizeof(key)) != 0) {
            return -1;
        }
        if (jexpect(s, ':') != 0) {
            return -1;
        }
        if (base_strcmp(key, "status") == 0) {
            if (jpeek(s) == 'n') {
                jskip_value(s);
                run->status = GH_TEST_NULL;
            } else if (jpeek(s) == '"') {
                char st[32];
                if (jstring(s, st, sizeof(st)) != 0) {
                    return -1;
                }
                run->status = parse_test_status(st);
            } else {
                if (jskip_value(s) != 0) {
                    return -1;
                }
            }
        } else if (base_strcmp(key, "headSha") == 0) {
            if (jpeek(s) == 'n') {
                jskip_value(s);
            } else if (jpeek(s) == '"') {
                if (jstring(s, run->head_sha, sizeof(run->head_sha)) != 0) {
                    return -1;
                }
            } else {
                if (jskip_value(s) != 0) {
                    return -1;
                }
            }
        } else if (base_strcmp(key, "logUrl") == 0) {
            if (jpeek(s) == 'n') {
                jskip_value(s);
            } else if (jpeek(s) == '"') {
                if (jstring(s, run->log_url, sizeof(run->log_url)) != 0) {
                    return -1;
                }
            } else {
                if (jskip_value(s) != 0) {
                    return -1;
                }
            }
        } else {
            if (jskip_value(s) != 0) {
                return -1;
            }
        }
        if (jconsume(s, '}')) {
            return 0;
        }
        if (jexpect(s, ',') != 0) {
            return -1;
        }
    }
}

static enum gh_review_verdict parse_review_verdict(const char *s)
{
    if (!s || !s[0]) {
        return GH_REVIEW_NONE;
    }
    if (base_strcmp(s, "APPROVE") == 0) {
        return GH_REVIEW_APPROVE;
    }
    if (base_strcmp(s, "COMMENT") == 0) {
        return GH_REVIEW_COMMENT;
    }
    if (base_strcmp(s, "REQUEST_CHANGES") == 0) {
        return GH_REVIEW_REQUEST_CHANGES;
    }
    return GH_REVIEW_COMMENT; /* unknown but present → treat as comment */
}

static int parse_local_review(jscan *s, gh_local_review *rev)
{
    base_memset(rev, 0, sizeof(*rev));
    rev->verdict = GH_REVIEW_NONE;
    if (jpeek(s) == 'n') {
        return jskip_value(s);
    }
    if (jexpect(s, '{') != 0) {
        return -1;
    }
    if (jconsume(s, '}')) {
        /* empty object — treat as no useful review */
        return 0;
    }
    for (;;) {
        char key[64];
        if (jstring(s, key, sizeof(key)) != 0) {
            return -1;
        }
        if (jexpect(s, ':') != 0) {
            return -1;
        }
        if (base_strcmp(key, "verdict") == 0) {
            if (jpeek(s) == 'n') {
                jskip_value(s);
            } else if (jpeek(s) == '"') {
                char v[32];
                if (jstring(s, v, sizeof(v)) != 0) {
                    return -1;
                }
                rev->verdict = parse_review_verdict(v);
            } else {
                if (jskip_value(s) != 0) {
                    return -1;
                }
            }
        } else if (base_strcmp(key, "status") == 0) {
            if (jpeek(s) == 'n') {
                jskip_value(s);
            } else if (jpeek(s) == '"') {
                if (jstring(s, rev->status, sizeof(rev->status)) != 0) {
                    return -1;
                }
            } else {
                if (jskip_value(s) != 0) {
                    return -1;
                }
            }
        } else {
            if (jskip_value(s) != 0) {
                return -1;
            }
        }
        if (jconsume(s, '}')) {
            /* If API sent an object without verdict, still mark as COMMENT. */
            if (rev->verdict == GH_REVIEW_NONE &&
                (rev->status[0] != '\0')) {
                rev->verdict = GH_REVIEW_COMMENT;
            }
            return 0;
        }
        if (jexpect(s, ',') != 0) {
            return -1;
        }
    }
}

static int parse_pr(jscan *s, gh_pr *pr)
{
    base_memset(pr, 0, sizeof(*pr));
    pr->mergeable = GH_MERGEABLE_NULL;
    pr->local_review.verdict = GH_REVIEW_NONE;

    if (jexpect(s, '{') != 0) {
        return -1;
    }
    if (jconsume(s, '}')) {
        return 0;
    }
    for (;;) {
        char key[64];
        if (jstring(s, key, sizeof(key)) != 0) {
            return -1;
        }
        if (jexpect(s, ':') != 0) {
            return -1;
        }

        if (base_strcmp(key, "id") == 0) {
            if (jnumber(s, &pr->id) != 0) {
                return -1;
            }
        } else if (base_strcmp(key, "number") == 0) {
            int64_t n = 0;
            if (jnumber(s, &n) != 0) {
                return -1;
            }
            pr->number = (int)n;
        } else if (base_strcmp(key, "title") == 0) {
            if (jstring(s, pr->title, sizeof(pr->title)) != 0) {
                return -1;
            }
        } else if (base_strcmp(key, "state") == 0) {
            if (jstring(s, pr->state, sizeof(pr->state)) != 0) {
                return -1;
            }
        } else if (base_strcmp(key, "draft") == 0) {
            int c = jpeek(s);
            if (c == 't') {
                pr->draft = true;
                jskip_value(s);
            } else if (c == 'f') {
                pr->draft = false;
                jskip_value(s);
            } else {
                jskip_value(s);
            }
        } else if (base_strcmp(key, "merged") == 0) {
            int c = jpeek(s);
            if (c == 't') {
                pr->merged = true;
                jskip_value(s);
            } else {
                pr->merged = false;
                jskip_value(s);
            }
        } else if (base_strcmp(key, "mergeable") == 0) {
            int c = jpeek(s);
            if (c == 't') {
                pr->mergeable = GH_MERGEABLE_TRUE;
                jskip_value(s);
            } else if (c == 'f') {
                pr->mergeable = GH_MERGEABLE_FALSE;
                jskip_value(s);
            } else {
                pr->mergeable = GH_MERGEABLE_NULL;
                jskip_value(s);
            }
        } else if (base_strcmp(key, "mergeableState") == 0) {
            if (jpeek(s) == 'n') {
                jskip_value(s);
            } else if (jpeek(s) == '"') {
                if (jstring(s, pr->mergeable_state,
                            sizeof(pr->mergeable_state)) != 0) {
                    return -1;
                }
            } else {
                jskip_value(s);
            }
        } else if (base_strcmp(key, "headRef") == 0) {
            if (jpeek(s) == '"') {
                if (jstring(s, pr->head_ref, sizeof(pr->head_ref)) != 0) {
                    return -1;
                }
            } else {
                jskip_value(s);
            }
        } else if (base_strcmp(key, "baseRef") == 0) {
            if (jpeek(s) == '"') {
                if (jstring(s, pr->base_ref, sizeof(pr->base_ref)) != 0) {
                    return -1;
                }
            } else {
                jskip_value(s);
            }
        } else if (base_strcmp(key, "createdAt") == 0) {
            if (jnumber(s, &pr->created_at) != 0) {
                return -1;
            }
        } else if (base_strcmp(key, "updatedAt") == 0) {
            if (jnumber(s, &pr->updated_at) != 0) {
                return -1;
            }
        } else if (base_strcmp(key, "authorLogin") == 0) {
            if (jpeek(s) == '"') {
                if (jstring(s, pr->author_login, sizeof(pr->author_login)) != 0) {
                    return -1;
                }
            } else {
                jskip_value(s);
            }
        } else if (base_strcmp(key, "htmlUrl") == 0) {
            if (jpeek(s) == '"') {
                if (jstring(s, pr->html_url, sizeof(pr->html_url)) != 0) {
                    return -1;
                }
            } else {
                jskip_value(s);
            }
        } else if (base_strcmp(key, "quickTest") == 0) {
            if (parse_test_run(s, &pr->quick) != 0) {
                return -1;
            }
        } else if (base_strcmp(key, "exhaustiveTest") == 0) {
            if (parse_test_run(s, &pr->exhaustive) != 0) {
                return -1;
            }
        } else if (base_strcmp(key, "localReview") == 0) {
            if (parse_local_review(s, &pr->local_review) != 0) {
                return -1;
            }
        } else {
            if (jskip_value(s) != 0) {
                return -1;
            }
        }

        if (jconsume(s, '}')) {
            return 0;
        }
        if (jexpect(s, ',') != 0) {
            return -1;
        }
    }
}

int gh_pr_list_parse(Arena *arena, const char *json, gh_pr_list *list)
{
    jscan s;
    s.p = json;
    s.end = json + base_strlen(json);
    s.err = NULL;

    gh_pr_list_init(list);

    if (jexpect(&s, '{') != 0) {
        gh_eprintf("githost: JSON parse error: %s\n",
                s.err ? s.err : "expected object");
        return -1;
    }
    if (jconsume(&s, '}')) {
        return 0;
    }

    for (;;) {
        char key[64];
        if (jstring(&s, key, sizeof(key)) != 0) {
            gh_eprintf("githost: JSON parse error: %s\n",
                    s.err ? s.err : "key");
            return -1;
        }
        if (jexpect(&s, ':') != 0) {
            gh_eprintf("githost: JSON parse error: %s\n",
                    s.err ? s.err : "colon");
            return -1;
        }

        if (base_strcmp(key, "items") == 0) {
            if (jexpect(&s, '[') != 0) {
                gh_eprintf("githost: JSON parse error: expected items array\n");
                return -1;
            }
            if (!jconsume(&s, ']')) {
                for (;;) {
                    ensure_cap(arena, list);
                    if (parse_pr(&s, &list->items[list->count]) != 0) {
                        gh_eprintf("githost: JSON parse error in PR: %s\n",
                                s.err ? s.err : "pr");
                        return -1;
                    }
                    list->count++;
                    if (jconsume(&s, ']')) {
                        break;
                    }
                    if (jexpect(&s, ',') != 0) {
                        gh_eprintf("githost: JSON parse error: %s\n",
                                s.err ? s.err : "comma in items");
                        return -1;
                    }
                }
            }
        } else if (base_strcmp(key, "limit") == 0) {
            int64_t n = 0;
            if (jnumber(&s, &n) != 0) {
                return -1;
            }
            list->limit = (int)n;
        } else if (base_strcmp(key, "offset") == 0) {
            int64_t n = 0;
            if (jnumber(&s, &n) != 0) {
                return -1;
            }
            list->offset = (int)n;
        } else {
            if (jskip_value(&s) != 0) {
                gh_eprintf("githost: JSON parse error: %s\n",
                        s.err ? s.err : "value");
                return -1;
            }
        }

        if (jconsume(&s, '}')) {
            break;
        }
        if (jexpect(&s, ',') != 0) {
            gh_eprintf("githost: JSON parse error: %s\n",
                    s.err ? s.err : "object comma");
            return -1;
        }
    }
    return 0;
}
