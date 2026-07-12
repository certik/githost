#include "githost.h"
#include "out.h"
#include "util.h"

#include <base/numconv.h>
#include <platform/platform.h>

static void usage(void)
{
    gh_printf(
        "githost — CLI for %s\n"
        "\n"
        "Usage:\n"
        "  githost [global options] <command> [args]\n"
        "  githost [global options]              # same as: pr list\n"
        "\n"
        "Commands:\n"
        "  login            Browser login; saves ~/.githost/session\n"
        "  pr list          List open PRs grouped like the web UI\n"
        "  pr view <n>      Show details for PR number <n>\n"
        "  review           Local review upload (agent-agnostic JSON)\n"
        "  help             Show this help\n"
        "  version          Show version\n"
        "\n"
        "Global options:\n"
        "  --url <url>      API base URL (default: %s)\n"
        "  --no-color       Disable ANSI colors\n"
        "  -h, --help       Show help\n"
        "\n"
        "pr list options:\n"
        "  --passed         Only \"Quick + Exhaustive passed\" (group 0)\n"
        "  --group <name>   Filter one priority group (see below)\n"
        "  --drafts         Include the Draft section\n"
        "  --all            Ready groups + drafts\n"
        "  --json           Machine-readable JSON of matching PRs\n"
        "\n"
        "Group names for --group:\n"
        "  passed | conflict | exhaustive-running | exhaustive-queued\n"
        "  exhaustive-skipped | exhaustive-not-run | exhaustive-failed\n"
        "  quick-running | quick-queued | quick-skipped | quick-failed\n"
        "  other | <numeric key 0,1,2,...>\n"
        "\n"
        "Review workflow (any agent):\n"
        "  1. githost pr view <n>\n"
        "  2. Agent writes githost.review/v1 JSON (see cli/docs/REVIEW.md)\n"
        "  3. githost login --url http://127.0.0.1:8787   # once\n"
        "  4. githost review submit <n> --file review.v1.json\n"
        "  5. Review appears in the web UI under local reviews\n"
        "\n"
        "  githost review init <n>              Write a JSON template\n"
        "  githost review submit <n> --file f   POST review to the server\n"
        "  githost review list <n>              List local reviews (auth)\n"
        "  githost review schema                Print the JSON schema blurb\n"
        "\n"
        "Examples:\n"
        "  githost\n"
        "  githost pr list --passed\n"
        "  githost pr list --group conflict\n"
        "  githost pr view 12028\n"
        "  githost login --url http://127.0.0.1:8787\n"
        "  githost review submit 12028 --file review.v1.json\n",
        GITHOST_DEFAULT_URL, GITHOST_DEFAULT_URL);
}

static int cmd_login(Arena *arena, const char *base_url, int argc, char **argv)
{
    const char *login_name = NULL;
    int i;
    for (i = 0; i < argc; i++) {
        if (base_strcmp(argv[i], "--login") == 0 ||
            base_strcmp(argv[i], "-u") == 0) {
            if (i + 1 >= argc) {
                gh_eprintf("githost: --login requires a name\n");
                return 2;
            }
            login_name = argv[++i];
        } else if (base_strcmp(argv[i], "-h") == 0 ||
                   base_strcmp(argv[i], "--help") == 0) {
            gh_printf(
                "Usage: githost [--url URL] login [--login NAME]\n"
                "\n"
                "Opens a browser to the githost web app to create a session,\n"
                "then saves it to ~/.githost/session for review submit/list.\n"
                "\n"
                "Local:  githost --url http://127.0.0.1:8787 login\n"
                "        githost --url http://127.0.0.1:8787 login --login alice\n"
                "Prod:   githost login   # GitHub OAuth via the deployed site\n");
            return 0;
        } else {
            gh_eprintf("githost: unknown login option: %s\n", argv[i]);
            return 2;
        }
    }
    return gh_cmd_login(arena, base_url, login_name);
}

