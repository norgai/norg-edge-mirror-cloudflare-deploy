<?php
/**
 * Family-aware CIDR matching for source-IP verification (port of workers/lib/cidr.mjs).
 *
 * Deliberately its own parser rather than inet_pton, so leading-zero octets,
 * embedded IPv4 tails and zone identifiers behave exactly as in the worker.
 * Addresses are compared as fixed-width binary strings, so no GMP is needed.
 *
 * Verdict contract: null = nothing to measure (fall back / fail closed);
 * true/false = authoritative.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * IPv4/IPv6 parsing and CIDR containment.
 */
final class Cidr {

	/**
	 * Parse an IPv4 or IPv6 address.
	 *
	 * @param string|null $ip Candidate address.
	 * @return array|null array( family, binary ), or null when invalid.
	 */
	public static function parse_ip( $ip ) {
		$text = trim( (string) $ip );
		if ( '' === $text ) {
			return null;
		}
		if ( false !== strpos( $text, ':' ) ) {
			$bin = self::parse_ipv6( $text );
			return null === $bin ? null : array( 6, $bin );
		}
		$bin = self::parse_ipv4( $text );
		return null === $bin ? null : array( 4, $bin );
	}

	/**
	 * Parse a dotted quad (1-3 digits per octet, each at most 255).
	 *
	 * @param string $ip Candidate address.
	 * @return string|null Four-byte binary, or null.
	 */
	private static function parse_ipv4( $ip ) {
		$parts = explode( '.', $ip );
		if ( 4 !== count( $parts ) ) {
			return null;
		}
		$bin = '';
		foreach ( $parts as $part ) {
			if ( ! preg_match( '/^\d{1,3}$/', $part ) || (int) $part > 255 ) {
				return null;
			}
			$bin .= chr( (int) $part );
		}
		return $bin;
	}

	/**
	 * Parse an IPv6 literal, including "::" and an embedded IPv4 tail; zone ids rejected.
	 *
	 * @param string $raw Candidate address.
	 * @return string|null Sixteen-byte binary, or null.
	 */
	private static function parse_ipv6( $raw ) {
		if ( false !== strpos( $raw, '%' ) ) {
			return null;
		}
		$ip = self::expand_embedded_ipv4( $raw );
		if ( null === $ip ) {
			return null;
		}
		$groups = self::ipv6_groups( $ip );
		if ( null === $groups ) {
			return null;
		}
		$bin = '';
		foreach ( $groups as $group ) {
			if ( ! preg_match( '/^[0-9a-f]{1,4}$/i', $group ) ) {
				return null;
			}
			$bin .= pack( 'n', hexdec( $group ) );
		}
		return $bin;
	}

	/**
	 * Expand "::" compression into exactly eight groups.
	 *
	 * @param string $ip IPv6 text with any IPv4 tail already rewritten.
	 * @return array|null Eight group strings, or null when malformed.
	 */
	private static function ipv6_groups( $ip ) {
		$halves = explode( '::', $ip );
		if ( count( $halves ) > 2 ) {
			return null;
		}
		$head    = '' === $halves[0] ? array() : explode( ':', $halves[0] );
		$tail    = ( 2 === count( $halves ) && '' !== $halves[1] ) ? explode( ':', $halves[1] ) : array();
		$missing = 8 - count( $head ) - count( $tail );
		if ( 2 === count( $halves ) ? $missing < 1 : 0 !== $missing ) {
			return null;
		}
		$fill = 2 === count( $halves ) ? array_fill( 0, $missing, '0' ) : array();
		return array_merge( $head, $fill, $tail );
	}

