<?php
/**
 * Contract every page-cache adapter implements.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge\Cache;

defined( 'ABSPATH' ) || exit;

/**
 * A page-cache integration that keeps AI agents' requests away from cached pages.
 */
interface Adapter {

	/**
	 * Stable identifier (reported in heartbeats).
	 *
	 * @return string Slug.
	 */
	public function slug();

	/**
	 * Human name.
	 *
	 * @return string Label.
	 */
	public function label();

	/**
	 * Is this cache active on the site?
	 *
	 * @return bool True when detected.
	 */
	public function detected();

	/**
	 * Register filters that must exist on every request (e.g. WP Rocket's reject list).
	 *
	 * @param array $tokens Divertable user-agent substrings.
	 * @return void
	 */
	public function register_runtime( array $tokens );

	/**
	 * Write the bypass into the cache's own configuration and rewrite rules.
	 *
	 * @param array $tokens  Current divertable user-agent substrings.
	 * @param array $retired Substrings this plugin added before and must now remove.
	 * @return array Result: ok (bool), mechanism (string), note (string).
	 */
	public function apply( array $tokens, array $retired );

	/**
	 * Remove every entry this plugin added.
	 *
	 * @param array $tokens Substrings previously added.
	 * @return void
	 */
	public function remove( array $tokens );
}
