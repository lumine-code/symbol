const el = require("./element-builder");

const murmur = require("murmurhash-js");
const BADGE_TEXT_HASH_MAP = new Map();

/**
 * Given a string of text, returns a hexadecimal character from `0` to `f` to
 * represent a classification “bucket.” This is used when assigning colors to
 * various symbol badges.
 *
 * @param   {String} text The text of the badge.
 * @returns {String} A single character that represents a hexadecimal digit.
 */
function getBadgeTextVariant(text) {
  // The goal here is to give each tag a color such that (a) two things with the
  // same tag will have badges of identical colors, and (b) two things with
  // different tags are very likely to have badges of different colors. We use a
  // fast (non-cryptographic) hashing algorithm, convert its return integer to
  // hex, then take the final character; this, in effect, gives a piece of text
  // an equal chance of being sorted into any of sixteen random buckets.
  //
  // In the CSS, we generate sixteen badge colors based on the user's UI theme;
  // they are identical in saturation and brightness and vary only in hue.
  if (BADGE_TEXT_HASH_MAP.has(text)) {
    return BADGE_TEXT_HASH_MAP.get(text);
  }
  let hash = murmur.murmur3(text, "symbol").toString(16);
  let variantType = hash.charAt(hash.length - 1);
  BADGE_TEXT_HASH_MAP.set(text, variantType);
  return variantType;
}

/**
 * Return a DOM element for a badge for a given symbol tag name.
 *
 * @param   {String} text The text of the tag.
 * @param   {Object} options Options. Defaults to an empty object.
 * @param   {Boolean} options.variant Whether to add a class name for the badge's
 *   “variant.” If enabled, this will attempt to assign a different badge color
 *   for each kind of tag. Optional; defaults to `false`.
 * @returns {Element} An element for adding to an `lumine-select-view` entry.
 */
function badge(text, options = {}) {
  let { variant = false } = options;
  let classNames = `.badge.badge-info.badge-flexible.badge-symbol-tag`;
  if (variant) {
    let variantType = getBadgeTextVariant(text);
    classNames += `.symbol-badge-variant-${variantType}`;
  }
  return el(`span${classNames}`, text);
}

module.exports = {
  badge,
};
