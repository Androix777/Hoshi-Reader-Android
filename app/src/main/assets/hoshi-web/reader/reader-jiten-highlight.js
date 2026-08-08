(function(global) {
  'use strict';

  var StyleElementId = 'hoshi-jiten-styles';
  var WordClass = 'jiten-word';
  var WrapperAttribute = 'data-jiten-wrap';
  var WordIdAttribute = 'data-jiten-word-id';
  var ReadingIndexAttribute = 'data-jiten-reading-index';

  var styleSheet = __HOSHI_JITEN_CSS_LITERAL__;

  function ensureStyles() {
    if (document.getElementById(StyleElementId)) return;
    var style = document.createElement('style');
    style.id = StyleElementId;
    style.textContent = styleSheet;
    (document.head || document.documentElement).appendChild(style);
  }

  function rubyAncestor(node, root) {
    var element = node.parentNode;
    while (element && element !== root) {
      if (String(element.tagName || '').toUpperCase() === 'RUBY') return element;
      element = element.parentNode;
    }
    return null;
  }

  /**
   * The DOM ranges a token covers, in document order. A token can straddle
   * several text nodes (a ruby base followed by an okurigana text node is the
   * common case), and can cover only part of one.
   */
  function tokenRanges(paragraph, token) {
    var ranges = [];
    paragraph.fragments.forEach(function(fragment) {
      if (fragment.end <= token.start || fragment.start >= token.end) return;
      var from = Math.max(token.start, fragment.start) - fragment.start;
      var to = Math.min(token.end, fragment.end) - fragment.start;
      if (to <= from) return;
      ranges.push({
        node: fragment.node,
        start: fragment.nodeStart + from,
        end: fragment.nodeStart + to
      });
    });
    return ranges;
  }

  function markWord(element, token) {
    // A token that shares an element with an earlier one would otherwise
    // repaint it; first token wins, as in the extension.
    if (element.hasAttribute(WordIdAttribute)) return false;
    element.classList.add(WordClass);
    (token.states || []).forEach(function(state) {
      element.classList.add('jiten-' + state);
    });
    element.setAttribute(WordIdAttribute, String(token.wordId));
    element.setAttribute(ReadingIndexAttribute, String(token.readingIndex));
    return true;
  }

  /**
   * Wrap one text-node range, splitting the node down to exactly that range.
   * Splitting keeps the prefix in the original node, so ranges applied in
   * reverse document order leave every earlier range's node and offsets valid.
   */
  function wrapRange(range, token) {
    var target = range.node;
    var data = target.nodeValue || '';
    if (range.end < data.length) target.splitText(range.end);
    if (range.start > 0) target = target.splitText(range.start);
    var parent = target.parentNode;
    if (!parent) return null;
    var span = document.createElement('span');
    span.setAttribute(WrapperAttribute, 'true');
    markWord(span, token);
    parent.insertBefore(span, target);
    span.appendChild(target);
    return span;
  }

  /**
   * Resolve every token to DOM ranges before touching the DOM, in document
   * order. Ranges are plain `(node, start, end)` triples, so the wrapping pass
   * can run back to front without re-reading the paragraph fragments.
   */
  function planTokens(paragraphs, tokensByParagraph, root) {
    var planned = [];
    paragraphs.forEach(function(paragraph, index) {
      var tokens = ((tokensByParagraph || [])[index] || []).slice().sort(function(a, b) {
        return a.start - b.start;
      });
      tokens.forEach(function(token) {
        var ranges = tokenRanges(paragraph, token);
        if (!ranges.length) return;
        planned.push({
          token: token,
          // Never wrap inside a ruby: that would split the base away from its
          // annotation. The whole ruby is coloured instead, which also leaves
          // the reader's own furigana untouched.
          rubies: ranges.map(function(range) { return rubyAncestor(range.node, root); }),
          ranges: ranges,
          applied: false
        });
      });
    });
    return planned;
  }

  /**
   * Colour `paragraphs` from `hoshiReaderJitenParagraphs.collectParagraphs`
   * with `tokensByParagraph[i]` holding `{ start, end, wordId, readingIndex,
   * states }` for `paragraphs[i]`, all offsets paragraph-local UTF-16.
   *
   * The paragraph list is consumed: applying splits text nodes, so a caller
   * that wants to recolour must collect paragraphs again.
   *
   * `options.deferOffsets` leaves the `buildNodeOffsets` pass to the caller,
   * for callers colouring several elements in a row.
   */
  function applyTokens(root, paragraphs, tokensByParagraph, options) {
    ensureStyles();
    var scope = root || document.body;
    var planned = planTokens(paragraphs, tokensByParagraph, scope);

    // Rubies first and in document order, so that where two tokens land in one
    // ruby the earlier one wins rather than whichever the wrapping pass met.
    planned.forEach(function(entry) {
      entry.rubies.forEach(function(ruby) {
        if (ruby && markWord(ruby, entry.token)) entry.applied = true;
      });
    });

    // Wrapping splits text nodes, and splitting leaves the prefix in the
    // original node. Going back to front therefore keeps every range that has
    // not been applied yet pointing at the right node and offsets.
    for (var i = planned.length - 1; i >= 0; i--) {
      var entry = planned[i];
      for (var r = entry.ranges.length - 1; r >= 0; r--) {
        if (entry.rubies[r]) continue;
        if (wrapRange(entry.ranges[r], entry.token)) entry.applied = true;
      }
    }

    var applied = planned.filter(function(entry) { return entry.applied; }).length;
    var deferOffsets = !!(options && options.deferOffsets);
    if (applied && !deferOffsets && global.hoshiReader) global.hoshiReader.buildNodeOffsets();
    return applied;
  }

  function jitenClasses(element) {
    return String(element.className || '')
      .split(/\s+/)
      .filter(function(name) { return name.indexOf('jiten-') === 0; });
  }

  /** Undo `applyTokens`, leaving the DOM as the reader built it. */
  function clearTokens(root) {
    var scope = root || document.body;
    var marked = Array.from(scope.querySelectorAll('.' + WordClass));
    var wrappers = [];
    marked.forEach(function(element) {
      element.removeAttribute(WordIdAttribute);
      element.removeAttribute(ReadingIndexAttribute);
      element.classList.remove.apply(element.classList, jitenClasses(element));
      if (element.hasAttribute(WrapperAttribute)) wrappers.push(element);
    });
    if (wrappers.length && global.hoshiReader) {
      global.hoshiReader.unwrap(wrappers);
      global.hoshiReader.buildNodeOffsets();
    }
    return marked.length;
  }

  global.hoshiReaderJitenHighlight = {
    applyTokens: applyTokens,
    clearTokens: clearTokens,
    ensureStyles: ensureStyles
  };
})(window);
