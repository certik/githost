/**
 * Shared MSW server for mocking outbound HTTP from tests.
 *
 * Per-test handlers are added via `server.use(http.get(...), ...)`. They're
 * cleared between tests by `afterEach(server.resetHandlers())` in setup.ts.
 *
 * `onUnhandledRequest: "error"` means any outbound fetch from worker code
 * that ISN'T explicitly mocked in a test fails loudly — no accidental network
 * calls in CI.
 */
import { setupServer } from "msw/node";

export const mswServer = setupServer();
