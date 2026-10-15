<?php
/**
 * LiteSpeed Cache: "Do Not Cache User Agents" (cache-exc_useragents) via its public conf API.
 *
 * The litespeed_save_conf action persists the option and regenerates .htaccess, where the
 * server-level rule `RewriteCond %{HTTP_USER_AGENT} (…) [NC]` sets
 * Cache-Control: no-cache before LiteSpeed's cache answers.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge\Cache;

defined( 'ABSPATH' ) || exit;

/**
 * LiteSpeed Cache adapter.
 */
final class Litespeed implements Adapter {

	const OPTION_ID = 'cache-exc_useragents';

	/**
	 * Stable identifier.
	 *
	 * @return string Slug.
	 */
	public function slug() {
		return 'litespeed-cache';
	}

	/**
	 * Human name.
	 *
	 * @return string Label.
	 */
	public function label() {
		return 'LiteSpeed Cache';
	}

	/**
	 * Is this cache active?
	 *
	 * @return bool True when detected.
	 */
	public function detected() {
		return defined( 'LSCWP_V' ) || Registry::plugin_active( 'litespeed-cache/litespeed-cache.php' );
	}

	/**
	 * Register per-request filters.
	 *
	 * @param array $tokens Divertable user-agent substrings.
	 * @return void
	 */
	public function register_runtime( array $tokens ) {
	}

	/**
	 * The current list.
	 *
	 * @return array Entries.
	 */
	private function current() {
		$value = apply_filters( 'litespeed_conf', self::OPTION_ID ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- LiteSpeed Cache's public API.
		if ( self::OPTION_ID === $value ) {
			$value = get_option( 'litespeed.conf.' . self::OPTION_ID, array() );
		}
		return array_values( array_filter( array_map( 'trim', is_array( $value ) ? $value : explode( "\n", (string) $value ) ) ) );
	}

	/**
	 * Write the bypass into this cache's configuration.
	 *
	 * @param array $tokens  Current tokens.
	 * @param array $retired Tokens to remove.
	 * @return array Result.
	 */
	public function apply( array $tokens, array $retired ) {
		$merged = array_values( array_unique( array_merge( array_diff( $this->current(), $retired ), $tokens ) ) );
		$this->save( $merged );
		return array(
			'ok'        => ! array_diff( $tokens, $this->current() ),
			'mechanism' => 'litespeed_save_conf ' . self::OPTION_ID,
			'note'      => '',
		);
	}

	/**
	 * Remove every entry this plugin added.
	 *
	 * @param array $tokens Tokens previously added.
	 * @return void
	 */
	public function remove( array $tokens ) {
		$this->save( array_values( array_diff( $this->current(), $tokens ) ) );
	}

	/**
	 * Save through LiteSpeed's API (which regenerates .htaccess), else the raw option.
	 *
	 * @param array $entries Entries.
	 * @return void
	 */
	private function save( array $entries ) {
		if ( has_action( 'litespeed_save_conf' ) ) {
			do_action( 'litespeed_save_conf', array( self::OPTION_ID => $entries ) ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- LiteSpeed Cache's public API.
			return;
		}
		update_option( 'litespeed.conf.' . self::OPTION_ID, $entries );
	}
}
