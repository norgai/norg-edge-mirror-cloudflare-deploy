<?php
/**
 * Uninstall: remove every option, transient, cron event and cache-plugin entry this plugin created.
 *
 * @package NorgEdgeRouter
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

if ( ! defined( 'NORG_EDGE_ROUTER_VERSION' ) ) {
	define( 'NORG_EDGE_ROUTER_VERSION', '0' );
	define( 'NORG_EDGE_ROUTER_FILE', __DIR__ . '/norg-edge-router.php' );
	define( 'NORG_EDGE_ROUTER_DIR', __DIR__ );
}
require_once __DIR__ . '/includes/autoload.php';

Norg\Edge\Cron::unschedule();
Norg\Edge\Cache\Registry::remove_all();

foreach ( array( 'norg_edge_settings', 'norg_edge_feed_status', 'norg_edge_last_heartbeat', 'norg_edge_last_self_check', 'norg_edge_last_error', 'norg_edge_events_dropped', 'norg_edge_feed_lock', 'norg_edge_bypass' ) as $norg_edge_option ) {
	delete_option( $norg_edge_option );
}
delete_site_transient( 'norg_edge_update_manifest' );

global $wpdb;
$wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE '\\_transient\\_norg\\_edge\\_%' OR option_name LIKE '\\_transient\\_timeout\\_norg\\_edge\\_%'" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery -- one-time cleanup of this plugin's own transients.
