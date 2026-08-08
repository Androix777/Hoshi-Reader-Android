(function(global) {
  'use strict';

  var WordIdAttribute = 'data-jiten-word-id';
  var ReadingIndexAttribute = 'data-jiten-reading-index';

  /**
   * The marked element covering `node`, if any.
   *
   * Colouring puts the key either on a wrapper span or directly on a `ruby`,
   * and the tap lands on the text node inside whichever it was, so the search
   * goes up rather than testing the hit itself.
   */
  function wordElement(node) {
    var element = node && node.nodeType === 1 ? node : (node && node.parentNode);
    while (element && element.nodeType === 1) {
      if (element.hasAttribute && element.hasAttribute(WordIdAttribute)) return element;
      element = element.parentNode;
    }
    return null;
  }

  function attributeNumber(element, name) {
    var raw = element.getAttribute(name);
    if (raw === null || raw === '') return null;
    var value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  /**
   * The Jiten card key under `node`, or null where the text carries no token:
   * Jiten switched off, the paragraph not parsed yet, or a word Jiten did not
   * recognize. Deliberately no surface text — one token can span a `ruby` and
   * a following okurigana wrapper, and half a word would misinform exactly the
   * check the card is opened to make.
   */
  function tokenAt(node) {
    var element = wordElement(node);
    if (!element) return null;
    var wordId = attributeNumber(element, WordIdAttribute);
    var readingIndex = attributeNumber(element, ReadingIndexAttribute);
    if (wordId === null || readingIndex === null) return null;
    return { wordId: wordId, readingIndex: readingIndex };
  }

  /**
   * The key for a `hoshiSelection` selection, for the one delegating call in
   * `postTextSelected`. The selection records where the tap landed, which is
   * what decides the token; where the scan then ran to is the dictionary's
   * business and no concern of Jiten's.
   */
  function describe(selection) {
    return selection ? tokenAt(selection.startNode) : null;
  }

  global.hoshiReaderJitenTap = {
    tokenAt: tokenAt,
    describe: describe
  };
})(window);
