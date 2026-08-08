import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const jitenUrl = new URL('../../main/assets/hoshi-web/reader/reader-jiten.js', import.meta.url);

/** The controller's batching window, as the bound for "no backoff has elapsed". */
const DispatchDelay = 500;

/** A stand-in for an element: only what the controller actually touches. */
function element(tagName, { text = '', children = [] } = {}) {
    return { nodeType: 1, tagName, textContent: text, children, paragraphs: text ? [text] : [] };
}

/**
 * The controller is tested against stub collector and highlight modules: what
 * it owns is which text gets requested and when, not the DOM work those two
 * modules have their own tests for.
 */
function load({ withBridge = true, withObserver = true } = {}) {
    const harness = {
        parseCalls: [],
        cancelCalls: [],
        sessions: [],
        applyCalls: [],
        appliedCues: [],
        clearCalls: 0,
        observed: [],
        unobserved: [],
        timers: new Map(),
        delays: [],
        listeners: {},
        offsetBuilds: 0,
    };
    const body = element('BODY');
    const window = {
        hoshiReader: {
            buildNodeOffsets() {
                harness.offsetBuilds += 1;
            },
            applySasayakiCues(cues) {
                harness.appliedCues.push(cues);
            },
        },
        navigator: { onLine: true },
        setTimeout(fn, delay) {
            handles += 1;
            harness.timers.set(handles, { fn, delay });
            harness.delays.push(delay);
            return handles;
        },
        clearTimeout(handle) {
            harness.timers.delete(handle);
        },
        addEventListener(name, listener) {
            harness.listeners[name] = listener;
        },
        hoshiReaderJitenParagraphs: {
            isBlockTag: (tagName) => ['BODY', 'DIV', 'P', 'SECTION', 'BR'].includes(tagName),
            collectParagraphs: (node) => (node.paragraphs || []).map((text) => ({ text, fragments: [] })),
        },
        hoshiReaderJitenHighlight: {
            applyTokens(root, paragraphs, tokens, options) {
                harness.applyCalls.push({ root, paragraphs, tokens, options });
                return tokens.reduce((total, paragraph) => total + paragraph.length, 0);
            },
            clearTokens() {
                harness.clearCalls += 1;
                return 1;
            },
        },
    };
    if (withBridge) {
        window.HoshiJiten = {
            beginSession(sessionId) {
                harness.sessions.push(sessionId);
            },
            parse(requestId, paragraphsJson) {
                harness.parseCalls.push({ requestId, paragraphs: JSON.parse(paragraphsJson) });
            },
            cancel(requestId) {
                harness.cancelCalls.push(requestId);
            },
        };
    }
    if (withObserver) {
        window.IntersectionObserver = class {
            constructor(callback, options) {
                harness.observerOptions = options;
                harness.notify = (entries) => callback(entries);
            }

            observe(node) {
                harness.observed.push(node);
            }

            unobserve(node) {
                harness.unobserved.push(node);
            }

            disconnect() {}
        };
    }
    let handles = 0;
    const documentStub = {
        body,
        hidden: false,
        addEventListener(name, listener) {
            harness.listeners[name] = listener;
        },
    };
    const context = { window, document: documentStub };
    harness.document = documentStub;
    context.globalThis = context;
    vm.runInNewContext(fs.readFileSync(jitenUrl, 'utf8'), context);
    harness.jiten = window.hoshiReaderJiten;
    harness.reader = window.hoshiReader;
    harness.window = window;
    harness.body = body;
    harness.enter = (node) => harness.notify([{ target: node, isIntersecting: true }]);
    harness.exit = (node) => harness.notify([{ target: node, isIntersecting: false }]);
    /**
     * Runs the timers due within `maxDelay`. The default runs everything; the
     * bound is how a test says "time passed, but not enough for the backoff" —
     * firing a five-second retry in the same breath as a half-second dispatch
     * would hide exactly the behaviour those tests are about.
     */
    harness.runTimers = (maxDelay = Infinity) => {
        const due = Array.from(harness.timers).filter(([, timer]) => timer.delay <= maxDelay);
        due.forEach(([handle]) => harness.timers.delete(handle));
        due.forEach(([, timer]) => timer.fn());
    };
    return harness;
}

