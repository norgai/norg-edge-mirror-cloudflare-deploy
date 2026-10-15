<?php
/**
 * Service container and hook registration. Nothing here makes a decision.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Wires the plugin into WordPress.
 */
final class Plugin {

	/**
	 * Singleton instance.
	 *
	 * @var Plugin|null
	 */
	private static $instance = null;

	/**
	 * Lazily built services.
	 *
	 * @var array
	 */
	private $services = array();

	/**
	 * The container.
	 *
	 * @return self Instance.
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Register every hook. Called once from the main plugin file.
	 *
	 * @return void
	 */
	public static function boot() {
		$plugin       = self::instance();
		Log::$enabled = (bool) $plugin->config()->get( 'debug' );
		add_action( 'plugins_loaded', array( $plugin->router(), 'dispatch' ), -1000 );
		Cron::register( $plugin );
		Cache\Registry::register_runtime( $plugin );
		if ( class_exists( Updater::class ) ) {
			( new Updater( $plugin ) )->register();
		}
		if ( is_admin() ) {
			( new Admin\Settings_Page( $plugin ) )->register();
			( new Admin\Actions( $plugin ) )->register();
			( new Admin\Notices( $plugin ) )->register();
		}
		Site_Health::register( $plugin );
		( new Rest_Api( $plugin ) )->register();
		if ( defined( 'WP_CLI' ) && WP_CLI ) {
			\WP_CLI::add_command( 'norg-edge', new Cli( $plugin ) );
		}
	}

	/**
	 * Build or return a service.
	 *
	 * @param string   $name    Service name.
	 * @param callable $factory Factory.
	 * @return mixed Service.
	 */
	private function service( $name, callable $factory ) {
		if ( ! isset( $this->services[ $name ] ) ) {
			$this->services[ $name ] = $factory();
		}
		return $this->services[ $name ];
	}

	/**
	 * Configuration.
	 *
	 * @return Config
	 */
	public function config() {
		return $this->service(
			'config',
			static function () {
				return new Config();
			}
		);
	}

	/**
	 * Reload configuration after a save.
	 *
	 * @return void
	 */
	public function reset() {
		$this->services = array();
	}

	/**
	 * The current request.
	 *
	 * @return Request
	 */
	public function request() {
		return $this->service(
			'request',
			function () {
				$config = $this->config();
				return Request::from_globals( new Ip_Resolver( (string) $config->get( 'trusted_proxy' ), (string) $config->get( 'trusted_header' ) ) );
			}
		);
	}

	/**
	 * Background queue.
	 *
	 * @return Deferred
	 */
	public function deferred() {
		return $this->service(
			'deferred',
			static function () {
				return new Deferred();
			}
		);
	}

	/**
	 * NORG client.
	 *
	 * @return Norg_Client
	 */
	public function client() {
		return $this->service(
			'client',
			function () {
				return new Norg_Client( $this->config() );
			}
		);
	}

	/**
	 * Feed.
	 *
	 * @return Feed
	 */
	public function feed() {
		return $this->service(
			'feed',
			function () {
				return new Feed( $this->config(), $this->client(), $this->deferred() );
			}
		);
	}

	/**
	 * Telemetry.
	 *
	 * @return Telemetry
	 */
	public function telemetry() {
		return $this->service(
			'telemetry',
			function () {
				return new Telemetry( $this->config(), $this->client(), $this->deferred() );
			}
		);
	}

	/**
	 * NORG-owned surfaces.
	 *
	 * @return Surfaces
	 */
	public function surfaces() {
		return $this->service(
			'surfaces',
			function () {
				return new Surfaces( $this->config(), $this->client() );
			}
		);
	}

	/**
	 * Agent server.
	 *
	 * @return Agent_Server
	 */
	public function agent_server() {
		return $this->service(
			'agent_server',
			function () {
				return new Agent_Server( $this->config(), $this->client(), $this->telemetry() );
			}
		);
	}

	/**
	 * Capture mode.
	 *
	 * @return Capture
	 */
	public function capture() {
		return $this->service(
			'capture',
			function () {
				return new Capture( $this );
			}
		);
	}

	/**
	 * Router.
	 *
	 * @return Router
	 */
	public function router() {
		return $this->service(
			'router',
			function () {
				return new Router( $this );
			}
		);
	}

	/**
	 * Self-check.
	 *
	 * @return Self_Check
	 */
	public function self_check() {
		return $this->service(
			'self_check',
			function () {
				return new Self_Check( $this );
			}
		);
	}
}
