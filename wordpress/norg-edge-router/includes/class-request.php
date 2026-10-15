<?php
/**
 * Immutable view of the current HTTP request.
 *
 * The pathname() method reproduces the WHATWG URL parser's path (what the worker reads as
 * url.pathname): percent-encodes the path percent-encode set, treats "\" as "/",
 * and resolves "." / ".." segments, but never decodes existing %XX escapes or
 * collapses "//". The shared vectors pin this against Node's URL.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Request accessors over a $_SERVER-shaped array.
 */
final class Request {

	/**
	 * Server variables.
	 *
	 * @var array
	 */
	private $server;

	/**
	 * Cached pathname.
	 *
	 * @var string|null
	 */
	private $pathname = null;

	/**
	 * Resolved client IP (null until computed; false when none).
	 *
	 * @var string|false|null
	 */
	private $client_ip = null;

	/**
	 * Trusted-proxy resolver.
	 *
	 * @var Ip_Resolver
	 */
	private $ip_resolver;

	/**
	 * Build a request.
	 *
	 * @param array       $server      $_SERVER-shaped array.
	 * @param Ip_Resolver $ip_resolver Client-IP resolver.
	 */
	public function __construct( array $server, Ip_Resolver $ip_resolver ) {
		$this->server      = $server;
		$this->ip_resolver = $ip_resolver;
	}