/** The requestId the controller minted for the nth request it sent. */
function requestId(harness, index = 0) {
    return harness.parseCalls[index].requestId;
}

test('jiten controller parses nothing until text approaches the viewport', () => {
    const harness = load();
    harness.body.children = [element('P', { text: '時間がある' }), element('P', { text: '海が見えた' })];

    const units = harness.jiten.start();

    assert.equal(units, 2);
    assert.equal(harness.observed.length, 2);
    // A chapter of any size costs nothing until the reader gets there.
    assert.equal(harness.parseCalls.length, 0);
});

test('jiten controller descends past a wrapper into real paragraphs', () => {
    const harness = load();
    const paragraphs = [element('P', { text: '時間がある' }), element('P', { text: '海が見えた' })];
    // An EPUB that wraps its chapter in one div must not become one unit.
    harness.body.children = [element('DIV', { text: '時間がある海が見えた', children: paragraphs })];

    harness.jiten.start();

    assert.deepEqual(Array.from(harness.observed), paragraphs);
});

test('jiten controller keeps a paragraph whole across its line breaks', () => {
    const harness = load();
    // <br> is a block boundary but not a container: descending into it would
    // strand the text on either side.
    const paragraph = element('P', { text: '時間がある', children: [element('BR')] });
    harness.body.children = [paragraph];

    harness.jiten.start();

    assert.deepEqual(Array.from(harness.observed), [paragraph]);
});

test('jiten controller requests a unit when it comes into reach', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();

    harness.enter(paragraph);
    harness.runTimers();

    assert.equal(harness.parseCalls.length, 1);
    assert.deepEqual(Array.from(harness.parseCalls[0].paragraphs), ['時間がある']);
});

test('jiten controller asks for a unit only once', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();

    harness.enter(paragraph);
    harness.runTimers();
    harness.enter(paragraph);
    harness.runTimers();

    assert.equal(harness.parseCalls.length, 1);
});

test('jiten controller stops watching a unit that holds no parsable text', () => {
    const harness = load();
    const image = element('DIV');
    harness.body.children = [image];
    harness.jiten.start();

    harness.enter(image);
    harness.runTimers();

    assert.equal(harness.parseCalls.length, 0);
    assert.deepEqual(Array.from(harness.unobserved), [image]);
});

test('jiten controller cancels a unit that scrolled out of reach', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.enter(paragraph);
    harness.runTimers();

    harness.exit(paragraph);

    assert.deepEqual(Array.from(harness.cancelCalls), [requestId(harness)]);
    // The answer is no longer wanted even if it was already on its way.
    assert.equal(harness.jiten.onTokens(requestId(harness), JSON.stringify([[{ start: 0, end: 2 }]])), 0);
});

test('jiten controller colours the unit that asked, not the document', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.enter(paragraph);
    harness.runTimers();

    const applied = harness.jiten.onTokens(requestId(harness), JSON.stringify([[{ start: 0, end: 2 }]]));

    assert.equal(applied, 1);
    assert.equal(harness.applyCalls[0].root, paragraph);
});

test('jiten controller ignores an answer it never asked for', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.enter(paragraph);
    harness.runTimers();

    // The shape a previous chapter's answer would arrive in.
    assert.equal(harness.jiten.onTokens('stale:1', JSON.stringify([[{ start: 0, end: 2 }]])), 0);
    assert.equal(harness.applyCalls.length, 0);
});

test('jiten controller announces a session so the previous chapter can be dropped', () => {
    const first = load();
    const second = load();

    first.jiten.start();
    second.jiten.start();

    assert.equal(first.sessions.length, 1);
    assert.notEqual(first.sessions[0], second.sessions[0]);
});

