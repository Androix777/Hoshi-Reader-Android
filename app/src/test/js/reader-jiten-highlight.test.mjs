import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const textSemanticsUrl = new URL('../../main/assets/hoshi-web/reader/reader-text-semantics.js', import.meta.url);
const jitenParagraphsUrl = new URL('../../main/assets/hoshi-web/reader/reader-jiten-paragraphs.js', import.meta.url);
const jitenHighlightUrl = new URL('../../main/assets/hoshi-web/reader/reader-jiten-highlight.js', import.meta.url);
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

    /** Supports only the `.class` selector this module uses. */
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
        getElementById: (id) => head.childNodes.find((child) => child.getAttribute?.('id') === id) ?? null,
    };
    const context = {
        window: {},
        document,
        Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    };
    context.globalThis = context;
    // The real style element carries an id property, not an attribute.
    document.getElementById = (id) => head.childNodes.find((child) => child.id === id) ?? null;
    vm.runInNewContext(fs.readFileSync(textSemanticsUrl, 'utf8'), context);
    vm.runInNewContext(fs.readFileSync(jitenParagraphsUrl, 'utf8'), context);
    const highlightSource = fs
        .readFileSync(jitenHighlightUrl, 'utf8')
        .replace('__HOSHI_JITEN_CSS_LITERAL__', JSON.stringify(fs.readFileSync(jitenCssUrl, 'utf8')));
    vm.runInNewContext(highlightSource, context);
    context.window.hoshiReader = {
        rebuilds: 0,
        buildNodeOffsets() {
            this.rebuilds += 1;
        },
        unwrap(wrappers) {
            wrappers.forEach((wrapper) => {
                const parent = wrapper.parentNode;
                if (!parent) return;
                [...wrapper.childNodes].forEach((child) => parent.insertBefore(child, wrapper));
                parent.removeChild(wrapper);
            });
        },
    };
    return {
        document,
        reader: context.window.hoshiReader,
        paragraphs: context.window.hoshiReaderJitenParagraphs,
        highlight: context.window.hoshiReaderJitenHighlight,
    };
}

function token(start, end, states, wordId = 1, readingIndex = 0) {
    return { start, end, states, wordId, readingIndex };
}

function words(root) {
    return root.querySelectorAll('.jiten-word');
}

test('jiten highlight wraps a token in a span carrying its card states', () => {
    const { paragraphs, highlight, reader } = load();
    const root = element('p', '時間がある');

    const applied = highlight.applyTokens(root, paragraphs.collectParagraphs(root), [[token(0, 2, ['new'])]]);

    assert.equal(applied, 1);
    assert.equal(root.textContent, '時間がある');
    const [word] = words(root);
    assert.equal(word.textContent, '時間');
    assert.equal(word.classes.has('jiten-new'), true);
    assert.equal(word.getAttribute('data-jiten-word-id'), '1');
    assert.equal(reader.rebuilds, 1);
});

test('jiten highlight keeps several tokens in one text node in order', () => {
    const { paragraphs, highlight } = load();
    const root = element('p', '時間がある');
    const tokens = [token(0, 2, ['mature'], 1), token(2, 3, ['new'], 2), token(3, 5, ['young'], 3)];

    highlight.applyTokens(root, paragraphs.collectParagraphs(root), [tokens]);

    assert.equal(root.textContent, '時間がある');
    assert.deepEqual(
        Array.from(words(root), (word) => word.textContent),
        ['時間', 'が', 'ある'],
    );
    assert.deepEqual(
        Array.from(words(root), (word) => word.getAttribute('data-jiten-word-id')),
        ['1', '2', '3'],
    );
});

test('jiten highlight colours the ruby element instead of splitting its base', () => {
    const { paragraphs, highlight } = load();
    const ruby = element('ruby', '食', element('rt', 'た'));
    const root = element('p', ruby, 'べる');

    highlight.applyTokens(root, paragraphs.collectParagraphs(root), [[token(0, 3, ['new'])]]);

    // The base text node is untouched; the annotation still hangs off it.
    assert.equal(ruby.childNodes.length, 2);
    assert.equal(ruby.childNodes[0].nodeValue, '食');
    assert.equal(ruby.classes.has('jiten-word'), true);
    assert.equal(ruby.classes.has('jiten-new'), true);
    const wrapped = words(root).filter((word) => word.hasAttribute('data-jiten-wrap'));
    assert.deepEqual(Array.from(wrapped, (word) => word.textContent), ['べる']);
});

