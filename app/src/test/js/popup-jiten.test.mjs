import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const popupJitenUrl = new URL('../../main/assets/hoshi-web/popup/popup-jiten.js', import.meta.url);

class FakeText {
    constructor(value) {
        this.nodeType = 3;
        this.value = value;
    }

    get textContent() {
        return this.value;
    }
}

class FakeElement {
    constructor(tagName) {
        this.nodeType = 1;
        this.tagName = tagName.toUpperCase();
        this.className = '';
        this.childNodes = [];
        this.style = {};
        this.own = '';
        this.id = '';
        this.scrollTop = 0;
        this.classes = new Set();
        this.classList = {
            add: (...names) => names.forEach((name) => this.classes.add(name)),
            remove: (...names) => names.forEach((name) => this.classes.delete(name)),
            contains: (name) => this.classes.has(name),
        };
    }

    get textContent() {
        return this.own + this.childNodes.map((child) => child.textContent).join('');
    }

    set textContent(value) {
        this.own = String(value);
        this.childNodes = [];
    }

    appendChild(child) {
        this.childNodes.push(child);
        return child;
    }

    replaceChildren() {
        this.childNodes = [];
    }

    addEventListener(type, listener) {
        this.listeners ??= new Map();
        this.listeners.set(type, (this.listeners.get(type) ?? []).concat(listener));
    }

    click() {
        if (this.disabled) return;
        (this.listeners?.get('click') ?? []).forEach((listener) => listener());
    }
}

function load() {
    const body = new FakeElement('body');
    const entries = new FakeElement('div');
    entries.id = 'entries-container';
    const listeners = new Map();
    const timers = [];
    const byId = new Map([['entries-container', entries]]);
    body.appendChild = (child) => {
        body.childNodes.push(child);
        if (child.id) byId.set(child.id, child);
        return child;
    };
    const document = {
        body,
        createElement: (tagName) => new FakeElement(tagName),
        createTextNode: (value) => new FakeText(value),
        getElementById: (id) => byId.get(id) ?? null,
        addEventListener: (type, listener) => {
            listeners.set(type, (listeners.get(type) ?? []).concat(listener));
        },
    };
    const context = {
        window: {
            addEventListener: () => {},
            innerHeight: 600,
            setTimeout: (callback) => timers.push(callback),
        },
        document,
    };
    context.window.document = document;
    context.globalThis = context;
    vm.runInNewContext(fs.readFileSync(popupJitenUrl, 'utf8'), context);

    const actions = [];
    context.window.webkit = {
        messageHandlers: {
            jitenAction: {
                postMessage: (name) => new Promise((resolve) => actions.push({ name, resolve })),
            },
        },
    };

    const fire = (type, y) => {
        (listeners.get(type) ?? []).forEach((listener) =>
            listener({ touches: y === undefined ? [] : [{ clientY: y }], cancelable: true, preventDefault() {} }));
    };
    const buttons = () => byClass(byId.get('hoshi-jiten-page') ?? new FakeElement('div'), 'hoshi-jiten-action');
    return {
        jiten: context.window.hoshiPopupJiten,
        entries,
        actions,
        buttons,
        /** The action button whose label is exactly `label`. */
        button: (label) => buttons().find((node) => node.textContent === label),
        /** Lets a resolved bridge promise reach its `then`. */
        tick: () => new Promise((resolve) => setImmediate(resolve)),
        page: () => byId.get('hoshi-jiten-page') ?? null,
        /** Runs a whole drag: press at 0, move to `to`, release. */
        drag: (to) => {
            fire('touchstart', 0);
            fire('touchmove', to);
            fire('touchend');
        },
        /** Runs the animation clean-up the module defers past the transition. */
        flush: () => {
            const pending = timers.splice(0);
            pending.forEach((callback) => callback());
        },
    };
}

/** Every element under `node` with this tag name, in document order. */
function byTag(node, tagName) {
    const found = [];
    const visit = (current) => {
        if (current.nodeType !== 1) return;
        if (current.tagName === tagName.toUpperCase()) found.push(current);
        current.childNodes.forEach(visit);
    };
    visit(node);
    return found;
}

/** Every element under `node` carrying `className` among its classes. */
function byClass(node, className) {
    const found = [];
    const visit = (current) => {
        if (current.nodeType !== 1) return;
        if (String(current.className).split(/\s+/).includes(className)) found.push(current);
        current.childNodes.forEach(visit);
    };
    visit(node);
    return found;
}

