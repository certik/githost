/*
 * Browser-based CLI login.
 *
 * 1. Listen on 127.0.0.1:<ephemeral>
 * 2. Open {base}/auth/cli-login?port=&state=
 * 3. Worker mints a session and redirects back to localhost with ?session=
 * 4. Write session id to ~/.githost/session
 *
 * Uses libc sockets (hosted build with PLATFORM_SKIP_ENTRY).
 */

#include "githost.h"
#include "out.h"
#include "util.h"

#include <base/numconv.h>
#include <platform/platform.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h> /* system() — hosted CLI helper */
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#ifndef GITHOST_VERSION
#define GITHOST_VERSION "0.1.0"
#endif

static void random_state(char *buf, size_t buflen)
{
    static const char alphabet[] =
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    size_t i;
    unsigned seed = (unsigned)time(NULL) ^ (unsigned)getpid();
    if (buflen < 17) {
        buf[0] = '\0';
        return;
    }
    for (i = 0; i < 16; i++) {
        seed = seed * 1103515245u + 12345u;
        buf[i] = alphabet[(seed >> 16) % (sizeof(alphabet) - 1)];
    }
    buf[16] = '\0';
}

static int open_browser(const char *url)
{
    char cmd[1200];
#if defined(__APPLE__)
    base_snprintf(cmd, sizeof(cmd), "open '%s'", url);
#elif defined(_WIN32)
    base_snprintf(cmd, sizeof(cmd), "start \"\" \"%s\"", url);
#else
    base_snprintf(cmd, sizeof(cmd), "xdg-open '%s' >/dev/null 2>&1", url);
#endif
    return system(cmd) == 0 ? 0 : -1;
}

static int ensure_githost_dir(Arena *arena)
{
    const char *home = gh_getenv(arena, "HOME");
    char path[512];
    char cmd[600];
    if (!home) {
        home = ".";
    }
    base_snprintf(path, sizeof(path), "%s/.githost", home);
    base_snprintf(cmd, sizeof(cmd), "mkdir -p '%s'", path);
    if (system(cmd) != 0) {
        gh_eprintf("githost: failed to create %s\n", path);
        return -1;
    }
    return 0;
}

static int write_session_file(Arena *arena, const char *session_id)
{
    const char *home = gh_getenv(arena, "HOME");
    char path[512];
    platform_fd_t fd;
    ciovec_t iov;
    size_t nwritten;
    size_t len;

    if (!home) {
        home = ".";
    }
    if (ensure_githost_dir(arena) != 0) {
        return -1;
    }
    base_snprintf(path, sizeof(path), "%s/.githost/session", home);
    fd = platform_path_open(path, base_strlen(path), PLATFORM_RIGHTS_WRITE,
                            PLATFORM_O_CREAT | PLATFORM_O_TRUNC);
    if (fd < 0) {
        gh_eprintf("githost: cannot write %s\n", path);
        return -1;
    }
    len = base_strlen(session_id);
    iov.buf = session_id;
    iov.buf_len = len;
    if (platform_fd_write(fd, &iov, 1, &nwritten) != 0) {
        platform_fd_close(fd);
        return -1;
    }
    /* trailing newline */
    {
        const char nl = '\n';
        iov.buf = &nl;
        iov.buf_len = 1;
        (void)platform_fd_write(fd, &iov, 1, &nwritten);
    }
    platform_fd_close(fd);
    gh_printf("Wrote session to %s\n", path);
    return 0;
}

/* Parse query string for key; writes value into out (NUL-terminated). */
static int query_get(const char *query, const char *key, char *out, size_t outlen)
{
    size_t keylen = base_strlen(key);
    const char *p = query;
    while (p && *p) {
        if (base_strncmp(p, key, keylen) == 0 && p[keylen] == '=') {
            const char *v = p + keylen + 1;
            size_t i = 0;
            while (v[i] && v[i] != '&' && i + 1 < outlen) {
                out[i] = v[i] == '+' ? ' ' : v[i];
                i++;
            }
            out[i] = '\0';
            return 0;
        }
        p = base_strchr(p, '&');
        if (p) {
            p++;
        }
    }
    return -1;
}

static void send_html(int fd, int status, const char *body)
{
    char header[256];
    size_t blen = base_strlen(body);
    const char *reason = status == 200 ? "OK" : "Error";
    int n = base_snprintf(header, sizeof(header),
                          "HTTP/1.1 %d %s\r\n"
                          "Content-Type: text/html; charset=utf-8\r\n"
                          "Content-Length: %zu\r\n"
                          "Connection: close\r\n"
                          "\r\n",
                          status, reason, blen);
    if (n > 0) {
        (void)write(fd, header, (size_t)n);
    }
    (void)write(fd, body, blen);
}

