<?php
/**
 * Updates from NORG instead of wordpress.org (NORG distribution channel only).
 *
 * The plugin header's Update URI makes WordPress ask update_plugins_{host} for
 * this plugin and never confuse it with a same-slug directory plugin. The
 * manifest names the version, package URL and SHA-256; the package is refused
 * unless its hash matches. Auto-updates are on by default and honour
 * DISALLOW_FILE_MODS / AUTOMATIC_UPDATER_DISABLED. The wordpress.org build
 * omits this file (directory guidelines forbid self-updating).
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Self-hosted update channel.
 */
final class Updater {

	const MANIFEST_CACHE = 'norg_edge_update_manifest';
	const UPDATE_HOST    = 'content-craft-api.norg.ai';

	/**
	 * Service container.
	 *
	 * @var Plugin
	 */
	private $plugin;

	/**
	 * Build the updater.
	 *
	 * @param Plugin $plugin Service container.
	 */
	public function __construct( Plugin $plugin ) {
		$this->plugin = $plugin;
	}

	/**
	 * Register update filters.
	 *
	 * @return void
	 */
	public function register() {
		add_filter( 'update_plugins_' . self::UPDATE_HOST, array( $this, 'check' ), 10, 3 );
		add_filter( 'plugins_api', array( $this, 'info' ), 10, 3 );
		add_filter( 'upgrader_pre_download', array( $this, 'verified_download' ), 10, 3 );
		add_filter( 'auto_update_plugin', array( $this, 'auto_update' ), 10, 2 );
	}

	/**
	 * This plugin's basename.
	 *
	 * @return string e.g. norg-edge-router/norg-edge-router.php.
	 */
	public static function basename() {
		return plugin_basename( NORG_EDGE_ROUTER_FILE );
	}

	/**
	 * The manifest, cached for six hours.
	 *
	 * @param bool $fresh Bypass the cache.
	 * @return array|null Manifest.
	 */
	public function manifest( $fresh = false ) {
		$cached = $fresh ? false : get_site_transient( self::MANIFEST_CACHE );
		if ( is_array( $cached ) ) {
			return $cached;
		}
		$manifest = $this->plugin->client()->get_update_manifest();
		if ( null === $manifest || empty( $manifest['version'] ) || empty( $manifest['package'] ) || empty( $manifest['sha256'] ) ) {
			return null;
		}
		set_site_transient( self::MANIFEST_CACHE, $manifest, 6 * HOUR_IN_SECONDS );
		return $manifest;
	}

	/**
	 * Answer WordPress's update check for this plugin.
	 *
	 * @param array|false $update      Update data so far.
	 * @param array       $plugin_data Plugin headers.
	 * @param string      $file        Plugin basename.
	 * @return array|false Update data.
	 */
	public function check( $update, $plugin_data, $file ) {
		if ( self::basename() !== $file ) {
			return $update;
		}
		$manifest = $this->manifest();
		if ( null === $manifest ) {
			return $update;
		}
		return array(
			'id'           => 'https://' . self::UPDATE_HOST . '/norg-edge-router',
			'slug'         => 'norg-edge-router',
			'plugin'       => $file,
			'version'      => (string) $manifest['version'],
			'new_version'  => (string) $manifest['version'],
			'url'          => (string) ( $manifest['homepage'] ?? 'https://app.norg.ai/help/wordpress-plugin' ),
			'package'      => (string) $manifest['package'],
			'requires'     => (string) ( $manifest['requires'] ?? '6.0' ),
			'tested'       => (string) ( $manifest['tested'] ?? '' ),
			'requires_php' => (string) ( $manifest['requires_php'] ?? '7.4' ),
		);
	}

	/**
	 * The "View details" modal.
	 *
	 * @param false|object|array $result Result so far.
	 * @param string             $action plugins_api action.
	 * @param object             $args   Arguments.
	 * @return false|object|array Plugin information.
	 */
	public function info( $result, $action, $args ) {
		if ( 'plugin_information' !== $action || ! isset( $args->slug ) || 'norg-edge-router' !== $args->slug ) {
			return $result;
		}
		$manifest = $this->manifest();
		if ( null === $manifest ) {
			return $result;
		}
		return (object) array(
			'name'          => 'NORG Edge Router',
			'slug'          => 'norg-edge-router',
			'version'       => (string) $manifest['version'],
			'author'        => '<a href="https://norg.ai">NORG</a>',
			'homepage'      => (string) ( $manifest['homepage'] ?? 'https://app.norg.ai/help/wordpress-plugin' ),
			'requires'      => (string) ( $manifest['requires'] ?? '6.0' ),
			'tested'        => (string) ( $manifest['tested'] ?? '' ),
			'requires_php'  => (string) ( $manifest['requires_php'] ?? '7.4' ),
			'download_link' => (string) $manifest['package'],
			'sections'      => array(
				'changelog' => wp_kses_post( (string) ( $manifest['changelog_html'] ?? '' ) ),
			),
		);
	}

	/**
	 * Download our package ourselves and refuse it unless the SHA-256 matches the manifest.
	 *
	 * @param bool|string|\WP_Error $reply    Short-circuit value so far.
	 * @param string                $package  Package URL.
	 * @param object                $upgrader Upgrader.
	 * @return bool|string|\WP_Error Path to the verified file, an error, or $reply untouched.
	 */
	public function verified_download( $reply, $package, $upgrader ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter.FoundAfterLastUsed -- filter signature.
		$manifest = $this->manifest();
		if ( false !== $reply || null === $manifest || $package !== $manifest['package'] ) {
			return $reply;
		}
		if ( ! function_exists( 'download_url' ) ) {
			require_once ABSPATH . 'wp-admin/includes/file.php';
		}
		$file = download_url( $package, 120 );
		if ( is_wp_error( $file ) ) {
			return $file;
		}
		if ( ! hash_equals( strtolower( (string) $manifest['sha256'] ), (string) hash_file( 'sha256', $file ) ) ) {
			wp_delete_file( $file );
			return new \WP_Error( 'norg_edge_bad_package', __( 'The NORG Edge Router update did not match its published checksum and was not installed.', 'norg-edge-router' ) );
		}
		return $file;
	}

	/**
	 * Auto-update this plugin when the setting is on (default).
	 *
	 * @param bool|null $update Current decision.
	 * @param object    $item   Update item.
	 * @return bool|null Decision.
	 */
	public function auto_update( $update, $item ) {
		if ( ! isset( $item->plugin ) || self::basename() !== $item->plugin ) {
			return $update;
		}
		return (bool) $this->plugin->config()->get( 'auto_update' );
	}

	/**
	 * Can WordPress update plugins on this host at all?
	 *
	 * @return string ok | file_mods_disallowed | auto_updater_disabled.
	 */
	public static function capability() {
		if ( defined( 'DISALLOW_FILE_MODS' ) && DISALLOW_FILE_MODS ) {
			return 'file_mods_disallowed';
		}
		return ( defined( 'AUTOMATIC_UPDATER_DISABLED' ) && AUTOMATIC_UPDATER_DISABLED ) ? 'auto_updater_disabled' : 'ok';
	}
}
