<?php
/**
 * Router for PHP's built-in server so it behaves like Apache/nginx in front of WordPress:
 * real files are served directly; everything else goes to index.php.
 *
 * @package NorgEdgeRouter
 */

$root = $_SERVER['DOCUMENT_ROOT'];
$path = parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH );
$file = realpath( $root . $path );
if ( false !== $file && is_dir( $file ) && is_file( $file . '/index.php' ) ) {
	$file = $file . '/index.php';
	$path = rtrim( $path, '/' ) . '/index.php';
}
if ( false !== $file && 0 === strpos( $file, realpath( $root ) ) && is_file( $file ) ) {
	if ( '.php' === substr( $file, -4 ) ) {
		$_SERVER['SCRIPT_NAME']     = $path;
		$_SERVER['SCRIPT_FILENAME'] = $file;
		$_SERVER['PHP_SELF']        = $path;
		chdir( dirname( $file ) );
		require $file;
		return true;
	}
	return false;
}
$_SERVER['SCRIPT_NAME'] = '/index.php';
require $root . '/index.php';
