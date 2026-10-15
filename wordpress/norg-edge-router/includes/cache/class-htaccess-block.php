<?php
/**
 * Opt-in generic .htaccess bypass block for caches with no user-agent API (FlyingPress, unknown).
 *
 * Placed ABOVE every cache plugin's block, it rewrites a divertable agent's
 * request straight to index.php with [END], so no later cache rule can serve a
 * static hit on the restarted pass. Apache 2.4 / LiteSpeed only; nginx never
 * reads .htaccess. Written with WordPress's insert_with_markers, and removed on
 * deactivation.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge\Cache;

defined( 'ABSPATH' ) || exit;

/**
 * Manages the "NORG Edge Router" marker block in the site's .htaccess.
 */
final class Htaccess_Block {

	const MARKER = 'NORG Edge Router';

	/**
	 * The rewrite lines for a token list.
	 *
	 * @param array $tokens Tokens.
	 * @return string[] Lines.
	 */
	public static function lines( array $tokens ) {
		if ( ! $tokens ) {
			return array();
		}
		$alternation = implode( '|', array_map( array( Wp_Super_Cache::class, 'rewrite_token' ), $tokens ) );
		return array(
			'<IfModule mod_rewrite.c>',
			'RewriteEngine On',
			'RewriteCond %{HTTP_USER_AGENT} (' . $alternation . ') [NC]',
			'RewriteCond %{REQUEST_METHOD} ^(GET|HEAD)$',
			'RewriteCond %{REQUEST_URI} !^/wp-(admin|includes|content|json)(/|$)',
			'RewriteCond %{REQUEST_FILENAME} !-f',
			'RewriteRule ^ index.php [END]',
			'</IfModule>',
		);
	}

	/**
	 * The .htaccess path (site root).
	 *
	 * @return string Path.
	 */
	private static function path() {
		if ( ! function_exists( 'get_home_path' ) ) {
			require_once ABSPATH . 'wp-admin/includes/file.php';
		}
		return get_home_path() . '.htaccess';
	}

	/**
	 * Is this server one that reads .htaccess?
	 *
	 * @return bool True for Apache / LiteSpeed.
	 */
	public static function server_supported() {
		$software = isset( $_SERVER['SERVER_SOFTWARE'] ) ? strtolower( sanitize_text_field( wp_unslash( $_SERVER['SERVER_SOFTWARE'] ) ) ) : '';
		return false !== strpos( $software, 'apache' ) || false !== strpos( $software, 'litespeed' );
	}

	/**
	 * Write (or refresh) the block at the top of .htaccess.
	 *
	 * @param array $tokens Tokens.
	 * @return array Result.
	 */
	public static function write( array $tokens ) {
		$path = self::path();
		if ( ! self::server_supported() || ! is_writable( file_exists( $path ) ? $path : dirname( $path ) ) ) { // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_is_writable -- capability probe only.
			return array(
				'ok'        => false,
				'mechanism' => '.htaccess block',
				'note'      => self::server_supported() ? '.htaccess is not writable.' : 'This server does not read .htaccess (nginx); ask your host for an equivalent rule.',
			);
		}
		self::ensure_first( $path );
		if ( ! function_exists( 'insert_with_markers' ) ) {
			require_once ABSPATH . 'wp-admin/includes/misc.php';
		}
		$ok = insert_with_markers( $path, self::MARKER, self::lines( $tokens ) );
		return array(
			'ok'        => (bool) $ok,
			'mechanism' => '.htaccess block',
			'note'      => $ok ? '' : 'insert_with_markers failed.',
		);
	}

	/**
	 * Remove the block entirely.
	 *
	 * @return array Result.
	 */
	public static function clear() {
		$path = self::path();
		if ( ! file_exists( $path ) || false === strpos( (string) file_get_contents( $path ), '# BEGIN ' . self::MARKER ) ) { // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- local file.
			return array(
				'ok'        => true,
				'mechanism' => 'none',
				'note'      => 'disabled',
			);
		}
		$contents = (string) file_get_contents( $path ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- local file.
		$cleaned  = preg_replace( '/# BEGIN ' . preg_quote( self::MARKER, '/' ) . '.*?# END ' . preg_quote( self::MARKER, '/' ) . '\R*/s', '', $contents );
		self::put( $path, (string) $cleaned );
		return array(
			'ok'        => true,
			'mechanism' => 'none',
			'note'      => 'removed',
		);
	}

	/**
	 * Make sure our (possibly empty) marker pair is the first block, so insert_with_markers fills it in place.
	 *
	 * @param string $path .htaccess path.
	 * @return void
	 */
	private static function ensure_first( $path ) {
		$contents = file_exists( $path ) ? (string) file_get_contents( $path ) : ''; // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- local file.
		$ours     = strpos( $contents, '# BEGIN ' . self::MARKER );
		$first    = strpos( $contents, '# BEGIN ' );
		if ( false !== $ours && $ours === $first ) {
			return;
		}
		$without = preg_replace( '/# BEGIN ' . preg_quote( self::MARKER, '/' ) . '.*?# END ' . preg_quote( self::MARKER, '/' ) . '\R*/s', '', $contents );
		self::put( $path, '# BEGIN ' . self::MARKER . "\n# END " . self::MARKER . "\n\n" . ltrim( (string) $without ) );
	}

	/**
	 * Write a file atomically-ish with an exclusive lock.
	 *
	 * @param string $path     Path.
	 * @param string $contents Contents.
	 * @return void
	 */
	private static function put( $path, $contents ) {
		file_put_contents( $path, $contents, LOCK_EX ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- .htaccess, same as core's insert_with_markers.
	}
}
