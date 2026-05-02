# 2.0.0 / 2026-04-28

## Breaking changes — TypeScript rewrite

- Rewritten in TypeScript with full IPC type safety via discriminated unions
- Adopted `lru-cache@11` native API (was a translated layer over `lru-cache@6`)
- Renamed methods: `del → delete`, `reset → clear`, `prune → purgeStale`, `length`/`itemCount → size`, `stale → allowStale`
- Renamed options: `maxAge → ttl`, `stale → allowStale`
- Removed `parse` / `stringify` options and `setObject` / `getObject` / `mGetObjects` / `mSetObjects` — callers handle serialization
- Removed `prune: <crontime>` option — schedule `purgeStale()` from your own scheduler
- Removed `execute(method, ...args)` — call methods directly
- Renamed `master` to `primary` everywhere (matches `cluster.isPrimary`)
- Internal IPC method renamed `sendToMaster` → `sendToPrimary`

## Features and infrastructure

- Canonical package name is now `@0xdoublesharp/lru-cache-clustered`; `lru-cache-for-clusters-as-promised` is published from the same build at the same version
- Repository moved to `github.com/doublesharp/lru-cache-clustered`
- Publish workflow builds once, prepares scoped and legacy package directories, and publishes both at the same version with npm provenance via GitHub Actions OIDC
- Publish prep validates required build artifacts before creating package directories
- Scoped and legacy package copies share primary state in one process to avoid duplicate IPC listeners during migration
- Dual ESM + CJS publish via `package.json` `exports`
- Generic types: `LRUCacheForClustersAsPromised<K, V>`
- Node `>=22` required
- Added `destroy()` to tear down namespace caches, stats, and fetch coordination state on the primary
- Added explicit startup controls via `LRUCacheClustered.bootstrap()` and `cache.healthCheck()`
- Added size-bounded cache support (`maxSize`, `maxEntrySize`, and `size` on write paths)
- `fetch()` now uses primary-side single-flight coordination across workers; `memoize()` delegates to it
- Dropped runtime deps: `cron`, `uuid` — request IDs use a per-process monotonic counter
- pnpm for development; node:test + c8 for tests/coverage; tsup + tsc for build
- 100% line/statement/function coverage
- CI: Node 24 test workflow plus Node 22 coverage workflow for Codecov, Doublcov HTML artifacts, and GitHub Pages coverage publishing from `main`
- `incr` / `decr` retained (race-safe across workers)
- `failsafe` and `timeout` retained for worker IPC

## Migration

See README "Migrating from older releases" for the full mapping.

# 1.7.1 / 2021-03-25

- Added `static getInstance(options)` to asynchronously return an `LRUCacheForClustersAsPromised` once the underlying `LRUCache` is guaranteed to exist.
- Added `static getAllCaches()` to return all underlying `LRUCache` instances keyed by namespace. _Use only when `cluster.isMaster === true`._
- Added `getCache()` to return underlying `LRUCache` instance. _Use only when `cluster.isMaster === true`._
- Added test coverage via GitHub Actions
- Bug fixes for namespaces
- Bug fixes for prune cron jobs
- Refactoring for maintainability
- Updated tests
- Updated dependencies

# 1.7.0 / 2021-03-25

- Refactoring for maintainability
- Update dependencies
- More reliable test coverage

# 1.6.1 / 2021-03-20

- Update types

# 1.6.0 / 2021-03-20

- Refactor codebase to be more maintainable
- Support for external `parse` and `stringify` functions, used for object caching, more efficient on large objects
- Update tests, 100% code coverage
- Update documentation
- Update dependencies
- npm audit fix

# 1.5.25 / 2021-03-02

- Update dependencies

# 1.5.24 / 2020-07-02

- Update dependencies
- npm audit fix

# 1.5.23 / 2020-06-10

- Typescript support (thanks @hanspeter1!)
- Update dependencies

# 1.5.22 / 2020-05-01

- Remove yarn.lock

# 1.5.21 / 2020-05-01

- Update dependencies

# 1.5.20 / 2019-09-29

- Update dependencies

# 1.5.19 / 2019-08-03

- Update dependencies
- Fix coverage badges with nyc

# 1.5.18 / 2019-08-01

- Update dependencies
- Use nyc for coverage

# 1.5.17 / 2019-04-25

- Update dependencies
- Lint code

# 1.5.16 / 2017-11-21

- Update dependencies

# 1.5.15 / 2017-10-14

- Update dependencies

# 1.5.14 / 2017-09-11

- Update dependencies

# 1.5.13 / 2017-08-04

- Update dependencies

# 1.5.12 / 2017-07-06

- Update dependencies

# 1.5.11 / 2017-05-07

