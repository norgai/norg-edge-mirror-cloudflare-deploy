<?php
/**
 * WP Super Cache: three layers, because its rejected-agent list only stops STORING.
 *
 * Verified in its source: phase 1 (advanced-cache.php) serves a cached page
 * without consulting $cache_rejected_user_agent; that list is read in phase 2,
 * after WordPress loads, to decide whether to store. So:
 *  1. Serve side, PHP mode: an extension file in wp-super-cache-plugins/ (which
 *     phase 1 loads before serving) hooks the documented cache_init action and
 *     turns $cache_enabled off for this request when the agent is divertable.
 *  2. Serve side, Expert (mod_rewrite) mode: a supercacherewriteconditions
 *     filter adds a user-agent condition, and the rules are regenerated.
 *  3. Store side: the tokens are merged into $cache_rejected_user_agent.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge\Cache;

defined( 'ABSPATH' ) || exit;

/**
 * WP Super Cache adapter.
 */
final class Wp_Super_Cache implements Adapter {

	/**
	 * Tokens for the rewrite-condition filter.
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
		return 'wp-super-cache';
	}

	/**
	 * Human name.
	 *
	 * @return string Label.
	 */
	public function label() {
		return 'WP Super Cache';
	}

	/**
	 * Is this cache active?
	 *
	 * @return bool True when detected.
	 */
	public function detected() {
		return defined( 'WPCACHEHOME' ) || Registry::plugin_active( 'wp-super-cache/wp-cache.php' );
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
			add_filter( 'supercacherewriteconditions', array( $this, 'conditions' ) );
		}
	}

	/**
	 * Add our user-agent condition to the Expert-mode rewrite rules.
	 *
	 * @param array $conditions RewriteCond lines.
	 * @return array Lines.
	 */
	public function conditions( $conditions ) {
		if ( $this->tokens ) {
			$alternation  = implode( '|', array_map( array( __CLASS__, 'rewrite_token' ), $this->tokens ) );
			$conditions[] = 'RewriteCond %{HTTP_USER_AGENT} !(' . $alternation . ') [NC]';
		}
		return (array) $conditions;
	}

	/**
	 * Escape a token for an Apache regex (spaces must be backslash-escaped).
	 *
	 * @param string $token Token.
	 * @return string Escaped.
	 */
	public static function rewrite_token( $token ) {
		return str_replace( ' ', '\\ ', preg_quote( $token, '#' ) );
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
		$merged = array_values( array_unique( array_merge( array_diff( $this->current(), $retired ), $tokens ) ) );
		$wrote  = $this->write( $merged );
		$serve  = $this->write_phase1_extension( $tokens );
		$rules  = $this->refresh_rewrite_rules();
		return array(
			'ok'        => $wrote && $serve,
			'mechanism' => 'cache_init extension + $cache_rejected_user_agent' . ( $rules ? ' + supercacherewriteconditions' : '' ),
			'note'      => $wrote && $serve ? '' : 'wp-cache-config.php or the wp-super-cache-plugins directory is not writable.',
		);
	}

	/**
	 * Remove every entry this plugin added.
	 *
	 * @param array $tokens Tokens previously added.
	 * @return void
	 */
	public function remove( array $tokens ) {
		remove_filter( 'supercacherewriteconditions', array( $this, 'conditions' ) );
		$this->tokens = array();
		$this->write( array_values( array_diff( $this->current(), $tokens ) ) );
		$this->write_phase1_extension( array() );
		$this->refresh_rewrite_rules();
	}

	/**
	 * Path of the phase-1 extension file (WPCACHEHOME/../wp-super-cache-plugins/).
	 *
	 * @return string|null Path, or null when WP Super Cache is not loaded.
	 */
	public static function extension_path() {
		return defined( 'WPCACHEHOME' ) ? dirname( rtrim( WPCACHEHOME, '/' ) ) . '/wp-super-cache-plugins/norg-edge-router.php' : null;
	}

	/**
	 * Write (or, with no tokens, delete) the phase-1 extension.
	 *
	 * @param array $tokens Tokens.
	 * @return bool True on success.
	 */
	private function write_phase1_extension( array $tokens ) {
		$path = self::extension_path();
		if ( null === $path ) {
			return false;
		}
		if ( ! $tokens ) {
			if ( file_exists( $path ) ) {
				wp_delete_file( $path );
			}
			return true;
		}
		if ( ! is_dir( dirname( $path ) ) && ! wp_mkdir_p( dirname( $path ) ) ) {
			return false;
		}
		$list = 'array( ' . implode( ', ', array_map( array( __CLASS__, 'literal' ), $tokens ) ) . ' )';
		$code = "<?php\n// Written by the NORG Edge Router plugin; removed when it is deactivated.\n"
			. "// AI agents NORG may divert must reach WordPress, so this request is not served from cache.\n"
			. "if ( ! function_exists( 'norg_edge_wpsc_cache_init' ) ) {\n"
			. "\tfunction norg_edge_wpsc_cache_init() {\n"
			. "\t\t\$ua = isset( \$_SERVER['HTTP_USER_AGENT'] ) ? strtolower( (string) \$_SERVER['HTTP_USER_AGENT'] ) : '';\n"
			. "\t\tforeach ( $list as \$token ) {\n"
			. "\t\t\tif ( false !== strpos( \$ua, \$token ) ) {\n"
			. "\t\t\t\t\$GLOBALS['cache_enabled'] = false;\n"
			. "\t\t\t\treturn;\n"
			. "\t\t\t}\n"
			. "\t\t}\n"
			. "\t}\n"
			. "\tif ( function_exists( 'add_cacheaction' ) ) {\n"
			. "\t\tadd_cacheaction( 'cache_init', 'norg_edge_wpsc_cache_init' );\n"
			. "\t}\n"
			. "}\n";
		return false !== file_put_contents( $path, $code, LOCK_EX ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- WP Super Cache's documented extension directory.
	}

	/**
	 * The current rejected list.
	 *
	 * @return array Entries.
	 */
	private function current() {
		global $cache_rejected_user_agent;
		return is_array( $cache_rejected_user_agent ) ? array_values( array_filter( $cache_rejected_user_agent ) ) : array();
	}

	/**
	 * Write the list with WP Super Cache's own single-line config writer.
	 *
	 * @param array $entries Entries.
	 * @return bool True when written.
	 */
	private function write( array $entries ) {
		global $wp_cache_config_file, $cache_rejected_user_agent;
		if ( ! function_exists( 'wp_cache_replace_line' ) || empty( $wp_cache_config_file ) ) {
			return false;
		}
		$literal = 'array( ' . implode( ', ', array_map( array( __CLASS__, 'literal' ), $entries ) ) . ' )';
		$ok      = false !== wp_cache_replace_line( '^ *\$cache_rejected_user_agent', '$cache_rejected_user_agent = ' . $literal . ';', $wp_cache_config_file );
		if ( $ok ) {
			$cache_rejected_user_agent = $entries; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedVariableFound -- WP Super Cache's own global, kept in step with its file.
		}
		return $ok;
	}

	/**
	 * Single-quoted PHP literal.
	 *
	 * @param string $value Value.
	 * @return string Literal.
	 */
	public static function literal( $value ) {
		return "'" . str_replace( array( '\\', "'" ), array( '\\\\', "\\'" ), (string) $value ) . "'";
	}

	/**
	 * Regenerate Expert-mode rules when that mode is on.
	 *
	 * @return bool True when rules were regenerated.
	 */
	private function refresh_rewrite_rules() {
		global $wp_cache_mod_rewrite;
		if ( empty( $wp_cache_mod_rewrite ) || ! function_exists( 'wpsc_update_htaccess' ) ) {
			return false;
		}
		return (bool) wpsc_update_htaccess();
	}
}
