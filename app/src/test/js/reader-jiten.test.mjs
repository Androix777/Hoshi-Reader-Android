import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const jitenUrl = new URL('../../main/assets/hoshi-web/reader/reader-jiten.js', import.meta.url);

/**
 * The controller is tested against stub collector and highlight modules: what
 * it owns is request identity and the guard on stale text, not the DOM work
 * those two modules have their own tests for.
 */
function load({ withBridge = true } = {}) {
    const harness = {
        collected: [],
        parseCalls: [],
        appliedCues: [],
        applyCalls: [],
        clearCalls: 0,
    };
    const window = {
        hoshiReader: {
            applySasayakiCues(cues) {
                harness.appliedCues.push(cues);
            },
        },
        hoshiReaderJitenParagraphs: {
            collectParagraphs: () =>
                harness.collected.map((entry) =>
                    typeof entry === 'string' ? { text: entry, fragments: [] } : entry,
                ),
        },
        hoshiReaderJitenHighlight: {
            applyTokens(root, paragraphs, tokens) {
                harness.applyCalls.push({ paragraphs, tokens });
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
            parse(requestId, paragraphsJson) {
                harness.parseCalls.push({ requestId, paragraphs: JSON.parse(paragraphsJson) });
            },
        };
    }
    const context = { window, document: { body: {} } };
    context.globalThis = context;
    vm.runInNewContext(fs.readFileSync(jitenUrl, 'utf8'), context);
    harness.jiten = window.hoshiReaderJiten;
    harness.reader = window.hoshiReader;
    return harness;
}

test('jiten controller posts the collected paragraph texts', () => {
    const harness = load();
    harness.collected = ['時間がある', '海が見えた'];

    const count = harness.jiten.start();

    assert.equal(count, 2);
    const [call] = harness.parseCalls;
    assert.equal(call.requestId, 1);
    assert.deepEqual(Array.from(call.paragraphs), ['時間がある', '海が見えた']);
});

test('jiten controller stays quiet without a bridge', () => {
    const harness = load({ withBridge: false });
    harness.collected = ['時間がある'];

    assert.equal(harness.jiten.start(), 0);
});

test('jiten controller applies tokens for the request it is waiting on', () => {
    const harness = load();
    harness.collected = ['時間がある'];
    harness.jiten.start();

    const applied = harness.jiten.onTokens(1, JSON.stringify([[{ start: 0, end: 2 }]]));

    assert.equal(applied, 1);
    assert.equal(harness.applyCalls.length, 1);
});

test('jiten controller drops the answer to a superseded request', () => {
    const harness = load();
    harness.collected = ['時間がある'];
    harness.jiten.start();
    harness.jiten.start();

    // The first chapter's answer arriving after the second was requested.
    assert.equal(harness.jiten.onTokens(1, JSON.stringify([[{ start: 0, end: 2 }]])), 0);
    assert.equal(harness.applyCalls.length, 0);
});

test('jiten controller re-collects paragraphs rather than holding them', () => {
    const harness = load();
    harness.collected = [{ text: '時間がある', fragments: ['stale'] }];
    harness.jiten.start();
    // Restoring progress and wrapping cues rearrange text nodes while the parse
    // is in flight, which is exactly what the fragments describe.
    harness.collected = [{ text: '時間がある', fragments: ['fresh'] }];

    harness.jiten.onTokens(1, JSON.stringify([[{ start: 0, end: 2 }]]));

    assert.deepEqual(Array.from(harness.applyCalls[0].paragraphs[0].fragments), ['fresh']);
});

test('jiten controller refuses to colour text that changed under it', () => {
    const harness = load();
    harness.collected = ['時間がある'];
    harness.jiten.start();
    harness.collected = ['時間がある', '足された段落'];

    assert.equal(harness.jiten.onTokens(1, JSON.stringify([[{ start: 0, end: 2 }]])), 0);
    assert.equal(harness.applyCalls.length, 0);
});

test('jiten controller survives an unparsable payload', () => {
    const harness = load();
    harness.collected = ['時間がある'];
    harness.jiten.start();

    assert.equal(harness.jiten.onTokens(1, 'not json'), 0);
});

test('jiten controller rebuilds sasayaki cues after splitting text nodes', () => {
    const harness = load();
    const cues = [{ id: 'cue-1', start: 0, length: 5 }];
    harness.reader.applySasayakiCues(cues);
    harness.collected = ['時間がある'];
    harness.jiten.start();

    harness.jiten.onTokens(1, JSON.stringify([[{ start: 0, end: 2 }]]));

    // Once from the reader itself, once to repair the ranges Jiten invalidated.
    assert.equal(harness.appliedCues.length, 2);
    assert.equal(harness.appliedCues[1], cues);
});

test('jiten controller leaves sasayaki alone when nothing was coloured', () => {
    const harness = load();
    harness.reader.applySasayakiCues([{ id: 'cue-1', start: 0, length: 5 }]);
    harness.collected = ['時間がある'];
    harness.jiten.start();

    harness.jiten.onTokens(1, JSON.stringify([[]]));

    assert.equal(harness.appliedCues.length, 1);
});

test('jiten controller clearing invalidates the request in flight', () => {
    const harness = load();
    harness.collected = ['時間がある'];
    harness.jiten.start();

    assert.equal(harness.jiten.clear(), 1);
    assert.equal(harness.jiten.onTokens(1, JSON.stringify([[{ start: 0, end: 2 }]])), 0);
});
