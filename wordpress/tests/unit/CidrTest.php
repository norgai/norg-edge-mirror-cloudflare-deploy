<?php
/**
 * CIDR containment and verdicts against workers/lib/cidr.mjs outputs.
 *
 * @package NorgEdgeRouter
 */

use Norg\Edge\Cidr;
use Norg\Edge\Ip_Resolver;
use PHPUnit\Framework\TestCase;

/**
 * CIDR parity.
 */
final class CidrTest extends TestCase {

	/**
	 * Containment and parseability match the worker, IPv4 and IPv6.
	 */
	public function test_contains_matches_worker() {
		foreach ( norg_edge_vectors()['cidr_contains'] as $c ) {
			$this->assertSame( $c['contains'], Cidr::contains( $c['ip'], $c['cidr'] ), $c['ip'] . ' in ' . $c['cidr'] );
			$this->assertSame( $c['parses'], null !== Cidr::parse_ip( $c['ip'] ), 'parse ' . $c['ip'] );
		}
	}

	/**
	 * Verdicts (true / false / null) match the worker.
	 */
	public function test_verdict_matches_worker() {
		$v = norg_edge_vectors();
		foreach ( $v['cidr_verdict'] as $c ) {
			$this->assertSame( $c['verdict'], Cidr::verdict_for( $c['ip'], $v['cidr_ranges'], array( 'company' => $c['company'] ) ), json_encode( $c ) );
		}
	}

	/**
	 * Trusted-proxy modes: REMOTE_ADDR by default; CF-Connecting-IP only from Cloudflare; header mode takes the last hop.
	 */
	public function test_ip_resolver_modes() {
		$cf     = array(
			'REMOTE_ADDR'           => '162.158.1.1',
			'HTTP_CF_CONNECTING_IP' => '192.0.2.5',
			'HTTP_CF_IPCOUNTRY'     => 'au',
		);
		$spoof  = array(
			'REMOTE_ADDR'           => '203.0.113.9',
			'HTTP_CF_CONNECTING_IP' => '192.0.2.5',
		);
		$xff    = array(
			'REMOTE_ADDR'          => '10.0.0.2',
			'HTTP_X_FORWARDED_FOR' => '192.0.2.99, 198.51.100.7',
		);
		$none   = new Ip_Resolver();
		$cfmode = new Ip_Resolver( 'cloudflare' );
		$this->assertSame( '162.158.1.1', $none->client_ip( $cf ) );
		$this->assertSame( '192.0.2.5', $cfmode->client_ip( $cf ) );
		$this->assertSame( 'AU', $cfmode->country( $cf ) );
		$this->assertSame( '203.0.113.9', $cfmode->client_ip( $spoof ), 'a non-Cloudflare peer cannot set CF-Connecting-IP' );
		$this->assertNull( $cfmode->country( $spoof ) );
		$this->assertSame( '198.51.100.7', ( new Ip_Resolver( 'header', 'X-Forwarded-For' ) )->client_ip( $xff ) );
		$this->assertNull( $none->client_ip( array( 'REMOTE_ADDR' => 'junk' ) ) );
		$this->assertSame( 'cloudflare', Ip_Resolver::suggest( $cf ) );
		$this->assertSame( 'header', Ip_Resolver::suggest( $xff ) );
	}

	/**
	 * Auto mode: each request's shape picks the source, and a public peer's headers are never trusted.
	 */
	public function test_ip_resolver_auto() {
		$auto  = new Ip_Resolver( 'auto' );
		$azure = array(
			'REMOTE_ADDR'          => '100.100.0.152',
			'HTTP_X_FORWARDED_FOR' => '192.0.2.99, 20.171.207.5',
		);
		$this->assertSame( '20.171.207.5', $auto->client_ip( $azure ), 'Azure Container Apps (RFC 6598 peer): last X-Forwarded-For hop' );
		$this->assertSame( 'header', Ip_Resolver::suggest( $azure ) );
		$this->assertSame( '198.51.100.7', $auto->client_ip( array( 'REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_FORWARDED_FOR' => '192.0.2.99, 198.51.100.7' ) ) );
		$this->assertSame( '198.51.100.8', $auto->client_ip( array( 'REMOTE_ADDR' => '172.16.0.4', 'HTTP_X_REAL_IP' => '198.51.100.8' ) ) );
		$this->assertSame( '192.0.2.5', $auto->client_ip( array( 'REMOTE_ADDR' => '162.158.1.1', 'HTTP_CF_CONNECTING_IP' => '192.0.2.5', 'HTTP_CF_IPCOUNTRY' => 'au' ) ) );
		$this->assertSame( 'AU', $auto->country( array( 'REMOTE_ADDR' => '162.158.1.1', 'HTTP_CF_CONNECTING_IP' => '192.0.2.5', 'HTTP_CF_IPCOUNTRY' => 'au' ) ) );
		$this->assertSame( '203.0.113.9', $auto->client_ip( array( 'REMOTE_ADDR' => '203.0.113.9', 'HTTP_X_FORWARDED_FOR' => '20.171.207.5' ) ), 'a public peer cannot set X-Forwarded-For' );
		$this->assertSame( '203.0.113.9', $auto->client_ip( array( 'REMOTE_ADDR' => '203.0.113.9', 'HTTP_CF_CONNECTING_IP' => '20.171.207.5' ) ), 'a non-Cloudflare peer cannot set CF-Connecting-IP' );
		$this->assertSame( '10.0.0.2', $auto->client_ip( array( 'REMOTE_ADDR' => '10.0.0.2' ) ), 'no forwarding header: the connection' );
	}
}