int gh_cmd_login(Arena *arena, const char *base_url, const char *login_name)
{
    int listen_fd = -1;
    int client_fd = -1;
    struct sockaddr_in addr;
    socklen_t addrlen = sizeof(addr);
    char state[32];
    char url[1024];
    char req[4096];
    ssize_t nread;
    int port;
    char session[256];
    char got_state[128];
    char login_out[64];
    const char *path_q;
    char *nl;
    int rc = 1;

    random_state(state, sizeof(state));

    listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        gh_eprintf("githost: socket() failed\n");
        return 1;
    }
    {
        int yes = 1;
        (void)setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    }
    base_memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0; /* ephemeral */
    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        gh_eprintf("githost: bind() failed\n");
        close(listen_fd);
        return 1;
    }
    if (getsockname(listen_fd, (struct sockaddr *)&addr, &addrlen) != 0) {
        gh_eprintf("githost: getsockname() failed\n");
        close(listen_fd);
        return 1;
    }
    port = (int)ntohs(addr.sin_port);
    if (listen(listen_fd, 1) != 0) {
        gh_eprintf("githost: listen() failed\n");
        close(listen_fd);
        return 1;
    }

    /* Build login URL */
    {
        size_t bn = base_strlen(base_url);
        char path[256];
        if (login_name && login_name[0]) {
            base_snprintf(path, sizeof(path),
                          "/auth/cli-login?port=%d&state=%s&login=%s", port,
                          state, login_name);
        } else {
            base_snprintf(path, sizeof(path),
                          "/auth/cli-login?port=%d&state=%s", port, state);
        }
        if (bn > 0 && base_url[bn - 1] == '/') {
            base_snprintf(url, sizeof(url), "%s%s", base_url, path + 1);
        } else {
            base_snprintf(url, sizeof(url), "%s%s", base_url, path);
        }
    }

    gh_printf("Opening browser for login…\n");
    gh_printf("If it does not open, visit:\n  %s\n", url);
    if (open_browser(url) != 0) {
        gh_eprintf("githost: could not open browser automatically\n");
    }
    gh_printf("Waiting for callback on http://127.0.0.1:%d/ …\n", port);

    client_fd = accept(listen_fd, NULL, NULL);
    if (client_fd < 0) {
        gh_eprintf("githost: accept() failed\n");
        close(listen_fd);
        return 1;
    }

    nread = read(client_fd, req, sizeof(req) - 1);
    if (nread <= 0) {
        gh_eprintf("githost: empty request from browser\n");
        close(client_fd);
        close(listen_fd);
        return 1;
    }
    req[nread] = '\0';

    /* Expect: GET /?session=...&state=... HTTP/1.x */
    if (base_strncmp(req, "GET ", 4) != 0) {
        send_html(client_fd, 400, "<html><body>Expected GET</body></html>");
        close(client_fd);
        close(listen_fd);
        return 1;
    }
    path_q = req + 4;
    while (*path_q == ' ') {
        path_q++;
    }
    nl = base_strchr(path_q, ' ');
    if (nl) {
        *nl = '\0';
    }
    /* path_q is like /?session=x&state=y or /callback?session= */
    {
        const char *q = base_strchr(path_q, '?');
        if (!q) {
            send_html(client_fd, 400,
                      "<html><body>Missing query string</body></html>");
            close(client_fd);
            close(listen_fd);
            return 1;
        }
        q++;
        if (query_get(q, "session", session, sizeof(session)) != 0 ||
            !session[0]) {
            send_html(client_fd, 400,
                      "<html><body>Missing session</body></html>");
            close(client_fd);
            close(listen_fd);
            return 1;
        }
        if (query_get(q, "state", got_state, sizeof(got_state)) != 0 ||
            base_strcmp(got_state, state) != 0) {
            send_html(client_fd, 400,
                      "<html><body>Invalid state</body></html>");
            close(client_fd);
            close(listen_fd);
            return 1;
        }
        if (query_get(q, "login", login_out, sizeof(login_out)) != 0) {
            base_snprintf(login_out, sizeof(login_out), "?");
        }
    }

    send_html(client_fd, 200,
              "<!doctype html><html><head><meta charset=utf-8>"
              "<title>githost login</title></head>"
              "<body style=\"font-family:system-ui;padding:2rem\">"
              "<h1>Logged in to githost CLI</h1>"
              "<p>You can close this window and return to the terminal.</p>"
              "</body></html>");
    close(client_fd);
    close(listen_fd);
    listen_fd = -1;
    client_fd = -1;

    if (write_session_file(arena, session) != 0) {
        return 1;
    }
    gh_printf("Logged in as %s\n", login_out);
    gh_printf("You can now run: githost review submit …\n");
    rc = 0;

    if (client_fd >= 0) {
        close(client_fd);
    }
    if (listen_fd >= 0) {
        close(listen_fd);
    }
    return rc;
}
