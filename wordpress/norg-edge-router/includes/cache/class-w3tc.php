<?php
/**
 * W3 Total Cache: pgcache.reject.ua through its config object, then its rule regeneration.
 *
 * Matched with stristr in PHP and written into its disk-enhanced rewrite rules.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge\Cache;

defined( 'ABSPATH' ) || exit;

/**
 * W3 Total Cache adapter.
 */
final class W3tc implements Adapter {

	const KEY = 'pgcache.reject.ua';

	/**
	 * Stable identifier.
	 *
	 * @return string Slug.
	 */
	public function slug() {
		return 'w3-total-cache';
	}

	/**
	 * Human name.
	 *
	 * @return string Label.
	 */
	public function label() {
		return 'W3 Total Cache';
	}

	/**
	 * Is this cache active?
	 *
	 * @return bool True when detected.
	 */
	public function detected() {
		return defined( 'W3TC' ) || Registry::plugin_active( 'w3-total-cache/w3-total-cache.php' );
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
		$config = $this->config();
		if ( null === $config ) {
			return array(
				'ok'        => false,
				'mechanism' => self::KEY,
				'note'      => 'W3 Total Cache is not loaded.',
			);
		}
		$merged = array_values( array_unique( array_merge( array_diff( (array) $config->get_array( self::KEY ), $retired ), $tokens ) ) );
		$this->save( $config, $merged );
		return array(
			'ok'        => true,
			'mechanism' => self::KEY,
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
		$config = $this->config();
		if ( null !== $config ) {
			$this->save( $config, array_values( array_diff( (array) $config->get_array( self::KEY ), $tokens ) ) );
		}
	}

	/**
	 * W3TC's config object.
	 *
	 * @return object|null Config.
	 */
	private function config() {
		return class_exists( '\\W3TC\\Dispatcher' ) ? \W3TC\Dispatcher::config() : null;
	}

	/**
	 * Save and regenerate rules.
	 *
	 * @param object $config W3TC config.
	 * @param array  $entries   Entries.
	 * @return void
	 */
	private function save( $config, array $entries ) {
		$config->set( self::KEY, $entries );
		$config->save();
		if ( class_exists( '\\W3TC\\Dispatcher' ) ) {
			$environment = \W3TC\Dispatcher::component( 'PgCache_Environment' );
			if ( is_object( $environment ) && method_exists( $environment, 'fix_on_wpadmin_request' ) ) {
				try {
					$environment->fix_on_wpadmin_request( $config, true );
				} catch ( \Exception $e ) {
					\Norg\Edge\Log::debug( 'w3tc_rules', array( 'error' => $e->getMessage() ) );
				}
			}
		}
	}
}
