<?php
/**
 * Calls to NORG that never delay the visitor: heartbeats, render requests, events, page views.
 *
 * Everything here runs through Deferred. Mirror hits and misses are reported by
 * the receptionist via X-Norg-Visit instead, so the hot path makes no call here
 * beyond a render request on a definite miss.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Background reporting to NORG.
 */
final class Telemetry {

	const HEARTBEAT_FLOOR = 'norg_edge_heartbeat_floor';
	const LAST_HEARTBEAT  = 'norg_edge_last_heartbeat';
	const EVENTS_DROPPED  = 'norg_edge_events_dropped';

	/**
	 * Configuration.
	 *
	 * @var Config
	 */
	private $config;

	/**
	 * NORG client.
	 *
	 * @var Norg_Client
	 */
	private $client;

	/**
	 * Background queue.
	 *
	 * @var Deferred
	 */
	private $deferred;

	/**
	 * Build telemetry.
	 *
	 * @param Config      $config   Configuration.
	 * @param Norg_Client $client   NORG client.
	 * @param Deferred    $deferred Background queue.
	 */
	public function __construct( Config $config, Norg_Client $client, Deferred $deferred ) {
		$this->config   = $config;
		$this->client   = $client;
		$this->deferred = $deferred;
	}

	/**
	 * Heartbeat on traffic at most every 15 minutes across all PHP processes.
	 *
	 * The floor is stamped BEFORE posting, so concurrent requests do not all beat.
	 *
	 * @return void
	 */
	public function maybe_heartbeat() {
		if ( false !== get_transient( self::HEARTBEAT_FLOOR ) ) {
			return;
		}
		set_transient( self::HEARTBEAT_FLOOR, time(), Constants::HEARTBEAT_MIN_INTERVAL );
		$this->deferred->defer(
			function ( $blocking ) {
				$this->heartbeat( 'traffic', $blocking );
			}
		);
	}

	/**
	 * Send a heartbeat now.
	 *
	 * @param string $trigger  traffic | cron | admin.
	 * @param bool   $blocking Read the response.
	 * @return array|null Recorded result.
	 */
	public function heartbeat( $trigger, $blocking = true ) {
		$dropped  = (int) get_option( self::EVENTS_DROPPED, 0 );
		$body     = array(
			'script_version' => NORG_EDGE_ROUTER_VERSION,
			'trigger'        => 'admin' === $trigger ? 'cron' : $trigger,
			'env'            => $this->config->edge_env(),
			'platform'       => Constants::PLATFORM,
			'runtime'        => Runtime::describe(),
			'events_dropped' => $dropped,
		);
		$response = $this->client->post( '/api/v1/edge/heartbeat', $body, $blocking );
		if ( ! $blocking ) {
			return null;
		}
		$ok     = null !== $response && $response['status'] >= 200 && $response['status'] < 300;
		$data   = ( $ok && is_array( $response['body'] ) ) ? $response['body'] : array();
		$record = array(
			'at'               => time(),
			'trigger'          => $trigger,
			'http'             => null === $response ? null : $response['status'],
			'ok'               => $ok,
			'latest_version'   => $data['latest_version'] ?? null,
			'update_available' => ! empty( $data['update_available'] ),
		);
		update_option( self::LAST_HEARTBEAT, $record, false );
		if ( $ok && $dropped ) {
			update_option( self::EVENTS_DROPPED, max( 0, (int) get_option( self::EVENTS_DROPPED, 0 ) - $dropped ), false );
		}
		if ( $record['update_available'] ) {
			delete_site_transient( 'update_plugins' );
		}
		return $record;
	}

	/**
	 * Ask NORG to render a page, at most once per path per 10 minutes.
	 *
	 * The plugin posts the PAGE path itself rather than letting the receptionist
	 * file the request, because the receptionist only knows the R2 key suffix
	 * ("/about/index.html") and the backend would store that as a new route.
	 *
	 * @param string $pathname Request pathname.
	 * @param string $url      Absolute page URL.
	 * @return void
	 */
	public function request_render( $pathname, $url ) {
		$dedup = 'norg_edge_rr_' . md5( $pathname );
		if ( false !== get_transient( $dedup ) ) {
			return;
		}
		set_transient( $dedup, 1, Constants::RENDER_DEDUP_TTL );
		$this->deferred->defer(
			function ( $blocking ) use ( $pathname, $url ) {
				$this->client->post(
					'/api/v1/edge/render-requests',
					array(
						'path'   => $pathname,
						'url'    => $url,
						'reason' => 'bot_miss',
					),
					$blocking
				);
			}
		);
	}

	/**
	 * Report a visit event (capture mode); a refused or failed post counts as dropped.
	 *
	 * @param array $body Event body for /api/v1/edge/events.
	 * @return void
	 */
	public function event( array $body ) {
		$this->deferred->defer(
			function ( $blocking ) use ( $body ) {
				$this->post_counted( '/api/v1/edge/events', $body, $blocking );
			}
		);
	}

	/**
	 * Report a citation page view.
	 *
	 * @param array $payload Page-view event.
	 * @return void
	 */
	public function page_view( array $payload ) {
		$this->deferred->defer(
			function ( $blocking ) use ( $payload ) {
				$this->post_counted( '/api/v1/edge/page-views', $payload, $blocking );
			}
		);
	}

	/**
	 * POST, counting anything NORG did not accept.
	 *
	 * @param string $path     API path.
	 * @param array  $body     Body.
	 * @param bool   $blocking Read the response.
	 * @return void
	 */
	private function post_counted( $path, array $body, $blocking ) {
		$response = $this->client->post( $path, $body, $blocking );
		if ( $blocking && ( null === $response || $response['status'] < 200 || $response['status'] >= 300 ) ) {
			update_option( self::EVENTS_DROPPED, (int) get_option( self::EVENTS_DROPPED, 0 ) + 1, false );
		}
	}
}
