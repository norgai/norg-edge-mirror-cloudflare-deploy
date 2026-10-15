<?php
/**
 * Mock NORG API + content receptionist for the end-to-end suite (php -S router script).
 *
 * Mirrors the real contracts: X-Norg-Site-Id/Key auth (401 on mismatch), the
 * bot-patterns feed with a weak ETag and 304, GET /content/{site}/{key} with a
 * JSON 404 on a miss, X-Norg-Visit decoding, and the four POST endpoints.
 * Every request is appended to $MOCK_LOG as one JSON line. A file named
 * "refuse" in $MOCK_STATE makes every authenticated call answer 401.
 *
 * @package NorgEdgeRouter
 */

$site_id  = getenv( 'MOCK_SITE_ID' );
$site_key = getenv( 'MOCK_SITE_KEY' );
$log      = getenv( 'MOCK_LOG' );
$state    = getenv( 'MOCK_STATE' );
$ttl      = (int) ( getenv( 'MOCK_FEED_TTL' ) ?: 3600 );
$path     = parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH );
$method   = $_SERVER['REQUEST_METHOD'];
$body     = file_get_contents( 'php://input' );
$visit    = isset( $_SERVER['HTTP_X_NORG_VISIT'] ) ? json_decode( base64_decode( strtr( $_SERVER['HTTP_X_NORG_VISIT'], '-_', '+/' ) ), true ) : null;

file_put_contents(
	$log,
	json_encode(
		array(
			'method' => $method,
			'path'   => $path,
			'body'   => json_decode( $body, true ) ?? $body,
			'visit'  => $visit,
			'lazy'   => $_SERVER['HTTP_X_NORG_LAZY_RENDER'] ?? null,
			'inm'    => $_SERVER['HTTP_IF_NONE_MATCH'] ?? null,
			'ua'     => $_SERVER['HTTP_USER_AGENT'] ?? null,
			'cookie' => isset( $_SERVER['HTTP_COOKIE'] ),
		)
	) . "\n",
	FILE_APPEND | LOCK_EX
);

/**
 * Send JSON and stop.
 *
 * @param int   $status Status.
 * @param mixed $data   Body.
 * @param array $extra  Headers.
 */
function out( $status, $data, array $extra = array() ) {
	http_response_code( $status );
	header( 'Content-Type: application/json' );
	foreach ( $extra as $k => $v ) {
		header( "$k: $v" );
	}
	echo is_string( $data ) ? $data : json_encode( $data );
	exit;
}

if ( '/api/v1/edge/wordpress/update-manifest' === $path ) {
	// Update tests: MOCK_UPDATE_VERSION / MOCK_PKG / MOCK_UPDATE_SHA (state files override env).
	$version = is_file( "$state/update_version" ) ? trim( file_get_contents( "$state/update_version" ) ) : '0.1.0';
	$sha     = is_file( "$state/update_sha" ) ? trim( file_get_contents( "$state/update_sha" ) ) : str_repeat( '0', 64 );
	$port    = $_SERVER['SERVER_PORT'];
	out( 200, array( 'version' => $version, 'package' => "http://127.0.0.1:$port/pkg/norg-edge-router.zip", 'sha256' => $sha, 'requires' => '6.0', 'tested' => '7.1', 'requires_php' => '7.4', 'channel' => 'ga' ) );
}
if ( '/pkg/norg-edge-router.zip' === $path && is_file( "$state/package.zip" ) ) {
	header( 'Content-Type: application/zip' );
	readfile( "$state/package.zip" );
	exit;
}

$auth_ok = ( $_SERVER['HTTP_X_NORG_SITE_ID'] ?? '' ) === $site_id && ( $_SERVER['HTTP_X_NORG_SITE_KEY'] ?? '' ) === $site_key;
if ( ! $auth_ok || file_exists( "$state/refuse" ) ) {
	out( 401, array( 'detail' => 'Invalid edge site credentials' ) );
}