test('jiten controller re-collects a unit rather than holding its fragments', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.enter(paragraph);
    harness.runTimers();
    // Restoring progress and wrapping cues rearrange text nodes while the parse
    // is in flight, which is exactly what fragments describe.
    paragraph.paragraphs = ['時間がある'];

    harness.jiten.onTokens(requestId(harness), JSON.stringify([[{ start: 0, end: 2 }]]));

    assert.equal(harness.applyCalls.length, 1);
});

test('jiten controller refuses to colour text that changed under it', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.enter(paragraph);
    harness.runTimers();
    paragraph.paragraphs = ['足された段落'];

    assert.equal(harness.jiten.onTokens(requestId(harness), JSON.stringify([[{ start: 0, end: 2 }]])), 0);
    assert.equal(harness.applyCalls.length, 0);
});

test('jiten controller survives an unparsable payload', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.enter(paragraph);
    harness.runTimers();

    assert.equal(harness.jiten.onTokens(requestId(harness), 'not json'), 0);
});

test('jiten controller sends a screenful of units as one request', () => {
    const harness = load();
    const first = element('P', { text: '時間がある' });
    const second = element('P', { text: '海が見えた' });
    harness.body.children = [first, second];
    harness.jiten.start();

    harness.enter(first);
    harness.enter(second);
    harness.runTimers();

    // One request per paragraph would trade a chapter of work for a chapter of
    // round trips; Kotlin is what splits this back into API-sized batches.
    assert.equal(harness.parseCalls.length, 1);
    assert.deepEqual(Array.from(harness.parseCalls[0].paragraphs), ['時間がある', '海が見えた']);
});

test('jiten controller gives each unit in a request its own tokens', () => {
    const harness = load();
    const first = element('P', { text: '時間がある' });
    const second = element('P', { text: '海が見えた' });
    harness.body.children = [first, second];
    harness.jiten.start();
    harness.enter(first);
    harness.enter(second);
    harness.runTimers();

    harness.jiten.onTokens(
        requestId(harness),
        JSON.stringify([[{ start: 0, end: 2 }], [{ start: 0, end: 1 }]]),
    );

    // A slice off by one would colour the wrong paragraph entirely.
    assert.equal(harness.applyCalls[0].root, first);
    assert.equal(harness.applyCalls[0].tokens[0][0].end, 2);
    assert.equal(harness.applyCalls[1].root, second);
    assert.equal(harness.applyCalls[1].tokens[0][0].end, 1);
});

test('jiten controller rebuilds offsets and cues once for a burst of units', () => {
    const harness = load();
    const first = element('P', { text: '時間がある' });
    const second = element('P', { text: '海が見えた' });
    const cues = [{ id: 'cue-1', start: 0, length: 5 }];
    harness.reader.applySasayakiCues(cues);
    harness.body.children = [first, second];
    harness.jiten.start();
    harness.enter(first);
    harness.enter(second);
    harness.runTimers();

    harness.jiten.onTokens(
        requestId(harness),
        JSON.stringify([[{ start: 0, end: 2 }], [{ start: 0, end: 1 }]]),
    );
    harness.runTimers();

    // Colouring never rebuilds on its own; one pass covers the whole burst.
    // (Objects from the vm realm fail deepEqual on prototype identity.)
    assert.equal(harness.applyCalls[0].options.deferOffsets, true);
    assert.equal(harness.offsetBuilds, 1);
    assert.equal(harness.appliedCues.length, 2);
    assert.equal(harness.appliedCues[1], cues);
});

test('jiten controller leaves sasayaki alone when nothing was coloured', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.reader.applySasayakiCues([{ id: 'cue-1', start: 0, length: 5 }]);
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.enter(paragraph);
    harness.runTimers();

    harness.jiten.onTokens(requestId(harness), JSON.stringify([[]]));
    harness.runTimers();

    assert.equal(harness.appliedCues.length, 1);
});

