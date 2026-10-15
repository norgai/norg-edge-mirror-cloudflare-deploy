<?php
/**
 * NORG-owned surfaces served to every caller before classification.
 *
 * MCP descriptors and JSON-RPC, discovery artifacts, per-page siblings, the
 * reserved /.norg/ assets and the OpenAI feed. Identical bytes for every
 * caller, so none is a cloaking surface. Each handler either sends a response
 * and ends the request, or returns so WordPress answers as it always would.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Handlers for NORG-owned paths.
 */
final class Surfaces {

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
	 * Build the handlers.
	 *
	 * @param Config      $config Configuration.
	 * @param Norg_Client $client NORG client.
	 */
	public function __construct( Config $config, Norg_Client $client ) {
		$this->config = $config;
		$this->client = $client;
	}

	/**
	 * MCP: GET/HEAD reads the manifest; POST relays JSON-RPC. A miss falls through to WordPress.
	 *
	 * @param Request $request Current request.
	 * @return void
	 */
	public function mcp( Request $request ) {
		if ( 'POST' === $request->method() ) {
			$this->mcp_post( $request );
			return;
		}
		$norg = $this->client->fetch_content( Paths::mcp_manifest_suffix( $request->pathname() ) );
		if ( null !== $norg && 200 === $norg['status'] ) {
			$norg['content_type'] = 'application/json';
			Responder::send(
				200,
				array_merge(
					array(
						'Content-Type' => 'application/json',
						'X-Norg-Edge'  => 'mcp',
					),
					Responder::no_store_headers()
				),
				$norg['body'],
				'HEAD' === $request->method()
			);
		}
	}

	/**
	 * Relay an MCP JSON-RPC POST with allowlisted headers only (never cookies or auth).
	 *
	 * @param Request $request Current request.
	 * @return void
	 */
	private function mcp_post( Request $request ) {
		$inbound = array();
		foreach ( Constants::MCP_FORWARD_HEADER_ALLOWLIST as $name ) {
			$value = $request->header( $name );
			if ( null !== $value ) {
				$inbound[ $name ] = $value;
			}
		}
		$response = $this->client->forward_mcp( $request->body(), $inbound, $request->pathname() );
		if ( null === $response ) {
			return;
		}
		$headers = array( 'Content-Type' => $response['headers']['content-type'] ?? 'application/json' );
		if ( isset( $response['headers']['mcp-session-id'] ) ) {
			$headers['Mcp-Session-Id'] = $response['headers']['mcp-session-id'];
		}
		Responder::send( $response['status'], array_merge( $headers, Responder::no_store_headers() ), $response['body'] );
	}

	/**
	 * Discovery files and sibling artifacts: the site's own file wins, else NORG's copy.
	 *
	 * @param Request $request Current request.
	 * @param bool    $formats Apply alternate-format headers (siblings only, never discovery).
	 * @return void
	 */
	public function origin_first( Request $request, $formats ) {
		if ( $this->origin_has( $request ) ) {
			return;
		}
		$norg = $this->client->fetch_content( Paths::key_suffix( $request->pathname() ) );
		if ( null !== $norg && 200 === $norg['status'] ) {
			Responder::mirror( $norg, $request, $this->config->edge_env(), $formats );
		}
	}

	/**
	 * Does WordPress itself serve a real (non-HTML 200) file at this path?
	 *
	 * A static file in the docroot never reaches PHP, so this only finds files a
	 * plugin generates (e.g. an SEO plugin's llms.txt). A loopback GET carrying
	 * the loop-guard header asks WordPress without this plugin; the verdict is
	 * cached for 10 minutes per path.
	 *
	 * @param Request $request Current request.
	 * @return bool True when the site answers the path itself.
	 */
	private function origin_has( Request $request ) {
		if ( ! $this->config->get( 'origin_probe' ) ) {
			return false;
		}
		$key    = 'norg_edge_origin_' . md5( $request->pathname() );
		$cached = get_transient( $key );
		if ( false !== $cached ) {
			return 'yes' === $cached;
		}
		$response = wp_remote_get(
			$request->url(),
			array(
				'headers'     => array( Constants::LOOP_GUARD_HEADER => '1' ),
				'timeout'     => Constants::LOOPBACK_TIMEOUT,
				'redirection' => 0,
				'sslverify'   => apply_filters( 'https_local_ssl_verify', false ), // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- core's loopback TLS filter.
			)
		);
		$type     = is_wp_error( $response ) ? '' : (string) wp_remote_retrieve_header( $response, 'content-type' );
		$has      = ! is_wp_error( $response ) && 200 === (int) wp_remote_retrieve_response_code( $response ) && false === stripos( $type, 'text/html' );
		set_transient( $key, $has ? 'yes' : 'no', 10 * MINUTE_IN_SECONDS );
		return $has;
	}

	/**
	 * Reserved /.norg/* assets (the mirror theme CSS), public and cacheable.
	 *
	 * @param Request $request Current request.
	 * @return void
	 */
	public function reserved_asset( Request $request ) {
		$norg = $this->client->fetch_content( Paths::key_suffix( $request->pathname() ) );
		if ( null !== $norg && 200 === $norg['status'] ) {
			$type = '' !== $norg['content_type'] ? $norg['content_type'] : 'text/css; charset=utf-8';
			Responder::shared_asset( $norg, $request, $this->config->edge_env(), 'reserved-asset', $type );
		}
	}

	/**
	 * Site-level OpenAI feed artifacts.
	 *
	 * @param Request $request Current request.
	 * @return void
	 */
	public function openai_feed( Request $request ) {
		$norg = $this->client->fetch_content( Paths::key_suffix( $request->pathname() ) );
		if ( null !== $norg && 200 === $norg['status'] ) {
			$type = Paths::ends_with( $request->pathname(), '.yaml' ) ? 'application/yaml' : 'application/json; charset=utf-8';
			Responder::shared_asset( $norg, $request, $this->config->edge_env(), 'openai-feed', $type );
		}
	}
}
