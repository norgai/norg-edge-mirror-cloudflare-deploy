<?php
/**
 * Activation and deactivation. Everything the plugin changes elsewhere is undone on deactivation.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Activation / deactivation hooks.
 */
final class Lifecycle {

	/**
	 * Schedule cron and apply the cache bypass.
	 *
	 * @return void
	 */
	public static function activate() {
		Cron::schedule();
		wp_schedule_single_event( time(), Cron::APPLY_BYPASS );
	}

	/**
	 * Remove cron events, the cache-plugin entries and the .htaccess block.
	 *
	 * @return void
	 */
	public static function deactivate() {
		Cron::unschedule();
		Cache\Registry::remove_all();
		delete_option( Feed::LOCK );
	}
}
