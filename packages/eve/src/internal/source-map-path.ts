const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:\/?[A-Za-z]:[\\/]|\\\\[^\\])/u;
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/u;

/**
 * Returns whether a source-map reference is a URL rather than a filesystem path.
 * Windows drive-letter paths resemble URL schemes, so they must be excluded
 * before applying the generic scheme check.
 */
export function isSourceMapUrl(source: string): boolean {
  return !WINDOWS_ABSOLUTE_PATH_PATTERN.test(source) && URL_SCHEME_PATTERN.test(source);
}
