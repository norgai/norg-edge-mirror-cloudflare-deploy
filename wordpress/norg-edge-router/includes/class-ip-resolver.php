<?php
/**
 * Client IP under the admin's trusted-proxy setting.
 *
 * There is no platform verified-bot signal inside WordPress, so source
 * verification is CIDR-only and the client IP is everything. "none" is
 * REMOTE_ADDR. "cloudflare" trusts CF-Connecting-IP only when REMOTE_ADDR is a
 * Cloudflare edge address; "header" trusts one named header (for X-Forwarded-For,
 * the last hop). "auto" (the setting's default) picks one of those per request
 * from what the request shows. An unusable value yields null, which fails closed.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Resolves the visitor's IP and (behind Cloudflare) country.
 */
final class Ip_Resolver {

	/** Cloudflare edge ranges, https://www.cloudflare.com/ips/ (refreshed with releases). */
	const CLOUDFLARE_RANGES = array(
		'173.245.48.0/20',
		'103.21.244.0/22',
		'103.22.200.0/22',
		'103.31.4.0/22',
		'141.101.64.0/18',
		'108.162.192.0/18',
		'190.93.240.0/20',
		'188.114.96.0/20',
		'197.234.240.0/22',
		'198.41.128.0/17',
		'162.158.0.0/15',
		'104.16.0.0/13',
		'104.24.0.0/14',
		'172.64.0.0/13',
		'131.0.72.0/22',
		'2400:cb00::/32',
		'2606:4700::/32',
		'2803:f800::/32',
		'2405:b500::/32',
		'2405:8100::/32',
		'2a06:98c0::/29',
		'2c0f:f248::/32',
	);

	const MODES = array( 'auto', 'none', 'cloudflare', 'header' );

	/**
	 * Non-private ranges only a proxy in front of this server connects from.
	 *
	 * RFC 6598 shared space: Azure Container Apps reaches the app from it, and
	 * PHP's reserved-range filter does not reliably cover it.
	 */
	const PROXY_RANGES = array( '100.64.0.0/10' );

	/**
	 * Trusted-proxy mode.
	 *
	 * @var string
	 */
	private $mode;

	/**
	 * Header name for "header" mode.
	 *
	 * @var string
	 */
	private $header;

	/**
	 * Build a resolver.
	 *
	 * @param string $mode   auto | none | cloudflare | header.
	 * @param string $header Header for "header" mode, e.g. "X-Real-IP".
	 */
	public function __construct( $mode = 'none', $header = '' ) {
		$this->mode   = in_array( $mode, self::MODES, true ) ? $mode : 'none';
		$this->header = (string) $header;
	}

	/**
	 * The client IP, or null when it cannot be trusted.
	 *
	 * @param array $server $_SERVER-shaped array.
	 * @return string|null IP.
	 */
	public function client_ip( array $server ) {
		list( $mode, $header ) = $this->effective( $server );
		$remote                = isset( $server['REMOTE_ADDR'] ) ? trim( (string) $server['REMOTE_ADDR'] ) : '';
		if ( 'cloudflare' === $mode && self::is_cloudflare( $remote ) ) {
			return self::valid( isset( $server['HTTP_CF_CONNECTING_IP'] ) ? $server['HTTP_CF_CONNECTING_IP'] : '' );
		}
		if ( 'header' === $mode && '' !== $header ) {
			return self::valid( self::last_hop( self::server_header( $server, $header ) ) );
		}
		return self::valid( $remote );
	}

	/**
	 * The mode and header in force: as configured, or under "auto" what suggest() reads from the request.
	 *
	 * @param array $server $_SERVER-shaped array.
	 * @return array array( mode, header ).
	 */
	private function effective( array $server ) {
		if ( 'auto' !== $this->mode ) {
			return array( $this->mode, $this->header );
		}
		$mode = self::suggest( $server );
		if ( 'header' !== $mode ) {
			return array( $mode, '' );
		}
		return array( $mode, isset( $server['HTTP_X_FORWARDED_FOR'] ) ? 'X-Forwarded-For' : 'X-Real-IP' );
	}

