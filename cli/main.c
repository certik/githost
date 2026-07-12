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
        "  pr list          List open PRs grouped like the web UI\n"
        "  pr view <n>      Show details for PR number <n>\n"
        "  review           Local review helpers (stub for future upload)\n"
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
        "Review workflow (future):\n"
        "  githost review path <n>     Print local review file path\n"
        "  githost review init <n>     Create a local review stub\n"
        "  githost review submit <n>   Upload (not implemented yet)\n"
        "\n"
        "Examples:\n"
        "  githost\n"
        "  githost pr list --passed\n"
        "  githost pr list --group conflict\n"
        "  githost pr view 12028\n",
        GITHOST_DEFAULT_URL, GITHOST_DEFAULT_URL);
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

static void review_path(Arena *arena, int number, char *buf, size_t buflen)
{
    const char *home = gh_getenv(arena, "HOME");
    if (!home) {
        home = ".";
    }
    base_snprintf(buf, buflen, "%s/.githost/reviews/%d.md", home, number);
}

static int write_review_file(const char *path, int number)
{
    platform_fd_t fd;
    char body[1024];
    int n;
    size_t nwritten;
    ciovec_t iov;

    n = base_snprintf(
        body, sizeof(body),
        "# Review for PR #%d\n"
        "\n"
        "<!-- Written by githost " GITHOST_VERSION " -->\n"
        "<!-- Upload with: githost review submit %d (coming soon) -->\n"
        "\n"
        "## Summary\n"
        "\n"
        "\n"
        "## Verdict\n"
        "\n"
        "- [ ] Approve\n"
        "- [ ] Request changes\n"
        "- [ ] Comment only\n"
        "\n"
        "## Notes\n"
        "\n",
        number, number);
    if (n < 0) {
        return -1;
    }

    fd = platform_path_open(path, base_strlen(path), PLATFORM_RIGHTS_WRITE,
                            PLATFORM_O_CREAT | PLATFORM_O_TRUNC);
    if (fd < 0) {
        return -1;
    }
    iov.buf = body;
    iov.buf_len = (size_t)n;
    if (platform_fd_write(fd, &iov, 1, &nwritten) != 0) {
        platform_fd_close(fd);
        return -1;
    }
    platform_fd_close(fd);
    return 0;
}

static int cmd_review(Arena *arena, int argc, char **argv)
{
    char path[1024];
    int number;
    const char *sub;

    if (argc < 1) {
        gh_eprintf(
            "githost review — local reviews (upload not implemented yet)\n"
            "\n"
            "  githost review path <n>\n"
            "  githost review init <n>\n"
            "  githost review submit <n>   (stub)\n");
        return 2;
    }
    sub = argv[0];
    if (argc < 2) {
        gh_eprintf("githost: review %s requires a PR number\n", sub);
        return 2;
    }
    number = gh_atoi(argv[1]);
    if (number <= 0) {
        gh_eprintf("githost: invalid PR number: %s\n", argv[1]);
        return 2;
    }
    review_path(arena, number, path, sizeof(path));

    if (base_strcmp(sub, "path") == 0) {
        gh_printf("%s\n", path);
        return 0;
    }
    if (base_strcmp(sub, "init") == 0) {
        if (write_review_file(path, number) != 0) {
            /* Fallback: cwd file if ~/.githost/reviews does not exist. */
            base_snprintf(path, sizeof(path), "githost-review-%d.md", number);
            if (write_review_file(path, number) != 0) {
                gh_eprintf(
                    "githost: failed to write review file (create "
                    "~/.githost/reviews or use cwd)\n");
                return 1;
            }
        }
        gh_printf("Created %s\n", path);
        return 0;
    }
    if (base_strcmp(sub, "submit") == 0) {
        gh_eprintf(
            "githost: review submit is not implemented yet.\n"
            "  Local file would be: %s\n"
            "  Future: POST to the githost API so the review appears online.\n",
            path);
        return 1;
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
        rc = cmd_review(arena, argc - i, argv + i);
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
