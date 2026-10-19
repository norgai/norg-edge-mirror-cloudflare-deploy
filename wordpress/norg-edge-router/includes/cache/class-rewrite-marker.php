<?php
/**
 * The ?norg_edge marker a host rewrite rule adds to AI-agent requests.
 *
 * A host whose page cache runs before PHP (WP Engine) can internally rewrite
 * AI user agents to a URL carrying this marker before its cache lookup. Every
 * response to a marked URL is made uncacheable, verified agent or not, so the
 * host never stores a copy under it and every marked request reaches the plugin.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge\Cache;

use Norg\Edge\Request;
use Norg\Edge\Responder;

defined( 'ABSPATH' ) || exit;

/**
 * Detects the marker and forbids caching of the marked response.
 */
final class Rewrite_Marker {

	/** The query argument the host's rewrite rule adds. */
	const QUERY_ARG = 'norg_edge';

	/**
	 * Does this request carry the marker?
	 *
	 * @param Request $request Current request.
	 * @return bool True when marked.
	 */
	public static function is_marked( Request $request ) {
		return null !== $request->query( self::QUERY_ARG );
	}

	/**
	 * Make a marked request's response uncacheable, whoever ends up answering it.
	 *
	 * @param Request $request Current request.
	 * @return void
	 */
	public static function apply( Request $request ) {
		if ( ! self::is_marked( $request ) ) {
			return;
		}
		Responder::forbid_page_caching();
		self::send_headers();
		// Sent again late: a host plugin may set its own Cache-Control after plugins_loaded.
		add_action( 'template_redirect', array( __CLASS__, 'send_headers' ), PHP_INT_MAX );
	}

	/**
	 * Emit the no-store headers, replacing any earlier Cache-Control.
	 *
	 * @return void
	 */
	public static function send_headers() {
		if ( headers_sent() ) {
			return;
		}
		foreach ( Responder::no_store_headers() as $name => $value ) {
			header( $name . ': ' . $value );
		}
	}
}
