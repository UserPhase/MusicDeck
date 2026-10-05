/**
 * @typedef {Object} UnifiedAlbum
 * @property {string} id
 * @property {string} title
 * @property {string} artist
 * @property {number|null} year
 * @property {string|null} coverArt
 * @property {'local'|'external'} discographySource
 * @property {string} provider
 */

/**
 * @typedef {Object} UnifiedTrack
 * @property {string} id
 * @property {string} title
 * @property {string} artist
 * @property {string|null} album
 * @property {number|null} durationSeconds
 * @property {'local'|'external'} discographySource
 * @property {string} provider
 */

export {};
