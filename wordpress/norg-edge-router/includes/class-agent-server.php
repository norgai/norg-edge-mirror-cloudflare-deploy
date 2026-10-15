<?php
/**
 * Serving a classified agent: the NORG render, or the stripped page on a definite miss.
 *
 * The visit travels on the receptionist fetch as X-Norg-Visit, so the
 * receptionist records hit and miss alike with no call from here.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Agent-serving paths (serveAgent, serveMirrorOrOrigin, serveAgenticPath).
 */
final class Agent_Server {

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
	 * Telemetry.
	 *
	 * @var Telemetry
	 */
	private $telemetry;

	/**
	 * Build the server.
	 *
	 * @param Config      $config    Configuration.
	 * @param Norg_Client $client    NORG client.
	 * @param Telemetry   $telemetry Telemetry.
	 */
	public function __construct( Config $config, Norg_Client $client, Telemetry $telemetry ) {
		$this->config    = $config;
		$this->client    = $client;
		$this->telemetry = $telemetry;
	}

	/**
	 * A verified, divertable agent: mirror on a hit; strip + render request on a definite 404.
	 *
	 * @param Request $request        Current request.
	 * @param array   $classification Classification.
	 * @return void
	 */
	public function serve_agent( Request $request, array $classification ) {
		$strip = (bool) $this->config->get( 'strip_fallback' );
		$norg  = $this->fetch( $request, $request->pathname(), $classification, 'mirror', $strip ? 'stripped' : 'origin' );
		if ( null !== $norg && 200 === $norg['status'] ) {
			Responder::mirror( $norg, $request, $this->config->edge_env() );
			return;
		}
		if ( null === $norg || 404 !== $norg['status'] ) {
			return;
		}
		if ( $this->config->get( 'lazy_render' ) ) {
			$this->telemetry->request_render( $request->pathname(), $request->url() );
		}
		if ( $strip ) {
			Strip_Buffer::arm( $this->config->edge_env() );
		}
	}

	/**
	 * The render if one exists, else the untouched page; never a render request.
	 *
	 * Shared by ?agent=true and divert_unverified.
	 *
	 * @param Request $request        Current request.
	 * @param array   $classification Classification logged with the visit.
	 * @param string  $label          served value for a hit.
	 * @return void
	 */
	public function mirror_or_origin( Request $request, array $classification, $label ) {
		$norg = $this->fetch( $request, $request->pathname(), $classification, $label, $label . '_miss' );
		if ( null !== $norg && 200 === $norg['status'] ) {
			Responder::mirror( $norg, $request, $this->config->edge_env() );
		}
	}

	/**
	 * The agentic subtree: same bytes for every caller, prefix stripped for the lookup.
	 *
	 * @param Request $request Current request.
	 * @param string  $prefix  Agentic prefix, e.g. "/ai".
	 * @return void
	 */
	public function agentic( Request $request, $prefix ) {
		$inner = substr( $request->pathname(), strlen( $prefix ) );
		$norg  = $this->fetch( $request, '' === $inner || false === $inner ? '/' : $inner, Classifier::none(), 'agentic_path', 'agentic_path_miss' );
		if ( null !== $norg && 200 === $norg['status'] ) {
			Responder::mirror( $norg, $request, $this->config->edge_env() );
		}
	}

	/**
	 * Fetch from the receptionist, describing the visit in X-Norg-Visit.
	 *
	 * @param Request $request        Current request.
	 * @param string  $path           Page path to look up.
	 * @param array   $classification Classification.
	 * @param string  $served         Hit label.
	 * @param string  $on_miss        Miss label.
	 * @return array|null Receptionist response.
	 */
	private function fetch( Request $request, $path, array $classification, $served, $on_miss ) {
		$extra = array_filter(
			array(
				'ip_country'    => $request->country(),
				'http_protocol' => $request->protocol(),
			)
		);
		$visit = Visit_Header::build( $classification, $served, $on_miss, (string) $request->header( 'user-agent' ), $extra );
		return $this->client->fetch_content( Paths::key_suffix( $path ), Visit_Header::encode( $visit ) );
	}
}
