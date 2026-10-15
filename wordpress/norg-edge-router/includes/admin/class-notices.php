<?php
/**
 * Admin notices: not connected, cache interference, refused key.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge\Admin;

use Norg\Edge\Plugin;
use Norg\Edge\Self_Check;

defined( 'ABSPATH' ) || exit;

/**
 * Shows at most one notice, to administrators only.
 */
final class Notices {

	/**
	 * Service container.
	 *
	 * @var Plugin
	 */
	private $plugin;

	/**
	 * Build notices.
	 *
	 * @param Plugin $plugin Service container.
	 */
	public function __construct( Plugin $plugin ) {
		$this->plugin = $plugin;
	}

	/**
	 * Register the hook.
	 *
	 * @return void
	 */
	public function register() {
		add_action( 'admin_notices', array( $this, 'render' ) );
	}

	/**
	 * Print the most important notice, if any.
	 *
	 * @return void
	 */
	public function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$message = $this->message();
		if ( null === $message ) {
			return;
		}
		$link = '<a href="' . esc_url( admin_url( 'options-general.php?page=' . Settings_Page::SLUG ) ) . '">' . esc_html__( 'Open NORG Edge Router', 'norg-edge-router' ) . '</a>';
		printf( '<div class="notice notice-%1$s"><p>%2$s %3$s</p></div>', esc_attr( $message[0] ), esc_html( $message[1] ), $link ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $link escaped above.
	}

	/**
	 * The notice to show.
	 *
	 * @return array|null array( type, text ).
	 */
	private function message() {
		$config = $this->plugin->config();
		if ( ! $config->is_configured() ) {
			return array( 'info', __( 'NORG Edge Router is installed but not connected yet.', 'norg-edge-router' ) );
		}
		$feed = (array) get_option( 'norg_edge_feed_status', array() );
		if ( 'refused' === ( $feed['outcome'] ?? '' ) ) {
			return array( 'error', __( 'NORG refused this site key, so AI agents get your normal pages.', 'norg-edge-router' ) );
		}
		$check = (array) get_option( Self_Check::OPTION, array() );
		if ( 'cache_interference' === ( $check['cache_reach'] ?? '' ) ) {
			return array( 'warning', __( 'A page cache is answering AI agents before NORG Edge Router can.', 'norg-edge-router' ) );
		}
		return null;
	}
}
