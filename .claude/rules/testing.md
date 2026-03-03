---
paths:
  - "src/**/__tests__/**/*.js"
  - "src/**/*.test.js"
---

# Testing Conventions

## Structure

- Tests live in `__tests__/` directories mirroring the source path.
  - `src/routes/tasks.js` → `src/routes/__tests__/tasks.test.js`
  - `src/services/foo.js` → `src/services/__tests__/foo.test.js`
- Use `describe()` to group by feature/behaviour, `it()` for individual cases.
- Use descriptive test names: `it('returns 404 when task does not exist')` not `it('works')`.

## Mocking

- Mock external dependencies (DB, HTTP clients, external services) — never hit real endpoints.
- Use `jest.mock()` at the top of the file for module-level mocks.
- Clear mocks between tests: `afterEach(() => jest.clearAllMocks())`.
- Mock `src/db/pool.js` for all route tests to avoid real DB calls.

## Assertions

- Assert on response status code AND body shape.
- For error cases, assert the exact error message or status code.
- For list endpoints, assert pagination shape: `{ data: [], pagination: { limit, offset, total } }`.

## Running tests

```bash
make test-run    # run once (CI mode)
npm run test:run # without Make
```

## Coverage

- Aim for coverage on all new route handlers and service methods.
- Focus on branching logic: happy path, validation errors, not-found cases, auth failures.
