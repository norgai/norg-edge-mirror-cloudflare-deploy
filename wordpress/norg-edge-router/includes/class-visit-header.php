<?php
/**
 * The X-Norg-Visit contract: describe the visit on the mirror fetch itself.
 *
 * PHP has no waitUntil, so the plugin hands the visit to NORG's content
 * receptionist in one request header (base64url JSON) on the fetch it awaits
 * anyway, and the receptionist records the event server-side. Fields and widths
 * match infrastructure/cloudflare/workers/lib/visit-header.mjs in content-craft.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Encodes visit descriptions for the receptionist.
 */
final class Visit_Header {

	const NAME      = 'X-Norg-Visit';
	const MAX_BYTES = 4096;

	/** Column widths in ai_crawler_visits. */
	const WIDTHS = array(
		'user_agent'    => 512,
		'bot_name'      => 100,
		'company'       => 100,
		'purpose'       => 50,
		'served'        => 64,
		'ip_country'    => 2,
		'ip_city'       => 255,
		'http_protocol' => 20,
		'tls_version'   => 20,
	);

	const SERVED_ON_MISS = array( 'stripped', 'origin', 'agentic_path_miss', 'agent_param_override_miss' );

	/**
	 * Build the visit array.
	 *
	 * @param array  $classification Classification.
	 * @param string $served         What a hit serves (mirror, agentic_path, ...).
	 * @param string $served_on_miss What a miss falls back to.
	 * @param string $user_agent     Raw user agent.
	 * @param array  $extra          Optional geo/protocol fields.
	 * @return array Visit.
	 */
	public static function build( array $classification, $served, $served_on_miss, $user_agent, array $extra = array() ) {
		$visit = array_merge(
			$extra,
			array(
				'user_agent'     => (string) $user_agent,
				'is_ai_bot'      => ! empty( $classification['is_ai_bot'] ),
				'bot_name'       => isset( $classification['bot_name'] ) ? (string) $classification['bot_name'] : '',
				'company'        => isset( $classification['company'] ) ? (string) $classification['company'] : '',
				'purpose'        => isset( $classification['purpose'] ) ? (string) $classification['purpose'] : '',
				'served'         => (string) $served,
				'served_on_miss' => in_array( $served_on_miss, self::SERVED_ON_MISS, true ) ? $served_on_miss : 'origin',
			)
		);
		foreach ( self::WIDTHS as $field => $width ) {
			if ( isset( $visit[ $field ] ) && is_string( $visit[ $field ] ) ) {
				$visit[ $field ] = self::clamp( $visit[ $field ], $width );
			}
		}
		return array_filter(
			$visit,
			static function ( $value ) {
				return '' !== $value && null !== $value;
			}
		);
	}

	/**
	 * Encode a visit as base64url JSON, shortening the user agent if it would not fit.
	 *
	 * @param array $visit Visit from build().
	 * @return string Header value (never longer than MAX_BYTES).
	 */
	public static function encode( array $visit ) {
		$encoded = self::base64url( (string) wp_json_encode( $visit ) );
		if ( strlen( $encoded ) > self::MAX_BYTES && isset( $visit['user_agent'] ) ) {
			$visit['user_agent'] = self::clamp( $visit['user_agent'], 128 );
			$encoded             = self::base64url( (string) wp_json_encode( $visit ) );
		}
		return strlen( $encoded ) > self::MAX_BYTES ? '' : $encoded;
	}

	/**
	 * Truncate to a width in characters without splitting a UTF-8 sequence.
	 *
	 * @param string $value Value.
	 * @param int    $width Maximum characters.
	 * @return string Clamped value.
	 */
	private static function clamp( $value, $width ) {
		if ( function_exists( 'mb_substr' ) && preg_match( '//u', $value ) ) {
			return mb_substr( $value, 0, $width, 'UTF-8' );
		}
		return substr( $value, 0, $width );
	}

	/**
	 * Base64url without padding.
	 *
	 * @param string $data Bytes.
	 * @return string Encoded.
	 */
	private static function base64url( $data ) {
		return rtrim( strtr( base64_encode( $data ), '+/', '-_' ), '=' ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- wire format, not obfuscation.
	}
}
