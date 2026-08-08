(function(global) {
  'use strict';

  /** Text this far past the viewport, in viewports, is parsed ahead of time. */
  var LookaheadMargin = '200%';

  /** Coalescing window for the chapter-wide offset and cue rebuild. */
  var ReindexDelayMillis = 50;

  /** Units entering view within this window travel as one request. */
  var DispatchDelayMillis = 500;

  /** Retry delay after a failed request, doubling to the ceiling. */
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
   * The WebView outlives a chapter and every chapter's counter starts at one,
   * so request ids need a per-page-load prefix to stay unique.
   */
  function newSession() {
    return String(Date.now()) + '-' + String(Math.floor(Math.random() * 1e9));
  }

  function bridge() {
    var api = global.HoshiJiten;
    return api && typeof api.parse === 'function' ? api : null;
  }

  /**
   * Records the cues Kotlin passes in, so [scheduleReindex] can rebuild them.
   * Sasayaki holds text nodes and offsets that colouring invalidates, and only
   * Kotlin knows the cues.
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

  /** Rebuilds reader offsets and Sasayaki cues, once per burst of answers. */
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
   * Whether an element holds a block child carrying text. Empty blocks (`br`,
   * `hr`) do not count: descending into them would strand their siblings.
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
   * The units observed and parsed independently: the deepest elements that are
   * not containers, which in prose is one per paragraph.
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

  /** Queues a unit for the next dispatch, rewinding the timer if it has run. */
  function queueUnit(node) {
    if (state.settled.has(node) || state.nodeRequests.has(node)) return;
    if (state.queue.indexOf(node) === -1) state.queue.push(node);
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
   * Sends everything queued as one request. Paragraphs are collected per unit
   * and applied back into that same element, so a unit's offsets never depend
   * on anything outside it; the request only concatenates them.
   *
   * A pending retry blocks dispatching, not just sweeping — otherwise scrolling
   * would route around the backoff, since text keeps arriving as the reader
   * moves. The queue is left standing, so nothing is lost by waiting.
   */
  function dispatch() {
    var api = bridge();
    if (!api) return 0;
    var probe = state.probe;
    state.probe = false;
    if (!probe && (state.retryTimer !== null || offline())) {
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
   * Returns a request's units to the unasked-for state, so the retry sweep
   * picks up whatever is still within reach.
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
      // At the ceiling, try even if the browser claims no network: a WebView
      // stuck on `onLine === false` would otherwise never colour anything.
      if (delay >= MaxRetryDelayMillis) state.probe = true;
      state.visible.forEach(queueUnit);
    }, delay);
  }

  /**
   * Whether the browser reports no network at all. It knows about aeroplane
   * mode and a dropped connection, but not about a network that goes nowhere,
   * so it is only ever a shortcut past a request certain to fail.
   */
  function offline() {
    var navigator = global.navigator;
    return !!navigator && navigator.onLine === false;
  }

  /**
   * Stops retrying while the page is hidden and resumes when it is shown. The
   * reader does not pause its WebView, so its timers keep running otherwise.
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

  /** Ends the backoff as soon as the network returns. */
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
   * The element the reader scrolls, which must be the observer root wherever it
   * is not the viewport: `rootMargin` expands the root, not an intermediate
   * clip, so paginated mode would otherwise get no lookahead at all. Absent, it
   * only costs late colouring, so an upstream rename is not worth failing over.
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
      // No way to scope by proximity; parse the chapter rather than nothing.
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
   * Begins colouring this chapter. Nothing is parsed here — units are parsed as
   * they approach the viewport, so the cost follows reading, not chapter size.
   */
  function start() {
    var api = bridge();
    if (!api) return 0;
    if (typeof api.beginSession === 'function') api.beginSession(state.session);
    return observeUnits();
  }

  /**
   * Whether a unit still holds the text that was posted for it. Progress
   * restore, Sasayaki cues and highlights all rearrange text nodes mid-flight
   * without changing the text; anything else makes the offsets untrustworthy.
   */
  function matchesPostedText(paragraphs, texts) {
    if (paragraphs.length !== texts.length) return false;
    for (var i = 0; i < paragraphs.length; i++) {
      if (paragraphs[i].text !== texts[i]) return false;
    }
    return true;
  }

  function onTokens(requestId, tokensJson) {
    // An unknown id is an answer to units that left the viewport, or to a
    // chapter the reader has moved on from.
    var request = state.requests.get(requestId);
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
