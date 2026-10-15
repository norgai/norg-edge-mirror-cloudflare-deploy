<?php
/**
 * Classmap-free autoloader for the Norg\Edge namespace (no Composer at runtime).
 *
 * @package NorgEdgeRouter
 */

defined( 'ABSPATH' ) || exit;

spl_autoload_register(
	/**
	 * Map Norg\Edge\Sub\Class_Name to includes/sub/class-class-name.php.
	 *
	 * @param string $class_name Fully-qualified class name.
	 */
	static function ( $class_name ) {
		$prefix = 'Norg\\Edge\\';
		if ( 0 !== strpos( $class_name, $prefix ) ) {
			return;
		}
		$parts = explode( '\\', substr( $class_name, strlen( $prefix ) ) );
		$leaf  = array_pop( $parts );
		$dir   = $parts ? strtolower( implode( '/', $parts ) ) . '/' : '';
		$file  = __DIR__ . '/' . $dir . 'class-' . strtolower( str_replace( '_', '-', $leaf ) ) . '.php';
		if ( is_readable( $file ) ) {
			require_once $file;
		}
	}
);
