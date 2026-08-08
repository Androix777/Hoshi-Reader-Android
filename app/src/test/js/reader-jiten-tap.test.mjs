import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const textSemanticsUrl = new URL('../../main/assets/hoshi-web/reader/reader-text-semantics.js', import.meta.url);
const jitenParagraphsUrl = new URL('../../main/assets/hoshi-web/reader/reader-jiten-paragraphs.js', import.meta.url);
const jitenHighlightUrl = new URL('../../main/assets/hoshi-web/reader/reader-jiten-highlight.js', import.meta.url);
const jitenTapUrl = new URL('../../main/assets/hoshi-web/reader/reader-jiten-tap.js', import.meta.url);
const jitenCssUrl = new URL('../../main/assets/hoshi-web/reader/reader-jiten.css', import.meta.url);

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

    get textContent() {
        return this.nodeValue;
    }

    splitText(offset) {
        const tail = new TestText(this.nodeValue.slice(offset));
        this.nodeValue = this.nodeValue.slice(0, offset);
        const parent = this.parentNode;
        if (parent) parent.insertBefore(tail, parent.childNodes[parent.childNodes.indexOf(this) + 1] ?? null);
        return tail;
    }
}

class TestElement extends TestNode {
    constructor(tagName, children = []) {
        super(1);
        this.tagName = tagName.toUpperCase();
        this.childNodes = [];
        this.attributes = new Map();
        this.classes = new Set();
        this.classList = {
            add: (...names) => names.forEach((name) => this.classes.add(name)),
            remove: (...names) => names.forEach((name) => this.classes.delete(name)),
            contains: (name) => this.classes.has(name),
        };
        children.forEach((child) => this.append(child));
    }

    get className() {
        return [...this.classes].join(' ');
    }

    get textContent() {
        return this.childNodes.map((child) => child.textContent).join('');
    }

    set textContent(value) {
        this.childNodes.forEach((child) => {
            child.parentNode = null;
        });
        this.childNodes = [];
        this.append(value);
    }

    append(child) {
        const node = typeof child === 'string' ? new TestText(child) : child;
        node.parentNode?.removeChild(node);
        node.parentNode = this;
        this.childNodes.push(node);
        return node;
    }

    appendChild(child) {
        return this.append(child);
    }

    insertBefore(child, reference) {
        child.parentNode?.removeChild(child);
        child.parentNode = this;
        const index = reference ? this.childNodes.indexOf(reference) : -1;
        if (index < 0) this.childNodes.push(child);
        else this.childNodes.splice(index, 0, child);
        return child;
    }