	/**
	 * Visitor country from CF-IPCountry, only when the request truly came via Cloudflare.
	 *
	 * @param array $server $_SERVER-shaped array.
	 * @return string|null Two-letter code.
	 */
	public function country( array $server ) {
		list( $mode ) = $this->effective( $server );
		$remote       = isset( $server['REMOTE_ADDR'] ) ? (string) $server['REMOTE_ADDR'] : '';
		if ( 'cloudflare' !== $mode || ! self::is_cloudflare( $remote ) ) {
			return null;
		}
		$code = isset( $server['HTTP_CF_IPCOUNTRY'] ) ? strtoupper( (string) $server['HTTP_CF_IPCOUNTRY'] ) : '';
		return preg_match( '/^[A-Z]{2}$/', $code ) && 'XX' !== $code ? $code : null;
	}

	/**
	 * Is an address inside Cloudflare's edge ranges?
	 *
	 * @param string $ip Address.
	 * @return bool True for a Cloudflare edge address.
	 */
	public static function is_cloudflare( $ip ) {
		return self::in_ranges( $ip, self::CLOUDFLARE_RANGES );
	}

	/**
	 * Is REMOTE_ADDR a proxy's (private, reserved, or shared address space)?
	 *
	 * @param string $ip Address.
	 * @return bool True when only a proxy in front of this server could connect from it.
	 */
	private static function is_proxy_peer( $ip ) {
		if ( null === Cidr::parse_ip( $ip ) ) {
			return false;
		}
		return self::in_ranges( $ip, self::PROXY_RANGES ) || ! filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE );
	}

	/**
	 * Is an address inside any of the ranges?
	 *
	 * @param string $ip     Address.
	 * @param array  $ranges CIDR blocks.
	 * @return bool True when contained.
	 */
	private static function in_ranges( $ip, array $ranges ) {
		$addr = Cidr::parse_ip( $ip );
		if ( null === $addr ) {
			return false;
		}
		foreach ( $ranges as $range ) {
			if ( Cidr::contains( $addr, $range ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * The mode the current request's shape calls for ("auto" uses it; the status page shows it).
	 *
	 * @param array $server $_SERVER-shaped array.
	 * @return string Suggested mode.
	 */
	public static function suggest( array $server ) {
		$remote = isset( $server['REMOTE_ADDR'] ) ? (string) $server['REMOTE_ADDR'] : '';
		if ( isset( $server['HTTP_CF_CONNECTING_IP'] ) && self::is_cloudflare( $remote ) ) {
			return 'cloudflare';
		}
		if ( self::is_proxy_peer( $remote ) && ( isset( $server['HTTP_X_REAL_IP'] ) || isset( $server['HTTP_X_FORWARDED_FOR'] ) ) ) {
			return 'header';
		}
		return 'none';
	}

	/**
	 * Read a named header from $_SERVER.
	 *
	 * @param array  $server $_SERVER-shaped array.
	 * @param string $name   Header name.
	 * @return string Value or "".
	 */
	private static function server_header( array $server, $name ) {
		$key = 'HTTP_' . strtoupper( str_replace( '-', '_', $name ) );
		return isset( $server[ $key ] ) ? (string) $server[ $key ] : '';
	}

	/**
	 * The last entry of a comma-separated forwarding list (the hop our proxy added).
	 *
	 * @param string $value Header value.
	 * @return string Last hop.
	 */
	private static function last_hop( $value ) {
		$hops = array_map( 'trim', explode( ',', $value ) );
		return (string) end( $hops );
	}

	/**
	 * The address when it parses, else null.
	 *
	 * @param string $ip Candidate.
	 * @return string|null IP.
	 */
	private static function valid( $ip ) {
		$ip = trim( (string) $ip );
		return null === Cidr::parse_ip( $ip ) ? null : $ip;
	}
}
