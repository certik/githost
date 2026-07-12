/*
 * Browser-assisted CLI login without C stdlib / sockets.
 *
 * Device-code style (RFC 8628-ish):
 *   1. POST /auth/cli-device/start  → device_code + user_code + URL
 *   2. User opens verification URL in a browser (printed; not auto-opened)
 *   3. POST /auth/cli-device/poll until authorized
 *   4. Write session id via platform file I/O to ~/.githost/session
 *
 * Only base/ + platform/ + libcurl (HTTPS).
 */

#include "githost.h"
#include "out.h"
#include "util.h"

#include <base/numconv.h>
#include <platform/platform.h>

#include <curl/curl.h>

/* Busy-wait approx ms using curl connect timeout (no unistd sleep). */
static void gh_sleep_ms(long ms)
{
    CURL *c;
    if (ms < 100) {
        ms = 100;
    }
    c = curl_easy_init();
    if (!c) {
        return;
    }
    /* Non-routable; curl spends ~ms trying to connect then fails. */
    curl_easy_setopt(c, CURLOPT_URL, "http://10.255.255.1:9/");
    curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT_MS, ms);
    curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, ms);
    curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
    (void)curl_easy_perform(c);
    curl_easy_cleanup(c);
}

static int write_session_file(Arena *arena, const char *session_id)
{
    const char *home = gh_getenv(arena, "HOME");
    char path[512];
    platform_fd_t fd;
    ciovec_t iov;
    size_t nwritten;
    char line[300];
    int n;

    if (!home) {
        home = ".";
    }
    base_snprintf(path, sizeof(path), "%s/.githost/session", home);
    n = base_snprintf(line, sizeof(line), "%s\n", session_id);
    if (n < 0) {
        return -1;
    }

    fd = platform_path_open(path, base_strlen(path), PLATFORM_RIGHTS_WRITE,
                            PLATFORM_O_CREAT | PLATFORM_O_TRUNC);
    if (fd < 0) {
        /* Parent dir may be missing — try cwd fallback. */
        base_snprintf(path, sizeof(path), ".githost-session");
        fd = platform_path_open(path, base_strlen(path), PLATFORM_RIGHTS_WRITE,
                                PLATFORM_O_CREAT | PLATFORM_O_TRUNC);
        if (fd < 0) {
            gh_eprintf(
                "githost: cannot write session file.\n"
                "  Create ~/.githost/ then re-run, or:\n"
                "  export GITHOST_SESSION='%s'\n",
                session_id);
            return -1;
        }
    }
    iov.buf = line;
    iov.buf_len = (size_t)n;
    if (platform_fd_write(fd, &iov, 1, &nwritten) != 0) {
        platform_fd_close(fd);
        return -1;
    }
    platform_fd_close(fd);
    gh_printf("Wrote session to %s\n", path);
    return 0;
}

/* Extract "key":"value" string (simple, no escapes in values we set). */
static int json_get_string(const char *json, const char *key, char *out,
                           size_t outlen)
{
    char pat[96];
    const char *p;
    size_t i = 0;
    base_snprintf(pat, sizeof(pat), "\"%s\"", key);
    p = base_strstr(json, pat);
    if (!p) {
        return -1;
    }
    p = base_strchr(p + base_strlen(pat), ':');
    if (!p) {
        return -1;
    }
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') {
        p++;
    }
    if (*p != '"') {
        return -1;
    }
    p++;
    while (*p && *p != '"' && i + 1 < outlen) {
        out[i++] = *p++;
    }
    out[i] = '\0';
    return i > 0 ? 0 : -1;
}

static void join_url(char *buf, size_t buflen, const char *base, const char *path)
{
    size_t n = base_strlen(base);
    if (n > 0 && base[n - 1] == '/') {
        base_snprintf(buf, buflen, "%s%s", base,
                      path[0] == '/' ? path + 1 : path);
    } else {
        base_snprintf(buf, buflen, "%s%s", base, path);
    }
}

int gh_cmd_login(Arena *arena, const char *base_url, const char *login_name)
{
    char url[1024];
    char body[256];
    gh_buf resp;
    long code = 0;
    char device_code[128];
    char user_code[64];
    char verification[512];
    char poll_body[256];
    char session[256];
    char login_out[64];
    char status[32];
    int attempts;
    int n;

    join_url(url, sizeof(url), base_url, "/auth/cli-device/start");
    if (login_name && login_name[0]) {
        n = base_snprintf(body, sizeof(body), "{\"login\": \"%s\"}", login_name);
    } else {
        n = base_snprintf(body, sizeof(body), "{}");
    }
    if (n < 0) {
        return 1;
    }

    if (gh_http_post_json(arena, url, NULL, body, &resp, &code) != 0) {
        gh_eprintf("githost: cli-device/start failed\n");
        return 1;
    }
    if (!resp.data) {
        return 1;
    }
    if (json_get_string(resp.data, "device_code", device_code,
                        sizeof(device_code)) != 0 ||
        json_get_string(resp.data, "user_code", user_code, sizeof(user_code)) !=
            0) {
        gh_eprintf("githost: bad start response: %s\n", resp.data);
        return 1;
    }
    if (json_get_string(resp.data, "verification_uri_complete", verification,
                        sizeof(verification)) != 0) {
        /* Build from base + user_code */
        base_snprintf(verification, sizeof(verification),
                      "%s/auth/cli-device?user_code=%s", base_url, user_code);
    }

    gh_printf("githost login\n");
    gh_printf("-------------\n");
    gh_printf("Open this URL in your browser to authorize the CLI:\n\n");
    gh_printf("  %s\n\n", verification);
    gh_printf("Waiting for authorization");

    join_url(url, sizeof(url), base_url, "/auth/cli-device/poll");
    base_snprintf(poll_body, sizeof(poll_body),
                  "{\"device_code\": \"%s\"}", device_code);

    for (attempts = 0; attempts < 300; attempts++) { /* ~5 min at 1s */
        gh_buf poll_resp;
        long pcode = 0;
        gh_print(".");
        if (gh_http_post_json(arena, url, NULL, poll_body, &poll_resp, &pcode) !=
            0) {
            /* 400 pending is not an HTTP error from our helper if we return 200 */
            gh_sleep_ms(1000);
            continue;
        }
        if (!poll_resp.data) {
            gh_sleep_ms(1000);
            continue;
        }
        if (json_get_string(poll_resp.data, "status", status, sizeof(status)) !=
            0) {
            gh_sleep_ms(1000);
            continue;
        }
        if (base_strcmp(status, "pending") == 0) {
            gh_sleep_ms(1000);
            continue;
        }
        if (base_strcmp(status, "complete") == 0 ||
            base_strcmp(status, "authorized") == 0) {
            if (json_get_string(poll_resp.data, "session", session,
                                sizeof(session)) != 0) {
                gh_eprintf("\ngithost: poll complete but no session\n");
                return 1;
            }
            if (json_get_string(poll_resp.data, "login", login_out,
                                sizeof(login_out)) != 0) {
                base_snprintf(login_out, sizeof(login_out), "?");
            }
            gh_printf("\nAuthorized as %s\n", login_out);
            if (write_session_file(arena, session) != 0) {
                return 1;
            }
            gh_printf("You can now run: githost review submit …\n");
            return 0;
        }
        if (base_strcmp(status, "expired") == 0 ||
            base_strcmp(status, "denied") == 0) {
            gh_eprintf("\ngithost: login %s\n", status);
            return 1;
        }
        gh_sleep_ms(1000);
    }
    gh_eprintf("\ngithost: login timed out\n");
    return 1;
}
