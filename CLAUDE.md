# Fork Guidance

Fork-only rules. This file does not exist upstream, so it never conflicts on
rebase — keep fork policy here, not in `AGENTS.md`.

`AGENTS.md` makes iOS behavior the source of truth for Reader work. Jiten has no
iOS counterpart, so that rule does not govern it; see `docs/JITEN_PLAN.md`.
Everything else still follows `AGENTS.md` in full. `applicationId` stays
`moe.antimony.hoshi`.

## Keeping Rebases Cheap

Reader files are upstream's most-edited area, and they are exactly what this
feature touches. Preference order for any change:

1. A new fork-owned file — `features/jiten/`,
   `hoshi-web/reader/reader-jiten-*.js`. These never conflict.
2. A delegating call from an upstream file into fork-owned code.
3. Editing upstream code directly. Last resort.

- Do not touch `docs/CHANGELOG.md`.
- Append new strings at the end of both `strings.xml` files, never near
  existing keys.

## Windows Environment

Upstream CI is `ubuntu-latest` only, so Windows breakage goes unnoticed there.

- `app/build.gradle.kts` carries a fork patch: `cargo` from `PATH`, and host lib
  `hoshiepub.dll` without the `lib` prefix. Preserve through rebases.
- `ANDROID_NDK_HOME` must be set or the build falls back to a Homebrew path.
- Submodules nest one level, and a non-recursive init silently leaves the C++
  engine empty.
- 52 of 1278 unit tests fail on Windows filesystem semantics alone (DataStore
  cannot rename over an existing file, POSIX paths, POSIX permissions). Clean
  means no *new* failing names against that baseline.