test('jiten highlight gives a shared ruby to the first token only', () => {
    const { paragraphs, highlight } = load();
    const ruby = element('ruby', '東京', element('rt', 'とうきょう'));
    const root = element('p', ruby);

    highlight.applyTokens(root, paragraphs.collectParagraphs(root), [
        [token(0, 1, ['new'], 1), token(1, 2, ['young'], 2)],
    ]);

    assert.equal(ruby.getAttribute('data-jiten-word-id'), '1');
    assert.equal(ruby.classes.has('jiten-young'), false);
});

test('jiten highlight splits a token that straddles a nested element', () => {
    const { paragraphs, highlight } = load();
    const root = element('p', element('em', '走'), 'れメロス');

    highlight.applyTokens(root, paragraphs.collectParagraphs(root), [[token(0, 2, ['due'])]]);

    assert.equal(root.textContent, '走れメロス');
    assert.deepEqual(Array.from(words(root), (word) => word.textContent), ['走', 'れ']);
});

test('jiten highlight cuts tokens on utf-16 boundaries', () => {
    const { paragraphs, highlight } = load();
    const root = element('p', '𩸽が旨い');

    // 𩸽 occupies two code units, so the noun ends at 2, not 1.
    highlight.applyTokens(root, paragraphs.collectParagraphs(root), [[token(0, 2, ['new'])]]);

    assert.equal(root.textContent, '𩸽が旨い');
    assert.equal(words(root)[0].textContent, '𩸽');
});

test('jiten highlight applies every state a card carries', () => {
    const { paragraphs, highlight } = load();
    const root = element('p', '時間');

    highlight.applyTokens(root, paragraphs.collectParagraphs(root), [[token(0, 2, ['new', 'redundant'])]]);

    const [word] = words(root);
    assert.equal(word.classes.has('jiten-new'), true);
    assert.equal(word.classes.has('jiten-redundant'), true);
});

test('jiten highlight clears back to the markup the reader built', () => {
    const { paragraphs, highlight, reader } = load();
    const ruby = element('ruby', '食', element('rt', 'た'));
    const root = element('p', ruby, 'べるのが好き');

    highlight.applyTokens(root, paragraphs.collectParagraphs(root), [
        [token(0, 3, ['new'], 1), token(5, 7, ['young'], 2)],
    ]);
    const cleared = highlight.clearTokens(root);

    assert.equal(cleared, 3);
    // textContent counts the furigana too; the point is that nothing moved.
    assert.equal(root.textContent, '食たべるのが好き');
    assert.equal(words(root).length, 0);
    assert.equal(ruby.className, '');
    assert.equal(ruby.hasAttribute('data-jiten-word-id'), false);
    assert.equal(reader.rebuilds, 2);
});

test('jiten highlight installs its stylesheet once', () => {
    const { document, paragraphs, highlight } = load();
    const root = element('p', '時間');

    highlight.applyTokens(root, paragraphs.collectParagraphs(root), [[token(0, 2, ['new'])]]);
    highlight.applyTokens(root, paragraphs.collectParagraphs(root), [[]]);

    const styles = document.head.childNodes.filter((child) => child.tagName === 'STYLE');
    assert.equal(styles.length, 1);
    assert.match(styles[0].textContent, /\.jiten-word\.jiten-new/);
});

test('jiten highlight ignores tokens no fragment covers', () => {
    const { paragraphs, highlight, reader } = load();
    const root = element('p', '時間');

    const applied = highlight.applyTokens(root, paragraphs.collectParagraphs(root), [[token(9, 12, ['new'])]]);

    assert.equal(applied, 0);
    assert.equal(reader.rebuilds, 0);
});
