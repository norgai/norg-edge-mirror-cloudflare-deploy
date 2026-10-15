<?php
/**
 * Emits a NORG-served response and ends the request.
 *
 * Before anything is sent every output buffer is discarded (so no page-cache or
 * optimiser buffer stores or rewrites a diverted body), DONOTCACHEPAGE is
 * defined, and per-caller responses get the worker's exact no-store headers
 * plus the LiteSpeed and nginx bypass headers.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Response helpers.
 */
final class Responder {

	/**
	 * Terminator, replaceable in tests.
	 *
	 * @var callable|null
	 */
	public static $terminate = null;

	/**
	 * Headers forbidding every cache from storing a per-caller response.
	 *
	 * @return array Header map.
	 */
	public static function no_store_headers() {
		return array(
			'Cache-Control'             => 'private, no-store',
			'CDN-Cache-Control'         => 'private, no-store',
			'X-LiteSpeed-Cache-Control' => 'no-cache',
			'X-Accel-Expires'           => '0',
		);
	}

	/**
	 * Tell every known page cache not to store this request's response.
	 *
	 * @return void
	 */
	public static function forbid_page_caching() {
		if ( ! defined( 'DONOTCACHEPAGE' ) ) {
			define( 'DONOTCACHEPAGE', true ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedConstantFound -- shared contract every page-cache plugin reads.
		}
		if ( ! defined( 'DONOTCACHEOBJECT' ) ) {
			define( 'DONOTCACHEOBJECT', true ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedConstantFound -- shared contract every page-cache plugin reads.
		}
		if ( ! defined( 'DONOTMINIFY' ) ) {
			define( 'DONOTMINIFY', true ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedConstantFound -- shared contract every page-cache plugin reads.
		}
		if ( ! defined( 'DONOTROCKETOPTIMIZE' ) ) {
			define( 'DONOTROCKETOPTIMIZE', true ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedConstantFound -- shared contract every page-cache plugin reads.
		}
		do_action( 'litespeed_control_set_nocache', 'norg-edge' ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- LiteSpeed Cache's public API.
	}

	/**
	 * A NORG render (or artifact) for an agent, at the visitor's own URL.
	 *
	 * Deliberately not noindex for HTML: this IS the page as far as an agent is concerned.
	 *
	 * @param array   $norg    Receptionist response (status, content_type, body).
	 * @param Request $request Current request.
	 * @param string  $env     X-Norg-Edge-Env value.
	 * @param bool    $formats Apply the alternate-format canonical/noindex headers.
	 * @return void
	 */
	public static function mirror( array $norg, Request $request, $env, $formats = true ) {
		$headers = array_merge(
			array(
				'Content-Type'    => '' !== $norg['content_type'] ? $norg['content_type'] : 'text/html; charset=utf-8',
				'X-Norg-Edge'     => 'mirror',
				'X-Norg-Edge-Env' => $env,
			),
			self::no_store_headers(),
			$formats ? Alternate_Format::headers( $request->scheme(), $request->host(), $request->pathname() ) : array()
		);
		self::send( 200, $headers, $norg['body'], 'HEAD' === $request->method() );
	}

	/**
	 * A shared, identical-for-everyone NORG asset (theme CSS, OpenAI feed files).
	 *
	 * @param array   $norg         Receptionist response.
	 * @param Request $request      Current request.
	 * @param string  $env          X-Norg-Edge-Env value.
	 * @param string  $edge         X-Norg-Edge value.
	 * @param string  $content_type Content type to send.
	 * @return void
	 */
	public static function shared_asset( array $norg, Request $request, $env, $edge, $content_type ) {
		$headers = array(
			'Content-Type'      => $content_type,
			'Cache-Control'     => Constants::RESERVED_ASSET_CACHE_CONTROL,
			'CDN-Cache-Control' => Constants::RESERVED_ASSET_CACHE_CONTROL,
			'X-Norg-Edge'       => $edge,
			'X-Norg-Edge-Env'   => $env,
		);
		self::send( 200, $headers, $norg['body'], 'HEAD' === $request->method() );
	}

	/**
	 * A JSON document.
	 *
	 * @param int     $status  HTTP status.
	 * @param array   $data    Body.
	 * @param Request $request Current request.
	 * @param array   $extra   Extra headers.
	 * @return void
	 */
	public static function json( $status, array $data, Request $request, array $extra = array() ) {
		$headers = array_merge( array( 'Content-Type' => 'application/json' ), self::no_store_headers(), $extra );
		self::send( $status, $headers, (string) wp_json_encode( $data ), 'HEAD' === $request->method() );
	}

	/**
	 * Send status, headers and body, then end the request.
	 *
	 * @param int    $status  HTTP status.
	 * @param array  $headers Header map.
	 * @param string $body    Body.
	 * @param bool   $head    Omit the body (HEAD).
	 * @return void
	 */
	public static function send( $status, array $headers, $body, $head = false ) {
		self::forbid_page_caching();
		while ( ob_get_level() > 0 ) {
			ob_end_clean();
		}
		if ( ! headers_sent() ) {
			foreach ( array( 'Set-Cookie', 'Cache-Control', 'Expires', 'Pragma', 'Last-Modified', 'Link', 'X-Pingback' ) as $stale ) {
				header_remove( $stale );
			}
			status_header( $status );
			foreach ( $headers as $name => $value ) {
				header( $name . ': ' . str_replace( array( "\r", "\n" ), '', (string) $value ) );
			}
			// No Content-Length: with zlib.output_compression on (common on shared
			// hosts) PHP compresses the body and a declared length would be wrong.
		}
		if ( ! $head ) {
			echo $body; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- verbatim NORG document or JSON, not HTML built here.
		}
		self::terminate();
	}

	/**
	 * End the request, running shutdown hooks (where Deferred flushes).
	 *
	 * @return void
	 */
	private static function terminate() {
		if ( is_callable( self::$terminate ) ) {
			call_user_func( self::$terminate );
			return;
		}
		exit;
	}
}
