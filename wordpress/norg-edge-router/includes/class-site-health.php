<?php
/**
 * Site Health tests, so problems surface in the site's own admin without NORG.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Registers Site Health tests.
 */
final class Site_Health {

	/**
	 * Register the tests.
	 *
	 * @param Plugin $plugin Service container.
	 * @return void
	 */
	public static function register( Plugin $plugin ) {
		add_filter(
			'site_status_tests',
			static function ( $tests ) use ( $plugin ) {
				$tests['direct']['norg_edge_connection']  = array(
					'label' => __( 'NORG Edge Router connection', 'norg-edge-router' ),
					'test'  => static function () use ( $plugin ) {
						return Site_Health::connection( $plugin );
					},
				);
				$tests['direct']['norg_edge_cache_reach'] = array(
					'label' => __( 'AI agents reach the NORG Edge Router', 'norg-edge-router' ),
					'test'  => array( __CLASS__, 'cache_reach' ),
				);
				$tests['direct']['norg_edge_background']  = array(
					'label' => __( 'NORG Edge Router background tasks', 'norg-edge-router' ),
					'test'  => array( __CLASS__, 'background' ),
				);
				return $tests;
			}
		);
	}

	/**
	 * A Site Health result.
	 *
	 * @param string $test        Test id.
	 * @param string $status      good | recommended | critical.
	 * @param string $label       Label.
	 * @param string $description Description (plain text).
	 * @return array Result.
	 */
	private static function result( $test, $status, $label, $description ) {
		return array(
			'label'       => $label,
			'status'      => $status,
			'badge'       => array(
				'label' => 'NORG',
				'color' => 'good' === $status ? 'blue' : 'orange',
			),
			'description' => '<p>' . esc_html( $description ) . '</p>',
			'actions'     => '<p><a href="' . esc_url( admin_url( 'options-general.php?page=norg-edge-router' ) ) . '">' . esc_html__( 'Open NORG Edge Router settings', 'norg-edge-router' ) . '</a></p>',
			'test'        => $test,
		);
	}

	/**
	 * Configured and entitled?
	 *
	 * @param Plugin $plugin Service container.
	 * @return array Result.
	 */
	public static function connection( Plugin $plugin ) {
		$config = $plugin->config();
		if ( ! $config->is_configured() ) {
			return self::result( 'norg_edge_connection', 'recommended', __( 'NORG Edge Router is not connected', 'norg-edge-router' ), __( 'Add the Site ID and Site Key from NORG. Until then the plugin changes nothing.', 'norg-edge-router' ) );
		}
		$status = get_option( 'norg_edge_feed_status', array() );
		$state  = is_array( $status ) && isset( $status['outcome'] ) ? $status['outcome'] : 'unchecked';
		if ( 'ok' === $state ) {
			return self::result( 'norg_edge_connection', 'good', __( 'NORG Edge Router is connected', 'norg-edge-router' ), __( 'NORG confirmed this install. Verified AI agents are served the NORG mirror.', 'norg-edge-router' ) );
		}
		if ( 'refused' === $state ) {
			return self::result( 'norg_edge_connection', 'critical', __( 'NORG refused this site key', 'norg-edge-router' ), __( 'The key is wrong, or the site is paused in NORG. Every visitor gets your normal site.', 'norg-edge-router' ) );
		}
		return self::result( 'norg_edge_connection', 'recommended', __( 'NORG could not be reached', 'norg-edge-router' ), __( 'Outbound requests to NORG are failing. Check WP_HTTP_BLOCK_EXTERNAL and your host firewall.', 'norg-edge-router' ) );
	}

	/**
	 * Did the last self-check prove agents reach PHP?
	 *
	 * @return array Result.
	 */
	public static function cache_reach() {
		$check = get_option( Self_Check::OPTION, array() );
		$reach = is_array( $check ) && isset( $check['cache_reach'] ) ? $check['cache_reach'] : 'unchecked';
		if ( 'reached' === $reach ) {
			return self::result( 'norg_edge_cache_reach', 'good', __( 'AI agents reach the plugin', 'norg-edge-router' ), __( 'The last self-check confirmed an AI agent request is answered by WordPress, not a cached page.', 'norg-edge-router' ) );
		}
		if ( 'cache_interference' === $reach ) {
			return self::result( 'norg_edge_cache_reach', 'critical', __( 'A page cache answers AI agents before the plugin', 'norg-edge-router' ), __( 'AI agents are being served cached pages. Open the plugin status page for the fix for your cache or host.', 'norg-edge-router' ) );
		}
		return self::result( 'norg_edge_cache_reach', 'recommended', __( 'Run the NORG Edge Router self-check', 'norg-edge-router' ), __( 'The self-check has not confirmed that AI agents reach the plugin through your page cache.', 'norg-edge-router' ) );
	}

	/**
	 * Can background tasks and heartbeats run?
	 *
	 * @return array Result.
	 */
	public static function background() {
		if ( defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON ) {
			return self::result( 'norg_edge_background', 'recommended', __( 'WP-Cron is disabled', 'norg-edge-router' ), __( 'Make sure a system cron calls wp-cron.php, or NORG stops hearing from this site when it is quiet.', 'norg-edge-router' ) );
		}
		if ( defined( 'WP_HTTP_BLOCK_EXTERNAL' ) && WP_HTTP_BLOCK_EXTERNAL ) {
			return self::result( 'norg_edge_background', 'critical', __( 'Outbound HTTP is blocked', 'norg-edge-router' ), __( 'Add content-craft-api.norg.ai and edge-content.norg.ai to WP_ACCESSIBLE_HOSTS.', 'norg-edge-router' ) );
		}
		return self::result( 'norg_edge_background', 'good', __( 'Background tasks can run', 'norg-edge-router' ), __( 'Heartbeats and render requests run after each response.', 'norg-edge-router' ) );
	}
}
