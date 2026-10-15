<?php
/**
 * Citation page-view payload (port of workers/lib/page-view.mjs).
 *
 * Exactly the CitationPageViewEvent key set: nullable fields are present as null,
 * because the backend schema forbids extra keys and requires every key.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Builds the page-view event a citation referral reports.
 */
final class Page_View {

	/**
	 * Daily-salted visitor fingerprint: sha256(ip:ua:lang:UTC date), first 16 bytes as hex.
	 *
	 * @param string $ip   Client IP.
	 * @param string $ua   User agent.
	 * @param string $lang Accept-Language.
	 * @param int    $now  Unix time.
	 * @return string 32 hex characters.
	 */
	public static function visitor_id( $ip, $ua, $lang, $now ) {
		$data = $ip . ':' . $ua . ':' . $lang . ':' . gmdate( 'Y-m-d', $now );
		return substr( hash( 'sha256', $data ), 0, 32 );
	}

	/**
	 * Device type from a user agent: tablet checks first.
	 *
	 * @param string|null $user_agent User agent.
	 * @return string mobile | tablet | desktop.
	 */
	public static function device_type( $user_agent ) {
		$ua = strtolower( (string) $user_agent );
		if ( '' === $ua ) {
			return 'desktop';
		}
		$android = false !== strpos( $ua, 'android' );
		$mobile  = false !== strpos( $ua, 'mobile' );
		if ( false !== strpos( $ua, 'ipad' ) || false !== strpos( $ua, 'tablet' ) || ( $android && ! $mobile ) ) {
			return 'tablet';
		}
		if ( $mobile || false !== strpos( $ua, 'iphone' ) || false !== strpos( $ua, 'ipod' ) || $android ) {
			return 'mobile';
		}
		return 'desktop';
	}

	/**
	 * Assemble the page-view event.
	 *
	 * @param Request $request   Current request.
	 * @param array   $detection From Referral::detect.
	 * @param int     $now       Unix time.
	 * @return array Event body for POST /api/v1/edge/page-views.
	 */
	public static function payload( Request $request, array $detection, $now ) {
		$ua = $request->header( 'user-agent' );
		return array_merge(
			array(
				'domain'       => $request->host(),
				'path'         => $request->pathname(),
				'visitor_id'   => self::visitor_id( (string) $request->client_ip(), (string) $ua, (string) $request->header( 'accept-language' ), $now ),
				'viewed_at'    => gmdate( 'Y-m-d\TH:i:s.000\Z', $now ),
				'referrer'     => $request->header( 'referer' ),
				'utm_source'   => $request->query( 'utm_source' ),
				'utm_medium'   => $request->query( 'utm_medium' ),
				'utm_campaign' => $request->query( 'utm_campaign' ),
				'country'      => $request->country(),
				'device_type'  => self::device_type( $ua ),
				'user_agent'   => $ua,
			),
			$detection,
			array(
				'served_surface' => 'customer_zone',
				'is_first_touch' => true,
			)
		);
	}
}
