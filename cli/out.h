#pragma once

/*
 * stdout/stderr helpers on top of platform_fd_write + base_snprintf.
 * No C standard library headers.
 */

#include <base/stdarg.h>
#include <base/types.h>

#ifdef __cplusplus
extern "C" {
#endif

void gh_write_fd(int fd, const char *data, size_t len);
void gh_print(const char *s);
void gh_print_err(const char *s);
void gh_putchar(int c);

/* Formatted write; uses base_vsnprintf (same format subset as base/). */
void gh_printf(const char *fmt, ...);
void gh_eprintf(const char *fmt, ...);
void gh_vprintf(int fd, const char *fmt, va_list ap);

#ifdef __cplusplus
}
#endif
