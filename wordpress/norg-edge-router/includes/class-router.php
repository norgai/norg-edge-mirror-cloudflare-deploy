<?php
/**
 * The request pipeline (handleRequest). Ordering only; every branch delegates.
 *
 * Runs at plugins_loaded, before redirect_canonical, template loading and any
 * 404 handling. The two rules hold on every path: any failure returns and
 * WordPress serves the page untouched, and search engines always get exactly
 * what people get.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Decides, per request, what NORG serves and what WordPress serves.
 */
final class Router {

	/**
	 * Service container.
	 *
	 * @var Plugin
	 */
	private $plugin;

	/**
	 * Build the router.
	 *
	 * @param Plugin $plugin Service container.
	 */
	public function __construct( Plugin $plugin ) {
		$this->plugin = $plugin;
	}

	/**
	 * Entry point. The catch is the whole safety story (rule 1).
	 *
	 * @return void
	 */
	public function dispatch() {
		try {
			$this->handle( $this->plugin->request() );
		} catch ( \Throwable $e ) {
			Log::error( $e );
		}
	}

	/**
	 * The pipeline.
	 *
	 * @param Request $request Current request.
	 * @return void
	 */
	private function handle( Request $request ) {
		$config = $this->plugin->config();
		if ( Health::is_probe( $request, $config ) ) {
			Health::respond( $request, $this->plugin );
			return;
		}
		Cache\Rewrite_Marker::apply( $request );
		if ( ! $config->is_configured() || $this->is_passthrough( $request ) ) {
			return;
		}
		if ( $config->get( 'capture_only' ) ) {
			$this->plugin->capture()->arm( $request );
			return;
		}
		$feed = $this->plugin->feed()->get();
		if ( empty( $feed['entitled'] ) ) {
			return;
		}
		if ( ! empty( $feed['capture_only'] ) ) {
			$this->plugin->capture()->arm( $request );
			return;
		}
		if ( $this->serve_norg_owned( $request, $feed ) ) {
			return;
		}
		$this->serve_classified( $request, $feed );
	}

	/**
	 * Requests that always belong to WordPress itself.
	 *
	 * @param Request $request Current request.
	 * @return bool True to leave the request alone.
	 */
	private function is_passthrough( Request $request ) {
		if ( $this->plugin->config()->get( 'disabled' ) || null !== $request->header( Constants::LOOP_GUARD_HEADER ) || null !== $request->header( 'upgrade' ) ) {
			return true;
		}
		if ( is_admin() || wp_doing_ajax() || wp_doing_cron() || ( defined( 'WP_CLI' ) && WP_CLI ) || ( defined( 'XMLRPC_REQUEST' ) && XMLRPC_REQUEST ) || defined( 'WP_INSTALLING' ) ) {
			return true;
		}
		$path = $request->pathname();
		$home = (string) wp_parse_url( home_url(), PHP_URL_PATH );
		if ( Paths::is_wordpress_internal( $path, $home ) || null !== $request->query( 'rest_route' ) ) {
			return true;
		}
		$method = $request->method();
		if ( 'GET' === $method ) {
			return false;
		}
		if ( 'HEAD' === $method && Paths::is_norg_owned_artifact( $path ) ) {
			return false;
		}
		return ! ( 'POST' === $method && Paths::is_mcp( $path ) );
	}

	/**
	 * Serve the surfaces addressed by URL rather than by caller.
	 *
	 * @param Request $request Current request.
	 * @param array   $feed    Feed entry.
	 * @return bool True when the request was decided here (served, or must go to WordPress).
	 */
	private function serve_norg_owned( Request $request, array $feed ) {
		$path     = $request->pathname();
		$surfaces = $this->plugin->surfaces();
		if ( Paths::is_mcp( $path ) ) {
			$surfaces->mcp( $request );
			return true;
		}
		if ( Paths::is_discovery( $path ) ) {
			$surfaces->origin_first( $request, false );
			return true;
		}
		if ( Paths::is_reserved_norg( $path ) ) {
			$surfaces->reserved_asset( $request );
			return true;
		}
		if ( Paths::is_openai_feed( $path ) ) {
			$surfaces->openai_feed( $request );
			return true;
		}
		if ( Paths::is_agentic( $path, (string) $feed['agentic_path_prefix'] ) ) {
			$this->plugin->telemetry()->maybe_heartbeat();
			$this->plugin->agent_server()->agentic( $request, (string) $feed['agentic_path_prefix'] );
			return true;
		}
		if ( Paths::is_sibling_artifact( $path ) ) {
			if ( ! Paths::is_skipped( $feed['skip_paths'], Paths::sibling_page_of( $path ) ) ) {
				$surfaces->origin_first( $request, true );
			}
			return true;
		}
		return Paths::is_static_asset( $path ) || Paths::is_skipped( $feed['skip_paths'], $path );
	}

	/**
	 * Serve by caller: search floor, override, classification, verification.
	 *
	 * @param Request $request Current request.
	 * @param array   $feed    Feed entry.
	 * @return void
	 */
	private function serve_classified( Request $request, array $feed ) {
		$ua = (string) $request->header( 'user-agent' );
		if ( Paths::is_traditional_search_bot( $ua ) ) {
			return;
		}
		$server = $this->plugin->agent_server();
		if ( 'true' === $request->query( 'agent' ) ) {
			$this->plugin->telemetry()->maybe_heartbeat();
			$server->mirror_or_origin( $request, Classifier::agent_override(), 'agent_param_override' );
			return;
		}
		$classification = Classifier::classify_agent( $ua, $feed['patterns'] );
		if ( empty( $classification['is_ai_bot'] ) ) {
			return;
		}
		if ( Classifier::may_divert_unverified( $classification ) ) {
			$this->plugin->telemetry()->maybe_heartbeat();
			$server->mirror_or_origin( $request, $classification, 'mirror_unverified' );
			return;
		}
		if ( ! Classifier::may_divert( $classification ) || ! $this->verified( $request, $feed, $classification ) ) {
			return;
		}
		$this->plugin->telemetry()->maybe_heartbeat();
		$server->serve_agent( $request, $classification );
	}

	/**
	 * Is the source IP genuinely the operator's? CIDR only; fails closed.
	 *
	 * The self-check may assert verification with the site key in the simulate
	 * header, so the full pipeline can be exercised from the server's own IP.
	 *
	 * @param Request $request        Current request.
	 * @param array   $feed           Feed entry.
	 * @param array   $classification Classification.
	 * @return bool True only when verified.
	 */
	private function verified( Request $request, array $feed, array $classification ) {
		$simulate = (string) $request->header( Constants::SIMULATE_HEADER );
		$key      = $this->plugin->config()->site_key();
		if ( '' !== $simulate && '' !== $key && hash_equals( $key, $simulate ) ) {
			return true;
		}
		return true === Cidr::verdict_for( $request->client_ip(), $feed['cidr_ranges'], $classification );
	}
}
