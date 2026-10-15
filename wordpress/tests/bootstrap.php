<?php
/**
 * Unit-test bootstrap: loads the pure modules with the few WordPress functions they touch.
 *
 * Anything that needs a real WordPress (hooks, options, HTTP API) is exercised by
 * the end-to-end suite in tests/e2e instead.
 *
 * @package NorgEdgeRouter
 */

define( 'ABSPATH', __DIR__ . '/' );

if ( ! function_exists( 'wp_json_encode' ) ) {
	/**
	 * Shim of wp_json_encode.
	 *
	 * @param mixed $data Data.
	 * @return string|false JSON.
	 */
	function wp_json_encode( $data ) {
		return json_encode( $data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
	}
}

if ( ! function_exists( 'wp_parse_url' ) ) {
	/**
	 * Shim of wp_parse_url.
	 *
	 * @param string $url       URL.
	 * @param int    $component Component.
	 * @return mixed Parsed value.
	 */
	function wp_parse_url( $url, $component = -1 ) {
		return parse_url( $url, $component );
	}
}

require dirname( __DIR__ ) . '/norg-edge-router/includes/autoload.php';

/**
 * The shared vectors generated from the JavaScript reference.
 *
 * @return array Vectors.
 */
function norg_edge_vectors() {
	static $vectors = null;
	if ( null === $vectors ) {
		$vectors = json_decode( (string) file_get_contents( __DIR__ . '/fixtures/edge-router-vectors.json' ), true );
	}
	return $vectors;
}
