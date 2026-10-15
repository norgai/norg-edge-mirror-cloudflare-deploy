<?php
/**
 * Pure path tests, ported from the Cloudflare worker and workers/lib/r2-content.mjs.
 *
 * Every function here takes a WHATWG-style pathname (see Request::pathname) and
 * must answer exactly as its JavaScript counterpart; the shared vectors in
 * tests/fixtures/edge-router-vectors.json pin that.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Path predicates and the URL-path to R2-key mapping.
 */
final class Paths {

	/**
	 * Map a request pathname to its R2 key suffix (pathToKeySuffix).
	 *
	 * A trailing slash always means a directory, even when the segment has a dot.
	 *
	 * @param string $pathname Request pathname.
	 * @return string Key suffix beginning with "/".
	 */
	public static function key_suffix( $pathname ) {
		if ( '' === $pathname || '/' === $pathname ) {
			return '/index.html';
		}
		if ( '/' === substr( $pathname, -1 ) ) {
			return $pathname . 'index.html';
		}
		$last = self::last_segment( $pathname );
		return false !== strpos( $last, '.' ) ? $pathname : $pathname . '/index.html';
	}

	/**
	 * The segment after the final slash.
	 *
	 * @param string $pathname Request pathname.
	 * @return string Last segment (may be empty).
	 */
	public static function last_segment( $pathname ) {
		$slash = strrpos( $pathname, '/' );
		return false === $slash ? $pathname : substr( $pathname, $slash + 1 );
	}

	/**
	 * Is this one of the exact discovery-artifact paths?
	 *
	 * @param string $pathname Request pathname.
	 * @return bool True for llms.txt, llms-full.txt, tree.json, graph.jsonld, agents.md.
	 */
	public static function is_discovery( $pathname ) {
		return in_array( $pathname, Constants::DISCOVERY_PATHS, true );
	}

	/**
	 * Is this a per-page sibling artifact (matched by filename in any directory)?
	 *
	 * @param string $pathname Request pathname.
	 * @return bool True for index.md/.json/.jsonld/.pdf/.openai.json and webmcp.js.
	 */
	public static function is_sibling_artifact( $pathname ) {
		return in_array( self::last_segment( $pathname ), Constants::SIBLING_ARTIFACT_FILENAMES, true );
	}

	/**
	 * The page a sibling artifact belongs to: "/about/index.md" becomes "/about".
	 *
	 * @param string $pathname Sibling artifact pathname.
	 * @return string Owning page path.
	 */
	public static function sibling_page_of( $pathname ) {
		$slash = strrpos( $pathname, '/' );
		$page  = false === $slash ? '' : substr( $pathname, 0, $slash );
		return '' === $page ? '/' : $page;
	}

	/**
	 * Is this under the reserved /.norg/ prefix?
	 *
	 * @param string $pathname Request pathname.
	 * @return bool True for NORG-owned assets such as /.norg/theme.css.
	 */
	public static function is_reserved_norg( $pathname ) {
		return 0 === strpos( $pathname, Constants::RESERVED_NORG_PREFIX );
	}

	/**
	 * Is this one of the site-level OpenAI feed artifacts?
	 *
	 * @param string $pathname Request pathname.
	 * @return bool True for ai-plugin.json, openapi.json, openapi.yaml.
	 */
	public static function is_openai_feed( $pathname ) {
		return in_array( $pathname, Constants::OPENAI_FEED_PATHS, true );
	}

	/**
	 * Is this an MCP surface (any path ending /mcp.json, /mcp or /sse)?
	 *
	 * @param string $pathname Request pathname.
	 * @return bool True for MCP endpoints.
	 */
	public static function is_mcp( $pathname ) {
		return self::ends_with( $pathname, '/mcp.json' ) || self::ends_with( $pathname, '/mcp' ) || self::ends_with( $pathname, '/sse' );
	}

	/**
	 * The manifest key for an MCP path: "/x/mcp" becomes "/x/mcp.json"; "/mcp.json" maps to itself.
	 *
	 * @param string $pathname MCP pathname.
	 * @return string Manifest key suffix.
	 */
	public static function mcp_manifest_suffix( $pathname ) {
		if ( self::ends_with( $pathname, '/mcp.json' ) ) {
			return $pathname;
		}
		return preg_replace( '#/(mcp|sse)$#', '', $pathname ) . '/mcp.json';
	}

