<?php
/**
 * Scheduled work: the 30-minute liveness heartbeat, the cache-bypass apply, and the self-check.
 *
 * WP-Cron runs on traffic, so a site with DISABLE_WP_CRON and no system cron
 * goes heartbeat-silent when idle; the status page flags that.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Cron hooks.
 */
final class Cron {

	const HEARTBEAT    = 'norg_edge_heartbeat';
	const APPLY_BYPASS = 'norg_edge_apply_cache_bypass';
	const DAILY        = 'norg_edge_daily';
	const SELF_CHECK   = 'norg_edge_self_check';
	const SCHEDULE     = 'norg_edge_thirty_minutes';

	/**
	 * Register schedules and handlers.
	 *
	 * @param Plugin $plugin Service container.
	 * @return void
	 */
	public static function register( Plugin $plugin ) {
		add_filter( 'cron_schedules', array( __CLASS__, 'schedules' ) ); // phpcs:ignore WordPress.WP.CronInterval.CronSchedulesInterval -- 30 minutes, matching the worker's liveness cron.
		add_action(
			self::HEARTBEAT,
			static function () use ( $plugin ) {
				if ( $plugin->config()->is_configured() ) {
					$plugin->telemetry()->heartbeat( 'cron' );
				}
			}
		);
		add_action(
			self::APPLY_BYPASS,
			static function () use ( $plugin ) {
				Cache\Registry::apply( $plugin );
				wp_schedule_single_event( time() + 5 * MINUTE_IN_SECONDS, self::SELF_CHECK );
			}
		);
		add_action(
			self::SELF_CHECK,
			static function () use ( $plugin ) {
				$plugin->self_check()->run();
			}
		);
		add_action(
			self::DAILY,
			static function () {
				wp_schedule_single_event( time(), self::APPLY_BYPASS );
			}
		);
	}

	/**
	 * Add the 30-minute schedule.
	 *
	 * @param array $schedules Schedules.
	 * @return array Schedules.
	 */
	public static function schedules( $schedules ) {
		$schedules[ self::SCHEDULE ] = array(
			'interval' => 30 * MINUTE_IN_SECONDS,
			'display'  => __( 'Every 30 minutes (NORG Edge Router)', 'norg-edge-router' ),
		);
		return $schedules;
	}

	/**
	 * Schedule recurring events (idempotent).
	 *
	 * @return void
	 */
	public static function schedule() {
		add_filter( 'cron_schedules', array( __CLASS__, 'schedules' ) ); // phpcs:ignore WordPress.WP.CronInterval.CronSchedulesInterval -- see register().
		if ( ! wp_next_scheduled( self::HEARTBEAT ) ) {
			wp_schedule_event( time() + MINUTE_IN_SECONDS, self::SCHEDULE, self::HEARTBEAT );
		}
		if ( ! wp_next_scheduled( self::DAILY ) ) {
			wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', self::DAILY );
		}
	}

	/**
	 * Remove every event.
	 *
	 * @return void
	 */
	public static function unschedule() {
		foreach ( array( self::HEARTBEAT, self::APPLY_BYPASS, self::DAILY, self::SELF_CHECK ) as $hook ) {
			wp_clear_scheduled_hook( $hook );
		}
	}
}
