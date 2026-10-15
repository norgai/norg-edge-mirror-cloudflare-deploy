<?php
/**
 * Plugin Name:       NORG Edge Router
 * Plugin URI:        https://app.norg.ai/help/wordpress-plugin
 * Description:       Serves NORG's AI-optimised mirror of your pages to verified AI agents at your own URLs. People and search engines always get your site, unchanged.
 * Version:           0.1.1
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            NORG
 * Author URI:        https://norg.ai
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       norg-edge-router
 * Domain Path:       /languages
 * Update URI:        https://content-craft-api.norg.ai/api/v1/edge/wordpress/update-manifest
 *
 * @package NorgEdgeRouter
 */

defined( 'ABSPATH' ) || exit;

define( 'NORG_EDGE_ROUTER_VERSION', '0.1.1' );
define( 'NORG_EDGE_ROUTER_FILE', __FILE__ );
define( 'NORG_EDGE_ROUTER_DIR', __DIR__ );

require_once __DIR__ . '/includes/autoload.php';

register_activation_hook( __FILE__, array( 'Norg\\Edge\\Lifecycle', 'activate' ) );
register_deactivation_hook( __FILE__, array( 'Norg\\Edge\\Lifecycle', 'deactivate' ) );

Norg\Edge\Plugin::boot();
