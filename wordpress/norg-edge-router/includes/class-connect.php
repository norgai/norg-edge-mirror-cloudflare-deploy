<?php
/**
 * Connect the plugin to NORG: validate the Site ID and Site Key, save them, prove the install.
 *
 * One implementation behind three doors — the settings page, WP-CLI
 * (`wp norg-edge configure`) and the REST endpoint NORG's dashboard calls with
 * an Application Password — so every door validates the same way and ends in
 * the same proof (feed refresh, self-check, heartbeat).
 *
 * @package Norg\Edge
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Shared connect logic.
 */
class Connect {

	const ENVS = array( 'production', 'test' );

	/**
	 * Validate the values the caller supplied and shape them for Config::save().
	 *
	 * Pure: no WordPress calls, so it is unit-testable without a WordPress.
	 *
	 * @param string      $site_id      Site UUID.
	 * @param string      $site_key     One-time site key (nek_live_… / nek_test_…).
	 * @param string|null $env          production | test, or null to leave unchanged.
	 * @param string|null $api_url      Override of the NORG API origin, or null.
	 * @param string|null $content_base Override of the NORG content origin, or null.
	 * @return array array( 'values' => array, 'error' => string ); error is '' when valid.
	 */
	public static function values( $site_id, $site_key, $env = null, $api_url = null, $content_base = null ) {
		$site_id = strtolower( trim( (string) $site_id ) );
		$key     = trim( (string) $site_key );
		if ( ! preg_match( '/^[0-9a-f-]{36}$/', $site_id ) ) {
			return array(
				'values' => array(),
				'error'  => 'site_id must be the UUID NORG issued',
			);
		}
		if ( ! preg_match( '/^nek_(live|test)_[A-Za-z0-9_-]{20,}$/', $key ) ) {
			return array(
				'values' => array(),
				'error'  => 'site_key must be the key NORG issued (nek_live_…)',
			);
		}
		$values = array(
			'site_id'  => $site_id,
			'site_key' => $key,
		);
		if ( null !== $env ) {
			$values['edge_env'] = in_array( (string) $env, self::ENVS, true ) ? (string) $env : '';
		}
		foreach ( array(
			'api_url'      => $api_url,
			'content_base' => $content_base,
		) as $field => $url ) {
			if ( null === $url || '' === trim( (string) $url ) ) {
				continue;
			}
			if ( ! self::is_https_origin( (string) $url ) ) {
				return array(
					'values' => array(),
					'error'  => $field . ' must be an https:// origin',
				);
			}
			$values[ $field ] = rtrim( trim( (string) $url ), '/' );
		}
		return array(
			'values' => $values,
			'error'  => '',
		);
	}

	/**
	 * Whether a value is an https URL with a host and nothing else of note.
	 *
	 * @param string $url Candidate.
	 * @return bool
	 */
	private static function is_https_origin( $url ) {
		$parts = parse_url( trim( $url ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions.parse_url_parse_url -- pure helper, must run without WordPress.
		return is_array( $parts ) && isset( $parts['scheme'], $parts['host'] ) && 'https' === $parts['scheme'];
	}

	/**
	 * Save validated values and prove the install: feed, self-check, heartbeat.
	 *
	 * @param Plugin $plugin Service container.
	 * @param array  $values Output of values()['values'].
	 * @return array Result: saved, feed, checks, heartbeat (never the key).
	 */
	public static function apply( Plugin $plugin, array $values ) {
		$plugin->config()->save( $values );
		$plugin->reset();
		$plugin->feed()->forget();
		$feed   = $plugin->feed()->refresh();
		$checks = $plugin->self_check()->run();
		return array(
			'saved'     => true,
			'site_id'   => $values['site_id'],
			'version'   => NORG_EDGE_ROUTER_VERSION,
			'feed'      => $feed,
			'checks'    => $checks,
			'heartbeat' => $plugin->telemetry()->heartbeat( 'admin' ),
		);
	}
}
