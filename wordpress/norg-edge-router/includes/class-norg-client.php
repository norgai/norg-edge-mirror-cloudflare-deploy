<?php
/**
 * Every call to NORG, through the WordPress HTTP API only.
 *
 * Short explicit timeouts, no redirects, TLS verified. Any failure returns null
 * and the caller serves the origin (rule 1).
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * The plugin's client for NORG's back-channel and content receptionist.
 */
final class Norg_Client {

	/**
	 * Configuration.
	 *
	 * @var Config
	 */
	private $config;

	/**
	 * Build a client.
	 *
	 * @param Config $config Configuration.
	 */
	public function __construct( Config $config ) {
		$this->config = $config;
	}

	/**
	 * Headers authenticating this install.
	 *
	 * @return array Header map.
	 */
	public function control_headers() {
		return array(
			'Content-Type'        => 'application/json',
			'X-Norg-Site-Id'      => (string) $this->config->get( 'site_id' ),
			'X-Norg-Site-Key'     => $this->config->site_key(),
			'X-Norg-Edge-Version' => NORG_EDGE_ROUTER_VERSION,
		);
	}

	/**
	 * GET the authenticated bot-pattern feed.
	 *
	 * @param string $etag ETag of the entry already held, for a conditional request.
	 * @return array|null array( status, etag, body ) or null when unreachable.
	 */
	public function get_feed( $etag ) {
		$headers = $this->control_headers();
		if ( '' !== $etag ) {
			$headers['If-None-Match'] = $etag;
		}
		$response = $this->request( 'GET', $this->api( '/api/v1/edge/bot-patterns' ), $headers, null, Constants::PATTERN_FETCH_TIMEOUT );
		if ( null === $response ) {
			return null;
		}
		$body = json_decode( $response['body'], true );
		return array(
			'status' => $response['status'],
			'etag'   => $response['headers']['etag'] ?? '',
			'body'   => is_array( $body ) ? $body : null,
		);
	}

	/**
	 * GET one object from the content receptionist: {content_base}/{site_id}{key_suffix}.
	 *
	 * @param string $key_suffix   From Paths::key_suffix.
	 * @param string $visit_header Encoded X-Norg-Visit, or "".
	 * @return array|null array( status, content_type, body ) or null on a transport error.
	 */
	public function fetch_content( $key_suffix, $visit_header = '' ) {
		$headers = $this->control_headers();
		unset( $headers['Content-Type'] );
		$headers[ Constants::LOOP_GUARD_HEADER ] = '1';
		if ( '' !== $visit_header ) {
			$headers[ Visit_Header::NAME ] = $visit_header;
		}
		$url      = rtrim( (string) $this->config->get( 'content_base' ), '/' ) . '/' . rawurlencode( (string) $this->config->get( 'site_id' ) ) . $key_suffix;
		$response = $this->request( 'GET', $url, $headers, null, Constants::MIRROR_FETCH_TIMEOUT, Constants::MAX_MIRROR_BYTES );
		if ( null === $response ) {
			return null;
		}
		return array(
			'status'       => $response['status'],
			'content_type' => $response['headers']['content-type'] ?? '',
			'body'         => $response['body'],
		);
	}

	/**
	 * POST JSON to a control endpoint.
	 *
	 * @param string $path     API path beginning with "/".
	 * @param array  $body     JSON body.
	 * @param bool   $blocking False fires and forgets (no response is read).
	 * @return array|null array( status, body ) (status 0 when non-blocking) or null on failure.
	 */
	public function post( $path, array $body, $blocking = true ) {
		$response = $this->request( 'POST', $this->api( $path ), $this->control_headers(), (string) wp_json_encode( $body ), Constants::CONTROL_CALL_TIMEOUT, null, $blocking );
		if ( null === $response ) {
			return null;
		}
		return array(
			'status' => $response['status'],
			'body'   => json_decode( $response['body'], true ),
		);
	}