test('jiten controller stays quiet without a bridge', () => {
    const harness = load({ withBridge: false });
    harness.body.children = [element('P', { text: '時間がある' })];

    assert.equal(harness.jiten.start(), 0);
    assert.equal(harness.observed.length, 0);
});

test('jiten controller parses everything when the browser has no observer', () => {
    const harness = load({ withObserver: false });
    harness.body.children = [element('P', { text: '時間がある' }), element('P', { text: '海が見えた' })];

    // Uncoloured is the worse failure; there is no notion of "near" to scope by.
    assert.equal(harness.jiten.start(), 2);
    harness.runTimers();
    assert.equal(harness.parseCalls.length, 1);
    assert.equal(harness.parseCalls[0].paragraphs.length, 2);
});

test('jiten controller asks again for text whose request failed', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.enter(paragraph);
    harness.runTimers();

    // Offline, or a server hiccup. The observer will not fire again for text
    // that never moved, so without this the paragraph stays uncoloured for good.
    harness.jiten.onFailed(requestId(harness));
    harness.runTimers();
    harness.runTimers();

    assert.equal(harness.parseCalls.length, 2);
});

test('jiten controller does not chase text the reader has scrolled past', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.enter(paragraph);
    harness.runTimers();
    harness.exit(paragraph);

    harness.jiten.onFailed(requestId(harness));
    harness.runTimers();
    harness.runTimers();

    // A chapter read offline must not queue up a chapter of retries.
    assert.equal(harness.parseCalls.length, 1);
});

test('jiten controller settles a unit an empty answer covers', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.enter(paragraph);
    harness.runTimers();

    // Jiten switched off answers with nothing; retrying would never help.
    harness.jiten.onTokens(requestId(harness), JSON.stringify([[]]));
    harness.enter(paragraph);
    harness.runTimers();

    assert.equal(harness.parseCalls.length, 1);
    assert.deepEqual(Array.from(harness.unobserved), [paragraph]);
});

test('jiten controller asks for nothing while there is no network', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.window.navigator.onLine = false;

    harness.enter(paragraph);
    harness.runTimers();

    // Reading offline is normal here; a request certain to fail is pure drain.
    assert.equal(harness.parseCalls.length, 0);
});

test('jiten controller sends nothing however far the reader scrolls offline', () => {
    const harness = load();
    const paragraphs = Array.from({ length: 20 }, () => element('P', { text: '時間がある' }));
    harness.body.children = paragraphs;
    harness.jiten.start();
    harness.window.navigator.onLine = false;

    paragraphs.forEach((paragraph) => {
        harness.enter(paragraph);
        harness.runTimers(DispatchDelay);
    });

    assert.equal(harness.parseCalls.length, 0);
});

test('jiten controller does not turn a dead network into a request per screenful', () => {
    const harness = load();
    const paragraphs = Array.from({ length: 20 }, () => element('P', { text: '時間がある' }));
    harness.body.children = paragraphs;
    harness.jiten.start();
    // The browser claims a network; the requests fail anyway. Scrolling must
    // not route around the backoff the failure just set up.
    harness.enter(paragraphs[0]);
    harness.runTimers();
    harness.jiten.onFailed(requestId(harness));

    paragraphs.slice(1).forEach((paragraph) => {
        harness.enter(paragraph);
        harness.runTimers(DispatchDelay);
    });

    assert.equal(harness.parseCalls.length, 1);
});

test('jiten controller stops retrying while nobody is looking at the page', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.window.navigator.onLine = false;
    harness.enter(paragraph);
    harness.runTimers(DispatchDelay);

    harness.document.hidden = true;
    harness.listeners.visibilitychange();

    // The reader never pauses its WebView, so a book left open offline would
    // otherwise keep probing in the background.
    assert.equal(harness.timers.size, 0);
});

