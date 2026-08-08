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
- Post paragraph text unnormalized so returned offsets index the same string.
- Exclude `rt`/`rp` from paragraph text; Jiten returns its own `rubies`.
- After wrapping, call `hoshiReader.buildNodeOffsets()` — same contract
  `highlights.js` already follows.

## Files

```
features/jiten/
  JitenApiClient.kt           HTTP, auth, retry
  JitenModels.kt              tokens, cards, knownState → JitenCardState
  JitenRepository.kt          per-chapter token cache, dispatcher boundaries
  JitenSettingsRepository.kt  DataStore: key, endpoint, enabled
  JitenReaderHooks.kt         the only surface upstream files call into

hoshi-web/reader/
  reader-jiten-paragraphs.js  DOM → paragraphs + raw-offset fragments
  reader-jiten-highlight.js   apply/remove word spans
  reader-jiten-tap.js         hit-test .jiten-word before normal selection
  reader-jiten.css            state classes
```

## Slices

**1. API client and settings.** `HttpURLConnection` following
`AnkiConnectBackend.kt`. `Authorization: ApiKey <token>`, 30s timeout, 3 retries
with backoff on 429/5xx, fail fast on 401/403. Endpoints: `reader/ping`,
`reader/parse`, `srs/review`, `srs/set-vocabulary-state`,
`srs/reader-study-decks`. Settings entry with key field and a ping-backed test
action.

**2. Paragraph extraction and colouring.** The bulk of the work. Walk the chapter
DOM into paragraphs of `{ node, start, end }` fragments over a raw UTF-16 string,
ruby-aware. Map tokens back, split text nodes, wrap in
`<span class="jiten-word …">`, rebuild offsets. Port the matching and error
correction from `text-highlighter.ts`, dropping what only exists to survive
arbitrary web pages. State CSS restricted to `color` and `background-color` —
border, underline and padding change layout metrics. Kotlin chunks
`reader/parse` calls, caches per chapter, aborts on chapter change, degrades
quietly offline.

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
resolves icons from a fixed path.

## Risks

- **Layout shift.** Verify saved progress before and after colouring.
- **Wrapper collisions.** Highlights and Sasayaki cues already wrap text nodes;
  decide nesting order before wrapping over them.
- **Offline-first app, online feature.** Chapters are long; chunk, cancel on
  chapter change, never surface raw exceptions into reader content.
- **Two dictionaries.** Jiten glosses are thinner than a good local dictionary,
  which is why the switch keeps both popups reachable.
