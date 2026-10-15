<?php
/**
 * Cross-format canonical Link + noindex for sibling artifacts (workers/lib/alternate-format.mjs).
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Derives the canonical HTML URL of a non-HTML format variant.
 */
final class Alternate_Format {

	/**
	 * The canonical HTML URL for a format variant, or null when not applicable.
	 *
	 * "/en-au/business/index.jsonld" becomes "https://host/en-au/business/". MCP
	 * manifests and .openai.json are exempt: they are resources, not variants.
	 *
	 * @param string $scheme "http" or "https".
	 * @param string $host   Request hostname.
	 * @param string $path   Request pathname.
	 * @return string|null Canonical URL.
	 */
	public static function canonical_url( $scheme, $host, $path ) {
		$dot = strrpos( $path, '.' );
		if ( false === $dot ) {
			return null;
		}
		if ( ! in_array( substr( $path, $dot ), Constants::ALTERNATE_FORMAT_EXTENSIONS, true ) ) {
			return null;
		}
		if ( Paths::ends_with( $path, '.openai.json' ) || Paths::ends_with( $path, '/mcp.json' ) ) {
			return null;
		}
		$filename  = Paths::last_segment( $path );
		$canonical = 0 === strpos( $filename, 'index.' )
			? substr( $path, 0, strlen( $path ) - strlen( $filename ) )
			: substr( $path, 0, $dot ) . '/';
		return $scheme . '://' . $host . $canonical;
	}

	/**
	 * Headers to add for a format variant (empty when not applicable).
	 *
	 * @param string $scheme Request scheme.
	 * @param string $host   Request hostname.
	 * @param string $path   Request pathname.
	 * @return array Header map.
	 */
	public static function headers( $scheme, $host, $path ) {
		$url = self::canonical_url( $scheme, $host, $path );
		if ( null === $url ) {
			return array();
		}
		return array(
			'Link'         => '<' . $url . '>; rel="canonical"',
			'X-Robots-Tag' => 'noindex',
		);
	}
}
