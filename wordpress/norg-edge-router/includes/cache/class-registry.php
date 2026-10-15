<?php
/**
 * Page-cache bypass: derive the AI-agent user agents from the feed and register them everywhere.
 *
 * Every major cache plugin serves a hit from a static file via rewrite rules
 * before PHP runs, so the bypass must land in each cache's OWN configuration
 * and rewrite rules. Entries are merged with the admin's own, tracked as ours,
 * and removed on deactivation. Applied from cron, never on the request path.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge\Cache;

use Norg\Edge\Plugin;

defined( 'ABSPATH' ) || exit;

require_once __DIR__ . '/interface-adapter.php';

/**
 * Adapter registry and bypass state.
 */
final class Registry {

	const OPTION = 'norg_edge_bypass';

	/**
	 * Built adapters.
	 *
	 * @var Adapter[]|null
	 */
	private static $adapters = null;

	/**
	 * Every adapter.
	 *
	 * @return Adapter[] Adapters.
	 */
	public static function adapters() {
		if ( null === self::$adapters ) {
			self::$adapters = array(
				new Wp_Rocket(),
				new Litespeed(),
				new Wp_Super_Cache(),
				new Wp_Fastest_Cache(),
				new Flyingpress(),
				new W3tc(),
				new Cache_Enabler(),
			);
		}
		return self::$adapters;
	}

	/**
	 * Slugs of the caches active on this site.
	 *
	 * @return string[] Slugs.
	 */
	public static function detected_slugs() {
		$slugs = array();
		foreach ( self::adapters() as $adapter ) {
			if ( $adapter->detected() ) {
				$slugs[] = $adapter->slug();
			}
		}
		if ( ! $slugs && defined( 'WP_CACHE' ) && WP_CACHE && file_exists( WP_CONTENT_DIR . '/advanced-cache.php' ) ) {
			$slugs[] = 'unknown-advanced-cache';
		}
		return $slugs;
	}

	/**
	 * User-agent substrings for patterns NORG may divert.
	 *
	 * @param array $feed Feed entry.
	 * @return string[] Sorted unique tokens.
	 */
	public static function tokens_for( array $feed ) {
		$tokens = array();
		foreach ( isset( $feed['patterns'] ) ? (array) $feed['patterns'] : array() as $pattern ) {
			$policy = isset( $pattern['serving_policy'] ) ? $pattern['serving_policy'] : '';
			$token  = isset( $pattern['pattern'] ) ? strtolower( trim( (string) $pattern['pattern'] ) ) : '';
			if ( in_array( $policy, array( 'divert', 'divert_unverified' ), true ) && preg_match( '/^[a-z0-9][a-z0-9._\- ]{1,63}$/', $token ) ) {
				$tokens[] = $token;
			}
		}
		$tokens = array_values( array_unique( $tokens ) );
		sort( $tokens );
		return $tokens;
	}

	/**
	 * Stored bypass state.
	 *
	 * @return array State.
	 */
	public static function state() {
		$state = get_option( self::OPTION, array() );
		return is_array( $state ) ? $state + array(
			'tokens'  => array(),
			'applied' => array(),
		) : array(
			'tokens'  => array(),
			'applied' => array(),
		);
	}

	/**
	 * Schedule an apply when the divertable set changed (called after a feed refresh).
	 *
	 * @param array $feed Fresh feed entry.
	 * @return void
	 */
	public static function schedule_if_changed( array $feed ) {
		if ( self::tokens_for( $feed ) !== self::state()['tokens'] && ! wp_next_scheduled( \Norg\Edge\Cron::APPLY_BYPASS ) ) {
			wp_schedule_single_event( time(), \Norg\Edge\Cron::APPLY_BYPASS );
		}
	}

