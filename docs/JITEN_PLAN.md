# Jiten Integration Plan

Jiten reading mode in the Reader: words coloured by card state, and a
dictionary popup that toggles to a Jiten view. A tap collects both the
dictionary word and the Jiten token under it when possible, so switching views
needs no second tap.

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
  reader-jiten.js             controller: observe, request, apply      (done)
  reader-jiten-tap.js         the Jiten token a tap resolves to, for the popup

hoshi-web/popup/
  popup-jiten.js              Jiten view: card and SRS actions
  popup-jiten.css             Jiten view layout
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

Constraints worth keeping:

- Paragraph boundaries come from a tag-name list, not `getComputedStyle`, which
  would cost a style pass per chapter. A mis-classified element only merges or
  splits a parse unit; offsets stay correct. `br` is a boundary, so no token
  spans a line break.
- Posted text folds whitespace as CSS `white-space: normal` renders it,
  including the segment break transformation that deletes a line break between
  two wide characters — otherwise the parser sees a break inside `食\nべる`
  wherever the EPUB happens to wrap. Folded-away characters get no fragment;
  fragments need only be ordered and non-overlapping.
- Token ranges are all resolved before the DOM is touched, then applied back to
  front, since `splitText` leaves the prefix in the original node. Rubies are
  patched in a separate forward pass, or a ruby shared by two tokens would go
  to the later one.
- State CSS uses `!important` narrowly: the reader forces
  `color: var(--hoshi-text-color) !important` on `html, body`, and EPUB
  stylesheets set colours at arbitrary specificity. Mature and Mastered get no
  rule, so the override only lands where a state has a colour. The palette is
  the extension's Toy Box preset, the one that needs no underline or opacity.
- Paragraphs are collected once to post and again to apply, and coloured only
  if the text still matches. Progress restore, Sasayaki and highlights all
  rearrange text nodes mid-flight without changing text.
- The scripts are injected whether or not Jiten is on; gating would thread the
  setting through every layer that builds the shell script.
- Paragraphs with no kana and no kanji are never posted, and their slot in the
  result is an empty list: alignment is by index, not by position among the
  posted ones. A paragraph over the request size travels alone rather than
  being split, which would renumber offsets against text never posted.
- `applySasayakiCues` is re-run after colouring, from a recorded copy of the
  cues. Its `cueSourceRanges` hold text nodes and offsets that a split
  invalidates, and it rebuilds them from scratch. Highlights hold wrapper
  elements and need no repair.

Verified on a device in both view modes: text colours, and the saved position is
unchanged before and after. The visual novel runtime is still uncoloured — it
never calls `start`, having no restore scripts.

**2b. Parsing what is about to be read.** Both view modes load a whole chapter
into the page and a book may be one chapter of a million characters, so the
chapter is not a unit of work. Text is parsed as it approaches the viewport,
after the extension's `IntersectionObserver` scoping in `apps/parser/base.parser.ts`.

Scoping:

- A parse unit is the deepest element with no text-carrying block child — in
  prose, one paragraph. Without descending, a chapter wrapped in one `div` is a
  single unit again. `br` and `hr` hold no text, so they are not containers.
- `rootMargin: 200%` reads as two screens ahead in continuous and two pages
  ahead in paginated, a page being a viewport.
- The observer root must be the element the reader scrolls, which paginated
  mode also clips to. `rootMargin` expands the root, not an intermediate clip,
  so a viewport root gives paginated no lookahead at all.
- Units entering view within 500ms travel as one request; the window has to
  span a scroll, since paragraphs cross the margin about 100ms apart. Kotlin
  still splits the result into API-sized batches, so this paces round trips,
  not request size.
- `JitenRepository` holds the API to one request at a time. With cancellation
  on leaving the viewport, that bounds the request rate whatever the reader
  does.
- Colouring defers `buildNodeOffsets`; the controller runs it and the Sasayaki
  repair once per burst. Both are chapter-wide passes.

Failure and offline, which is a normal mode here:

- Kotlin answers every request, with tokens or a failure. The observer fires
  once for text crossing into view, so silence leaves that text uncoloured for
  as long as it stays on screen. An empty answer settles rather than fails —
  Jiten switched off is not fixed by asking again.
- `navigator.onLine` skips requests certain to fail; the `online` event ends
  the wait. Retries back off 5s→2min for the case where the browser claims a
  network that goes nowhere.
- A pending retry blocks dispatching, not just the sweep. Otherwise scrolling
  routes around the backoff, since new text keeps arriving.
- `visibilitychange` stops retrying while the page is hidden; the reader does
  not pause its WebView.
- At the backoff ceiling the sweep ignores `onLine`. The flag can be wrong, and
  a stuck `false` would otherwise mean a chapter that never colours.

Still uncached: re-entering a chapter re-parses it, and a chapter first read
offline stays uncoloured until read again online. Card states outlive a session,
so a store keyed by word and reading would colour known words with no network —
the real offline answer, and bigger than this slice.

**3. Popup mode toggle.** The dictionary popup toggles between its dictionary
view and a Jiten view. The toggle only changes what is shown; colouring stays
applied either way. Later: long-press the toggle to drop the colouring too.

**4. Tap and SRS actions.** A tap collects both the dictionary word and the
Jiten token under it when the tap lands on a coloured span, so toggling to the
Jiten view needs no second tap. The Jiten view shows the card and the SRS
actions: grade (again/hard/good/easy), never forget, blacklist, forget. An
action updates the word's colour immediately and reconciles if the server
disagrees.

## Risks

- **Layout shift.** Verify saved progress before and after colouring.
- **Wrapper collisions.** Highlights and Sasayaki cues already wrap text nodes;
  see Wrapping Rules for the ordering this forces.
- **Offline-first app, online feature.** Chapters are long; chunk, cancel on
  chapter change, never surface raw exceptions into reader content.
- **Two dictionaries.** Jiten glosses are thinner than a good local dictionary,
  which is why the popup keeps the dictionary view one toggle away rather than
  replacing it.
