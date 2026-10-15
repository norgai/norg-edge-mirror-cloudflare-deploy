<?php
/**
 * Strip the WordPress-rendered page for an agent when NORG has no render yet.
 *
 * Armed at plugins_loaded so this buffer is OUTERMOST: optimisers and cache
 * buffers started later flush into it. The callback accumulates every chunk and
 * acts only on the final one, then mirrors the worker's canStrip rules: only a
 * 200 text/html page that is not a 404 is stripped, and a strip leaving fewer
 * than 120 words returns the untouched page (origin_thin).
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Output buffer that strips the page on final flush.
 */
final class Strip_Buffer {

	/**
	 * Accumulated output.
	 *
	 * @var string
	 */
	private $buffer = '';

	/**
	 * X-Norg-Edge-Env value.
	 *
	 * @var string
	 */
	private $env;

	/**
	 * Arm the buffer for this request.
	 *
	 * @param string $env X-Norg-Edge-Env value.
	 * @return void
	 */
	public static function arm( $env ) {
		Responder::forbid_page_caching();
		add_filter( 'autoptimize_filter_noptimize', '__return_true' );
		if ( ! headers_sent() ) {
			foreach ( Responder::no_store_headers() as $name => $value ) {
				header( $name . ': ' . $value );
			}
		}
		$instance      = new self();
		$instance->env = $env;
		ob_start( array( $instance, 'handle' ) );
	}

	/**
	 * Output callback.
	 *
	 * @param string $chunk Output chunk.
	 * @param int    $phase PHP_OUTPUT_HANDLER_* bitmask.
	 * @return string Output to pass on.
	 */
	public function handle( $chunk, $phase ) {
		$this->buffer .= $chunk;
		if ( ! ( $phase & PHP_OUTPUT_HANDLER_FINAL ) ) {
			return '';
		}
		try {
			return $this->finish( $this->buffer );
		} catch ( \Throwable $e ) {
			return $this->buffer;
		}
	}

	/**
	 * Decide and produce the final body.
	 *
	 * @param string $html Whole page.
	 * @return string Stripped or untouched page.
	 */
	private function finish( $html ) {
		if ( 200 !== http_response_code() || ! self::is_html_response() || ( function_exists( 'is_404' ) && is_404() ) ) {
			return $html;
		}
		$stripped = Strip::html( $html );
		if ( Strip::count_words( $stripped ) < Constants::STRIP_WORD_FLOOR ) {
			return $html;
		}
		if ( ! headers_sent() ) {
			header( 'X-Norg-Edge: stripped' );
			header( 'X-Norg-Edge-Env: ' . $this->env );
			header_remove( 'Content-Length' );
		}
		return $stripped;
	}

	/**
	 * Is the response text/html (PHP's default when nothing set a type)?
	 *
	 * @return bool True for HTML.
	 */
	private static function is_html_response() {
		foreach ( headers_list() as $header ) {
			if ( 0 === stripos( $header, 'content-type:' ) ) {
				return false !== stripos( $header, 'text/html' );
			}
		}
		$default = (string) ini_get( 'default_mimetype' );
		return '' === $default || false !== stripos( $default, 'text/html' );
	}
}