	/**
	 * Register runtime filters from the stored token list (no NORG call at boot).
	 *
	 * @param Plugin $plugin Service container.
	 * @return void
	 */
	public static function register_runtime( Plugin $plugin ) {
		if ( ! $plugin->config()->get( 'cache_bypass' ) ) {
			return;
		}
		$tokens = self::state()['tokens'];
		if ( ! $tokens ) {
			return;
		}
		foreach ( self::adapters() as $adapter ) {
			if ( $adapter->detected() ) {
				$adapter->register_runtime( $tokens );
			}
		}
	}

	/**
	 * Apply the bypass to every detected cache and the optional .htaccess block.
	 *
	 * @param Plugin $plugin Service container.
	 * @return array State after applying.
	 */
	public static function apply( Plugin $plugin ) {
		$state = self::state();
		if ( ! $plugin->config()->get( 'cache_bypass' ) || ! $plugin->config()->is_configured() ) {
			return $state;
		}
		$tokens  = self::tokens_for( $plugin->feed()->get() );
		$retired = array_values( array_diff( $state['tokens'], $tokens ) );
		$applied = array();
		foreach ( self::adapters() as $adapter ) {
			if ( ! $adapter->detected() ) {
				continue;
			}
			$adapter->register_runtime( $tokens );
			$applied[ $adapter->slug() ] = self::safely( $adapter, $tokens, $retired );
		}
		$applied['htaccess-block'] = $plugin->config()->get( 'htaccess_block' ) ? Htaccess_Block::write( $tokens ) : Htaccess_Block::clear();
		$state                     = array(
			'tokens'   => $tokens,
			'applied'  => $applied,
			'at'       => time(),
			'verified' => null,
		);
		update_option( self::OPTION, $state, false );
		return $state;
	}

	/**
	 * Apply one adapter, never letting its failure reach the caller.
	 *
	 * @param Adapter $adapter Adapter.
	 * @param array   $tokens  Tokens.
	 * @param array   $retired Retired tokens.
	 * @return array Result.
	 */
	private static function safely( Adapter $adapter, array $tokens, array $retired ) {
		try {
			return $adapter->apply( $tokens, $retired ) + array( 'at' => time() );
		} catch ( \Throwable $e ) {
			return array(
				'ok'        => false,
				'mechanism' => 'error',
				'note'      => substr( $e->getMessage(), 0, 200 ),
				'at'        => time(),
			);
		}
	}

	/**
	 * Undo everything (deactivation / uninstall).
	 *
	 * @return void
	 */
	public static function remove_all() {
		$tokens = self::state()['tokens'];
		foreach ( self::adapters() as $adapter ) {
			if ( $adapter->detected() && $tokens ) {
				try {
					$adapter->remove( $tokens );
				} catch ( \Throwable $e ) {
					\Norg\Edge\Log::error( $e );
				}
			}
		}
		Htaccess_Block::clear();
		delete_option( self::OPTION );
	}

	/**
	 * Record whether the self-check proved agents reach PHP.
	 *
	 * @param bool $reached Self-check verdict.
	 * @return void
	 */
	public static function record_verification( $reached ) {
		$state = self::state();
		if ( isset( $state['at'] ) ) {
			$state['verified'] = (bool) $reached;
			update_option( self::OPTION, $state, false );
		}
	}

	/**
	 * Does a user agent contain any divertable token (case-insensitive)?
	 *
	 * @param string $ua     User agent.
	 * @param array  $tokens Tokens.
	 * @return bool True on a match.
	 */
	public static function matches( $ua, array $tokens ) {
		$ua = strtolower( (string) $ua );
		foreach ( $tokens as $token ) {
			if ( '' !== $token && false !== strpos( $ua, $token ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Is a plugin active (single site or network)?
	 *
	 * @param string $basename e.g. wp-rocket/wp-rocket.php.
	 * @return bool True when active.
	 */
	public static function plugin_active( $basename ) {
		if ( in_array( $basename, (array) get_option( 'active_plugins', array() ), true ) ) {
			return true;
		}
		return is_multisite() && isset( ( (array) get_site_option( 'active_sitewide_plugins', array() ) )[ $basename ] );
	}
}
