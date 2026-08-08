(function(global) {
  'use strict';

  var state = {
    requestId: 0,
    texts: null,
    sasayakiCues: null
  };

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

  function repairSasayakiCues() {
    var reader = global.hoshiReader;
    if (!reader || !state.sasayakiCues) return;
    reader.applySasayakiCues(state.sasayakiCues);
  }

  function collect() {
    var collector = global.hoshiReaderJitenParagraphs;
    return collector ? collector.collectParagraphs(document.body) : [];
  }

  /**
   * Collect the chapter and ask Kotlin to parse it. Answers arrive at
   * [onTokens]; a later `start` invalidates an earlier request, which is how a
   * chapter change discards a response that is still in flight.
   */
  function start() {
    var api = bridge();
    if (!api) return 0;
    var texts = collect().map(function(paragraph) { return paragraph.text; });
    state.requestId += 1;
    state.texts = texts;
    if (!texts.length) return 0;
    api.parse(state.requestId, JSON.stringify(texts));
    return texts.length;
  }

  /**
   * Restoring progress, wrapping Sasayaki cues and creating a highlight all
   * rearrange text nodes while a parse is in flight, so the paragraphs are
   * collected again here rather than held across the round trip. None of those
   * change the text itself; if it changed anyway the offsets are not ours to
   * trust, and nothing is coloured.
   */
  function matchesPostedText(paragraphs) {
    if (!state.texts || paragraphs.length !== state.texts.length) return false;
    for (var i = 0; i < paragraphs.length; i++) {
      if (paragraphs[i].text !== state.texts[i]) return false;
    }
    return true;
  }

  function onTokens(requestId, tokensJson) {
    if (requestId !== state.requestId) return 0;
    var highlight = global.hoshiReaderJitenHighlight;
    if (!highlight) return 0;
    var tokens;
    try {
      tokens = JSON.parse(tokensJson || '[]');
    } catch (error) {
      return 0;
    }
    var paragraphs = collect();
    if (!matchesPostedText(paragraphs)) return 0;
    state.texts = null;
    var applied = highlight.applyTokens(document.body, paragraphs, tokens);
    if (applied) repairSasayakiCues();
    return applied;
  }

  function clear() {
    var highlight = global.hoshiReaderJitenHighlight;
    if (!highlight) return 0;
    state.requestId += 1;
    state.texts = null;
    var cleared = highlight.clearTokens(document.body);
    if (cleared) repairSasayakiCues();
    return cleared;
  }

  observeSasayakiCues();

  global.hoshiReaderJiten = {
    start: start,
    onTokens: onTokens,
    clear: clear
  };
})(window);
