<?php
/**
 * Record-only mode: WordPress answers untouched; the visit is reported after the response.
 *
 * Nothing NORG-side runs before the response. After it: AI agents go to
 * /edge/events with served "capture", and people arriving from an AI answer go
 * to /edge/page-views when NORG has citation tracking on for the site.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Capture-mode reporting.
 */
final class Capture {

	/**
	 * Service container.
	 *
	 * @var Plugin
	 */
	private $plugin;

	/**
	 * Build capture.
	 *
	 * @param Plugin $plugin Service container.
	 */
	public function __construct( Plugin $plugin ) {
		$this->plugin = $plugin;
	}

	/**
	 * Report this request after the response has gone.
	 *
	 * @param Request $request Current request.
	 * @return void
	 */
	public function arm( Request $request ) {
		$this->plugin->deferred()->defer(
			function () use ( $request ) {
				$this->record( $request, (int) http_response_code() );
			}
		);
	}

	/**
	 * Report one visit. Never throws.
	 *
	 * @param Request $request Current request.
	 * @param int     $status  Status WordPress answered with.
	 * @return void
	 */
	public function record( Request $request, $status ) {
		$feed = $this->plugin->feed()->get();
		if ( empty( $feed['entitled'] ) || Paths::is_static_asset( $request->pathname() ) ) {
			return;
		}
		$telemetry = $this->plugin->telemetry();
		$telemetry->maybe_heartbeat();
		$ua             = (string) $request->header( 'user-agent' );
		$classification = Classifier::classify_agent( $ua, $feed['patterns'] );
		if ( ! empty( $classification['is_ai_bot'] ) ) {
			$telemetry->event( self::event_body( $request, $classification, $status, $feed ) );
			return;
		}
		if ( empty( $feed['citation_tracking_enabled'] ) ) {
			return;
		}
		$detection = Referral::detect( $request->header( 'referer' ), $request->query( 'utm_source' ), $request->host() );
		if ( null !== $detection ) {
			$telemetry->page_view( Page_View::payload( $request, $detection, time() ) );
		}
	}

	/**
	 * The /edge/events body for a captured agent visit.
	 *
	 * @param Request $request        Current request.
	 * @param array   $classification Classification.
	 * @param int     $status         Response status.
	 * @param array   $feed           Feed entry.
	 * @return array Body.
	 */
	public static function event_body( Request $request, array $classification, $status, array $feed ) {
		return array(
			'domain'          => $request->host(),
			'path'            => $request->pathname(),
			'user_agent'      => $request->header( 'user-agent' ),
			'is_ai_bot'       => true,
			'bot_name'        => $classification['bot_name'],
			'company'         => $classification['company'],
			'purpose'         => $classification['purpose'],
			'served'          => 'capture',
			'response_status' => $status,
			'verified_source' => true === Cidr::verdict_for( $request->client_ip(), $feed['cidr_ranges'], $classification ),
			'ip_country'      => $request->country(),
			'http_protocol'   => $request->protocol(),
		);
	}
}
