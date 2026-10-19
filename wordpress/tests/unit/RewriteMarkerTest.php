<?php
/**
 * The ?norg_edge marker a host rewrite rule adds.
 *
 * @package NorgEdgeRouter
 */

use Norg\Edge\Cache\Rewrite_Marker;
use Norg\Edge\Ip_Resolver;
use Norg\Edge\Request;
use PHPUnit\Framework\TestCase;

/**
 * Rewrite marker detection.
 */
final class RewriteMarkerTest extends TestCase {

	/**
	 * Build a request with the given query string.
	 *
	 * @param string $query Query string.
	 * @return Request Request.
	 */
	private function request( $query ) {
		return new Request(
			array(
				'HTTP_HOST'    => 'shop.example',
				'REQUEST_URI'  => '/shop/' . ( '' === $query ? '' : '?' . $query ),
				'QUERY_STRING' => $query,
			),
			new Ip_Resolver()
		);
	}

	/**
	 * The marker is found alone, after the original query, and with any value.
	 */
	public function test_marked_requests() {
		$this->assertTrue( Rewrite_Marker::is_marked( $this->request( 'norg_edge=1' ) ) );
		$this->assertTrue( Rewrite_Marker::is_marked( $this->request( 'page=2&norg_edge=1' ) ) );
		$this->assertTrue( Rewrite_Marker::is_marked( $this->request( 'norg_edge' ) ) );
	}

	/**
	 * No marker, or a lookalike name, is not marked.
	 */
	public function test_unmarked_requests() {
		$this->assertFalse( Rewrite_Marker::is_marked( $this->request( '' ) ) );
		$this->assertFalse( Rewrite_Marker::is_marked( $this->request( 'page=2' ) ) );
		$this->assertFalse( Rewrite_Marker::is_marked( $this->request( 'norg_edgex=1&xnorg_edge=1' ) ) );
	}
}
