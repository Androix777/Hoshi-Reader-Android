(function(global) {
  'use strict';

  // Elements whose text is never reader prose. RT/RP are handled separately
  // because they are furigana: skipped here, but their ruby parent is not.
  var skipTags = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO',
    'IMG', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON',
    'RT', 'RP'
  ]);

  // Paragraph boundaries are decided by tag name rather than by
  // getComputedStyle. Resolving style for every element in a chapter costs a
  // full style pass, and the failure mode is mild: a mis-classified element
  // only merges or splits a parse unit, which degrades tokenization at that
  // spot. Offsets stay correct either way.
  var blockTags = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'CAPTION', 'DD', 'DIV',
    'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1',
    'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL',
    'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD',
    'TR', 'UL'
  ]);

  var whitespace = /[\t\n\f\r ]/;

  function textSemantics() {
    if (!global.hoshiReaderTextSemantics) {
      throw new Error('hoshiReaderTextSemantics is required for Jiten paragraph extraction');
    }
    return global.hoshiReaderTextSemantics;
  }

  function isWideCharacter(char) {
    return !!char && textSemantics().isJapaneseBreakCharacter(char);
  }

  function isBlockTag(tagName) {
    return blockTags.has(String(tagName || '').toUpperCase());
  }

  /**
   * Collect the text nodes of `root` grouped into parse units, in document
   * order. Every group is the content between two block boundaries.
   */
  function collectRuns(root) {
    var runs = [];
    var current = [];
    var flush = function() {
      if (current.length) runs.push(current);
      current = [];
    };
    var visit = function(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue) current.push(node);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      var tagName = String(node.tagName || '').toUpperCase();
      if (skipTags.has(tagName)) return;
      var isBlock = blockTags.has(tagName);
      if (isBlock) flush();
      var children = node.childNodes || [];
      for (var i = 0; i < children.length; i++) {
        visit(children[i]);
      }
      if (isBlock) flush();
    };
    visit(root);
    flush();
    return runs;
  }

  /**
   * Build the string posted to Jiten out of one run of text nodes, together
   * with the fragments that map it back to the DOM.
   *
   * Whitespace is folded the way CSS `white-space: normal` renders it, so the
   * posted string is what the reader shows: runs collapse to one space, runs
   * at either edge vanish, and a run containing a line break between two wide
   * characters vanishes too (the segment break transformation, which is why
   * `食\nべる` reads as one word on screen and must parse as one).
   *
   * Folded-away characters are simply left out of the fragment list. Fragments
   * therefore need not tile their node — they only have to be ordered and
   * non-overlapping, which is all the offset mapping requires.
   */
  function buildParagraph(run) {
    var text = '';
    var fragments = [];
    var pending = null;

    var push = function(node, nodeStart, nodeEnd, value) {
      var last = fragments[fragments.length - 1];
      if (last && last.node === node && last.nodeEnd === nodeStart && last.end === text.length) {
        last.nodeEnd = nodeEnd;
        last.end = text.length + value.length;
      } else {
        fragments.push({
          node: node,
          nodeStart: nodeStart,
          nodeEnd: nodeEnd,
          start: text.length,
          end: text.length + value.length
        });
      }
      text += value;
    };

    var flushPending = function(nextChar) {
      if (!pending) return;
      var run = pending;
      pending = null;
      if (!text.length) return;
      if (run.hasLineBreak && isWideCharacter(text.charAt(text.length - 1)) && isWideCharacter(nextChar)) {
        return;
      }
      push(run.node, run.offset, run.offset + 1, ' ');
    };

    for (var r = 0; r < run.length; r++) {
      var node = run[r];
      var data = node.nodeValue || '';
      var i = 0;
      while (i < data.length) {
        var char = data.charAt(i);
        if (whitespace.test(char)) {
          if (!pending) pending = { node: node, offset: i, hasLineBreak: false };
          if (char === '\n' || char === '\r') pending.hasLineBreak = true;
          i += 1;
          continue;
        }
        var start = i;
        while (i < data.length && !whitespace.test(data.charAt(i))) {
          i += 1;
        }
        flushPending(char);
        push(node, start, i, data.slice(start, i));
      }
    }

    return { text: text, fragments: fragments };
  }

  /**
   * Split `root` into the paragraphs posted to `reader/parse`.
   *
   * Offsets in the result are UTF-16 code units over `paragraph.text` and are
   * paragraph-local, matching what Jiten returns. They are unrelated to the
   * reader's own code-point offsets in `nodeStartOffsets`.
   */
  function collectParagraphs(root) {
    var paragraphs = [];
    collectRuns(root || document.body).forEach(function(run) {
      var paragraph = buildParagraph(run);
      if (paragraph.fragments.length) paragraphs.push(paragraph);
    });
    return paragraphs;
  }

  global.hoshiReaderJitenParagraphs = {
    collectParagraphs: collectParagraphs,
    isBlockTag: isBlockTag
  };
})(window);
