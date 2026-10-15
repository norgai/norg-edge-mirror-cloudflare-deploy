<?php
/**
 * WP-CLI: wp norg-edge status|check|heartbeat|apply-cache-bypass.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Manage the NORG Edge Router from the command line.
 */
final class Cli {

	/**
	 * Service container.
	 *
	 * @var Plugin
	 */
	private $plugin;

	/**
	 * Build the command.
	 *
	 * @param Plugin $plugin Service container.
	 */
	public function __construct( Plugin $plugin ) {
		$this->plugin = $plugin;
	}

	/**
	 * Store the Site ID and Site Key (key encrypted at rest).
	 *
	 * ## OPTIONS
	 *
	 * --site-id=<uuid>
	 * : edge_sites.id issued by NORG.
	 *
	 * --site-key=<key>
	 * : The one-time site key (nek_live_...).
	 *
	 * [--env=<env>]
	 * : production or test.
	 *
	 * @param array $args       Positional arguments.
	 * @param array $assoc_args Named arguments.
	 * @return void
	 */
	public function configure( $args, $assoc_args ) {
		$site_id = strtolower( (string) ( $assoc_args['site-id'] ?? '' ) );
		$key     = (string) ( $assoc_args['site-key'] ?? '' );
		if ( ! preg_match( '/^[0-9a-f-]{36}$/', $site_id ) || ! preg_match( '/^nek_(live|test)_[A-Za-z0-9_-]{20,}$/', $key ) ) {
			\WP_CLI::error( 'Pass --site-id=<uuid> and --site-key=nek_live_...' );
		}
		$values = array(
			'site_id'  => $site_id,
			'site_key' => $key,
		);
		if ( isset( $assoc_args['env'] ) ) {
			$values['edge_env'] = in_array( $assoc_args['env'], array( 'production', 'test' ), true ) ? $assoc_args['env'] : '';
		}
		$this->plugin->config()->save( $values );
		$this->plugin->reset();
		$this->plugin->feed()->forget();
		\WP_CLI::success( 'Saved. Feed: ' . $this->plugin->feed()->refresh() );
	}

	/**
	 * Show install status (never prints the site key).
	 *
	 * @return void
	 */
	public function status() {
		\WP_CLI::line( (string) wp_json_encode( Health::status( $this->plugin ), JSON_PRETTY_PRINT ) );
	}

	/**
	 * Run the self-check (feed, cache reach, human, search, agent).
	 *
	 * @return void
	 */
	public function check() {
		\WP_CLI::line( (string) wp_json_encode( $this->plugin->self_check()->run(), JSON_PRETTY_PRINT ) );
	}

	/**
	 * Send a heartbeat now.
	 *
	 * @return void
	 */
	public function heartbeat() {
		$result = $this->plugin->telemetry()->heartbeat( 'admin' );
		\WP_CLI::line( (string) wp_json_encode( $result, JSON_PRETTY_PRINT ) );
	}

	/**
	 * Register the AI-agent user agents with every detected page cache now.
	 *
	 * @subcommand apply-cache-bypass
	 * @return void
	 */
	public function apply_cache_bypass() {
		\WP_CLI::line( (string) wp_json_encode( Cache\Registry::apply( $this->plugin ), JSON_PRETTY_PRINT ) );
	}
}
