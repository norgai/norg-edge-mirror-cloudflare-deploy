<?php
/**
 * REST endpoints NORG's dashboard uses to connect the plugin remotely.
 *
 * `norg-edge/v1/status` and `norg-edge/v1/connect`, both for administrators
 * only. NORG calls them with a WordPress Application Password the site owner
 * creates (Users › Profile › Application Passwords), so the customer never
 * pastes the Site ID and Site Key by hand. The site key is accepted here and
 * never returned by anything.
 *
 * @package Norg\Edge
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Registers and serves the REST routes.
 */
class Rest_Api {

	const NAMESPACE_V1 = 'norg-edge/v1';

	/**
	 * Service container.
	 *
	 * @var Plugin
	 */
	private $plugin;

	/**
	 * Build the API.
	 *
	 * @param Plugin $plugin Service container.
	 */
	public function __construct( Plugin $plugin ) {
		$this->plugin = $plugin;
	}

	/**
	 * Hook route registration.
	 *
	 * @return void
	 */
	public function register() {
		add_action( 'rest_api_init', array( $this, 'routes' ) );
	}

	/**
	 * Register both routes.
	 *
	 * @return void
	 */
	public function routes() {
		register_rest_route(
			self::NAMESPACE_V1,
			'/status',
			array(
				'methods'             => 'GET',
				'callback'            => array( $this, 'status' ),
				'permission_callback' => array( $this, 'permission' ),
			)
		);
		register_rest_route(
			self::NAMESPACE_V1,
			'/connect',
			array(
				'methods'             => 'POST',
				'callback'            => array( $this, 'connect' ),
				'permission_callback' => array( $this, 'permission' ),
				'args'                => array(
					'site_id'      => array(
						'type'     => 'string',
						'required' => true,
					),
					'site_key'     => array(
						'type'     => 'string',
						'required' => true,
					),
					'env'          => array( 'type' => 'string' ),
					'api_url'      => array( 'type' => 'string' ),
					'content_base' => array( 'type' => 'string' ),
				),
			)
		);
	}

	/**
	 * Administrators only; Application Passwords authenticate as that user.
	 *
	 * @return bool
	 */
	public function permission() {
		return current_user_can( 'manage_options' );
	}

	/**
	 * Install status: never the site key.
	 *
	 * @return \WP_REST_Response
	 */
	public function status() {
		$config = $this->plugin->config();
		$status = Health::status( $this->plugin );
		return rest_ensure_response(
			array_merge(
				$status,
				array(
					'configured' => $config->is_configured(),
					'locked'     => $config->is_locked( 'site_id' ) || $config->is_locked( 'site_key' ),
					'last_check' => get_option( Self_Check::OPTION, null ),
				)
			)
		);
	}

	/**
	 * Save the Site ID and Site Key, then prove the install.
	 *
	 * @param \WP_REST_Request $request Request.
	 * @return \WP_REST_Response|\WP_Error
	 */
	public function connect( \WP_REST_Request $request ) {
		$config = $this->plugin->config();
		if ( $config->is_locked( 'site_id' ) || $config->is_locked( 'site_key' ) ) {
			return new \WP_Error(
				'norg_edge_locked',
				__( 'NORG_SITE_ID / NORG_SITE_KEY are defined in wp-config.php; update them there.', 'norg-edge-router' ),
				array( 'status' => 409 )
			);
		}
		$parsed = Connect::values(
			$request->get_param( 'site_id' ),
			$request->get_param( 'site_key' ),
			$request->get_param( 'env' ),
			$request->get_param( 'api_url' ),
			$request->get_param( 'content_base' )
		);
		if ( '' !== $parsed['error'] ) {
			return new \WP_Error( 'norg_edge_invalid', $parsed['error'], array( 'status' => 400 ) );
		}
		return rest_ensure_response( Connect::apply( $this->plugin, $parsed['values'] ) );
	}
}