	/**
	 * Forward an MCP JSON-RPC POST to {api}/public-mcp/ (trailing slash load-bearing).
	 *
	 * @param string $body    Raw request body.
	 * @param array  $inbound Allowlisted inbound headers (lower-case name => value).
	 * @param string $page    Requested page path (X-Norg-Edge-Page).
	 * @return array|null 2xx response array( status, headers, body ) or null to fall through.
	 */
	public function forward_mcp( $body, array $inbound, $page ) {
		$headers  = array_merge(
			$inbound,
			array(
				'X-Norg-Site-Id'   => (string) $this->config->get( 'site_id' ),
				'X-Norg-Site-Key'  => $this->config->site_key(),
				'X-Norg-Edge-Page' => $page,
			)
		);
		$response = $this->request( 'POST', $this->api( '/public-mcp/' ), $headers, $body, Constants::MCP_FORWARD_TIMEOUT );
		return ( null !== $response && $response['status'] >= 200 && $response['status'] < 300 ) ? $response : null;
	}

	/**
	 * GET the plugin update manifest.
	 *
	 * @return array|null Manifest, or null.
	 */
	public function get_update_manifest() {
		$response = $this->request( 'GET', $this->api( '/api/v1/edge/wordpress/update-manifest' ), $this->control_headers(), null, Constants::PATTERN_FETCH_TIMEOUT );
		if ( null === $response || 200 !== $response['status'] ) {
			return null;
		}
		$body = json_decode( $response['body'], true );
		return is_array( $body ) ? $body : null;
	}

	/**
	 * Absolute API URL.
	 *
	 * @param string $path Path beginning with "/".
	 * @return string URL.
	 */
	private function api( $path ) {
		return rtrim( (string) $this->config->get( 'api_url' ), '/' ) . $path;
	}

	/**
	 * Perform one HTTP request through the WordPress HTTP API.
	 *
	 * @param string      $method   HTTP method.
	 * @param string      $url      URL.
	 * @param array       $headers  Headers.
	 * @param string|null $body     Body.
	 * @param int         $timeout  Seconds.
	 * @param int|null    $limit    Maximum response bytes.
	 * @param bool        $blocking Wait for the response.
	 * @return array|null array( status, headers (lower-case), body ) or null on failure.
	 */
	private function request( $method, $url, array $headers, $body, $timeout, $limit = null, $blocking = true ) {
		$args = array(
			'method'      => $method,
			'headers'     => $headers,
			'timeout'     => $timeout,
			'redirection' => 0,
			'sslverify'   => true,
			'blocking'    => (bool) $blocking,
			'user-agent'  => 'norg-edge-router-wp/' . NORG_EDGE_ROUTER_VERSION,
		);
		if ( null !== $body ) {
			$args['body'] = $body;
		}
		if ( null !== $limit ) {
			$args['limit_response_size'] = $limit;
		}
		$response = wp_remote_request( $url, $args );
		if ( is_wp_error( $response ) ) {
			Log::debug(
				'http_failed',
				array(
					'url'   => $url,
					'error' => $response->get_error_message(),
				)
			);
			return null;
		}
		return array(
			'status'  => (int) wp_remote_retrieve_response_code( $response ),
			'headers' => self::flatten_headers( wp_remote_retrieve_headers( $response ) ),
			'body'    => (string) wp_remote_retrieve_body( $response ),
		);
	}

	/**
	 * Normalise WordPress response headers to lower-case name => single string value.
	 *
	 * @param mixed $headers CaseInsensitiveDictionary or array.
	 * @return array Headers.
	 */
	private static function flatten_headers( $headers ) {
		$all = ( is_object( $headers ) && method_exists( $headers, 'getAll' ) ) ? $headers->getAll() : (array) $headers;
		$out = array();
		foreach ( $all as $name => $value ) {
			$out[ strtolower( (string) $name ) ] = is_array( $value ) ? (string) end( $value ) : (string) $value;
		}
		return $out;
	}
}
