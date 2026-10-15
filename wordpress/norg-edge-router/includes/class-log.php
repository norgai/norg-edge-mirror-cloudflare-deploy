<?php
/**
 * Debug logging (off unless NORG_EDGE_DEBUG / the debug setting is on). Never logs the site key.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Minimal structured logger writing to the PHP error log.
 */
final class Log {

	/**
	 * Whether debug logging is enabled.
	 *
	 * @var bool
	 */
	public static $enabled = false;

	/**
	 * Log a debug event.
	 *
	 * @param string $event   Event name.
	 * @param array  $context Context (must not contain secrets).
	 * @return void
	 */
	public static function debug( $event, array $context = array() ) {
		if ( self::$enabled ) {
			error_log( 'norg-edge ' . $event . ' ' . wp_json_encode( $context ) ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- opt-in debug logging.
		}
	}

	/**
	 * Remember the most recent internal error for the status page (throttled to one write a minute).
	 *
	 * @param \Throwable $error Error.
	 * @return void
	 */
	public static function error( \Throwable $error ) {
		self::debug( 'error', array( 'message' => $error->getMessage() ) );
		if ( false !== get_transient( 'norg_edge_error_throttle' ) ) {
			return;
		}
		set_transient( 'norg_edge_error_throttle', 1, MINUTE_IN_SECONDS );
		update_option(
			'norg_edge_last_error',
			array(
				'at'      => time(),
				'message' => substr( $error->getMessage(), 0, 300 ),
				'where'   => basename( $error->getFile() ) . ':' . $error->getLine(),
			),
			false
		);
	}
}
