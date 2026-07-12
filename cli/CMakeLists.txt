cmake_minimum_required(VERSION 3.16)
project(githost_cli C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

find_package(CURL REQUIRED)

set(GITHOST_COREC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/corec)

set(GITHOST_COREC_SOURCES
    ${GITHOST_COREC_DIR}/base/arena.c
    ${GITHOST_COREC_DIR}/base/assert.c
    ${GITHOST_COREC_DIR}/base/buddy.c
    ${GITHOST_COREC_DIR}/base/exit.c
    ${GITHOST_COREC_DIR}/base/format.c
    ${GITHOST_COREC_DIR}/base/io.c
    ${GITHOST_COREC_DIR}/base/math.c
    ${GITHOST_COREC_DIR}/base/mem.c
    ${GITHOST_COREC_DIR}/base/numconv.c
    ${GITHOST_COREC_DIR}/base/scratch.c
    ${GITHOST_COREC_DIR}/base/strbuf.c
    ${GITHOST_COREC_DIR}/base/string.c
)

if (WIN32)
    list(APPEND GITHOST_COREC_SOURCES
        ${GITHOST_COREC_DIR}/platform/platform_windows.c)
elseif (APPLE)
    list(APPEND GITHOST_COREC_SOURCES
        ${GITHOST_COREC_DIR}/platform/platform_macos.c)
else()
    list(APPEND GITHOST_COREC_SOURCES
        ${GITHOST_COREC_DIR}/platform/platform_linux.c)
endif()

add_executable(githost
    main.c
    http.c
    json_pr.c
    display.c
    util.c
    out.c
    ${GITHOST_COREC_SOURCES}
)

# Hosted build: libc provides main(); corec skips its _start.
target_compile_definitions(githost PRIVATE PLATFORM_SKIP_ENTRY)

target_include_directories(githost PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${GITHOST_COREC_DIR}
    ${GITHOST_COREC_DIR}/platform
)

target_link_libraries(githost PRIVATE CURL::libcurl)

install(TARGETS githost RUNTIME DESTINATION bin)

# Reference tests need the repo root (wrangler, seed scripts, web/dist).
# Prefer: npm run test:cli   or   ./cli/tests/run_tests.sh ./cli/build/githost
enable_testing()
add_test(
    NAME githost_cli_reference
    COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/tests/run_tests.sh
            $<TARGET_FILE:githost>
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/..
)
