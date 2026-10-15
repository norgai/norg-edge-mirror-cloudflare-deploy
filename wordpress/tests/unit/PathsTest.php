<?php
/**
 * Path predicates and key mapping against the worker's own outputs.
 *
 * @package NorgEdgeRouter
 */

use Norg\Edge\Paths;
use Norg\Edge\Request;
use PHPUnit\Framework\TestCase;

/**
 * Paths parity.
 */
final class PathsTest extends TestCase {

	/**
	 * Each path vector.
	 *
	 * @return array Data sets.
	 */
	public function path_vectors() {
		$out = array();
		foreach ( norg_edge_vectors()['paths'] as $v ) {
			$out[ 'path ' . $v['path'] ] = array( $v );
		}
		return $out;
	}

	/**
	 * Every predicate answers as the worker does.
	 *
	 * @dataProvider path_vectors
	 * @param array $v Vector.
	 */
	public function test_predicates_match_worker( array $v ) {
		$p = $v['path'];
		$this->assertSame( $v['key_suffix'], Paths::key_suffix( $p ), 'key_suffix' );
		$this->assertSame( $v['is_discovery'], Paths::is_discovery( $p ), 'is_discovery' );
		$this->assertSame( $v['is_sibling_artifact'], Paths::is_sibling_artifact( $p ), 'is_sibling_artifact' );
		$this->assertSame( $v['sibling_page_of'], Paths::sibling_page_of( $p ), 'sibling_page_of' );
		$this->assertSame( $v['is_reserved_norg'], Paths::is_reserved_norg( $p ), 'is_reserved_norg' );
		$this->assertSame( $v['is_openai_feed'], Paths::is_openai_feed( $p ), 'is_openai_feed' );
		$this->assertSame( $v['is_mcp'], Paths::is_mcp( $p ), 'is_mcp' );
		$this->assertSame( $v['is_static_asset'], Paths::is_static_asset( $p ), 'is_static_asset' );
		$this->assertSame( $v['is_agentic'], Paths::is_agentic( $p, '/ai' ), 'is_agentic' );
		$this->assertSame( $v['normalise_skip'], Paths::normalise_skip( '' === $p ? '/' : $p ), 'normalise_skip' );
	}

	/**
	 * Request targets normalise exactly like Node's WHATWG URL parser.
	 */
	public function test_pathname_matches_whatwg() {
		foreach ( norg_edge_vectors()['pathnames'] as $v ) {
			$this->assertSame( $v['pathname'], Request::normalise_pathname( $v['target'] ), $v['target'] );
		}
	}

	/**
	 * The request URL keeps the Host port and the full (subdirectory) path; never home_url() + path.
	 */
	public function test_request_url_keeps_port_and_subdirectory() {
		$request = new Request(
			array(
				'HTTP_HOST'   => 'Shop.Example:8443',
				'HTTPS'       => 'on',
				'REQUEST_URI' => '/blog/llms.txt?x=1',
			),
			new \Norg\Edge\Ip_Resolver()
		);
		$this->assertSame( 'https://shop.example:8443/blog/llms.txt', $request->url() );
	}

	/**
	 * MCP aliases map to their manifest; a manifest maps to itself.
	 */
	public function test_mcp_manifest_suffix() {
		$this->assertSame( '/products/x/mcp.json', Paths::mcp_manifest_suffix( '/products/x/mcp' ) );
		$this->assertSame( '/mcp.json', Paths::mcp_manifest_suffix( '/sse' ) );
		$this->assertSame( '/mcp.json', Paths::mcp_manifest_suffix( '/mcp.json' ) );
		$this->assertSame( '/.well-known/mcp.json', Paths::mcp_manifest_suffix( '/.well-known/mcp.json' ) );
	}

	/**
	 * WordPress's own application paths always pass through, including in a subdirectory install.
	 */
	public function test_wordpress_internal_paths() {
		foreach ( array( '/wp-admin/', '/wp-admin', '/wp-json/wp/v2/posts', '/wp-json', '/wp-login.php', '/feed', '/feed/rss2', '/wp-content/uploads/a.jpg', '/xmlrpc.php', '/wp-admin/admin-ajax.php' ) as $p ) {
			$this->assertTrue( Paths::is_wordpress_internal( $p ), $p );
		}
		foreach ( array( '/', '/about', '/feedback', '/wp-jsonx', '/blog/feed-tips' ) as $p ) {
			$this->assertFalse( Paths::is_wordpress_internal( $p ), $p );
		}
		$this->assertTrue( Paths::is_wordpress_internal( '/blog/wp-json/x', '/blog' ) );
		$this->assertFalse( Paths::is_wordpress_internal( '/blog/about', '/blog' ) );
	}

	/**
	 * Skip membership uses the normalised stored form.
	 */
	public function test_is_skipped() {
		$this->assertTrue( Paths::is_skipped( array( '/a/b' ), '/a//b/' ) );
		$this->assertFalse( Paths::is_skipped( array( '/a/b' ), '/a/bc' ) );
	}
}