test('the reveal lags the finger, so slack at the top turns no page', () => {
    const { jiten } = load();

    assert.equal(jiten.revealFor(0), 0);
    assert.equal(jiten.revealFor(-40), 0);
    // Below the travel floor a drag is a tap or the start of a scroll.
    assert.equal(jiten.revealFor(8), 0);
    assert.ok(jiten.revealFor(100) < 100);
});

test('the reveal stops growing once the turn is decided', () => {
    const { jiten } = load();

    assert.equal(jiten.revealFor(5000), jiten.revealFor(100000));
    assert.ok(jiten.turnsPage(jiten.revealFor(5000)));
});

test('a short drag does not turn the page and a long one does', () => {
    const { jiten } = load();

    assert.equal(jiten.turnsPage(jiten.revealFor(40)), false);
    assert.equal(jiten.turnsPage(jiten.revealFor(400)), true);
});

test('the card leads with the word, its reading and its state', () => {
    const { jiten } = load();

    const card = jiten.renderCard({
        spelling: '食べる',
        reading: 'たべる',
        frequencyRank: 312,
        states: ['due'],
        meanings: [{ glosses: ['to eat'], partsOfSpeech: ['v1', 'vt'] }],
    });

    assert.equal(byClass(card, 'hoshi-jiten-spelling')[0].textContent, '食べる');
    assert.equal(byClass(card, 'hoshi-jiten-reading')[0].textContent, 'たべる');
    const state = byClass(card, 'hoshi-jiten-state')[0];
    assert.equal(state.textContent, 'Due');
    // The chip reuses the chapter's state class, so both read the same colour.
    assert.ok(String(state.className).split(/\s+/).includes('jiten-due'));
    assert.equal(byClass(card, 'hoshi-jiten-frequency')[0].textContent, '#312');
});

test('a bracketed reading becomes furigana on the word, not a second word', () => {
    const { jiten } = load();

    // Jiten sends the whole word annotated, so printing it beside the spelling
    // would say the word twice and printing it raw would show the brackets.
    const card = jiten.renderCard({
        spelling: '取り引き',
        reading: '取[と]り引[ひ]き',
        states: ['new'],
        meanings: [],
    });

    assert.equal(byClass(card, 'hoshi-jiten-reading').length, 0);
    const word = byClass(card, 'hoshi-jiten-spelling')[0];
    assert.equal(word.textContent, '取とり引ひき');
    const rubies = byTag(word, 'ruby');
    assert.equal(rubies.length, 2);
    assert.deepEqual(byTag(word, 'rt').map((rt) => rt.textContent), ['と', 'ひ']);
});

test('okurigana after the final bracket is not dropped', () => {
    const { jiten } = load();

    const card = jiten.renderCard({
        spelling: '食べる',
        reading: '食[た]べる',
        states: ['due'],
        meanings: [],
    });

    const word = byClass(card, 'hoshi-jiten-spelling')[0];
    assert.equal(word.textContent, '食たべる');
    assert.equal(byTag(word, 'ruby').length, 1);
    // The trailing べる is a plain text node beside the ruby, not inside it.
    assert.equal(byTag(word, 'ruby')[0].textContent, '食た');
});

test('a word with no brackets is shown as plain text', () => {
    const { jiten } = load();

    const card = jiten.renderCard({
        spelling: 'ある',
        reading: 'ある',
        states: ['mature'],
        meanings: [],
    });

    const word = byClass(card, 'hoshi-jiten-spelling')[0];
    assert.equal(byTag(word, 'ruby').length, 0);
    assert.equal(word.textContent, 'ある');
});

test('a kana word does not say its reading back to itself', () => {
    const { jiten } = load();

    const card = jiten.renderCard({
        spelling: 'たべる',
        reading: 'たべる',
        states: [],
        meanings: [{ glosses: ['to eat'], partsOfSpeech: [] }],
    });

    assert.equal(byClass(card, 'hoshi-jiten-reading').length, 0);
});

test('every state the card carries is shown, not just the first', () => {
    const { jiten } = load();

    // A card is a tier state plus modifiers; showing one would misreport it.
    const card = jiten.renderCard({
        spelling: '本',
        reading: 'ほん',
        states: ['new', 'suspended'],
        meanings: [],
    });

    assert.deepEqual(
        byClass(card, 'hoshi-jiten-state').map((chip) => chip.textContent),
        ['New', 'Suspended'],
    );
});