	/**
	 * Request for the current PHP process.
	 *
	 * @param Ip_Resolver $ip_resolver Client-IP resolver.
	 * @return self Request.
	 */
	public static function from_globals( Ip_Resolver $ip_resolver ) {
		return new self( $_SERVER, $ip_resolver ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- read-only view; every accessor validates what it returns.
	}

	/**
	 * Upper-cased HTTP method.
	 *
	 * @return string Method.
	 */
	public function method() {
		return strtoupper( isset( $this->server['REQUEST_METHOD'] ) ? (string) $this->server['REQUEST_METHOD'] : 'GET' );
	}

	/**
	 * A request header (case-insensitive), or null.
	 *
	 * @param string $name Header name.
	 * @return string|null Value.
	 */
	public function header( $name ) {
		$key = strtoupper( str_replace( '-', '_', $name ) );
		if ( in_array( $key, array( 'CONTENT_TYPE', 'CONTENT_LENGTH' ), true ) && isset( $this->server[ $key ] ) ) {
			return (string) $this->server[ $key ];
		}
		return isset( $this->server[ 'HTTP_' . $key ] ) ? (string) $this->server[ 'HTTP_' . $key ] : null;
	}

	/**
	 * Lower-cased host name without port (url.hostname).
	 *
	 * @return string Host.
	 */
	public function host() {
		$host = isset( $this->server['HTTP_HOST'] ) ? (string) $this->server['HTTP_HOST'] : ( isset( $this->server['SERVER_NAME'] ) ? (string) $this->server['SERVER_NAME'] : '' );
		$host = strtolower( trim( $host ) );
		if ( '' !== $host && '[' === $host[0] ) {
			$end = strpos( $host, ']' );
			return false === $end ? $host : substr( $host, 0, $end + 1 );
		}
		return preg_replace( '/:\d*$/', '', $host );
	}

	/**
	 * Absolute URL of this request's path, keeping the Host header's port.
	 *
	 * Built from the request itself rather than home_url(): on a subdirectory
	 * install the pathname already contains the subdirectory.
	 *
	 * @return string URL without query string.
	 */
	public function url() {
		$host = isset( $this->server['HTTP_HOST'] ) ? strtolower( trim( (string) $this->server['HTTP_HOST'] ) ) : $this->host();
		$host = preg_replace( '/[^a-z0-9.:\[\]-]/', '', $host );
		return $this->scheme() . '://' . $host . $this->pathname();
	}

	/**
	 * "https" or "http".
	 *
	 * @return string Scheme.
	 */
	public function scheme() {
		$https = isset( $this->server['HTTPS'] ) ? strtolower( (string) $this->server['HTTPS'] ) : '';
		if ( ( '' !== $https && 'off' !== $https ) || ( isset( $this->server['SERVER_PORT'] ) && '443' === (string) $this->server['SERVER_PORT'] ) ) {
			return 'https';
		}
		return 'http';
	}

	/**
	 * Raw query string.
	 *
	 * @return string Query string without "?".
	 */
	public function query_string() {
		if ( isset( $this->server['QUERY_STRING'] ) ) {
			return (string) $this->server['QUERY_STRING'];
		}
		$uri = $this->raw_uri();
		$q   = strpos( $uri, '?' );
		return false === $q ? '' : (string) substr( $uri, $q + 1 );
	}

	/**
	 * First value of a query parameter (URLSearchParams.get), or null.
	 *
	 * @param string $name Parameter name.
	 * @return string|null Value.
	 */
	public function query( $name ) {
		foreach ( explode( '&', $this->query_string() ) as $pair ) {
			if ( '' === $pair ) {
				continue;
			}
			$kv = explode( '=', $pair, 2 );
			if ( urldecode( $kv[0] ) === $name ) {
				return isset( $kv[1] ) ? urldecode( $kv[1] ) : '';
			}
		}
		return null;
	}

	/**
	 * The WHATWG-normalised pathname.
	 *
	 * @return string Pathname beginning with "/".
	 */
	public function pathname() {
		if ( null === $this->pathname ) {
			$this->pathname = self::normalise_pathname( $this->raw_uri() );
		}
		return $this->pathname;
	}

	/**
	 * Raw REQUEST_URI.
	 *
	 * @return string URI.
	 */
	private function raw_uri() {
		return isset( $this->server['REQUEST_URI'] ) ? (string) $this->server['REQUEST_URI'] : '/';
	}

	/**
	 * Normalise a request-target to a WHATWG pathname.
	 *
	 * @param string $uri Request target (origin-form or absolute-form).
	 * @return string Pathname.
	 */
	public static function normalise_pathname( $uri ) {
		if ( preg_match( '#^[a-z][a-z0-9+.-]*://[^/]*(.*)$#i', $uri, $m ) ) {
			$uri = $m[1];
		}
		$cut  = strcspn( $uri, '?#' );
		$path = str_replace( '\\', '/', substr( $uri, 0, $cut ) );
		if ( '' === $path || '/' !== $path[0] ) {
			$path = '/' . $path;
		}
		$encoded = preg_replace_callback(
			'/[\x00-\x20"<>`{}\x7F-\xFF]/',
			static function ( $c ) {
				return '%' . strtoupper( bin2hex( $c[0] ) );
			},
			$path
		);
		return self::remove_dot_segments( $encoded );
	}

	/**
	 * Resolve "." and ".." segments (including %2e forms) as the URL parser does.
	 *
	 * @param string $path Encoded path beginning with "/".
	 * @return string Path.
	 */
	private static function remove_dot_segments( $path ) {
		$segments = explode( '/', substr( $path, 1 ) );
		$out      = array();
		$last     = count( $segments ) - 1;
		foreach ( $segments as $i => $segment ) {
			$lower = strtolower( $segment );
			if ( in_array( $lower, array( '..', '.%2e', '%2e.', '%2e%2e' ), true ) ) {
				array_pop( $out );
				if ( $i === $last ) {
					$out[] = '';
				}
			} elseif ( in_array( $lower, array( '.', '%2e' ), true ) ) {
				if ( $i === $last ) {
					$out[] = '';
				}
			} else {
				$out[] = $segment;
			}
		}
		return '/' . implode( '/', $out );
	}

	/**
	 * Client IP as resolved under the trusted-proxy setting, or null.
	 *
	 * @return string|null IP.
	 */
	public function client_ip() {
		if ( null === $this->client_ip ) {
			$ip              = $this->ip_resolver->client_ip( $this->server );
			$this->client_ip = null === $ip ? false : $ip;
		}
		return false === $this->client_ip ? null : $this->client_ip;
	}

	/**
	 * Visitor country when a trusted proxy supplies one, else null.
	 *
	 * @return string|null ISO country code.
	 */
	public function country() {
		return $this->ip_resolver->country( $this->server );
	}

	/**
	 * HTTP protocol, e.g. "HTTP/2.0".
	 *
	 * @return string|null Protocol.
	 */
	public function protocol() {
		return isset( $this->server['SERVER_PROTOCOL'] ) ? (string) $this->server['SERVER_PROTOCOL'] : null;
	}

	/**
	 * The raw request body (MCP POST only).
	 *
	 * @return string Body.
	 */
	public function body() {
		$body = file_get_contents( 'php://input' ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- php://input is not a remote URL.
		return false === $body ? '' : $body;
	}
}
