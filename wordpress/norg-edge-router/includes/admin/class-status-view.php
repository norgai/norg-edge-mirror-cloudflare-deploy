<?php
/**
 * Data the status panel shows, assembled in one place so the view only escapes and prints.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge\Admin;

use Norg\Edge\Cache\Host_Detector;
use Norg\Edge\Cache\Registry;
use Norg\Edge\Deferred;
use Norg\Edge\Ip_Resolver;
use Norg\Edge\Plugin;
use Norg\Edge\Self_Check;
use Norg\Edge\Telemetry;
use Norg\Edge\Updater;

defined( 'ABSPATH' ) || exit;

/**
 * Status panel view-model.
 */
final class Status_View {

	/**
	 * Service container.
	 *
	 * @var Plugin
	 */
	public $plugin;

	/**
	 * Build the view-model.
	 *
	 * @param Plugin $plugin Service container.
	 */
	public function __construct( Plugin $plugin ) {
		$this->plugin = $plugin;
	}

	/**
	 * Rows of label => array( state, text ), state one of good | warn | bad | info.
	 *
	 * @return array Rows.
	 */
	public function rows() {
		$config = $this->plugin->config();
		$feed   = (array) get_option( 'norg_edge_feed_status', array() );
		$beat   = (array) get_option( Telemetry::LAST_HEARTBEAT, array() );
		$check  = (array) get_option( Self_Check::OPTION, array() );
		$rows   = array(
			__( 'Connection', 'norg-edge-router' )         => $this->connection_row( $config, $feed ),
			__( 'Last heartbeat', 'norg-edge-router' )     => $this->heartbeat_row( $beat ),
			__( 'AI agents reach plugin', 'norg-edge-router' ) => $this->reach_row( $check ),
			__( 'People untouched', 'norg-edge-router' )   => $this->simple_row( $check, 'human', 'ok' ),
			__( 'Search engines untouched', 'norg-edge-router' ) => $this->simple_row( $check, 'search', 'ok' ),
			__( 'Simulated AI agent', 'norg-edge-router' ) => $this->agent_row( $check ),
			__( 'Background tasks', 'norg-edge-router' )   => array( 'nonblocking' === Deferred::mode() ? 'warn' : 'good', Deferred::mode() . ( defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON ? ' · WP-Cron disabled' : '' ) ),
			__( 'Updates', 'norg-edge-router' )            => $this->update_row(),
			__( 'Client IP source', 'norg-edge-router' )   => $this->proxy_row(),
		);
		if ( $config->site_key_unreadable() ) {
			$rows[ __( 'Site key', 'norg-edge-router' ) ] = array( 'bad', __( 'Stored key cannot be decrypted (the site salts changed). Paste the key again.', 'norg-edge-router' ) );
		}
		return $rows;
	}

	/**
	 * Connection state.
	 *
	 * @param \Norg\Edge\Config $config Configuration.
	 * @param array             $feed   Feed status.
	 * @return array Row.
	 */
	private function connection_row( $config, array $feed ) {
		if ( ! $config->is_configured() ) {
			return array( 'warn', __( 'Not connected. Add the Site ID and Site Key from NORG.', 'norg-edge-router' ) );
		}
		$outcome = $feed['outcome'] ?? 'unchecked';
		$map     = array(
			'ok'          => array( 'good', __( 'Connected and entitled', 'norg-edge-router' ) ),
			'refused'     => array( 'bad', __( 'NORG refused the key (wrong key, or site paused)', 'norg-edge-router' ) ),
			'unreachable' => array( 'bad', __( 'NORG unreachable from this server', 'norg-edge-router' ) ),
		);
		$row     = $map[ $outcome ] ?? array( 'info', __( 'Not checked yet', 'norg-edge-router' ) );
		if ( $config->get( 'disabled' ) ) {
			$row = array( 'warn', __( 'Disabled: every visitor gets your normal site', 'norg-edge-router' ) );
		}
		$row[1] .= ' · ' . $config->edge_env();
		return $row;
	}

	/**
	 * Heartbeat state.
	 *
	 * @param array $beat Last heartbeat.
	 * @return array Row.
	 */
	private function heartbeat_row( array $beat ) {
		if ( empty( $beat['at'] ) ) {
			return array( 'info', __( 'None sent yet', 'norg-edge-router' ) );
		}
		/* translators: %s: time since the last heartbeat. */
		$text = sprintf( __( '%s ago', 'norg-edge-router' ), human_time_diff( (int) $beat['at'] ) ) . ( empty( $beat['ok'] ) ? ' · HTTP ' . ( $beat['http'] ?? 'error' ) : '' );
		return array( empty( $beat['ok'] ) ? 'bad' : 'good', $text );
	}

