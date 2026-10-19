<?php
/**
 * Managed hosts whose page cache runs before PHP (no plugin can bypass it).
 *
 * Fingerprints are best-effort; the self-check is the authority on whether
 * agents actually reach the plugin.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge\Cache;

defined( 'ABSPATH' ) || exit;

/**
 * Detects host-level caches and names the fix.
 */
final class Host_Detector {

	/** Host => what the customer should ask for. */
	const ADVICE = array(
		'kinsta'       => 'Ask Kinsta support to bypass the page cache for the AI user agents listed below.',
		'wpengine'     => 'In the WP Engine User Portal, add a Web Rule (Rewrite Rules > Internal rewrite) that adds ?norg_edge=1 for the AI user agents listed below. No support ticket is needed. Exact rule: https://app.norg.ai/help/wordpress-plugin-wpengine',
		'pantheon'     => 'Pantheon honours Cache-Control: no-store on diverted pages; ask support to vary or bypass its edge cache for the AI user agents listed below.',
		'flywheel'     => 'Ask Flywheel support to bypass the page cache for the AI user agents listed below.',
		'siteground'   => 'In SiteGround Speed Optimizer, or with support, exclude the AI user agents listed below from the dynamic cache.',
		'wordpresscom' => 'WordPress.com Business sites cache at the edge; ask support to bypass it for the AI user agents listed below.',
		'godaddy'      => 'Ask GoDaddy support to bypass the managed WordPress cache for the AI user agents listed below.',
		'cloudways'    => 'In Cloudways, exclude the AI user agents listed below from Varnish (Application Settings > Varnish).',
		'pressable'    => 'Ask Pressable support to bypass the edge cache for the AI user agents listed below.',
	);

	/**
	 * The detected host slug, or "".
	 *
	 * @return string Host slug.
	 */
	public static function detect() {
		$server = $_SERVER; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- presence checks only.
		$checks = array(
			'kinsta'       => defined( 'KINSTAMU_VERSION' ) || isset( $server['KINSTA_CACHE_ZONE'] ),
			'wpengine'     => defined( 'WPE_APIKEY' ) || function_exists( 'is_wpe' ) || class_exists( 'WpeCommon' ),
			'pantheon'     => isset( $server['PANTHEON_ENVIRONMENT'] ) || defined( 'PANTHEON_ENVIRONMENT' ),
			'flywheel'     => defined( 'FLYWHEEL_CONFIG_DIR' ) || defined( 'FLYWHEEL_PLUGIN_DIR' ),
			'siteground'   => class_exists( 'SiteGround_Optimizer\\Loader\\Loader' ) || defined( 'SG_OPTIMIZER_VERSION' ),
			'wordpresscom' => defined( 'ATOMIC_SITE_ID' ) || defined( 'WPCOMSH_VERSION' ),
			'godaddy'      => class_exists( 'WPaaS\\Plugin' ),
			'cloudways'    => isset( $server['cw_allowed_ip'] ) || false !== strpos( (string) ( $server['DOCUMENT_ROOT'] ?? '' ), '/applications/' ),
			'pressable'    => defined( 'IS_PRESSABLE' ),
		);
		foreach ( $checks as $host => $hit ) {
			if ( $hit ) {
				return $host;
			}
		}
		return '';
	}

	/**
	 * Advice for the detected host.
	 *
	 * @return string Advice, or "".
	 */
	public static function advice() {
		$host = self::detect();
		return '' === $host ? '' : self::ADVICE[ $host ];
	}
}