static int fetch_prs(Arena *arena, const char *base_url, gh_pr_list *list)
{
    char url[1024];
    gh_buf body;
    long code = 0;
    int rc;
    size_t n;

    /*
     * Match the SPA default "Open" filter: anonymous /api/prs is capped at 50
     * rows. Without state=open those 50 mix open+closed and many ready PRs are
     * pushed out of the window (web shows 14 both-passed; unfiltered showed 7).
     */
    base_snprintf(url, sizeof(url), "%s/api/prs?state=open", base_url);
    n = base_strlen(base_url);
    if (n > 0 && base_url[n - 1] == '/') {
        base_snprintf(url, sizeof(url), "%sapi/prs?state=open", base_url);
    }

    rc = gh_http_get(arena, url, &body, &code);
    if (rc != 0) {
        return -1;
    }
    return gh_pr_list_parse(arena, body.data, list);
}

static int cmd_pr_list(Arena *arena, const char *base_url, int argc, char **argv,
                       bool color)
{
    gh_display_opts opts;
    gh_pr_list list;
    int i;
    int rc;

    base_memset(&opts, 0, sizeof(opts));
    opts.color = color;
    opts.filter_priority = -1;
    opts.show_drafts = false;
    opts.show_closed = false;
    opts.json_out = false;
    opts.now_ms = 0;

    for (i = 0; i < argc; i++) {
        if (base_strcmp(argv[i], "--passed") == 0) {
            opts.filter_priority = GH_PRI_PASSED;
        } else if (base_strcmp(argv[i], "--group") == 0) {
            if (i + 1 >= argc) {
                gh_eprintf("githost: --group requires a name or key\n");
                return 2;
            }
            i++;
            opts.filter_priority = gh_parse_group_name(argv[i]);
            if (opts.filter_priority == -2) {
                gh_eprintf("githost: unknown group '%s'\n", argv[i]);
                return 2;
            }
        } else if (base_strcmp(argv[i], "--drafts") == 0) {
            opts.show_drafts = true;
        } else if (base_strcmp(argv[i], "--all") == 0) {
            opts.show_drafts = true;
            opts.filter_priority = -1;
        } else if (base_strcmp(argv[i], "--json") == 0) {
            opts.json_out = true;
            opts.color = false;
        } else if (base_strcmp(argv[i], "--no-color") == 0) {
            opts.color = false;
        } else if (base_strcmp(argv[i], "-h") == 0 ||
                   base_strcmp(argv[i], "--help") == 0) {
            usage();
            return 0;
        } else {
            gh_eprintf("githost: unknown option for pr list: %s\n", argv[i]);
            return 2;
        }
    }

    gh_pr_list_init(&list);
    rc = fetch_prs(arena, base_url, &list);
    if (rc != 0) {
        return 1;
    }

    opts.now_ms = gh_now_ms(&list);
    gh_display_pr_list(arena, &list, &opts);
    return 0;
}

static int cmd_pr_view(Arena *arena, const char *base_url, int argc, char **argv,
                       bool color)
{
    gh_pr_list list;
    int number = -1;
    size_t i;
    int rc;
    int a;

    for (a = 0; a < argc; a++) {
        if (base_strcmp(argv[a], "--no-color") == 0) {
            color = false;
        } else if (argv[a][0] == '-') {
            gh_eprintf("githost: unknown option for pr view: %s\n", argv[a]);
            return 2;
        } else if (number < 0) {
            number = gh_atoi(argv[a]);
        } else {
            gh_eprintf("githost: unexpected argument: %s\n", argv[a]);
            return 2;
        }
    }
    if (number <= 0) {
        gh_eprintf("githost: usage: githost pr view <number>\n");
        return 2;
    }

    gh_pr_list_init(&list);
    rc = fetch_prs(arena, base_url, &list);
    if (rc != 0) {
        return 1;
    }

    for (i = 0; i < list.count; i++) {
        if (list.items[i].number == number) {
            gh_display_pr(&list.items[i], color, gh_now_ms(&list));
            return 0;
        }
    }

    gh_eprintf("githost: PR #%d not in public /api/prs snapshot (%zu items).\n",
               number, list.count);
    return 1;
}

