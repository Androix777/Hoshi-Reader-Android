import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const textSemanticsUrl = new URL('../../main/assets/hoshi-web/reader/reader-text-semantics.js', import.meta.url);
const jitenParagraphsUrl = new URL('../../main/assets/hoshi-web/reader/reader-jiten-paragraphs.js', import.meta.url);

class TestNode {
    constructor(nodeType) {
        this.nodeType = nodeType;
        this.parentNode = null;
    }
}

class TestText extends TestNode {
    constructor(value) {
        super(3);
        this.nodeValue = value;
    }
}

class TestElement extends TestNode {
    constructor(tagName, children = []) {
        super(1);
        this.tagName = tagName.toUpperCase();
        this.childNodes = [];
        children.forEach((child) => this.append(child));
    }

    append(child) {
        const node = typeof child === 'string' ? new TestText(child) : child;
        node.parentNode = this;
        this.childNodes.push(node);
        return node;
    }
}

function element(tagName, ...children) {
    return new TestElement(tagName, children);
}

function loadParagraphs() {
    const context = { window: {}, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 } };
    context.globalThis = context;
    vm.runInNewContext(fs.readFileSync(textSemanticsUrl, 'utf8'), context);
    vm.runInNewContext(fs.readFileSync(jitenParagraphsUrl, 'utf8'), context);
    return context.window.hoshiReaderJitenParagraphs;
}

/** Rebuilds the list in this realm; arrays from the vm context fail deepEqual on prototype identity. */
function texts(paragraphs) {
    return Array.from(paragraphs, (paragraph) => paragraph.text);
}

/** Every fragment must quote its node verbatim at the offsets it claims. */
function assertFragmentsMapBack(paragraph) {
    paragraph.fragments.forEach((fragment) => {
        assert.equal(
            fragment.node.nodeValue.slice(fragment.nodeStart, fragment.nodeEnd),
            paragraph.text.slice(fragment.start, fragment.end),
        );
    });
}

test('jiten paragraphs split on block boundaries and restart offsets at zero', () => {
    const { collectParagraphs } = loadParagraphs();
    const root = element('div', element('p', '走れメロス。'), element('p', '海が見えた。'));

    const paragraphs = collectParagraphs(root);

    assert.deepEqual(texts(paragraphs), ['走れメロス。', '海が見えた。']);
    paragraphs.forEach((paragraph) => {
        assert.equal(paragraph.fragments[0].start, 0);
        assertFragmentsMapBack(paragraph);
    });
});

test('jiten paragraphs break at br, which is a line break inside a block', () => {
    const { collectParagraphs } = loadParagraphs();
    const root = element('p', '春はあけぼの', element('br'), '夏は夜');

    assert.deepEqual(texts(collectParagraphs(root)), ['春はあけぼの', '夏は夜']);
});

test('jiten paragraphs exclude furigana but keep the ruby base inline', () => {
    const { collectParagraphs } = loadParagraphs();
    const ruby = element('ruby', '世界', element('rt', 'せかい'), element('rp', ')'));
    const root = element('p', 'この', ruby, 'は');

    const [paragraph] = collectParagraphs(root);

    assert.equal(paragraph.text, 'この世界は');
    assert.equal(paragraph.fragments.length, 3);
    assert.equal(paragraph.fragments[1].node.nodeValue, '世界');
    assert.deepEqual([paragraph.fragments[1].start, paragraph.fragments[1].end], [2, 4]);
    assertFragmentsMapBack(paragraph);
});

test('jiten paragraphs skip elements that never hold prose', () => {
    const { collectParagraphs } = loadParagraphs();
    const root = element('div', element('p', '本文'), element('script', 'var x = 1;'), element('img'));

    assert.deepEqual(texts(collectParagraphs(root)), ['本文']);
});

test('jiten paragraphs drop the line break the reader itself renders away', () => {
    const { collectParagraphs } = loadParagraphs();
    // Source-formatted markup: the browser renders 食べる as one word, so a
    // space here would break the token apart.
    const root = element('p', element('span', '食'), '\n      ', element('span', 'べる'));

    const [paragraph] = collectParagraphs(root);

    assert.equal(paragraph.text, '食べる');
    assertFragmentsMapBack(paragraph);
});

test('jiten paragraphs keep one space where the reader renders one', () => {
    const { collectParagraphs } = loadParagraphs();
    const root = element('p', '  Run   Melos\n  ');

    const [paragraph] = collectParagraphs(root);

    assert.equal(paragraph.text, 'Run Melos');
    assertFragmentsMapBack(paragraph);
});

test('jiten paragraph offsets count utf-16 code units, not code points', () => {
    const { collectParagraphs } = loadParagraphs();
    const root = element('p', '𩸽が旨い');

    const [paragraph] = collectParagraphs(root);

    assert.equal(paragraph.text.length, 5);
    assert.equal(Array.from(paragraph.text).length, 4);
    assert.deepEqual([paragraph.fragments[0].start, paragraph.fragments[0].end], [0, 5]);
});

test('jiten paragraphs merge adjacent runs of the same node into one fragment', () => {
    const { collectParagraphs } = loadParagraphs();
    const root = element('p', '走れメロス。');

    const [paragraph] = collectParagraphs(root);

    assert.equal(paragraph.fragments.length, 1);
});

test('jiten paragraphs ignore blocks that hold no text', () => {
    const { collectParagraphs } = loadParagraphs();
    const root = element('div', element('p', '   '), element('p', '本文'), element('p'));

    assert.deepEqual(texts(collectParagraphs(root)), ['本文']);
});

test('jiten paragraphs treat a nested block as its own parse unit', () => {
    const { collectParagraphs } = loadParagraphs();
    const root = element('div', 'まえ', element('p', 'なか'), 'あと');

    assert.deepEqual(texts(collectParagraphs(root)), ['まえ', 'なか', 'あと']);
});