test('meanings carry their parts of speech', () => {
    const { jiten } = load();

    const card = jiten.renderCard({
        spelling: '本',
        reading: 'ほん',
        states: ['mature'],
        meanings: [
            { glosses: ['book', 'volume'], partsOfSpeech: ['n'] },
            { glosses: ['main'], partsOfSpeech: [] },
        ],
    });

    const items = byClass(card, 'hoshi-jiten-meaning');
    assert.equal(items.length, 2);
    assert.equal(items[0].textContent, 'nbook; volume');
    assert.equal(items[1].textContent, 'main');
});

test('a card with nothing to gloss says so rather than showing an empty list', () => {
    const { jiten } = load();

    const card = jiten.renderCard({
        spelling: '本',
        reading: 'ほん',
        states: ['new'],
        meanings: [{ glosses: [], partsOfSpeech: ['n'] }],
    });

    assert.equal(byClass(card, 'hoshi-jiten-meanings').length, 0);
    assert.equal(byClass(card, 'hoshi-jiten-empty').length, 1);
});

test('an unknown state is shown as itself rather than dropped', () => {
    const { jiten } = load();

    // Jiten can add states; a silent drop would misreport the card.
    const card = jiten.renderCard({
        spelling: '本',
        reading: 'ほん',
        states: ['brandnew'],
        meanings: [],
    });

    assert.equal(byClass(card, 'hoshi-jiten-state')[0].textContent, 'brandnew');
});

const AnyCard = { spelling: '本', reading: 'ほん', states: ['new'], meanings: [] };

test('abandoning a drag puts the dictionary back where it was', () => {
    const harness = load();
    harness.jiten.showCard(AnyCard);

    harness.drag(30);
    harness.flush();

    // The regression: the dictionary was pushed down by the drag and left
    // there, so the article stayed offset for as long as the popup was open.
    assert.equal(harness.entries.style.transform, '');
    assert.equal(harness.entries.style.display, '');
    assert.equal(harness.jiten.state.showing, 'dictionary');
});

test('abandoning a drag rolls the card back up rather than sliding it away', () => {
    const harness = load();
    harness.jiten.showCard(AnyCard);

    harness.drag(30);

    // Reversing the reveal means collapsing its height. Sliding it down instead
    // sent the page being revealed off in the direction it had come from.
    assert.equal(harness.page().style.height, '0px');
    assert.equal(harness.page().style.transform, '');
});

test('a drag past the threshold turns the page and takes the dictionary out', () => {
    const harness = load();
    harness.jiten.showCard(AnyCard);

    harness.drag(400);
    harness.flush();

    assert.equal(harness.jiten.state.showing, 'jiten');
    assert.ok(harness.page().classList.contains('hoshi-jiten-committed'));
    assert.equal(harness.entries.style.display, 'none');
});

test('dragging back returns to the dictionary and restores it', () => {
    const harness = load();
    harness.jiten.showCard(AnyCard);
    harness.drag(400);
    harness.flush();

    harness.drag(400);
    harness.flush();

    assert.equal(harness.jiten.state.showing, 'dictionary');
    assert.equal(harness.entries.style.display, '');
    assert.equal(harness.entries.style.transform, '');
    assert.equal(harness.page().classList.contains('hoshi-jiten-committed'), false);
});

test('abandoning the drag back leaves the card in place', () => {
    const harness = load();
    harness.jiten.showCard(AnyCard);
    harness.drag(400);
    harness.flush();

    harness.drag(30);
    harness.flush();

    assert.equal(harness.jiten.state.showing, 'jiten');
    assert.ok(harness.page().classList.contains('hoshi-jiten-committed'));
    assert.equal(harness.page().style.transform, '');
    assert.equal(harness.entries.style.display, 'none');
});

test('with no card for this tap the drag does nothing at all', () => {
    const harness = load();
    harness.jiten.showCard(null);

    harness.drag(400);
    harness.flush();

    assert.equal(harness.jiten.state.showing, 'dictionary');
    // Never written at all, rather than written and cleared: with no card the
    // drag is not armed and the handlers return before touching the DOM.
    assert.ok(!harness.entries.style.transform);
});

