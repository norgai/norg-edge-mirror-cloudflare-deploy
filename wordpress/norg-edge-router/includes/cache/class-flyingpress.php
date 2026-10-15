<?php
/**
 * FlyingPress: flying_press_is_cacheable stops it caching agent requests.
 *
 * FlyingPress has no user-agent exclusion and serves hits from static files via
 * rewrite rules, so the serve side needs the generic .htaccess bypass block
 * (Apache/LiteSpeed) or a host-level rule (nginx); the status page says which.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge\Cache;

defined( 'ABSPATH' ) || exit;

/**
 * FlyingPress adapter.
 */
final class Flyingpress implements Adapter {

	/**
	 * Tokens for the cacheability filter.
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
		return 'flyingpress';
	}

	/**
	 * Human name.
	 *
	 * @return string Label.
	 */
	public function label() {
		return 'FlyingPress';
	}

	/**
	 * Is this cache active?
	 *
	 * @return bool True when detected.
	 */
	public function detected() {
		return defined( 'FLYING_PRESS_VERSION' ) || Registry::plugin_active( 'flying-press/flying-press.php' );
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
			add_filter( 'flying_press_is_cacheable', array( $this, 'is_cacheable' ) );
		}
	}

	/**
	 * Never cache a page generated for a divertable agent.
	 *
	 * @param bool $cacheable FlyingPress's decision.
	 * @return bool Decision.
	 */
	public function is_cacheable( $cacheable ) {
		$ua = isset( $_SERVER['HTTP_USER_AGENT'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) ) : '';
		return $cacheable && ! Registry::matches( $ua, $this->tokens );
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
		return array(
			'ok'        => true,
			'mechanism' => 'flying_press_is_cacheable',
			'note'      => 'Store side only. Enable the .htaccess bypass block (Apache/LiteSpeed) or ask your host to bypass the cache for AI user agents (nginx).',
		);
	}

	/**
	 * Remove every entry this plugin added.
	 *
	 * @param array $tokens Tokens previously added.
	 * @return void
	 */
	public function remove( array $tokens ) {
		remove_filter( 'flying_press_is_cacheable', array( $this, 'is_cacheable' ) );
		$this->tokens = array();
	}
}