    removeChild(child) {
        const index = this.childNodes.indexOf(child);
        if (index >= 0) {
            this.childNodes.splice(index, 1);
            child.parentNode = null;
        }
        return child;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    hasAttribute(name) {
        return this.attributes.has(name);
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    /** Supports only the `.class` selector these modules use. */
    querySelectorAll(selector) {
        const name = selector.replace(/^\./, '');
        const found = [];
        const visit = (node) => {
            if (node.nodeType !== 1) return;
            if (node.classes.has(name)) found.push(node);
            node.childNodes.forEach(visit);
        };
        this.childNodes.forEach(visit);
        return found;
    }
}

function element(tagName, ...children) {
    return new TestElement(tagName, children);
}

function load() {
    const head = element('head');
    const document = {
        head,
        createElement: (tagName) => element(tagName),
        getElementById: (id) => head.childNodes.find((child) => child.id === id) ?? null,
    };
    const context = {
        window: {},
        document,
        Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    };
    context.globalThis = context;
    vm.runInNewContext(fs.readFileSync(textSemanticsUrl, 'utf8'), context);
    vm.runInNewContext(fs.readFileSync(jitenParagraphsUrl, 'utf8'), context);
    const highlightSource = fs
        .readFileSync(jitenHighlightUrl, 'utf8')
        .replace('__HOSHI_JITEN_CSS_LITERAL__', JSON.stringify(fs.readFileSync(jitenCssUrl, 'utf8')));
    vm.runInNewContext(highlightSource, context);
    vm.runInNewContext(fs.readFileSync(jitenTapUrl, 'utf8'), context);
    context.window.hoshiReader = { buildNodeOffsets() {} };
    return {
        paragraphs: context.window.hoshiReaderJitenParagraphs,
        highlight: context.window.hoshiReaderJitenHighlight,
        tap: context.window.hoshiReaderJitenTap,
    };
}

/** Colours `root` with `tokens` against the paragraph the modules extract. */
function colour(modules, root, tokens) {
    const paragraphs = modules.paragraphs.collectParagraphs(root);
    modules.highlight.applyTokens(root, paragraphs, [tokens]);
}

/**
 * Rebuilds a result as a host object. The modules build theirs inside the `vm`
 * context, where the prototype is not the one `deepStrictEqual` compares to.
 */
function key(result) {
    return result && { wordId: result.wordId, readingIndex: result.readingIndex };
}

/**
 * The first text node under `node` whose value is exactly `value`. Colouring
 * splits text nodes, so the values to ask for after it are the split ones.
 */
function textNode(node, value) {
    if (node.nodeType === 3) return node.nodeValue === value ? node : null;
    for (const child of node.childNodes) {
        const found = textNode(child, value);
        if (found) return found;
    }
    return null;
}

test('resolves a tap inside a wrapped word to its card key', () => {
    const modules = load();
    const root = element('p', '今日は本を読む');
    // 今(0)日(1)は(2)本(3)を(4)読(5)む(6): the token is を読む.
    colour(modules, root, [{ start: 4, end: 7, wordId: 91, readingIndex: 2, states: ['new'] }]);

    assert.deepEqual(key(modules.tap.tokenAt(textNode(root, 'を読む'))), { wordId: 91, readingIndex: 2 });
});

test('returns null for text left outside every token', () => {
    const modules = load();
    const root = element('p', '今日は本を読む');
    colour(modules, root, [{ start: 4, end: 7, wordId: 91, readingIndex: 2, states: ['new'] }]);

    // The prefix stays in the original node when the wrapped range is split off.
    assert.equal(key(modules.tap.tokenAt(textNode(root, '今日は本'))), null);
    assert.equal(key(modules.tap.tokenAt(null)), null);
});

test('resolves a tap on a ruby base, where the key sits on the ruby itself', () => {
    const modules = load();
    const ruby = element('ruby', '食', element('rt', 'た'));
    const root = element('p', '今日', ruby, 'べる');
    // Paragraph text is 今日食べる: rt is excluded, so 食べる is 2..5.
    colour(modules, root, [{ start: 2, end: 5, wordId: 7, readingIndex: 0, states: ['due'] }]);

    assert.deepEqual(key(modules.tap.tokenAt(textNode(root, '食'))), { wordId: 7, readingIndex: 0 });
    assert.deepEqual(key(modules.tap.tokenAt(textNode(root, 'べる'))), { wordId: 7, readingIndex: 0 });
});

test('a tap on the furigana of a coloured word still resolves to the word', () => {
    const modules = load();
    const ruby = element('ruby', '食', element('rt', 'た'));
    const root = element('p', ruby, 'べる');
    colour(modules, root, [{ start: 0, end: 3, wordId: 7, readingIndex: 0, states: ['new'] }]);

    assert.deepEqual(key(modules.tap.tokenAt(textNode(root, 'た'))), { wordId: 7, readingIndex: 0 });
});

test('reading index zero survives, being a real reading rather than a missing one', () => {
    const modules = load();
    const root = element('p', '本');
    colour(modules, root, [{ start: 0, end: 1, wordId: 0, readingIndex: 0, states: ['mature'] }]);

    assert.deepEqual(key(modules.tap.tokenAt(textNode(root, '本'))), { wordId: 0, readingIndex: 0 });
});

test('describe reads the tap point, not where the dictionary scan ended', () => {
    const modules = load();
    const root = element('p', '今日は本を読む');
    colour(modules, root, [{ start: 4, end: 7, wordId: 91, readingIndex: 2, states: ['new'] }]);

    const startNode = textNode(root, 'を読む');
    assert.deepEqual(key(modules.tap.describe({ startNode, startOffset: 1 })), { wordId: 91, readingIndex: 2 });
    assert.equal(key(modules.tap.describe(null)), null);
});