	/**
	 * Cache-reach verdict.
	 *
	 * @param array $check Last self-check.
	 * @return array Row.
	 */
	private function reach_row( array $check ) {
		$reach = $check['cache_reach'] ?? 'unchecked';
		if ( 'reached' === $reach ) {
			return array( 'good', __( 'Yes: an AI agent request is answered by WordPress', 'norg-edge-router' ) );
		}
		if ( 'cache_interference' === $reach ) {
			return array( 'bad', __( 'No: a page cache answered first. See the fix below.', 'norg-edge-router' ) );
		}
		return array( 'info', 'unverifiable' === $reach ? __( 'Could not verify (loopback blocked)', 'norg-edge-router' ) : __( 'Run the checks', 'norg-edge-router' ) );
	}

	/**
	 * A pass/fail self-check row.
	 *
	 * @param array  $check Last self-check.
	 * @param string $key   Field.
	 * @param string $pass  Passing value.
	 * @return array Row.
	 */
	private function simple_row( array $check, $key, $pass ) {
		$value = $check[ $key ] ?? 'unchecked';
		if ( $pass === $value ) {
			return array( 'good', __( 'Yes', 'norg-edge-router' ) );
		}
		return array( 'touched' === $value ? 'bad' : 'info', $value );
	}

	/**
	 * Simulated agent outcome.
	 *
	 * @param array $check Last self-check.
	 * @return array Row.
	 */
	private function agent_row( array $check ) {
		$value = $check['agent'] ?? 'unchecked';
		$state = in_array( $value, array( 'mirror', 'stripped' ), true ) ? 'good' : 'info';
		return array( $state, 'untouched' === $value ? __( 'Not diverted (feed does not divert GPTBot, or no render yet and strip off)', 'norg-edge-router' ) : $value );
	}

	/**
	 * Update capability.
	 *
	 * @return array Row.
	 */
	private function update_row() {
		if ( ! class_exists( Updater::class ) ) {
			return array( 'info', __( 'Updates come from WordPress.org', 'norg-edge-router' ) );
		}
		$capability = Updater::capability();
		$auto       = $this->plugin->config()->get( 'auto_update' ) ? __( 'automatic', 'norg-edge-router' ) : __( 'manual', 'norg-edge-router' );
		return array( 'ok' === $capability ? 'good' : 'warn', NORG_EDGE_ROUTER_VERSION . ' · ' . $auto . ( 'ok' === $capability ? '' : ' · ' . $capability ) );
	}

	/**
	 * Trusted proxy and suggestion.
	 *
	 * @return array Row.
	 */
	private function proxy_row() {
		$mode       = (string) $this->plugin->config()->get( 'trusted_proxy' );
		$suggestion = Ip_Resolver::suggest( $_SERVER ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- presence checks only.
		if ( 'auto' === $mode ) {
			/* translators: %s: the mode this request resolved to. */
			return array( 'good', sprintf( __( 'auto · this request uses "%s"', 'norg-edge-router' ), $suggestion ) );
		}
		$text = $mode . ( $suggestion !== $mode ? ' · ' . sprintf( /* translators: %s: suggested mode. */ __( 'this request suggests "%s"', 'norg-edge-router' ), $suggestion ) : '' );
		return array( $suggestion === $mode ? 'good' : 'warn', $text );
	}

	/**
	 * Per-cache bypass results.
	 *
	 * @return array slug => array( label, result ).
	 */
	public function caches() {
		$state = Registry::state();
		$out   = array();
		foreach ( Registry::adapters() as $adapter ) {
			if ( $adapter->detected() ) {
				$out[ $adapter->slug() ] = array( $adapter->label(), $state['applied'][ $adapter->slug() ] ?? null );
			}
		}
		return $out;
	}

	/**
	 * Tokens registered as cache bypasses.
	 *
	 * @return array Tokens.
	 */
	public function tokens() {
		return Registry::state()['tokens'];
	}

	/**
	 * Host advice, or "".
	 *
	 * @return string Advice.
	 */
	public function host_advice() {
		return Host_Detector::advice();
	}

	/**
	 * Last internal error.
	 *
	 * @return array|null Error.
	 */
	public function last_error() {
		$error = get_option( 'norg_edge_last_error' );
		return is_array( $error ) ? $error : null;
	}
}
