<?php
/**
 * Admin actions (admin-post.php), each capability-checked and nonce-verified.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge\Admin;

use Norg\Edge\Cache\Registry;
use Norg\Edge\Health;
use Norg\Edge\Plugin;

defined( 'ABSPATH' ) || exit;

/**
 * Run checks, heartbeat, apply cache bypass, download debug report.
 */
final class Actions {

	const ACTIONS = array( 'norg_edge_run_checks', 'norg_edge_heartbeat', 'norg_edge_apply_bypass', 'norg_edge_debug_report' );

	/**
	 * Service container.
	 *
	 * @var Plugin
	 */
	private $plugin;

	/**
	 * Build the handlers.
	 *
	 * @param Plugin $plugin Service container.
	 */
	public function __construct( Plugin $plugin ) {
		$this->plugin = $plugin;
	}

	/**
	 * Register handlers.
	 *
	 * @return void
	 */
	public function register() {
		foreach ( self::ACTIONS as $action ) {
			add_action( 'admin_post_' . $action, array( $this, 'handle' ) );
		}
	}

	/**
	 * Dispatch the current action.
	 *
	 * @return void
	 */
	public function handle() {
		$action = isset( $_REQUEST['action'] ) ? sanitize_key( wp_unslash( $_REQUEST['action'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- verified below.
		if ( ! in_array( $action, self::ACTIONS, true ) || ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to do that.', 'norg-edge-router' ), 403 );
		}
		check_admin_referer( $action );
		if ( 'norg_edge_debug_report' === $action ) {
			$this->debug_report();
			return;
		}
		if ( 'norg_edge_run_checks' === $action ) {
			$this->plugin->self_check()->run();
			if ( $this->plugin->config()->is_configured() ) {
				$this->plugin->telemetry()->heartbeat( 'admin' );
			}
		} elseif ( 'norg_edge_heartbeat' === $action ) {
			$this->plugin->telemetry()->heartbeat( 'admin' );
		} else {
			Registry::apply( $this->plugin );
			$this->plugin->self_check()->run();
		}
		wp_safe_redirect( add_query_arg( 'norg_edge_done', $action, admin_url( 'options-general.php?page=' . Settings_Page::SLUG ) ) );
		exit;
	}

	/**
	 * A redacted JSON report for support (no site key, no visitor data).
	 *
	 * @return void
	 */
	private function debug_report() {
		$report = array(
			'status'     => Health::status( $this->plugin ),
			'self_check' => get_option( \Norg\Edge\Self_Check::OPTION ),
			'heartbeat'  => get_option( \Norg\Edge\Telemetry::LAST_HEARTBEAT ),
			'bypass'     => Registry::state(),
			'last_error' => get_option( 'norg_edge_last_error' ),
			'site_key'   => $this->plugin->config()->site_key_masked(),
			'home'       => home_url( '/' ),
		);
		nocache_headers();
		header( 'Content-Type: application/json; charset=utf-8' );
		header( 'Content-Disposition: attachment; filename="norg-edge-debug-' . gmdate( 'Ymd-His' ) . '.json"' );
		echo wp_json_encode( $report, JSON_PRETTY_PRINT ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- JSON download.
		exit;
	}
}