test('on release the dictionary keeps going down with the card, not back up', () => {
    const harness = load();
    harness.jiten.showCard(AnyCard);

    harness.drag(400);

    // The two are one surface: the dictionary rides the bottom edge of the
    // card, which is growing to fill the viewport. Clearing the travel here
    // instead sends them apart the moment the finger lifts.
    assert.equal(harness.entries.style.transform, 'translateY(100vh)');
    harness.flush();
    // Only once it is out of sight does the travel go.
    assert.equal(harness.entries.style.display, 'none');
    assert.equal(harness.entries.style.transform, '');
});

test('a drag of about two thirds of an inch turns the page', () => {
    const harness = load();
    harness.jiten.showCard(AnyCard);

    // Roughly 65px of finger. Lower than it was, and still past the slack that
    // starts a scroll.
    harness.drag(70);
    harness.flush();

    assert.equal(harness.jiten.state.showing, 'jiten');
});

const DueCard = {
    spelling: '本',
    reading: 'ほん',
    states: ['due'],
    meanings: [{ glosses: ['book'], partsOfSpeech: ['n'] }],
};

test('the card offers the four grades and the three deck actions', () => {
    const harness = load();
    harness.jiten.showCard(DueCard);

    assert.deepEqual(
        harness.buttons().map((node) => node.textContent),
        ['Again', 'Hard', 'Good', 'Easy', 'Never forget', 'Blacklist', 'Forget'],
    );
});

test('actions are placed above meanings', () => {
    const { jiten } = load();
    const card = jiten.renderCard(DueCard);

    assert.deepEqual(
        card.childNodes.map((node) => node.className),
        ['hoshi-jiten-head', 'hoshi-jiten-actions', 'hoshi-jiten-meanings'],
    );
});

test('the card renders only actions enabled in settings', () => {
    const harness = load();
    harness.jiten.showCard({ ...DueCard, actions: ['again', 'good', 'blacklist'] });

    assert.deepEqual(
        harness.buttons().map((node) => node.textContent),
        ['Again', 'Good', 'Blacklist'],
    );
});

test('hiding every action removes the action panel', () => {
    const { jiten } = load();
    const card = jiten.renderCard({ ...DueCard, actions: [] });

    assert.equal(byClass(card, 'hoshi-jiten-actions').length, 0);
});

test('a membership button says what it will do, not what the card is', () => {
    const harness = load();
    harness.jiten.showCard({ ...DueCard, states: ['mastered', 'blacklisted'] });

    assert.ok(harness.button('Remove never forget'));
    assert.ok(harness.button('Remove blacklist'));
});

test('grading sends the action and repaints from the answer, not from a guess', async () => {
    const harness = load();
    harness.jiten.showCard(DueCard);

    harness.button('Good').click();

    assert.deepEqual(harness.actions.map((call) => call.name), ['good']);
    // Locked while in flight, so a second tap cannot queue a second review.
    assert.ok(harness.buttons().every((node) => node.disabled));

    harness.actions[0].resolve(['young']);
    await harness.tick();

    assert.deepEqual(harness.jiten.state.card.states, ['young']);
    assert.ok(harness.buttons().every((node) => !node.disabled));
});

test('forgetting asks twice, because it cannot be undone', async () => {
    const harness = load();
    harness.jiten.showCard(DueCard);

    harness.button('Forget').click();

    // The first tap only arms it; nothing has been sent.
    assert.deepEqual(harness.actions, []);
    assert.ok(harness.button('Tap again to forget'));

    harness.button('Tap again to forget').click();

    assert.deepEqual(harness.actions.map((call) => call.name), ['forget']);
});

test('a refused action says so and leaves the buttons usable', async () => {
    const harness = load();
    harness.jiten.showCard(DueCard);

    harness.button('Again').click();
    harness.actions[0].resolve(null);
    await harness.tick();

    const page = harness.page();
    assert.equal(byClass(page, 'hoshi-jiten-failed').length, 1);
    // The card keeps the state it had: nothing was changed, so nothing moves.
    assert.deepEqual(harness.jiten.state.card.states, ['due']);
    assert.ok(harness.buttons().every((node) => !node.disabled));
});

test('opening a new popup clears an armed forget', () => {
    const harness = load();
    harness.jiten.showCard(DueCard);
    harness.button('Forget').click();

    harness.jiten.showCard(DueCard);

    // Otherwise the next word's first tap on Forget would go straight through.
    assert.ok(harness.button('Forget'));
    assert.equal(harness.jiten.state.confirming, false);
});
