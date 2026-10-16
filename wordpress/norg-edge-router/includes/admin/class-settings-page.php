<?php
/**
 * Settings > NORG Edge Router: the settings form (Settings API) and the status panel.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge\Admin;

use Norg\Edge\Config;
use Norg\Edge\Plugin;

defined( 'ABSPATH' ) || exit;

/**
 * The admin page.
 */
final class Settings_Page {

	const SLUG  = 'norg-edge-router';
	const GROUP = 'norg_edge_settings_group';

	/**
	 * Service container.
	 *
	 * @var Plugin
	 */
	private $plugin;

	/**
	 * Build the page.
	 *
	 * @param Plugin $plugin Service container.
	 */
	public function __construct( Plugin $plugin ) {
		$this->plugin = $plugin;
	}

	/**
	 * Register hooks.
	 *
	 * @return void
	 */
	public function register() {
		add_action( 'admin_menu', array( $this, 'menu' ) );
		add_action( 'admin_init', array( $this, 'settings' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( NORG_EDGE_ROUTER_FILE ), array( $this, 'action_links' ) );
	}

	/**
	 * Add the menu entry.
	 *
	 * @return void
	 */
	public function menu() {
		add_options_page( __( 'NORG Edge Router', 'norg-edge-router' ), __( 'NORG Edge Router', 'norg-edge-router' ), 'manage_options', self::SLUG, array( $this, 'render' ) );
	}

	/**
	 * Settings link on the Plugins screen.
	 *
	 * @param array $links Links.
	 * @return array Links.
	 */
	public function action_links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'options-general.php?page=' . self::SLUG ) ) . '">' . esc_html__( 'Settings', 'norg-edge-router' ) . '</a>' );
		return $links;
	}

	/**
	 * Register the option with its sanitiser.
	 *
	 * @return void
	 */
	public function settings() {
		register_setting(
			self::GROUP,
			Config::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( $this, 'sanitize' ),
				'show_in_rest'      => false,
			)
		);
	}

	/**
	 * Validate submitted settings; an empty key field keeps the stored key.
	 *
	 * @param mixed $input Submitted values.
	 * @return array Option value.
	 */
	public function sanitize( $input ) {
		$input   = is_array( $input ) ? $input : array();
		$current = get_option( Config::OPTION, array() );
		$current = is_array( $current ) ? $current : array();
		$out     = $current;

		$site_id = isset( $input['site_id'] ) ? strtolower( trim( sanitize_text_field( $input['site_id'] ) ) ) : '';
		if ( '' === $site_id || preg_match( '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $site_id ) ) {
			$out['site_id'] = $site_id;
		} else {
			add_settings_error( Config::OPTION, 'site_id', __( 'The Site ID must be the UUID NORG gave you.', 'norg-edge-router' ) );
		}
		$key = isset( $input['site_key'] ) ? trim( sanitize_text_field( $input['site_key'] ) ) : '';
		if ( '' !== $key ) {
			if ( preg_match( '/^nek_(live|test)_[A-Za-z0-9_-]{20,}$/', $key ) ) {
				$out['site_key_enc'] = \Norg\Edge\Secrets::encrypt( $key );
			} else {
				add_settings_error( Config::OPTION, 'site_key', __( 'That does not look like a NORG site key (nek_live_…).', 'norg-edge-router' ) );
			}
		}
		$proxy                 = isset( $input['trusted_proxy'] ) ? sanitize_key( $input['trusted_proxy'] ) : 'auto';
		$out['trusted_proxy']  = in_array( $proxy, \Norg\Edge\Ip_Resolver::MODES, true ) ? $proxy : 'auto';
		$out['trusted_header'] = isset( $input['trusted_header'] ) ? preg_replace( '/[^A-Za-z0-9-]/', '', (string) $input['trusted_header'] ) : '';
		$env                   = isset( $input['edge_env'] ) ? sanitize_key( $input['edge_env'] ) : '';
		$out['edge_env']       = in_array( $env, array( '', 'production', 'test' ), true ) ? $env : '';
		foreach ( array( 'disabled', 'capture_only', 'strip_fallback', 'lazy_render', 'origin_probe', 'cache_bypass', 'htaccess_block', 'auto_update', 'debug' ) as $flag ) {
			$out[ $flag ] = ! empty( $input[ $flag ] );
		}
		$this->plugin->feed()->forget();
		wp_schedule_single_event( time(), \Norg\Edge\Cron::APPLY_BYPASS );
		return $out;
	}

	/**
	 * Render the page.
	 *
	 * @return void
	 */
	public function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$view = new Status_View( $this->plugin );
		require NORG_EDGE_ROUTER_DIR . '/includes/admin/views/settings.php';
	}
}
