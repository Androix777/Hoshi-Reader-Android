# Jiten Integration Plan

Jiten reading mode in the Reader: words coloured by card state, and a switch in
the Reader chrome that makes tapping a word open a Jiten popup with SRS actions
instead of the dictionary popup.

Ported from the JitenReader browser extension: `shared/jiten/` (API),
`apps/text-highlighter/` and `apps/paragraph-reader/` (token→DOM mapping),
`shared/word-style/generate-css.ts` (state colours).

## Order Of Reader Modes

Continuous first, then paginated, then VN.

Paginated shares `reader-dom-text.js` and `reader-text-semantics.js` with
continuous, so extending is mostly wiring; it comes second because span wrapping
can shift column pagination and therefore saved progress. VN owns a separate
text model (`reader-vn-content-stream.js`, `reader-vn-range-map.js`) and
`AGENTS.md` forbids reusing the paginated/continuous runtime there, so it is an
independent implementation.

## Two Offset Spaces

Conflating these silently misplaces every highlight.

| | Hoshi reader | Jiten |
|---|---|---|
| Unit | Unicode code points | UTF-16 code units |
| Text | normalized via `reader-text-semantics.js` | raw string as posted |
| Source | `nodeStartOffsets` / `nodeStartRawOffsets` | `token.start` / `token.end` |

- The Jiten layer keeps its own fragment list with raw UTF-16 offsets and never
  reads `nodeStartOffsets`.
- Token offsets are paragraph-local: the extension's `ParagraphReader` resets its
  counter on every block break, and Hoshi's port must too.
- Post paragraph text unnormalized so returned offsets index the same string.
- Exclude `rt`/`rp` from paragraph text; Jiten returns its own `rubies`.
- After wrapping, call `hoshiReader.buildNodeOffsets()` — same contract
  `highlights.js` already follows.

## Wrapping Rules

- **Never regenerate ruby.** The extension rebuilds `<ruby><rt class="jiten-furi">`
  from `token.rubies` because arbitrary web pages have no ruby. EPUBs do, and
  furigana is settings-driven, so `token.rubies` is display-irrelevant here.
- Classes go straight onto a `ruby`, never onto a wrapper inside it: wrapping
  part of the base would tear it away from its annotation. Everywhere else a
  `span` wrapper is simpler than the extension's `patchElement` heuristics, and
  costs nothing — the state CSS sets no box, so a wrapper shifts no metrics.
- Jiten colours **before** highlights and Sasayaki cues. Both hold direct node
  references (`hoshiHighlights.wrappers`, `cueSourceRanges`, `cueGeometryRanges`)
  that a later text-node split invalidates, and `buildNodeOffsets()` does not
  repair them. Re-colouring a live chapter must re-run `applyHighlights` and
  `applySasayakiCues`.

## Files

```
features/jiten/
  JitenApiClient.kt           HTTP, auth, retry            (done)
  JitenModels.kt              tokens, cards, knownState → JitenCardState  (done)
  JitenSettingsRepository.kt  DataStore: key, enabled      (done)
  JitenSettingsView[Model].kt settings entry               (done)
  JitenRepository.kt          chunking, skipping, result alignment     (done)
  JitenReaderTokens.kt        wire shape for the highlight module      (done)
  JitenReaderViewModel.kt     one parse at a time per reader           (done)
  JitenReaderHooks.kt         the only surface upstream files call into (done)

hoshi-web/reader/
  reader-jiten-paragraphs.js  DOM → paragraphs + raw-offset fragments  (done)
  reader-jiten-highlight.js   apply/remove word spans                  (done)
  reader-jiten.css            state classes                            (done)
  reader-jiten.js             controller: collect, request, apply      (done)
  reader-jiten-tap.js         hit-test .jiten-word before normal selection
```

Upstream files touched, all of it delegation: three lines in
`ReaderChapterWebView.kt` (a parameter, install, remove), the asset list in
`ReaderWebAssets.kt`, script assembly and one restore-script line in
`ReaderPaginationScripts.kt`, and the view model plus callback in
`ReaderWebView.kt`.

## Slices

**1. API client and settings.** Done. `HttpURLConnection` following
`AnkiConnectBackend.kt`. `Authorization: ApiKey <token>`, 30s timeout, 3 attempts
with jittered backoff on 429/5xx and transport errors, fail fast on 401/403 with
a rejected-key latch that an explicitly passed key bypasses. Endpoints:
`reader/ping`, `reader/parse`, `reader/lookup-vocabulary`, `srs/review`,
`srs/set-vocabulary-state`, `srs/reader-study-decks`.

Decisions taken while implementing:

- No user-editable endpoint. Jiten is one hosted service; `JitenApiClient.Endpoint`
  is a constant, and settings hold only `enabled` and `apiKey`. It must keep the
  `/api` suffix: the base URL comes from the extension's configuration default,
  not from the suffix-less dead default parameter on `requestByUrl`.
- Server failures carry their HTTP status into the settings status line, so a
  wrong path or a revoked key is diagnosable without attaching a debugger.
- `reader/lookup-vocabulary` refreshes card states for a cached chapter and after
  a review, so slice 2's cache does not have to re-parse to stay current.
- Empty or unrecognized `knownState` falls back to Mature on the parse path and
  New on the lookup path, mirroring the extension: an unmappable state must never
  paint a word as unseen while reading.
- Every string list in `vocabulary` arrives as either a string or an array, and
  the two mix inside one response — including one level down, per meaning
  (`"meaningsPartOfSpeech": ["n", ["n", "vs"]]`). The wire model normalizes
  instead of failing: one unwrapped entry would otherwise cost a whole chapter
  its colouring, and the error surfaces as a decode failure long after the
  request succeeded.
