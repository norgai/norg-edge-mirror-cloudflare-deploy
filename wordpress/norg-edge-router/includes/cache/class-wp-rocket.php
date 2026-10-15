<?php
/**
 * WP Rocket: rocket_cache_reject_ua, written into its config file and .htaccess.
 *
 * Its .htaccess rule is anchored (`!^(list).*`) while its PHP check is not, so
 * each entry is ".*" plus a case-insensitive character-class form of the token
 * (real agent user agents start with "Mozilla/5.0", and the PHP check is
 * case-sensitive).
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge\Cache;

defined( 'ABSPATH' ) || exit;

/**
 * WP Rocket adapter.
 */
final class Wp_Rocket implements Adapter {

	/**
	 * Tokens registered for this request.
	 *
	 * @var array
	 */
	private $tokens = array();

	/**
	 * Whether the filter is hooked.
	 *
	 * @var bool
	 */
	private $hooked = false;

	/**
	 * Stable identifier.
	 *
	 * @return string Slug.
	 */
	public function slug() {
		return 'wp-rocket';
	}

	/**
	 * Human name.
	 *
	 * @return string Label.
	 */
	public function label() {
		return 'WP Rocket';
	}

	/**
	 * Is this cache active?
	 *
	 * @return bool True when detected.
	 */
	public function detected() {
		return defined( 'WP_ROCKET_VERSION' ) || Registry::plugin_active( 'wp-rocket/wp-rocket.php' );
	}

	/**
	 * Register per-request filters.
	 *
	 * @param array $tokens Divertable user-agent substrings.
	 * @return void
	 */
	public function register_runtime( array $tokens ) {
		$this->tokens = $tokens;
		if ( ! $this->hooked ) {
			$this->hooked = true;
			add_filter( 'rocket_cache_reject_ua', array( $this, 'reject_ua' ) );
		}
	}

	/**
	 * Append our entries to WP Rocket's rejected user agents.
	 *
	 * @param array $ua Existing list.
	 * @return array List.
	 */
	public function reject_ua( $ua ) {
		return array_merge( (array) $ua, array_map( array( __CLASS__, 'entry' ), $this->tokens ) );
	}

	/**
	 * ".*" + case-insensitive character classes, e.g. ".*[gG][pP][tT][bB][oO][tT]".
	 *
	 * @param string $token Token.
	 * @return string Regex fragment.
	 */
	public static function entry( $token ) {
		$out = '.*';
		foreach ( str_split( (string) $token ) as $char ) {
			$out .= ctype_alpha( $char ) ? '[' . strtolower( $char ) . strtoupper( $char ) . ']' : preg_quote( $char, '#' );
		}
		return $out;
	}

	/**
	 * Write the bypass into this cache's configuration.
	 *
	 * @param array $tokens  Current tokens.
	 * @param array $retired Tokens to remove.
	 * @return array Result.
	 */
	public function apply( array $tokens, array $retired ) {
		$this->register_runtime( $tokens );
		$written = array();
		if ( function_exists( 'rocket_generate_config_file' ) ) {
			rocket_generate_config_file();
			$written[] = 'config';
		}
		if ( function_exists( 'flush_rocket_htaccess' ) ) {
			flush_rocket_htaccess();
			$written[] = 'htaccess';
		}
		return array(
			'ok'        => (bool) $written,
			'mechanism' => 'rocket_cache_reject_ua (' . implode( ', ', $written ) . ')',
			'note'      => $written ? '' : 'WP Rocket functions not loaded; the filter applies on its next config regeneration.',
		);
	}

	/**
	 * Remove every entry this plugin added.
	 *
	 * @param array $tokens Tokens previously added.
	 * @return void
	 */
	public function remove( array $tokens ) {
		remove_filter( 'rocket_cache_reject_ua', array( $this, 'reject_ua' ) );
		$this->tokens = array();
		if ( function_exists( 'rocket_generate_config_file' ) ) {
			rocket_generate_config_file();
		}
		if ( function_exists( 'flush_rocket_htaccess' ) ) {
			flush_rocket_htaccess();
		}
	}
}