static void review_default_path(Arena *arena, int number, char *buf,
                                size_t buflen)
{
    const char *home = gh_getenv(arena, "HOME");
    if (!home) {
        home = ".";
    }
    base_snprintf(buf, buflen, "%s/.githost/reviews/%d.v1.json", home, number);
}

static int write_bytes(const char *path, const char *data, size_t len)
{
    platform_fd_t fd;
    size_t nwritten;
    ciovec_t iov;

    fd = platform_path_open(path, base_strlen(path), PLATFORM_RIGHTS_WRITE,
                            PLATFORM_O_CREAT | PLATFORM_O_TRUNC);
    if (fd < 0) {
        return -1;
    }
    iov.buf = data;
    iov.buf_len = len;
    if (platform_fd_write(fd, &iov, 1, &nwritten) != 0) {
        platform_fd_close(fd);
        return -1;
    }
    platform_fd_close(fd);
    return 0;
}

static int write_review_template(const char *path, int number)
{
    char body[1024];
    int n;

    n = base_snprintf(
        body, sizeof(body),
        "{\n"
        "  \"schema\": \"githost.review/v1\",\n"
        "  \"pr\": %d,\n"
        "  \"headSha\": \"REPLACE_WITH_PR_HEAD_SHA\",\n"
        "  \"verdict\": \"COMMENT\",\n"
        "  \"summary\": \"Overall assessment in markdown.\\n\\n\",\n"
        "  \"comments\": [\n"
        "    {\n"
        "      \"path\": \"path/to/file.ext\",\n"
        "      \"line\": 1,\n"
        "      \"body\": \"Inline comment in markdown.\"\n"
        "    }\n"
        "  ],\n"
        "  \"meta\": {\n"
        "    \"model\": \"agent-or-human-name\"\n"
        "  }\n"
        "}\n",
        number);
    if (n < 0) {
        return -1;
    }
    return write_bytes(path, body, (size_t)n);
}

/* Session cookie for authenticated API calls. */
static const char *load_session(Arena *arena)
{
    const char *env = gh_getenv(arena, "GITHOST_SESSION");
    char path[512];
    char *data = NULL;
    const char *home;

    if (env && env[0]) {
        return env;
    }
    home = gh_getenv(arena, "HOME");
    if (!home) {
        return NULL;
    }
    base_snprintf(path, sizeof(path), "%s/.githost/session", home);
    if (gh_read_file(arena, path, &data, NULL) != 0 || !data || !data[0]) {
        return NULL;
    }
    /* Trim trailing whitespace/newlines. */
    {
        size_t n = base_strlen(data);
        while (n > 0 && (data[n - 1] == '\n' || data[n - 1] == '\r' ||
                         data[n - 1] == ' ' || data[n - 1] == '\t')) {
            data[--n] = '\0';
        }
    }
    return data[0] ? data : NULL;
}

static void join_url(char *buf, size_t buflen, const char *base, const char *path)
{
    size_t n = base_strlen(base);
    if (n > 0 && base[n - 1] == '/') {
        base_snprintf(buf, buflen, "%s%s", base, path[0] == '/' ? path + 1 : path);
    } else {
        base_snprintf(buf, buflen, "%s%s", base, path);
    }
}

/* Minimal check that the document looks like githost.review/v1. */
static int review_json_sanity(const char *json, int expected_pr)
{
    if (!json || json[0] != '{') {
        gh_eprintf("githost: review file must be a JSON object\n");
        return -1;
    }
    if (base_strstr(json, "headSha") == NULL &&
        base_strstr(json, "\"head_sha\"") == NULL) {
        gh_eprintf("githost: review JSON must include headSha\n");
        return -1;
    }
    (void)expected_pr;
    return 0;
}

static void print_review_schema(void)
{
    gh_print(
        "{\n"
        "  \"schema\": \"githost.review/v1\",\n"
        "  \"pr\": 12028,\n"
        "  \"headSha\": \"<commit sha of the PR head>\",\n"
        "  \"verdict\": \"COMMENT | APPROVE | REQUEST_CHANGES\",\n"
        "  \"summary\": \"Main review body (markdown)\",\n"
        "  \"comments\": [\n"
        "    { \"path\": \"file.ext\", \"line\": 42, \"body\": \"…\" },\n"
        "    { \"path\": \"file.ext\", \"startLine\": 10, \"line\": 18,\n"
        "      \"side\": \"RIGHT\", \"body\": \"multi-line …\" }\n"
        "  ],\n"
        "  \"meta\": { \"model\": \"any-agent-or-human\" }\n"
        "}\n");
}

