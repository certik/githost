#include "out.h"

#include <base/mem.h>
#include <base/numconv.h>
#include <platform/platform.h>

void gh_write_fd(int fd, const char *data, size_t len)
{
    ciovec_t iov;
    size_t nwritten;
    if (!data || len == 0) {
        return;
    }
    iov.buf = data;
    iov.buf_len = len;
    /* Best-effort: ignore errors for CLI printing. */
    (void)platform_fd_write(fd, &iov, 1, &nwritten);
}

void gh_print(const char *s)
{
    if (!s) {
        return;
    }
    gh_write_fd(PLATFORM_STDOUT_FD, s, base_strlen(s));
}

void gh_print_err(const char *s)
{
    if (!s) {
        return;
    }
    gh_write_fd(PLATFORM_STDERR_FD, s, base_strlen(s));
}

void gh_putchar(int c)
{
    char ch = (char)c;
    gh_write_fd(PLATFORM_STDOUT_FD, &ch, 1);
}

void gh_vprintf(int fd, const char *fmt, va_list ap)
{
    char buf[4096];
    int n = base_vsnprintf(buf, sizeof(buf), fmt, ap);
    if (n < 0) {
        return;
    }
    if ((size_t)n >= sizeof(buf)) {
        n = (int)sizeof(buf) - 1;
    }
    gh_write_fd(fd, buf, (size_t)n);
}

void gh_printf(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    gh_vprintf(PLATFORM_STDOUT_FD, fmt, ap);
    va_end(ap);
}

void gh_eprintf(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    gh_vprintf(PLATFORM_STDERR_FD, fmt, ap);
    va_end(ap);
}
