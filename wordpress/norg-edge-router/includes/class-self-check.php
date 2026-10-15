<?php
/**
 * The truth test: does an AI agent's request actually reach the plugin?
 *
 * Loopback requests from the server to its own home page, through whatever page
 * cache sits in front of PHP:
 *   reach   GPTBot UA + probe key  -> the plugin's JSON means agents reach PHP;
 *                                     HTML means a cache answered first.
 *   human   browser UA             -> must carry no X-Norg-Edge header.
 *   search  Googlebot UA + simulate -> must carry no X-Norg-Edge header (rule 2).
 *   agent   GPTBot UA + simulate   -> X-Norg-Edge mirror|stripped once a render or
 *                                     strip applies.
 * A loopback that cannot connect reports "unverifiable", never failure.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Runs and records the self-check.
 */
final class Self_Check {

	const OPTION     = 'norg_edge_last_self_check';
	const AGENT_UA   = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';
	const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
	const SEARCH_UA  = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

	/**
	 * Service container.
	 *
	 * @var Plugin
	 */
	private $plugin;

	/**
	 * Build the check.
	 *
	 * @param Plugin $plugin Service container.
	 */
	public function __construct( Plugin $plugin ) {
		$this->plugin = $plugin;
	}

	/**
	 * Run every check and store the result.
	 *
	 * @return array Result.
	 */
	public function run() {
		$config = $this->plugin->config();
		$result = array(
			'at'          => time(),
			'configured'  => $config->is_configured(),
			'feed'        => $config->is_configured() ? $this->plugin->feed()->refresh() : 'not_configured',
			'cache_reach' => 'unchecked',
			'human'       => 'unchecked',
			'search'      => 'unchecked',
			'agent'       => 'unchecked',
			'caches'      => Cache\Registry::detected_slugs(),
		);
		if ( $result['configured'] ) {
			$key                   = $config->site_key();
			$url                   = home_url( '/' );
			$warm                  = $this->fetch( $url, self::BROWSER_UA, array() );
			$result['human']       = $this->untouched( $warm );
			$result['cache_reach'] = $this->reach( $this->fetch( $url, self::AGENT_UA, array( Constants::HEALTH_CHECK_HEADER => $key ) ) );
			$result['search']      = $this->untouched( $this->fetch( $url, self::SEARCH_UA, array( Constants::SIMULATE_HEADER => $key ) ) );
			$result['agent']       = $this->agent( $this->fetch( $url, self::AGENT_UA, array( Constants::SIMULATE_HEADER => $key ) ) );
		}
		Cache\Registry::record_verification( 'reached' === $result['cache_reach'] );
		update_option( self::OPTION, $result, false );
		return $result;
	}

	/**
	 * One loopback request.
	 *
	 * @param string $url     URL.
	 * @param string $ua      User agent.
	 * @param array  $headers Extra headers.
	 * @return array|null array( status, edge, type, body ) or null when unreachable.
	 */
	private function fetch( $url, $ua, array $headers ) {
		$response = wp_remote_get(
			$url,
			array(
				'user-agent'  => $ua,
				'headers'     => $headers,
				'timeout'     => 10,
				'redirection' => 3,
				'sslverify'   => apply_filters( 'https_local_ssl_verify', false ), // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- core's loopback TLS filter.
			)
		);
		if ( is_wp_error( $response ) ) {
			return null;
		}
		return array(
			'status' => (int) wp_remote_retrieve_response_code( $response ),
			'edge'   => (string) wp_remote_retrieve_header( $response, 'x-norg-edge' ),
			'type'   => (string) wp_remote_retrieve_header( $response, 'content-type' ),
			'body'   => (string) wp_remote_retrieve_body( $response ),
		);
	}

	/**
	 * Interpret the probe-key request.
	 *
	 * @param array|null $r Response.
	 * @return string reached | cache_interference | unverifiable.
	 */
	private function reach( $r ) {
		if ( null === $r ) {
			return 'unverifiable';
		}
		$json = json_decode( $r['body'], true );
		if ( is_array( $json ) && isset( $json['platform'] ) && Constants::PLATFORM === $json['platform'] ) {
			return 'reached';
		}
		return 'cache_interference';
	}

	/**
	 * A response that must not have been touched.
	 *
	 * @param array|null $r Response.
	 * @return string ok | touched | unverifiable.
	 */
	private function untouched( $r ) {
		if ( null === $r ) {
			return 'unverifiable';
		}
		return '' === $r['edge'] ? 'ok' : 'touched';
	}

	/**
	 * Interpret the simulated-agent request.
	 *
	 * @param array|null $r Response.
	 * @return string mirror | stripped | untouched | unverifiable.
	 */
	private function agent( $r ) {
		if ( null === $r ) {
			return 'unverifiable';
		}
		return '' === $r['edge'] ? 'untouched' : $r['edge'];
	}
}