	/**
	 * Is this a path NORG owns and serves to every caller before classification?
	 *
	 * @param string $pathname Request pathname.
	 * @return bool True for MCP, discovery, reserved and OpenAI feed paths.
	 */
	public static function is_norg_owned_artifact( $pathname ) {
		return self::is_mcp( $pathname ) || self::is_discovery( $pathname ) || self::is_reserved_norg( $pathname ) || self::is_openai_feed( $pathname );
	}

	/**
	 * Is this a static subresource rather than a document? Reads the last segment only.
	 *
	 * @param string $pathname Request pathname (no query string).
	 * @return bool True for known asset extensions.
	 */
	public static function is_static_asset( $pathname ) {
		$segment = self::last_segment( $pathname );
		$dot     = strrpos( $segment, '.' );
		if ( false === $dot || 0 === $dot || strlen( $segment ) - 1 === $dot ) {
			return false;
		}
		return in_array( strtolower( substr( $segment, $dot ) ), Constants::STATIC_ASSET_SUFFIXES, true );
	}

	/**
	 * Is this path the agentic prefix or inside it ("/ai" never captures "/aircraft")?
	 *
	 * @param string $pathname Request pathname.
	 * @param string $prefix   Configured prefix; empty disables the subtree.
	 * @return bool True when inside the agentic subtree.
	 */
	public static function is_agentic( $pathname, $prefix ) {
		if ( '' === (string) $prefix ) {
			return false;
		}
		return $pathname === $prefix || 0 === strpos( $pathname, $prefix . '/' );
	}

	/**
	 * Normalise a pathname to the stored EdgeRoute.path form (collapse "//", drop trailing "/").
	 *
	 * @param string $pathname Request pathname.
	 * @return string Normalised path.
	 */
	public static function normalise_skip( $pathname ) {
		if ( strlen( $pathname ) <= 1 ) {
			return $pathname;
		}
		$collapsed = preg_replace( '#/{2,}#', '/', $pathname );
		$trimmed   = rtrim( $collapsed, '/' );
		return '' === $trimmed ? '/' : $trimmed;
	}

	/**
	 * Has the operator marked this page to pass through to the origin?
	 *
	 * @param array  $skip_paths Normalised paths from the feed.
	 * @param string $pathname   Path to test, in request form.
	 * @return bool True when excluded from the mirror.
	 */
	public static function is_skipped( array $skip_paths, $pathname ) {
		return in_array( self::normalise_skip( $pathname ), $skip_paths, true );
	}

	/**
	 * Is this a traditional search-engine crawler (rule 2: always the origin)?
	 *
	 * @param string $user_agent Raw User-Agent header.
	 * @return bool True for web-index crawlers where cloaking is a risk.
	 */
	public static function is_traditional_search_bot( $user_agent ) {
		$ua = strtolower( (string) $user_agent );
		foreach ( Constants::TRADITIONAL_SEARCH_BOTS as $bot ) {
			if ( false !== strpos( $ua, $bot ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Does this WordPress path always belong to the site's own application?
	 *
	 * Matches Constants::WORDPRESS_INTERNAL_PATHS ("/x/*" is a prefix, others exact),
	 * relative to the site's home path so subdirectory installs work.
	 *
	 * @param string $pathname  Request pathname.
	 * @param string $home_path Path part of home_url(), e.g. "/blog" or "".
	 * @return bool True when the request must reach WordPress untouched.
	 */
	public static function is_wordpress_internal( $pathname, $home_path = '' ) {
		$home = rtrim( (string) $home_path, '/' );
		if ( '' !== $home && 0 === strpos( $pathname, $home . '/' ) ) {
			$pathname = substr( $pathname, strlen( $home ) );
		}
		foreach ( Constants::WORDPRESS_INTERNAL_PATHS as $rule ) {
			if ( self::ends_with( $rule, '/*' ) ) {
				if ( 0 === strpos( $pathname, substr( $rule, 0, -1 ) ) ) {
					return true;
				}
			} elseif ( $pathname === $rule ) {
				return true;
			}
		}
		return self::ends_with( $pathname, '/admin-ajax.php' ) || self::ends_with( $pathname, '/admin-post.php' );
	}

	/**
	 * Does a string end with a suffix? (PHP 7.4 has no str_ends_with.)
	 *
	 * @param string $haystack String to test.
	 * @param string $needle   Suffix.
	 * @return bool True on a match.
	 */
	public static function ends_with( $haystack, $needle ) {
		$len = strlen( $needle );
		return 0 === $len || ( strlen( $haystack ) >= $len && substr( $haystack, -$len ) === $needle );
	}
}