- Update dependencies

# 1.5.10 / 2017-05-07

- Deduplicate common methods - fixes CodeClimate rating to 4.0

# 1.5.9 / 2017-05-06

- Remove `npm-shrinkwrap.json`
- Update dependencies

# 1.5.8 / 2017-03-03

- Use Google ESLint config
- Update dependencies

# 1.5.7 / 2017-02-02

- Use `yarn` for installs
- Update dependencies and dev dependencies

# 1.5.6 / 2016-12-14

- Update dependencies

# 1.5.5 / 2016-12-14

- Update dependencies

# 1.5.4 / 2016-12-05

- Update dependencies

# 1.5.3 / 2016-11-19

- Update `uuid` and `developer-tools`

# 1.5.2 / 2016-11-17

- Improved debug logging

# 1.5.1 / 2016-11-17

- Add support for `mSetObjects()` and `mGetObjects()`
- Pass namespace through to pruning job for debugging

# 1.5.0 / 2016-11-16

- Add support for `mGet([key])`, `mSet({key: value}, maxAge)`, and `mDel([key])`.

# 1.4.6 / 2016-11-16

- Always use a shared cache for consistent behavior

# 1.4.5 / 2016-11-15

- Bug fix for null objects

# 1.4.4 / 2016-11-15

- Support for getting and setting objects + test coverage
  Update deps
  Bump version

# 1.4.3 / 2016-11-12

- Update ESLint settings
  Remove duplicated code
  Update deps
  Bump version

# 1.4.2 / 2016-11-08

- Update dependencies
  Bump version

# 1.4.1 / 2016-10-26

- bump version
- fix the tests, provide more coverage
  fix for case when no options are passed in.
- Give longer to create cache
  Overwrite settings if they are different (allow workers to just use
  name, for example).
  Better properties on create return options
  Bugfix, cache master caches by namespace.

# 1.4.0 / 2016-10-21

- Use cron to optionally prune cache on the master
  Support for `maxAge` parameter on `set()`
  Updated debugging
  Updated test coverage
  Updated deps
  Bumped version
- use web sequence diagrams

# 1.3.1 / 2016-10-11

- bump version
- Update code climate config
- dedupe keys test
- dedupe tests
- Dedupe test code
- fix hello test
- Refactor tests to improve coverage and remove duplicated code.
- Downgrade version of `eslint-plugin-import`
- Update deps
  Add pre-push testing
  Allow code climate to calc duplication

# 1.3.0 / 2016-10-03

- When `cluster.isMaster===true` and the `caches[namespace]` is
  populated, use that instead of creating a `new LRUCache()` - the master
  thread will now act on the same cache as the workers.
  Support for updating the max, maxAge, stale of the cache.
  Update README for new features.
  Update tests to provide 100% coverage.
  Bump version
- use a long random string as the lru key value to give the promise time
  to call the failsafe with reject()
- update eslint config for code climate
- disable duplication check
- Fix `import/no-extraneous-dependencies` value

# 1.2.0 / 2016-09-30

- Bump version
- Add support and tests for `incr()`/`decr()`
  Update readme.
  Syntax cleanup.

# 1.1.0 / 2016-09-29

- bump version
- Update to failsafe with `resolve(undefined)` and `reject(Error)` via
  `options.failsafe=reject`, update docs

# 1.0.6 / 2016-09-29

- Update readme, bump version
- bump version

# 1.0.5 / 2016-09-29

- Export `init` method stub
  Some refactoring
  Add tests for timeout coverage - 100% covered!
  Update README for `init()`

# 1.0.4 / 2016-09-26

- Update dependencies, new lint rules, start worker for each cpu core and
  then call mocha done(), don’t resolve a value if the callback has timed
  out, set timeout in options, update README, bump version

# 1.0.3 / 2016-09-21

- Bump version, remove code climate issue count since it won’t update
- Update standards/linting
  Update main filename
  Update tests
- update developer-tools confs
  lint code
- update code climate config
- use .eslintrc instead of .eslintrc.js
- ignore eslintrc.js in code climate, update config file to standards
- check in code climate file

# 1.0.2 / 2016-08-25

- fix link in readme, bump version

# 1.0.1 / 2016-08-25

- add header, eslint config, clean up code, bump version to 1.0.1

# 1.0.0 / 2016-08-25

- fix typo, more example updates
- fix example
- more comments
- add more comments
- Update README.md
  update with info about `namespace` option.
- Update README.md
  update with api and options, fix example
- Update README.md
  add description, install, usage, patterns.
- fix for properties on promisified lru-cache
- Update readme and add git repo to package
- Update to create coverage badge
- Only fork twice for tests
- First version, linted with test coverage.
- Initial commit
