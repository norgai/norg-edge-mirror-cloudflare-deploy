<?php
/**
 * Constant tables shared with the Cloudflare edge-router worker.
 *
 * Deliberate COPY of the worker's declarations; tests/unit/ConstantsParityTest
 * compares every list against workers/edge-router-worker.js and fails on drift.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Constants mirrored from workers/edge-router-worker.js (EDGE_SCRIPT_VERSION 0.14.2).
 */
final class Constants {

	/** Baked binding defaults (EDGEPAR 04); EDGE_ENV deliberately has none. */
	const BINDING_DEFAULTS = array(
		'NORG_API_URL'           => 'https://content-craft-api.norg.ai',
		'NORG_CONTENT_BASE'      => 'https://edge-content.norg.ai',
		'STRIP_FALLBACK_ENABLED' => 'true',
		'EDGE_DISABLED'          => 'false',
		'LAZY_RENDER_ENABLED'    => 'true',
		'CAPTURE_ONLY'           => 'false',
	);

	/** The heartbeat/probe platform name; must equal edge_sites.cdn_provider. */
	const PLATFORM = 'wordpress';

	const RESERVED_NORG_PREFIX         = '/.norg/';
	const RESERVED_ASSET_CACHE_CONTROL = 'public, max-age=60, s-maxage=30, stale-while-revalidate=300';
	const LOOP_GUARD_HEADER            = 'x-norg-edge';
	const HEALTH_CHECK_HEADER          = 'x-norg-edge-check';
	const SIMULATE_HEADER              = 'x-norg-edge-simulate';

	/** Budgets in seconds (WordPress HTTP API takes seconds). */
	const MIRROR_FETCH_TIMEOUT   = 4;
	const PATTERN_FETCH_TIMEOUT  = 5;
	const CONTROL_CALL_TIMEOUT   = 3;
	const MCP_FORWARD_TIMEOUT    = 10;
	const LOOPBACK_TIMEOUT       = 3;
	const PATTERN_DEFAULT_TTL    = 3600;
	const UNENTITLED_TTL         = 60;
	const HEARTBEAT_MIN_INTERVAL = 900;
	const RENDER_DEDUP_TTL       = 600;
	const STRIP_WORD_FLOOR       = 120;
	const MAX_MIRROR_BYTES       = 8388608;

	const DEFAULT_AGENTIC_PATH_PREFIX = '/ai';
	const REFUSAL_STATUSES            = array( 401, 403 );

	/** Web-index crawlers that must always see the origin (rule 2). Operator list, not a purpose. */
	const TRADITIONAL_SEARCH_BOTS = array( 'googlebot', 'bingbot', 'applebot', 'duckduckbot', 'baiduspider', 'yandex', 'slurp' );

	const STRIP_REMOVE_SELECTORS = array(
		'script',
		'style',
		'noscript',
		'iframe',
		'svg',
		'canvas',
		'video',
		'audio',
		'form',
		'input',
		'select',
		'textarea',
		'nav',
		'aside',
		'footer',
		"link[rel='stylesheet']",
		"link[rel='preload']",
		"link[rel='prefetch']",
		"[role='navigation']",
		"[aria-hidden='true']",
	);

	const STRIP_UNWRAP_SELECTORS = array( 'button' );

	const STRIP_KEEP_ATTRIBUTES = array( 'href', 'src', 'alt', 'title', 'lang', 'datetime', 'content', 'name', 'rel' );

	const SIBLING_ARTIFACT_FILENAMES = array( 'index.md', 'index.json', 'index.jsonld', 'index.pdf', 'index.openai.json', 'webmcp.js' );

	const OPENAI_FEED_PATHS = array( '/.well-known/ai-plugin.json', '/openapi.json', '/openapi.yaml' );

	const DISCOVERY_PATHS = array( '/llms.txt', '/llms-full.txt', '/tree.json', '/graph.jsonld', '/agents.md' );

	/** Backend _ASSET_SUFFIXES minus .xml/.txt/.json (NORG's own surfaces use those). */
	const STATIC_ASSET_SUFFIXES = array(
		'.css',
		'.js',
		'.mjs',
		'.map',
		'.png',
		'.jpg',
		'.jpeg',
		'.gif',
		'.webp',
		'.svg',
		'.ico',
		'.avif',
		'.bmp',
		'.tiff',
		'.heic',
		'.woff',
		'.woff2',
		'.ttf',
		'.eot',
		'.otf',
		'.mp4',
		'.webm',
		'.mov',
		'.avi',
		'.mkv',
		'.m4v',
		'.ogv',
		'.mp3',
		'.wav',
		'.ogg',
		'.m4a',
		'.aac',
		'.flac',
		'.weba',
		'.vtt',
		'.srt',
		'.pdf',
		'.doc',
		'.docx',
		'.xls',
		'.xlsx',
		'.ppt',
		'.pptx',
		'.zip',
		'.gz',
		'.rar',
		'.tar',
		'.7z',
		'.webmanifest',
	);

	/** Alternate formats that carry a canonical Link + noindex (workers/lib/alternate-format.mjs). */
	const ALTERNATE_FORMAT_EXTENSIONS = array( '.json', '.jsonld', '.md', '.pdf', '.csv' );

	/** Headers an MCP forward may carry (workers/lib/mcp-forward.mjs). */
	const MCP_FORWARD_HEADER_ALLOWLIST = array( 'accept', 'accept-language', 'content-type', 'user-agent', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id' );

	/**
	 * WordPress paths that always belong to the site's own application.
	 *
	 * Backend route_scope.WORDPRESS_ROUTE_EXCLUSIONS verbatim, plus the REST and
	 * AJAX endpoints a worker route never sees because they are not documents.
	 */
	const WORDPRESS_INTERNAL_PATHS = array(
		'/wp-content/*',
		'/wp-includes/*',
		'/wp-cron.php',
		'/cdn-cgi/*',
		'/feed',
		'/feed/*',
		'/wp-admin/*',
		'/wp-login.php',
		'/xmlrpc.php',
		'/readme.html',
		'/license.txt',
		'/wp-comments-post.php',
		'/wp-signup.php',
		'/wp-activate.php',
		'/wp-json',
		'/wp-json/*',
		'/wp-admin',
	);
}
