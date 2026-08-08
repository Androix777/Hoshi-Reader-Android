(function(global) {
  'use strict';

  /**
   * How far past the viewport still counts as "about to be read", as a
   * percentage of the viewport on every side.
   *
   * Both view modes scroll a container — continuous by pixels, paginated by
   * whole viewports worth of CSS columns — so one margin reads as "roughly two
   * screens ahead" in either. The number is deliberately generous: a unit
   * fetched too early costs one request, while one fetched too late is visibly
   * uncoloured text under the reader's eyes.
   */
  var LookaheadMargin = '200%';

  /**
   * Rebuilding reader offsets and Sasayaki cues costs a pass over the whole
   * chapter, and colouring now lands one small unit at a time. Coalescing a
   * burst of answers into one rebuild keeps that cost per screen, not per
   * paragraph.
   */
  var ReindexDelayMillis = 50;

  /**
   * One request per paragraph would trade a chapter's worth of work for a
   * chapter's worth of round trips, so everything that arrives within this
   * window travels together; Kotlin then splits it into request-sized batches.
   *
   * It has to be long enough to span a scroll, not just a repaint: paragraphs
   * cross the margin one at a time, a tenth of a second or so apart, and a
   * window shorter than that batches nothing. Nothing waits on it visibly —
   * colouring is already being fetched two screens ahead of the reader.
   */
  var DispatchDelayMillis = 500;

  /**
   * How long to wait before asking again for text whose request failed, and the
   * ceiling that backing off doubles towards.
   *
   * The observer never fires twice for text that did not move, so a failure — a
   * server hiccup, or simply no network — would otherwise leave that text
   * permanently uncoloured while everything around it colours normally. But
   * this reader is offline half the time by design, and a fixed retry would
   * then spend a whole reading session failing on a schedule. Backing off keeps
   * an offline hour down to a handful of attempts, and `online` is what
   * actually ends the wait.
   */
  var RetryDelayMillis = 5000;
  var MaxRetryDelayMillis = 120000;

  var state = {
    session: newSession(),
    counter: 0,
    observer: null,
    /** Units that came into reach and have not been sent yet. */
    queue: [],
    dispatchTimer: null,
    /** requestId -> { units: [{ node, texts, start }] } for everything in flight. */
    requests: new Map(),
    /** node -> requestId, so a unit leaving the viewport can be dropped. */
    nodeRequests: new Map(),
    /** Units that need no further work: coloured, or holding no parsable text. */
    settled: new Set(),
    /** Units currently within reach, and so worth asking for again on failure. */
    visible: new Set(),
    retryTimer: null,
    retryDelay: RetryDelayMillis,
    probe: false,
    reindexTimer: null,
    sasayakiCues: null
  };

  /**
   * The WebView outlives a chapter, so a fresh controller's counter restarts
   * while the previous chapter's requests may still be in flight. The session
   * prefix keeps ids from colliding, and telling Kotlin about it lets the old
   * chapter's work be dropped instead of parsed into nothing.
   */
  function newSession() {
    return String(Date.now()) + '-' + String(Math.floor(Math.random() * 1e9));
  }

  function bridge() {
    var api = global.HoshiJiten;
    return api && typeof api.parse === 'function' ? api : null;
  }

  /**
   * Sasayaki keeps text-node references and offsets in `cueSourceRanges`, which
   * a Jiten text-node split invalidates. `applySasayakiCues` rebuilds all of it
   * from scratch, so re-running it repairs the damage — but only if we know the
   * cues, and only Kotlin ever passes them in. Recording them here keeps the
   * repair inside fork-owned code; upstream stays untouched.
   */
  function observeSasayakiCues() {
    var reader = global.hoshiReader;
    if (!reader || typeof reader.applySasayakiCues !== 'function') return;
    if (reader.jitenObservesSasayakiCues) return;
    reader.jitenObservesSasayakiCues = true;
    var original = reader.applySasayakiCues;
    reader.applySasayakiCues = function(cues) {
      state.sasayakiCues = cues;
      return original.apply(this, arguments);
    };
  }

  /** One pass over the chapter for every burst of answers, rather than per unit. */
  function scheduleReindex() {
    if (state.reindexTimer !== null) return;
    state.reindexTimer = global.setTimeout(function() {
      state.reindexTimer = null;
      var reader = global.hoshiReader;
      if (reader && typeof reader.buildNodeOffsets === 'function') reader.buildNodeOffsets();
      if (reader && state.sasayakiCues && typeof reader.applySasayakiCues === 'function') {
        reader.applySasayakiCues(state.sasayakiCues);
      }
    }, ReindexDelayMillis);
  }

  function paragraphsOf(node) {
    var collector = global.hoshiReaderJitenParagraphs;
    return collector ? collector.collectParagraphs(node) : [];
  }

  function isBlockTag(tagName) {
    var collector = global.hoshiReaderJitenParagraphs;
    return !!collector && collector.isBlockTag(tagName);
  }

  /**
   * An element counts as a container only if it holds a block child that
   * carries text. `br` and `hr` are block boundaries but not containers, so
   * they must not force a descent that would strand the text around them.
   */
  function isContainer(node) {
    var children = node.children || [];
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (isBlockTag(child.tagName) && (child.textContent || '').length) return true;
    }
    return false;
  }

  /**
   * Split the chapter into the units that are observed and parsed on their own.
   *
   * A unit is the deepest element that is not a container — in prose, one
   * paragraph. Descending is the point: an EPUB that wraps its chapter in a
   * single `div` would otherwise be one unit again, which is exactly the
   * unbounded work this whole mechanism exists to avoid.
   */
  function collectUnits(root) {
    var units = [];
    var visit = function(node) {
      if (!node || node.nodeType !== 1) return;
      if (!isContainer(node)) {
        units.push(node);
        return;
      }
      var children = node.children;
      for (var i = 0; i < children.length; i++) {
        visit(children[i]);
      }
    };
    var top = (root || document.body).children || [];
    for (var k = 0; k < top.length; k++) {
      visit(top[k]);
    }
    return units;
  }

  /** A unit came into reach: it travels with whatever else arrives this tick. */
  function queueUnit(node) {
    if (state.settled.has(node) || state.nodeRequests.has(node)) return;
    if (state.queue.indexOf(node) === -1) state.queue.push(node);
    // Also for a unit already queued: an offline dispatch leaves the queue
    // standing but takes its timer with it, so something has to wind it again.
    scheduleDispatch();
  }

  function scheduleDispatch() {
    if (state.dispatchTimer !== null) return;
    state.dispatchTimer = global.setTimeout(function() {
      state.dispatchTimer = null;
      dispatch();
    }, DispatchDelayMillis);
  }

  /**
   * Send everything queued as one request. Offsets are collected per unit and
   * applied back into that same element, so they never depend on anything
   * outside it; the request only concatenates them.
   */
  function dispatch() {
    var api = bridge();
    if (!api) return 0;
    var probe = state.probe;
    state.probe = false;
    // A pending retry means the last attempt failed, and scrolling must not
    // route around that: text keeps arriving as the reader moves, and without
    // this a dead network would cost a request per screenful instead of one
    // per backoff step. While it is pending the sweep is the only way out, and
    // the sweep is allowed exactly one attempt.
    if (!probe && (state.retryTimer !== null || offline())) {
      // The queue keeps what it has; nothing is settled and nothing is asked
      // for until there is a network to ask over. Waiting here is free — no
      // request is made, so an offline hour costs a boolean read now and then.
      scheduleRetry();
      return 0;
    }
    var queued = state.queue.splice(0);
    var units = [];
    var texts = [];
    queued.forEach(function(node) {
      if (state.settled.has(node) || state.nodeRequests.has(node)) return;
      var unitTexts = paragraphsOf(node).map(function(paragraph) { return paragraph.text; });
      if (!unitTexts.length) {
        settle(node);
        return;
      }
      units.push({ node: node, texts: unitTexts, start: texts.length });
      texts = texts.concat(unitTexts);
    });
    if (!units.length) return 0;
    state.counter += 1;
    var requestId = state.session + ':' + String(state.counter);
    state.requests.set(requestId, { units: units });
    units.forEach(function(unit) { state.nodeRequests.set(unit.node, requestId); });
    api.parse(requestId, JSON.stringify(texts));
    return texts.length;
  }

  /**
   * A unit scrolled out of reach. One request covers several units, so the work
   * behind it is only called off once every unit in it has gone.
   */
  function cancelUnit(node) {
    var queued = state.queue.indexOf(node);
    if (queued !== -1) state.queue.splice(queued, 1);
    var requestId = state.nodeRequests.get(node);
    if (!requestId) return;
    state.nodeRequests.delete(node);
    var request = state.requests.get(requestId);
    if (!request) return;
    request.units = request.units.filter(function(unit) { return unit.node !== node; });
    if (request.units.length) return;
    state.requests.delete(requestId);
    var api = bridge();
    if (api && typeof api.cancel === 'function') api.cancel(requestId);
  }

  function settle(node) {
    state.settled.add(node);
    state.visible.delete(node);
    if (state.observer) state.observer.unobserve(node);
  }

  function onIntersection(entries) {
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (entry.isIntersecting) {
        state.visible.add(entry.target);
        queueUnit(entry.target);
      } else {
        state.visible.delete(entry.target);
        cancelUnit(entry.target);
      }
    }
  }

  /**
   * A request came back empty-handed. The units go back to being unasked-for
   * rather than settled, and the sweep picks them up again — text the reader
   * has already scrolled past is simply no longer in `visible`.
   */
  function onFailed(requestId) {
    var request = state.requests.get(requestId);
    if (!request) return 0;
    state.requests.delete(requestId);
    request.units.forEach(function(unit) { state.nodeRequests.delete(unit.node); });
    scheduleRetry();
    return request.units.length;
  }

  function scheduleRetry() {
    if (state.retryTimer !== null) return;
    var delay = state.retryDelay;
    state.retryDelay = Math.min(state.retryDelay * 2, MaxRetryDelayMillis);
    state.retryTimer = global.setTimeout(function() {
      state.retryTimer = null;
      // Once backing off has run out of room, try for real even if the browser
      // says there is no network. That is the only thing standing between a
      // WebView stuck on `onLine === false` and a chapter that never colours,
      // and at this delay it costs one request every couple of minutes.
      if (delay >= MaxRetryDelayMillis) state.probe = true;
      state.visible.forEach(queueUnit);
    }, delay);
  }

  /**
   * Reported by the WebView, so it knows about aeroplane mode and a dropped
   * connection but not about a network that merely goes nowhere. It is a
   * shortcut past a request that is certain to fail, never the only way back:
   * scrolling asks again, and the sweep probes regardless of it once the
   * backoff reaches its ceiling, so a flag stuck on `false` costs a slow retry
   * rather than a chapter that never colours.
   */
  function offline() {
    var navigator = global.navigator;
    return !!navigator && navigator.onLine === false;
  }

  /**
   * Nobody is reading a hidden page, so nothing is worth retrying for it. The
   * reader never pauses its WebView, so without this a book left open offline
   * keeps probing every couple of minutes in the background.
   */
  function whenVisible() {
    if (typeof document.addEventListener !== 'function') return;
    document.addEventListener('visibilitychange', function() {
      if (document.hidden) {
        if (state.retryTimer !== null) {
          global.clearTimeout(state.retryTimer);
          state.retryTimer = null;
        }
        return;
      }
      state.visible.forEach(queueUnit);
    });
  }

  /** Coming back online is what should end the wait, not the next timer. */
  function whenOnline() {
    if (typeof global.addEventListener !== 'function') return;
    global.addEventListener('online', function() {
      state.retryDelay = RetryDelayMillis;
      if (state.retryTimer !== null) {
        global.clearTimeout(state.retryTimer);
        state.retryTimer = null;
      }
      state.visible.forEach(queueUnit);
    });
  }

  /**
   * Paginated mode scrolls `document.body` and clips to it, so an observer
   * rooted at the viewport can never see past the current page: `rootMargin`
   * expands the root, not an intermediate clip, and the lookahead silently
   * becomes none — colouring then arrives after each page turn instead of
   * before it. Continuous scrolls the viewport itself, where the default root
   * is already the right one.
   *
   * Losing this only makes paginated colouring late, so an upstream rename is
   * not worth failing over.
   */
  function scrollRoot() {
    var reader = global.hoshiReader;
    if (!reader || typeof reader.getScrollContext !== 'function') return null;
    try {
      var context = reader.getScrollContext();
      return (context && context.scrollEl) || null;
    } catch (error) {
      return null;
    }
  }

  function observerOptions() {
    var options = { rootMargin: LookaheadMargin };
    var root = scrollRoot();
    if (root) options.root = root;
    return options;
  }

  function observeUnits() {
    var units = collectUnits(document.body);
    if (!global.IntersectionObserver) {
      // Without an observer there is no notion of "near the viewport" to scope
      // by, and leaving the chapter uncoloured is the worse failure.
      units.forEach(function(unit) {
        state.visible.add(unit);
        queueUnit(unit);
      });
      return units.length;
    }
    if (state.observer) state.observer.disconnect();
    state.observer = new global.IntersectionObserver(onIntersection, observerOptions());
    units.forEach(function(unit) { state.observer.observe(unit); });
    return units.length;
  }

  /**
   * Begin colouring this chapter. Nothing is parsed here: units are parsed as
   * they approach the viewport, which is what keeps a book that is one chapter
   * of a million characters from becoming one chapter of a million characters
   * worth of requests.
   */
  function start() {
    var api = bridge();
    if (!api) return 0;
    if (typeof api.beginSession === 'function') api.beginSession(state.session);
    return observeUnits();
  }

  /**
   * Restoring progress, wrapping Sasayaki cues and creating a highlight all
   * rearrange text nodes while a parse is in flight, so a unit's paragraphs are
   * collected again here rather than held across the round trip. None of those
   * change the text itself; if it changed anyway the offsets are not ours to
   * trust, and nothing is coloured.
   */
  function matchesPostedText(paragraphs, texts) {
    if (paragraphs.length !== texts.length) return false;
    for (var i = 0; i < paragraphs.length; i++) {
      if (paragraphs[i].text !== texts[i]) return false;
    }
    return true;
  }

  function onTokens(requestId, tokensJson) {
    var request = state.requests.get(requestId);
    // Unknown ids are answers to units that left the viewport, or to a chapter
    // the reader has already moved on from.
    if (!request) return 0;
    state.requests.delete(requestId);
    request.units.forEach(function(unit) { state.nodeRequests.delete(unit.node); });
    var highlight = global.hoshiReaderJitenHighlight;
    if (!highlight) return 0;
    var tokens;
    try {
      tokens = JSON.parse(tokensJson || '[]');
    } catch (error) {
      return 0;
    }
    // An answer means the network is back; the next failure starts over at the
    // short delay rather than inheriting an offline stretch's backoff.
    state.retryDelay = RetryDelayMillis;
    var applied = 0;
    request.units.forEach(function(unit) {
      var paragraphs = paragraphsOf(unit.node);
      // A mismatch leaves the unit unsettled, so scrolling back retries it.
      if (!matchesPostedText(paragraphs, unit.texts)) return;
      settle(unit.node);
      var slice = tokens.slice(unit.start, unit.start + unit.texts.length);
      applied += highlight.applyTokens(unit.node, paragraphs, slice, { deferOffsets: true });
    });
    if (applied) scheduleReindex();
    return applied;
  }

  function clear() {
    var highlight = global.hoshiReaderJitenHighlight;
    if (!highlight) return 0;
    var api = bridge();
    if (api && typeof api.cancel === 'function') {
      Array.from(state.requests.keys()).forEach(function(requestId) { api.cancel(requestId); });
    }
    state.queue = [];
    state.requests.clear();
    state.nodeRequests.clear();
    state.settled = new Set();
    state.visible = new Set();
    var cleared = highlight.clearTokens(document.body);
    if (cleared) scheduleReindex();
    return cleared;
  }

  observeSasayakiCues();
  whenOnline();
  whenVisible();

  global.hoshiReaderJiten = {
    start: start,
    onTokens: onTokens,
    onFailed: onFailed,
    clear: clear
  };
})(window);
