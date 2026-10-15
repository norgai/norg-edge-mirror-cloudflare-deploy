<?php
/**
 * What this install is running on, for the heartbeat's fleet report and the status page.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Describes the WordPress runtime (no personal data, no secrets).
 */
final class Runtime {

	/**
	 * Runtime description.
	 *
	 * @return array WordPress, php, sapi, server, deferred, cache, host, bypass, secrets.
	 */
	public static function describe() {
		$check  = get_option( Self_Check::OPTION, array() );
		$server = isset( $_SERVER['SERVER_SOFTWARE'] ) ? sanitize_text_field( wp_unslash( $_SERVER['SERVER_SOFTWARE'] ) ) : '';
		return array(
			'wordpress' => get_bloginfo( 'version' ),
			'php'       => PHP_VERSION,
			'sapi'      => PHP_SAPI,
			'server'    => substr( strtolower( strtok( $server, '/ ' ) ? strtok( $server, '/ ' ) : '' ), 0, 32 ),
			'deferred'  => Deferred::mode(),
			'cache'     => Cache\Registry::detected_slugs(),
			'host'      => Cache\Host_Detector::detect(),
			'bypass'    => is_array( $check ) && isset( $check['cache_reach'] ) ? (string) $check['cache_reach'] : 'unchecked',
			'secrets'   => defined( 'NORG_SITE_KEY' ) ? 'constant' : Secrets::scheme(),
			'multisite' => is_multisite(),
		);
	}
}
