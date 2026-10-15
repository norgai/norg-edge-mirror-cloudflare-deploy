<?php
/**
 * The keyed health probe: x-norg-edge-check equal to the site key answers JSON.
 *
 * Without the header the path behaves normally, so the probe never shadows a
 * real page. Comparison is constant-time.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Health probe.
 */
final class Health {

	/**
	 * Is this request an authenticated probe?
	 *
	 * @param Request $request Current request.
	 * @param Config  $config  Configuration.
	 * @return bool True when the probe key matches.
	 */
	public static function is_probe( Request $request, Config $config ) {
		$probe = (string) $request->header( Constants::HEALTH_CHECK_HEADER );
		$key   = $config->site_key();
		return '' !== $probe && '' !== $key && hash_equals( $key, $probe );
	}

	/**
	 * The status document.
	 *
	 * @param Plugin $plugin Service container.
	 * @return array Status.
	 */
	public static function status( Plugin $plugin ) {
		$config = $plugin->config();
		$feed   = get_option( 'norg_edge_feed_status', array() );
		return array(
			'site_id'      => (string) $config->get( 'site_id' ),
			'version'      => NORG_EDGE_ROUTER_VERSION,
			'platform'     => Constants::PLATFORM,
			'env'          => $config->edge_env(),
			'disabled'     => (bool) $config->get( 'disabled' ),
			'capture_only' => (bool) $config->get( 'capture_only' ),
			'entitled'     => ! empty( $plugin->feed()->get()['entitled'] ),
			'feed'         => is_array( $feed ) ? $feed : array(),
			'runtime'      => Runtime::describe(),
			'ts'           => (int) round( microtime( true ) * 1000 ),
		);
	}

	/**
	 * Answer the probe.
	 *
	 * @param Request $request Current request.
	 * @param Plugin  $plugin  Service container.
	 * @return void
	 */
	public static function respond( Request $request, Plugin $plugin ) {
		Responder::json( 200, self::status( $plugin ), $request );
	}
}
