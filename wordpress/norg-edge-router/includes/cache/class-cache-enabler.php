<?php
/**
 * Cache Enabler: detection only.
 *
 * It serves hits from advanced-cache.php before any plugin loads and has no
 * user-agent exclusion, so no plugin can keep agents off its cached pages. The
 * status page and self-check say so; the fix is a host-level bypass rule.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge\Cache;

defined( 'ABSPATH' ) || exit;

/**
 * Cache Enabler (unfixable from a plugin; reported).
 */
final class Cache_Enabler implements Adapter {

	/**
	 * Stable identifier.
	 *
	 * @return string Slug.
	 */
	public function slug() {
		return 'cache-enabler';
	}

	/**
	 * Human name.
	 *
	 * @return string Label.
	 */
	public function label() {
		return 'Cache Enabler';
	}

	/**
	 * Is this cache active?
	 *
	 * @return bool True when detected.
	 */
	public function detected() {
		return defined( 'CACHE_ENABLER_VERSION' ) || Registry::plugin_active( 'cache-enabler/cache-enabler.php' );
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
	 * Write the bypass into this cache's configuration.
	 *
	 * @param array $tokens  Current tokens.
	 * @param array $retired Tokens to remove.
	 * @return array Result.
	 */
	public function apply( array $tokens, array $retired ) {
		return array(
			'ok'        => false,
			'mechanism' => 'none',
			'note'      => 'Cache Enabler has no user-agent exclusion and serves cached pages before plugins load. Ask your host to bypass the cache for AI user agents, or switch cache plugin.',
		);
	}

	/**
	 * Remove every entry this plugin added.
	 *
	 * @param array $tokens Tokens previously added.
	 * @return void
	 */
	public function remove( array $tokens ) {
	}
}
