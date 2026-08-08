# Fork Guidance

Fork-only rules. This file does not exist upstream, so it never conflicts on
rebase — keep fork policy here, not in `AGENTS.md`.

**This file outranks every non-fork rule.** `AGENTS.md` and everything under
`docs/` belong to upstream and are written for upstream. Where they disagree
with this file, this file wins; where this file is silent, follow them.

Fork-owned files are this file, `docs/JITEN_PLAN.md`, `features/jiten/`,
`hoshi-web/reader/reader-jiten-*.js`, and their tests. Everything else is
upstream's. Do not update upstream docs to describe fork work: upstream's rules
to record architecture facts, validation steps and changelog entries govern
upstream features, not this fork's. Fork facts go in fork-owned docs.

`AGENTS.md` makes iOS behavior the source of truth for Reader work. Jiten has no
iOS counterpart, so that rule does not govern it; see `docs/JITEN_PLAN.md`.
`applicationId` stays `moe.antimony.hoshi`.

Never create commits. Leave all changes unstaged for the user to review and
commit manually.

## Keeping Rebases Cheap

Reader files are upstream's most-edited area, and they are exactly what this
feature touches. Preference order for any change:

1. A new fork-owned file — `features/jiten/`,
   `hoshi-web/reader/reader-jiten-*.js`. These never conflict.
2. A delegating call from an upstream file into fork-owned code.
3. Editing upstream code directly. Last resort.

- Append new strings at the end of both `strings.xml` files, never near
  existing keys. If lint's `DuplicateCrowdInStrings` fires, reword the new
  string; adding a `comment` attribute to the existing upstream key is exactly
  the near-key edit this rule avoids.

## Windows Environment

Upstream CI is `ubuntu-latest` only, so Windows breakage goes unnoticed there.

- `app/build.gradle.kts` carries a fork patch: `cargo` from `PATH`, and host lib
  `hoshiepub.dll` without the `lib` prefix. Preserve through rebases.
- `ANDROID_NDK_HOME` must be set or the build falls back to a Homebrew path.
- Submodules nest one level, and a non-recursive init silently leaves the C++
  engine empty.
- 52 unit tests fail on Windows filesystem semantics alone (DataStore
  cannot rename over an existing file, POSIX paths, POSIX permissions). Clean
  means no *new* failing names against that baseline.