test('jiten controller picks the work back up when the page is shown again', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.window.navigator.onLine = false;
    harness.enter(paragraph);
    harness.runTimers(DispatchDelay);
    harness.document.hidden = true;
    harness.listeners.visibilitychange();

    harness.window.navigator.onLine = true;
    harness.document.hidden = false;
    harness.listeners.visibilitychange();
    harness.runTimers(DispatchDelay);

    assert.equal(harness.parseCalls.length, 1);
});

test('jiten controller eventually tries anyway when told there is no network', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.window.navigator.onLine = false;
    harness.enter(paragraph);

    // A WebView stuck on onLine === false would otherwise mean a chapter that
    // never colours, with nothing to show why.
    for (let tick = 0; tick < 40 && harness.parseCalls.length === 0; tick += 1) {
        harness.runTimers();
    }

    assert.equal(harness.parseCalls.length, 1);
    // Only once backing off has run out of room, not on every sweep.
    assert.equal(harness.delays.filter((delay) => delay === 120000).length, 1);
});

test('jiten controller asks again the moment the network returns', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.window.navigator.onLine = false;
    harness.enter(paragraph);
    harness.runTimers();

    harness.window.navigator.onLine = true;
    harness.listeners.online();
    harness.runTimers();

    // Coming back online ends the wait, rather than the next backoff tick.
    assert.equal(harness.parseCalls.length, 1);
});

test('jiten controller backs off rather than failing on a schedule', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.enter(paragraph);
    harness.runTimers();

    const delays = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
        harness.jiten.onFailed(requestId(harness, attempt));
        delays.push(harness.delays.at(-1));
        harness.runTimers();
        harness.runTimers();
    }

    // An hour offline must not cost an hour of retries.
    assert.deepEqual(delays, [5000, 10000, 20000, 40000]);
});

test('jiten controller starts over at the short delay once something answers', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    const second = element('P', { text: '海が見えた' });
    harness.body.children = [paragraph, second];
    harness.jiten.start();
    harness.enter(paragraph);
    harness.runTimers();
    harness.jiten.onFailed(requestId(harness, 0));
    harness.runTimers();
    harness.runTimers();

    harness.jiten.onTokens(requestId(harness, 1), JSON.stringify([[{ start: 0, end: 2 }]]));
    harness.enter(second);
    harness.runTimers();
    harness.jiten.onFailed(requestId(harness, 2));

    // One bad stretch must not slow down the rest of the session.
    assert.equal(harness.delays.at(-1), 5000);
});

test('jiten controller clearing invalidates the requests in flight', () => {
    const harness = load();
    const paragraph = element('P', { text: '時間がある' });
    harness.body.children = [paragraph];
    harness.jiten.start();
    harness.enter(paragraph);
    harness.runTimers();

    assert.equal(harness.jiten.clear(), 1);

    assert.deepEqual(Array.from(harness.cancelCalls), [requestId(harness)]);
    assert.equal(harness.jiten.onTokens(requestId(harness), JSON.stringify([[{ start: 0, end: 2 }]])), 0);
});

test('jiten controller looks ahead of the viewport rather than at it', () => {
    const harness = load();
    harness.body.children = [element('P', { text: '時間がある' })];

    harness.jiten.start();

    // Colouring that lands only once text is on screen is visibly late.
    assert.equal(harness.observerOptions.rootMargin, '200%');
    assert.equal(harness.observerOptions.root, undefined);
});

test('jiten controller looks ahead inside a reader that scrolls its own element', () => {
    const harness = load();
    const scroller = element('BODY');
    // Paginated clips to the element it scrolls, and rootMargin only ever
    // expands the root — rooted at the viewport the lookahead would be none.
    harness.reader.getScrollContext = () => ({ scrollEl: scroller });
    harness.body.children = [element('P', { text: '時間がある' })];

    harness.jiten.start();

    assert.equal(harness.observerOptions.root, scroller);
    assert.equal(harness.observerOptions.rootMargin, '200%');
});