- Retry sleeping sits behind `JitenRetryDelay` so tests exercise retry paths
  without real delays; the repo has no `kotlinx-coroutines-test`.

**2. Paragraph extraction and colouring.** The bulk of the work. Walk the chapter
DOM into paragraphs of `{ node, start, end }` fragments over a raw UTF-16 string,
ruby-aware. Map tokens back, split text nodes, wrap in
`<span class="jiten-word …">`, rebuild offsets. Port the matching and error
correction from `text-highlighter.ts`, dropping what only exists to survive
arbitrary web pages. State CSS restricted to `color` and `background-color` —
border, underline and padding change layout metrics. Write that CSS directly;
do not port `generate-css.ts`, whose effect engine emits `!important` and
`-webkit-text-fill-color` that would override reader themes. A card carries
several states at once, so the class set is multi-class and needs a colour
priority; i+1 and study-deck membership classes are out of scope for v1. Kotlin
chunks `reader/parse` calls, caches per chapter, aborts on chapter change,
degrades quietly offline.

JS tests must cover ruby, surrogate pairs, tokens spanning multiple text nodes,
and offset stability after wrapping.

Decisions taken while implementing the browser side:

- Paragraph boundaries come from a tag-name list, not `getComputedStyle`.
  Resolving style for every element in a chapter costs a full style pass, and a
  mis-classified element only merges or splits a parse unit — offsets stay
  correct either way. `br` counts as a boundary so no token spans a line break.
- Posted text folds whitespace the way CSS `white-space: normal` renders it,
  including the segment break transformation that deletes a line break between
  two wide characters. Posting node data verbatim instead would hand the parser
  a break in the middle of `食\nべる` wherever the EPUB happens to wrap.
- Folded-away characters get no fragment. Fragments need only be ordered and
  non-overlapping; tiling their node buys nothing and complicates folding.
- All token ranges are resolved before the DOM is touched, then applied back to
  front. `splitText` leaves the prefix in the original node, so every range not
  yet applied still points at the right node and offset.
- Rubies are patched in document order in a pass of their own. Without it the
  back-to-front wrapping pass would give a ruby shared by two tokens to the
  later one.
- State CSS uses `!important`, narrowly. The reader forces
  `color: var(--hoshi-text-color) !important` on `html, body` and EPUB
  stylesheets set colours at arbitrary specificity; a state colour that loses to
  either is worse than none. Mature and Mastered get no rule, so the override
  only lands where a state was deliberately given a colour.
- Palette is the extension's Toy Box preset — the one colour-only preset, so it
  needs no underline or opacity effect.

Decisions taken while wiring it up:

- Paragraphs are collected twice: once to post, once to apply. Restoring
  progress inserts and removes a marker, Sasayaki wraps cues and the reader
  normalizes text nodes afterwards — all while the parse is in flight, all
  invalidating held fragments. None of them change the text, so re-collecting
  and comparing the texts is both cheaper and safer than trying to keep
  fragments alive. A text mismatch colours nothing.
- Requests carry an id and the controller only accepts the newest. That, plus
  cancelling the previous job, is what discards a chapter's answer that arrives
  after the reader moved on.
- The scripts are injected unconditionally and do nothing until the bridge
  answers. Gating on the setting would mean threading it through every layer
  that builds the shell script, for ~6 KB.
- Paragraphs with no kana and no kanji are never posted, and their slot in the
  result is filled with an empty list. A shifted result would colour the wrong
  paragraph, so alignment is by index, not by position among the posted ones.
- A paragraph over the request size still travels alone rather than being split:
  splitting renumbers the offsets against text the reader never posted.
- `applySasayakiCues` is re-run after colouring, via a recorded copy of the cues
  the reader last passed in. Sasayaki's `cueSourceRanges` hold text nodes and
  offsets that a split invalidates, and the function rebuilds all of it from
  scratch. Highlights need no repair: they hold wrapper elements, which survive
  a split of the text inside them.

Verified on a device: a chapter colours, and the saved position is byte-identical
before and after. Not covered yet: the visual novel runtime never calls `start`,
since it has no restore scripts. Paginated shares the continuous restore path and
is coloured today — whether column pagination survives it still needs checking.

**3. Mode switch.** The switch controls tap behavior only: on, a tap opens the
Jiten popup; off, the dictionary popup. Colouring stays applied either way.
Later: long-press the switch to drop the colouring too.

**4. Popup and SRS actions.** Hit-test `.jiten-word`, fall through to normal
selection on a miss. New bridge messages following the existing
`mineEntry`/`duplicateCheck` pattern. Optimistic class update on the word,
reconciled after the API responds.

The card body needs no `popup.js` change: shape it as Yomitan-style structured
content and `renderStructuredContent` draws it. The actions — grade
(again/hard/good/easy), never forget, blacklist, add to study deck — do require
editing `popup.js`, since `createButtonSlot` only knows `audio` and `mine` and
resolves icons from a fixed path. Keep that edit to one delegating call into a
fork-owned `popup-jiten.js`; `popup.js` is upstream's file and the rest of this
feature deliberately avoids it.

## Risks

- **Layout shift.** Verify saved progress before and after colouring.
- **Wrapper collisions.** Highlights and Sasayaki cues already wrap text nodes;
  see Wrapping Rules for the ordering this forces.
- **Offline-first app, online feature.** Chapters are long; chunk, cancel on
  chapter change, never surface raw exceptions into reader content.
- **Two dictionaries.** Jiten glosses are thinner than a good local dictionary,
  which is why the switch keeps both popups reachable.
