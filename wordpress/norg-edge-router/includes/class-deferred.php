<?php
/**
 * Background work after the response, replacing Cloudflare's ctx.waitUntil.
 *
 * At shutdown (last priority) the response is flushed and, where the SAPI
 * allows, the connection is closed first (fastcgi_finish_request on PHP-FPM,
 * litespeed_finish_request on LiteSpeed), so tasks run with the visitor gone
 * and may block briefly. Elsewhere (mod_php, CGI) tasks run non-blocking: the
 * request is written and not awaited. Delivery is never guaranteed; NORG's
 * server-side dedup stays authoritative.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Queue of callables run after the response.
 */
final class Deferred {

	/**
	 * Queued tasks; each receives (bool $blocking).
	 *
	 * @var callable[]
	 */
	private $tasks = array();

	/**
	 * Whether the shutdown hook is registered.
	 *
	 * @var bool
	 */
	private $hooked = false;

	/**
	 * Queue a task.
	 *
	 * @param callable $task Receives bool $blocking.
	 * @return void
	 */
	public function defer( callable $task ) {
		$this->tasks[] = $task;
		if ( ! $this->hooked ) {
			$this->hooked = true;
			add_action( 'shutdown', array( $this, 'flush' ), PHP_INT_MAX );
		}
	}

	/**
	 * Run every queued task once the visitor has their response.
	 *
	 * @return void
	 */
	public function flush() {
		if ( ! $this->tasks ) {
			return;
		}
		ignore_user_abort( true );
		$blocking = $this->finish_response();
		// Tasks may queue more tasks (capture -> event post); drain until empty, bounded.
		for ( $round = 0; $this->tasks && $round < 5; $round++ ) {
			$tasks       = $this->tasks;
			$this->tasks = array();
			foreach ( $tasks as $task ) {
				try {
					call_user_func( $task, $blocking );
				} catch ( \Throwable $e ) {
					Log::error( $e );
				}
			}
		}
	}

	/**
	 * Flush output and close the connection when the SAPI can.
	 *
	 * @return bool True when tasks may block (the client is already gone).
	 */
	private function finish_response() {
		while ( ob_get_level() > 0 ) {
			ob_end_flush();
		}
		flush();
		if ( function_exists( 'fastcgi_finish_request' ) ) {
			fastcgi_finish_request();
			return true;
		}
		if ( function_exists( 'litespeed_finish_request' ) ) {
			litespeed_finish_request();
			return true;
		}
		return 'cli' === PHP_SAPI || 'cli-server' === PHP_SAPI;
	}

	/**
	 * How background work runs on this host (status page).
	 *
	 * @return string fastcgi | litespeed | nonblocking.
	 */
	public static function mode() {
		if ( function_exists( 'fastcgi_finish_request' ) ) {
			return 'fastcgi';
		}
		return function_exists( 'litespeed_finish_request' ) ? 'litespeed' : 'nonblocking';
	}
}