	/**
	 * Rewrite an embedded IPv4 tail ("::ffff:192.0.2.1") as two hex groups.
	 *
	 * @param string $ip Candidate address.
	 * @return string|null Rewritten address, or null when the tail is malformed.
	 */
	private static function expand_embedded_ipv4( $ip ) {
		$idx  = strrpos( $ip, ':' );
		$last = substr( $ip, $idx + 1 );
		if ( false === strpos( $last, '.' ) ) {
			return $ip;
		}
		$v4 = self::parse_ipv4( $last );
		if ( null === $v4 ) {
			return null;
		}
		$words = unpack( 'n2', $v4 );
		return substr( $ip, 0, $idx + 1 ) . dechex( $words[1] ) . ':' . dechex( $words[2] );
	}

	/**
	 * The address family of a CIDR block's network part.
	 *
	 * @param string $cidr Block in "network/len" form.
	 * @return int|null 4, 6, or null when unparseable.
	 */
	public static function ip_family( $cidr ) {
		$parsed = self::parse_ip( explode( '/', (string) $cidr )[0] );
		return null === $parsed ? null : $parsed[0];
	}

	/**
	 * Is an address inside a CIDR block? False on any mismatch or malformed input.
	 *
	 * @param string|array $ip   Address text, or a parse_ip result.
	 * @param string       $cidr Block in "network/len" form ("/len" optional).
	 * @return bool True when contained.
	 */
	public static function contains( $ip, $cidr ) {
		$addr = is_array( $ip ) ? $ip : self::parse_ip( $ip );
		$cut  = explode( '/', (string) $cidr );
		if ( null === $addr || count( $cut ) > 2 ) {
			return false;
		}
		$net = self::parse_ip( $cut[0] );
		if ( null === $net || $net[0] !== $addr[0] ) {
			return false;
		}
		$width = 4 === $addr[0] ? 32 : 128;
		$bits  = isset( $cut[1] ) ? ( preg_match( '/^\d{1,3}$/', $cut[1] ) ? (int) $cut[1] : -1 ) : $width;
		if ( $bits < 0 || $bits > $width ) {
			return false;
		}
		return self::masked( $addr[1], $bits ) === self::masked( $net[1], $bits );
	}

	/**
	 * Keep the first $bits bits of a binary address, zeroing the rest.
	 *
	 * @param string $bin  Binary address.
	 * @param int    $bits Prefix length.
	 * @return string Masked binary.
	 */
	private static function masked( $bin, $bits ) {
		$full = intdiv( $bits, 8 );
		$rest = $bits % 8;
		$out  = substr( $bin, 0, $full );
		if ( $rest ) {
			$out .= chr( ord( $bin[ $full ] ) & ( 0xFF << ( 8 - $rest ) ) & 0xFF );
		}
		return str_pad( $out, strlen( $bin ), "\0" );
	}

	/**
	 * Verify a client address against the operator's published set (cidrVerdictFor).
	 *
	 * @param string|null $client_ip      Client address.
	 * @param array       $cidr_ranges    Feed cidr_ranges keyed by operator (company).
	 * @param array       $classification Classification (uses company).
	 * @return bool|null Verdict, or null when no usable set applies.
	 */
	public static function verdict_for( $client_ip, array $cidr_ranges, array $classification ) {
		$company = isset( $classification['company'] ) ? (string) $classification['company'] : '';
		$entry   = isset( $cidr_ranges[ $company ] ) ? $cidr_ranges[ $company ] : null;
		$cidrs   = ( is_array( $entry ) && isset( $entry['cidrs'] ) && is_array( $entry['cidrs'] ) ) ? $entry['cidrs'] : array();
		$addr    = $cidrs ? self::parse_ip( $client_ip ) : null;
		if ( null === $addr ) {
			return null;
		}
		$same = array_filter(
			$cidrs,
			static function ( $cidr ) use ( $addr ) {
				return self::ip_family( $cidr ) === $addr[0];
			}
		);
		if ( ! $same ) {
			return null;
		}
		foreach ( $same as $cidr ) {
			if ( self::contains( $addr, $cidr ) ) {
				return true;
			}
		}
		return false;
	}
}
