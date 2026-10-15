<?php
/**
 * WP Fastest Cache: user-agent exclude rules in WpFastestCacheExclude, then its .htaccess rewrite.
 *
 * Rules use the exact shape its admin UI stores ({type, prefix, content}); the
 * excluded agent never starts WPFC's buffer, so nothing is stored for it, and
 * the regenerated block adds `RewriteCond %{HTTP_USER_AGENT} !token [NC]`.
 * WPFC honours DONOTCACHEPAGE only in narrow cases, so this exclusion is the
 * real protection.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge\Cache;

defined( 'ABSPATH' ) || exit;

/**
 * WP Fastest Cache adapter.
 */
final class Wp_Fastest_Cache implements Adapter {

	const OPTION = 'WpFastestCacheExclude';

	/**
	 * Stable identifier.
	 *
	 * @return string Slug.
	 */
	public function slug() {
		return 'wp-fastest-cache';
	}

	/**
	 * Human name.
	 *
	 * @return string Label.
	 */
	public function label() {
		return 'WP Fastest Cache';
	}

	/**
	 * Is this cache active?
	 *
	 * @return bool True when detected.
	 */
	public function detected() {
		return class_exists( 'WpFastestCache' ) || Registry::plugin_active( 'wp-fastest-cache/wpFastestCache.php' );
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
	 * Current rules as arrays.
	 *
	 * @return array Rules.
	 */
	private function rules() {
		$json  = get_option( self::OPTION );
		$rules = is_string( $json ) ? json_decode( $json, true ) : null;
		return is_array( $rules ) ? array_values( $rules ) : array();
	}

	/**
	 * Is this one of our user-agent rules for one of these tokens?
	 *
	 * @param array $rule   Rule.
	 * @param array $tokens Tokens.
	 * @return bool True when ours.
	 */
	private static function is_ours( array $rule, array $tokens ) {
		return isset( $rule['type'], $rule['content'] ) && 'useragent' === $rule['type'] && in_array( strtolower( (string) $rule['content'] ), $tokens, true );
	}

	/**
	 * Write the bypass into this cache's configuration.
	 *
	 * @param array $tokens  Current tokens.
	 * @param array $retired Tokens to remove.
	 * @return array Result.
	 */
	public function apply( array $tokens, array $retired ) {
		$rules = array_values(
			array_filter(
				$this->rules(),
				function ( $rule ) use ( $tokens, $retired ) {
					return ! self::is_ours( (array) $rule, array_merge( $tokens, $retired ) );
				}
			)
		);
		foreach ( $tokens as $token ) {
			$rules[] = array(
				'prefix'  => 'contain',
				'content' => preg_replace( '/[#\s()*\'"]/', '', $token ),
				'type'    => 'useragent',
			);
		}
		$this->save( $rules );
		return array(
			'ok'        => true,
			'mechanism' => self::OPTION . ( $this->rewrite() ? ' + .htaccess exclude block' : '' ),
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
		$rules = array_values(
			array_filter(
				$this->rules(),
				function ( $rule ) use ( $tokens ) {
					return ! self::is_ours( (array) $rule, $tokens );
				}
			)
		);
		$this->save( $rules );
		$this->rewrite();
	}

	/**
	 * Store rules the way WPFC does (JSON string, deleted when empty).
	 *
	 * @param array $rules Rules.
	 * @return void
	 */
	private function save( array $rules ) {
		if ( $rules ) {
			update_option( self::OPTION, (string) wp_json_encode( $rules ) );
		} else {
			delete_option( self::OPTION );
		}
	}

	/**
	 * Regenerate WPFC's exclude block with its own method.
	 *
	 * @return bool True when the block was rewritten.
	 */
	private function rewrite() {
		$wpfc = isset( $GLOBALS['wp_fastest_cache'] ) ? $GLOBALS['wp_fastest_cache'] : ( isset( $GLOBALS['wpfc'] ) ? $GLOBALS['wpfc'] : null );
		if ( is_object( $wpfc ) && method_exists( $wpfc, 'modify_htaccess_for_exclude' ) ) {
			$wpfc->modify_htaccess_for_exclude();
			return true;
		}
		return false;
	}
}