static int cmd_review_submit(Arena *arena, const char *base_url, int number,
                             const char *file_path)
{
    const char *session;
    char *json = NULL;
    char url[1024];
    char pathbuf[64];
    gh_buf resp;
    long code = 0;

    if (!file_path || !file_path[0]) {
        gh_eprintf("githost: review submit requires --file <path>\n");
        return 2;
    }
    session = load_session(arena);
    if (!session) {
        gh_eprintf(
            "githost: not authenticated.\n"
            "  Run:  githost --url %s login\n"
            "  Or set GITHOST_SESSION / write the session id to ~/.githost/session\n",
            base_url);
        return 1;
    }
    if (gh_read_file(arena, file_path, &json, NULL) != 0) {
        return 1;
    }
    if (review_json_sanity(json, number) != 0) {
        return 1;
    }

    base_snprintf(pathbuf, sizeof(pathbuf), "/api/prs/%d/reviews", number);
    join_url(url, sizeof(url), base_url, pathbuf);

    if (gh_http_post_json(arena, url, session, json, &resp, &code) != 0) {
        return 1;
    }
    gh_printf("Uploaded review for PR #%d (HTTP %ld)\n", number, code);
    if (resp.data && resp.len > 0) {
        gh_printf("%s\n", resp.data);
    }
    return 0;
}

static int cmd_review_list(Arena *arena, const char *base_url, int number)
{
    const char *session;
    char url[1024];
    char pathbuf[64];
    gh_buf resp;
    long code = 0;

    session = load_session(arena);
    if (!session) {
        gh_eprintf("githost: not authenticated (GITHOST_SESSION / ~/.githost/session)\n");
        return 1;
    }
    base_snprintf(pathbuf, sizeof(pathbuf), "/api/prs/%d", number);
    join_url(url, sizeof(url), base_url, pathbuf);
    if (gh_http_get_auth(arena, url, session, &resp, &code) != 0) {
        return 1;
    }
    gh_printf("%s\n", resp.data ? resp.data : "");
    return 0;
}

static int cmd_review(Arena *arena, const char *base_url, int argc, char **argv)
{
    char path[1024];
    int number = -1;
    const char *sub;
    const char *file_path = NULL;
    int i;

    if (argc < 1) {
        gh_eprintf(
            "githost review — local reviews (agent-agnostic JSON)\n"
            "\n"
            "  githost review schema\n"
            "  githost review init <n>\n"
            "  githost review submit <n> --file review.v1.json\n"
            "  githost review list <n>\n"
            "  githost review path <n>\n");
        return 2;
    }
    sub = argv[0];

    if (base_strcmp(sub, "schema") == 0) {
        print_review_schema();
        return 0;
    }

    /* Remaining subcommands need a PR number as argv[1]. */
    if (argc < 2) {
        gh_eprintf("githost: review %s requires a PR number\n", sub);
        return 2;
    }
    number = gh_atoi(argv[1]);
    if (number <= 0) {
        gh_eprintf("githost: invalid PR number: %s\n", argv[1]);
        return 2;
    }

    for (i = 2; i < argc; i++) {
        if (base_strcmp(argv[i], "--file") == 0 ||
            base_strcmp(argv[i], "-f") == 0) {
            if (i + 1 >= argc) {
                gh_eprintf("githost: --file requires a path\n");
                return 2;
            }
            file_path = argv[++i];
        } else {
            gh_eprintf("githost: unknown option: %s\n", argv[i]);
            return 2;
        }
    }

    review_default_path(arena, number, path, sizeof(path));

    if (base_strcmp(sub, "path") == 0) {
        gh_printf("%s\n", path);
        return 0;
    }
    if (base_strcmp(sub, "init") == 0) {
        if (write_review_template(path, number) != 0) {
            base_snprintf(path, sizeof(path), "review-%d.v1.json", number);
            if (write_review_template(path, number) != 0) {
                gh_eprintf(
                    "githost: failed to write review template "
                    "(create ~/.githost/reviews or use cwd)\n");
                return 1;
            }
        }
        gh_printf("Created %s\n", path);
        gh_printf("Edit the file (any agent), then:\n");
        gh_printf("  githost review submit %d --file %s\n", number, path);
        return 0;
    }
    if (base_strcmp(sub, "submit") == 0) {
        if (!file_path) {
            file_path = path; /* default path if --file omitted */
        }
        return cmd_review_submit(arena, base_url, number, file_path);
    }
    if (base_strcmp(sub, "list") == 0) {
        return cmd_review_list(arena, base_url, number);
    }

    gh_eprintf("githost: unknown review subcommand: %s\n", sub);
    return 2;
}

