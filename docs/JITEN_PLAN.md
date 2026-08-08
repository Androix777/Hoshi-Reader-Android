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
- Prefer the extension's `patchElement` shape: when a token covers an existing
  element exactly, add classes to that element instead of inserting a wrapper.
  No new node means no split text node and no metric change.
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
  JitenRepository.kt          per-chapter token cache, dispatcher boundaries
  JitenReaderHooks.kt         the only surface upstream files call into

hoshi-web/reader/
  reader-jiten-paragraphs.js  DOM → paragraphs + raw-offset fragments
  reader-jiten-highlight.js   apply/remove word spans
  reader-jiten-tap.js         hit-test .jiten-word before normal selection
  reader-jiten.css            state classes
```

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
- `partsOfSpeech` arrives as either a string or an array; the wire model accepts
  both rather than failing the whole parse.
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
