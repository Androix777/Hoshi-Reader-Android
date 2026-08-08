(function(global) {
  'use strict';

  var PageId = 'hoshi-jiten-page';
  var SettlingClass = 'hoshi-jiten-settling';
  var CommittedClass = 'hoshi-jiten-committed';

  /**
   * Reveal, in pixels, that turns the page when the finger lifts. With the
   * damping below this is about 65px of finger, which is a short deliberate
   * drag rather than the half-screen the first attempt asked for.
   */
  var CommitThreshold = 40;

  /**
   * The reveal lags the finger. A page turn has to be meant: without damping,
   * the slack at the top of a flick would start turning pages on its own.
   */
  var Damping = 0.7;

  /** Travel below this is a tap or the start of a scroll, not a drag. */
  var MinTravel = 8;

  /** Past this the turn is decided; more travel only stretches the animation. */
  var MaxReveal = 260;

  /** Must outlast the CSS transition, which is what it is cleaning up after. */
  var SettleMillis = 200;

  var StateLabels = {
    'new': 'New',
    young: 'Young',
    mature: 'Mature',
    mastered: 'Mastered',
    due: 'Due',
    blacklisted: 'Blacklisted',
    redundant: 'Redundant',
    suspended: 'Suspended'
  };

  /** How far the page is revealed for a finger that has travelled `travel`. */
  function revealFor(travel) {
    if (travel <= MinTravel) return 0;
    return Math.min((travel - MinTravel) * Damping, MaxReveal);
  }

  function turnsPage(reveal) {
    return reveal >= CommitThreshold;
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /**
   * Jiten writes a reading as the whole word with each run of kanji followed by
   * its own reading in brackets — `取[と]り引[ひ]き`. So it is not a reading to
   * put beside the spelling; it *is* the spelling, annotated. Printed as it
   * arrives it reads as gibberish, and printed next to the spelling it says the
   * word twice.
   *
   * Anything with no bracket is left alone: a kana word arrives unannotated.
   */
  function furiganaNodes(wordWithReading) {
    if (wordWithReading.indexOf('[') === -1) {
      return [document.createTextNode(wordWithReading)];
    }
    // A run of non-kana — the class spans hiragana and katakana, U+3040..U+30FF
    // — followed by its reading in brackets.
    var pattern = /([^぀-ゟ゠-ヿ]+)\[(.+?)\]/g;
    var nodes = [];
    var consumed = 0;
    var match;
    while ((match = pattern.exec(wordWithReading)) !== null) {
      if (match.index > consumed) {
        nodes.push(document.createTextNode(wordWithReading.slice(consumed, match.index)));
      }
      var ruby = element('ruby');
      ruby.appendChild(document.createTextNode(match[1]));
      ruby.appendChild(element('rt', null, match[2]));
      nodes.push(ruby);
      consumed = pattern.lastIndex;
    }
    if (consumed < wordWithReading.length) {
      nodes.push(document.createTextNode(wordWithReading.slice(consumed)));
    }
    return nodes;
  }

  /** The word as one annotated run, falling back to the bare spelling. */
  function renderWord(card) {
    var word = element('span', 'hoshi-jiten-spelling');
    var source = card.reading && card.reading.indexOf('[') !== -1 ? card.reading : card.spelling;
    furiganaNodes(String(source || '')).forEach(function(node) { word.appendChild(node); });
    return word;
  }

  /**
   * The card as the Jiten page shows it: the word and its state first, because
   * the page is turned to check that the tap found the word the reader meant.
   */
  function renderCard(card, view, onAction) {
    var options = view || {};
    var root = element('div', 'hoshi-jiten-card');
    var head = element('div', 'hoshi-jiten-head');
    head.appendChild(renderWord(card));
    // Only where the reading carries no furigana of its own and actually says
    // something the spelling does not.
    if (card.reading && card.reading.indexOf('[') === -1 && card.reading !== card.spelling) {
      head.appendChild(element('span', 'hoshi-jiten-reading', card.reading));
    }
    (card.states || []).forEach(function(state) {
      head.appendChild(element('span', 'hoshi-jiten-state jiten-' + state, StateLabels[state] || state));
    });
    if (card.frequencyRank) {
      head.appendChild(element('span', 'hoshi-jiten-frequency', '#' + card.frequencyRank));
    }
    root.appendChild(head);

    var actions = renderActions(card, options, onAction);
    if (actions) root.appendChild(actions);

    var meanings = (card.meanings || []).filter(function(meaning) {
      return meaning && (meaning.glosses || []).length;
    });
    if (!meanings.length) {
      root.appendChild(element('div', 'hoshi-jiten-empty', 'No meanings'));
    } else {
      var list = element('ol', 'hoshi-jiten-meanings');
      meanings.forEach(function(meaning) {
        var item = element('li', 'hoshi-jiten-meaning');
        if ((meaning.partsOfSpeech || []).length) {
          item.appendChild(element('span', 'hoshi-jiten-pos', meaning.partsOfSpeech.join(', ')));
        }
        item.appendChild(document.createTextNode(meaning.glosses.join('; ')));
        list.appendChild(item);
      });
      root.appendChild(list);
    }

    return root;
  }

  var Grades = [
    { name: 'again', label: 'Again' },
    { name: 'hard', label: 'Hard' },
    { name: 'good', label: 'Good' },
    { name: 'easy', label: 'Easy' }
  ];

  function hasState(card, name) {
    return (card.states || []).indexOf(name) !== -1;
  }

  function actionButton(label, name, view, onAction, className) {
    var node = element(
      'button',
      'hoshi-jiten-action hoshi-jiten-action-' + name + ' ' + (className || ''),
      label
    );
    node.type = 'button';
    node.disabled = !!view.busy;
    node.addEventListener('click', function() {
      if (onAction) onAction(name);
    });
    return node;
  }

  /**
   * Membership buttons say what they will do, not what the card is: the same
   * button removes what it added, and a label naming the state would read as
   * an instruction to set it again.
   *
   * Forgetting destroys the card's review history and has no counterpart, so it
   * asks twice. A second tap rather than a dialog — `window.confirm` in a
   * WebView needs a chrome client to answer it, and an unanswered one is simply
   * dropped, which would make the button silently do nothing.
   */
  function renderActions(card, view, onAction) {
    var configured = Array.isArray(card.actions) ? card.actions : null;
    function isVisible(name) {
      return !configured || configured.indexOf(name) !== -1;
    }

    var actions = element('div', 'hoshi-jiten-actions');
    var grades = element('div', 'hoshi-jiten-grades');
    Grades.forEach(function(grade) {
      if (isVisible(grade.name)) {
        grades.appendChild(actionButton(grade.label, grade.name, view, onAction, 'hoshi-jiten-grade'));
      }
    });
    if (grades.childNodes.length) actions.appendChild(grades);

    var decks = element('div', 'hoshi-jiten-decks');
    if (isVisible('neverForget')) {
      decks.appendChild(actionButton(
        hasState(card, 'mastered') ? 'Remove never forget' : 'Never forget',
        'neverForget',
        view,
        onAction
      ));
    }
    if (isVisible('blacklist')) {
      decks.appendChild(actionButton(
        hasState(card, 'blacklisted') ? 'Remove blacklist' : 'Blacklist',
        'blacklist',
        view,
        onAction
      ));
    }
    if (isVisible('forget')) {
      decks.appendChild(actionButton(
        view.confirming ? 'Tap again to forget' : 'Forget',
        'forget',
        view,
        onAction,
        view.confirming ? 'hoshi-jiten-confirming' : ''
      ));
    }
    if (decks.childNodes.length) actions.appendChild(decks);

    if (view.failed) {
      actions.appendChild(element('div', 'hoshi-jiten-failed', 'Jiten did not answer. Nothing was changed.'));
    }
    return actions.childNodes.length ? actions : null;
  }

  var state = {
    /** undefined: not asked yet. null: asked, this tap has no card. */
    card: undefined,
    showing: 'dictionary',
    dragging: false,
    startY: 0,
    reveal: 0,
    /** An action is in flight; the buttons are disabled until it answers. */
    busy: false,
    /** Forget has been tapped once and is waiting to be confirmed. */
    confirming: false,
    failed: false
  };

  function page() {
    var existing = document.getElementById(PageId);
    if (existing) return existing;
    var node = document.createElement('div');
    node.id = PageId;
    document.body.appendChild(node);
    return node;
  }

  function entries() {
    return document.getElementById('entries-container');
  }

  function scrollRoot() {
    return document.scrollingElement || document.documentElement || document.body;
  }

  /**
   * Whether a downward drag is the page turn rather than a scroll. Only at the
   * very top: below it the drag belongs to whichever page is being read.
   */
  function armed() {
    if (state.card === undefined || state.card === null) return false;
    // `reducedMotionScrolling` claims every touchmove for its own paging.
    if (global.reducedMotionScrolling) return false;
    if (state.showing === 'jiten') return page().scrollTop <= 0;
    var root = scrollRoot();
    return !root || (root.scrollTop || 0) <= 0;
  }

  /** Turning to Jiten: the page grows from the top, pushing the dictionary. */
  function setReveal(reveal) {
    state.reveal = reveal;
    var node = page();
    node.style.height = reveal + 'px';
    node.style.transform = '';
    var container = entries();
    if (container) container.style.transform = 'translateY(' + reveal + 'px)';
  }

  /**
   * Turning back is the same downward drag, so the Jiten page slides down out
   * of the way and the dictionary comes out from behind its top edge. Shrinking
   * the page instead would roll it upward, against the finger.
   */
  function setRetreat(reveal) {
    state.reveal = reveal;
    var container = entries();
    if (container) {
      container.style.display = '';
      container.style.transform = '';
    }
    page().style.transform = 'translateY(' + reveal + 'px)';
  }

  /**
   * Runs the release out and then clears what the drag left inline — after the
   * animation, or there would be nothing to animate from.
   *
   * Which way it plays depends on the page dragged *from*, not only on who won.
   * Abandoning a drag has to run that drag backwards; it is not the same motion
   * as turning the other way, and playing it as one sends the page that was
   * being revealed sliding off in the direction it came from.
   */
  function settle(from, turned) {
    var node = page();
    var container = entries();
    var toJiten = from === 'dictionary' ? turned : !turned;
    node.classList.add(SettlingClass);
    if (container) container.classList.add(SettlingClass);
    state.showing = toJiten ? 'jiten' : 'dictionary';
    state.reveal = 0;

    if (from === 'dictionary') {
      // Throughout the drag the dictionary sits against the bottom edge of the
      // card, so it has to keep sitting there through the release: the card
      // grows to the full viewport, so the dictionary travels a viewport down.
      // Sending it back to zero here instead makes the two halves of one
      // surface leave in opposite directions the instant the finger lifts.
      if (turned) {
        node.classList.add(CommittedClass);
        node.style.height = '';
        if (container) container.style.transform = 'translateY(100vh)';
      } else {
        node.style.height = '0px';
        if (container) container.style.transform = '';
      }
    } else {
      // Turning: the card carries on down and off. Abandoning: it slides back
      // up over the dictionary it had begun to uncover.
      node.style.transform = turned ? 'translateY(100%)' : '';
    }

    global.setTimeout(function() {
      node.classList.remove(SettlingClass);
      if (from === 'jiten' && turned) {
        node.classList.remove(CommittedClass);
        node.style.transform = '';
        node.style.height = '0px';
      }
      if (container) {
        container.classList.remove(SettlingClass);
        // Behind a full-height page the dictionary only lengthens the document
        // and can still catch a stray scroll, so it is taken out entirely. The
        // travel it was left holding goes with it, once it is out of sight.
        container.style.display = toJiten ? 'none' : '';
        if (toJiten) container.style.transform = '';
      }
    }, SettleMillis);
  }

  function onTouchStart(event) {
    state.dragging = false;
    if (!event.touches || event.touches.length !== 1) return;
    if (!armed()) return;
    state.dragging = true;
    state.startY = event.touches[0].clientY;
  }

  function onTouchMove(event) {
    if (!state.dragging || !event.touches || event.touches.length !== 1) return;
    var travel = event.touches[0].clientY - state.startY;
    if (travel <= 0) return;
    var reveal = revealFor(travel);
    if (!reveal) return;
    // Past the first pixel the drag is the page turn, not a scroll.
    if (event.cancelable) event.preventDefault();
    if (state.showing === 'jiten') setRetreat(reveal);
    else setReveal(reveal);
  }

  function onTouchEnd() {
    if (!state.dragging) return;
    state.dragging = false;
    settle(state.showing, turnsPage(state.reveal));
  }

  function render() {
    var node = page();
    node.replaceChildren();
    if (!state.card) return;
    node.appendChild(renderCard(state.card, {
      busy: state.busy,
      confirming: state.confirming,
      failed: state.failed
    }, onAction));
  }

  function showCard(card) {
    state.card = card || null;
    state.busy = false;
    state.confirming = false;
    state.failed = false;
    render();
  }

  function sendAction(name) {
    var handlers = global.webkit && global.webkit.messageHandlers;
    var handler = handlers && handlers.jitenAction;
    if (!handler || typeof handler.postMessage !== 'function') return null;
    var pending = handler.postMessage(name);
    return pending && typeof pending.then === 'function' ? pending : null;
  }

  /**
   * The states are taken from the answer rather than guessed at beforehand. A
   * grade moves a card by rules that live on the server, so an optimistic
   * colour would be right only by accident, and a word repainted wrongly is
   * worse than one repainted a moment late.
   */
  function onAction(name) {
    if (state.busy || !state.card) return;
    if (name === 'forget' && !state.confirming) {
      state.confirming = true;
      render();
      return;
    }
    state.confirming = false;
    state.failed = false;
    state.busy = true;
    render();
    var pending = sendAction(name);
    if (!pending) {
      state.busy = false;
      state.failed = true;
      render();
      return;
    }
    pending.then(function(states) {
      state.busy = false;
      if (states) {
        state.card = Object.assign({}, state.card, { states: states });
      } else {
        state.failed = true;
      }
      render();
    });
  }

  function requestCard() {
    var handlers = global.webkit && global.webkit.messageHandlers;
    var handler = handlers && handlers.jitenCard;
    if (!handler || typeof handler.postMessage !== 'function') {
      showCard(null);
      return;
    }
    var pending = handler.postMessage();
    if (!pending || typeof pending.then !== 'function') {
      showCard(null);
      return;
    }
    // The reply is inlined into a script call, so it arrives already decoded.
    pending.then(showCard);
  }

  /**
   * Back to the dictionary with no animation, for a popup being reused: the
   * previous word's card must not be what the next tap opens onto.
   */
  function reset() {
    state.card = undefined;
    state.showing = 'dictionary';
    state.dragging = false;
    state.reveal = 0;
    state.busy = false;
    state.confirming = false;
    state.failed = false;
    var node = page();
    node.classList.remove(SettlingClass, CommittedClass);
    node.style.height = '0px';
    node.replaceChildren();
    var container = entries();
    if (container) {
      container.classList.remove(SettlingClass);
      container.style.transform = '';
      container.style.display = '';
    }
  }

  /**
   * Listens for the host's own render messages rather than hooking `popup.js`,
   * which owns none of this and would have to be edited to announce itself.
   */
  function observePopup() {
    if (typeof global.addEventListener !== 'function') return;
    global.addEventListener('message', function(event) {
      if (event.origin !== 'https://appassets.androidplatform.net') return;
      var message = event.data || {};
      if (message.type === 'renderPopup') {
        reset();
        // Deferred past this dispatch on purpose. This module is loaded from
        // the head, so its listener runs before the document's own, which is
        // what sets `window.popupId` — and every bridge message is tagged with
        // it. Asking now would send a request with no popup to answer for, and
        // an unanswerable request never resolves its promise.
        global.setTimeout(requestCard, 0);
        return;
      }
      if (message.type === 'resetPopup') reset();
    });
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchEnd, { passive: true });
  }

  observePopup();

  global.hoshiPopupJiten = {
    revealFor: revealFor,
    turnsPage: turnsPage,
    renderCard: renderCard,
    showCard: showCard,
    reset: reset,
    state: state
  };
})(window);