int main(int argc, char **argv)
{
    const char *base_url = GITHOST_DEFAULT_URL;
    bool color = true; /* no isatty in platform; disable with --no-color */
    int i = 1;
    int rc;
    Arena *arena;

    /* Hosted process environment (no unistd.h — just the symbol). */
    {
        extern char **environ;
        platform_init(argc, argv, environ);
    }
    arena = arena_create(64 * 1024);

    gh_http_global_init();

    while (i < argc && argv[i][0] == '-') {
        if (base_strcmp(argv[i], "--url") == 0) {
            if (i + 1 >= argc) {
                gh_eprintf("githost: --url requires a value\n");
                rc = 2;
                goto done;
            }
            base_url = argv[++i];
        } else if (base_strcmp(argv[i], "--no-color") == 0) {
            color = false;
        } else if (base_strcmp(argv[i], "-h") == 0 ||
                   base_strcmp(argv[i], "--help") == 0) {
            usage();
            rc = 0;
            goto done;
        } else if (base_strcmp(argv[i], "--version") == 0) {
            gh_printf("githost %s\n", GITHOST_VERSION);
            rc = 0;
            goto done;
        } else {
            break;
        }
        i++;
    }

    if (i >= argc) {
        rc = cmd_pr_list(arena, base_url, 0, NULL, color);
        goto done;
    }

    if (base_strcmp(argv[i], "help") == 0) {
        usage();
        rc = 0;
        goto done;
    }
    if (base_strcmp(argv[i], "version") == 0) {
        gh_printf("githost %s\n", GITHOST_VERSION);
        rc = 0;
        goto done;
    }
    if (base_strcmp(argv[i], "login") == 0) {
        i++;
        rc = cmd_login(arena, base_url, argc - i, argv + i);
        goto done;
    }
    if (base_strcmp(argv[i], "pr") == 0) {
        i++;
        if (i >= argc || base_strcmp(argv[i], "list") == 0) {
            if (i < argc && base_strcmp(argv[i], "list") == 0) {
                i++;
            }
            rc = cmd_pr_list(arena, base_url, argc - i, argv + i, color);
            goto done;
        }
        if (base_strcmp(argv[i], "view") == 0) {
            i++;
            rc = cmd_pr_view(arena, base_url, argc - i, argv + i, color);
            goto done;
        }
        gh_eprintf("githost: unknown pr subcommand: %s\n", argv[i]);
        rc = 2;
        goto done;
    }
    if (base_strcmp(argv[i], "list") == 0) {
        i++;
        rc = cmd_pr_list(arena, base_url, argc - i, argv + i, color);
        goto done;
    }
    if (base_strcmp(argv[i], "review") == 0) {
        i++;
        rc = cmd_review(arena, base_url, argc - i, argv + i);
        goto done;
    }

    if (argv[i][0] == '-') {
        rc = cmd_pr_list(arena, base_url, argc - i, argv + i, color);
        goto done;
    }

    gh_eprintf("githost: unknown command: %s\n", argv[i]);
    gh_eprintf("Try: githost help\n");
    rc = 2;

done:
    gh_http_global_cleanup();
    arena_destroy(arena);
    return rc;
}