if ( '/api/v1/edge/bot-patterns' === $path ) {
	$feed = array(
		'patterns'                  => array(
			array( 'pattern' => 'gptbot', 'company' => 'openai', 'purpose' => 'training', 'serving_policy' => 'divert' ),
			array( 'pattern' => 'claudebot', 'company' => 'anthropic', 'purpose' => 'training', 'serving_policy' => 'divert' ),
			array( 'pattern' => 'deepseekbot', 'company' => 'deepseek', 'purpose' => 'training', 'serving_policy' => 'divert_unverified' ),
			array( 'pattern' => 'perplexitybot', 'company' => 'perplexity', 'purpose' => 'search', 'serving_policy' => 'never_divert' ),
		),
		'count'                     => 4,
		'cache_ttl'                 => $ttl,
		'cidr_ranges'               => array(
			'openai'    => array( 'cidrs' => array( '127.0.0.0/8', '::1/128' ), 'last_refreshed_at' => '2026-10-15T00:00:00Z' ),
			'anthropic' => array( 'cidrs' => array( '192.0.2.0/24' ), 'last_refreshed_at' => '2026-10-15T00:00:00Z' ),
		),
		'agentic_path_prefix'       => '/ai',
		'response_cache'            => array( 'enabled' => false, 'ttl' => 300 ),
		'content_version'           => '1',
		'skip_paths'                => array( '/skipped-page' ),
		'capture_only'              => false,
		'citation_tracking_enabled' => true,
	);
	$etag = 'W/"' . substr( sha1( json_encode( $feed ) ), 0, 32 ) . '"';
	if ( ( $_SERVER['HTTP_IF_NONE_MATCH'] ?? '' ) === $etag ) {
		http_response_code( 304 );
		header( "ETag: $etag" );
		exit;
	}
	out( 200, $feed, array( 'ETag' => $etag, 'Cache-Control' => "private, max-age=$ttl" ) );
}

if ( 'POST' === $method && preg_match( '#^/api/v1/edge/(heartbeat|render-requests|events|page-views)$#', $path, $m ) ) {
	$answers = array(
		'heartbeat'       => array( 'status' => 'ok', 'latest_version' => '0.1.0', 'update_available' => false ),
		'render-requests' => array( 'status' => 'queued', 'path' => json_decode( $body, true )['path'] ?? '' ),
		'events'          => array( 'status' => 'recorded', 'id' => 'e1' ),
		'page-views'      => array( 'status' => 'recorded', 'id' => 'p1' ),
	);
	out( 'render-requests' === $m[1] ? 202 : 200, $answers[ $m[1] ] );
}

if ( 'POST' === $method && '/public-mcp/' === $path ) {
	$rpc = json_decode( $body, true );
	out( 200, array( 'jsonrpc' => '2.0', 'id' => $rpc['id'] ?? null, 'result' => array( 'echo' => $rpc['method'] ?? null, 'page' => $_SERVER['HTTP_X_NORG_EDGE_PAGE'] ?? null ) ), array( 'Mcp-Session-Id' => 'sess-123' ) );
}

$renders = array(
	'/index.html'                => array( 'text/html; charset=utf-8', '<!doctype html><html><head><title>NORG render of home</title></head><body><main>NORG-RENDER-HOME</main></body></html>' ),
	'/sample-page/index.html'    => array( 'text/html; charset=utf-8', '<!doctype html><html><body><main>NORG-RENDER-SAMPLE</main></body></html>' ),
	'/llms.txt'                  => array( 'text/plain; charset=utf-8', "# NORG llms.txt\n" ),
	'/.norg/theme.css'           => array( 'text/css; charset=utf-8', 'body{color:#111}' ),
	'/mcp.json'                  => array( 'application/json', '{"name":"norg-mcp-root"}' ),
	'/sample-page/mcp.json'      => array( 'application/json', '{"name":"norg-mcp-sample"}' ),
	'/about/index.md'            => array( 'text/markdown; charset=utf-8', "# About (NORG)\n" ),
	'/openapi.json'              => array( 'application/json', '{"openapi":"3.1.0"}' ),
	'/skipped-page/index.html'   => array( 'text/html; charset=utf-8', 'SHOULD-NEVER-BE-SERVED' ),
);
if ( 'GET' === $method && preg_match( '#^/content/([0-9a-f-]{36})(/.*)$#', $path, $m ) ) {
	if ( $m[1] !== $site_id ) {
		out( 401, array( 'error' => 'site_mismatch' ) );
	}
	if ( isset( $renders[ $m[2] ] ) ) {
		http_response_code( 200 );
		header( 'Content-Type: ' . $renders[ $m[2] ][0] );
		header( 'Cache-Control: private, no-store' );
		echo $renders[ $m[2] ][1];
		exit;
	}
	out( 404, array( 'error' => 'not_found' ), array( 'Cache-Control' => 'no-store' ) );
}

out( 404, array( 'error' => 'mock_unknown_route', 'path' => $path ) );
