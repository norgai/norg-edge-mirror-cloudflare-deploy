<?php
/**
 * Alternate-format canonicals, citation referrals, device types and the visit header.
 *
 * @package NorgEdgeRouter
 */

use Norg\Edge\Alternate_Format;
use Norg\Edge\Page_View;
use Norg\Edge\Referral;
use Norg\Edge\Visit_Header;
use PHPUnit\Framework\TestCase;

/**
 * Smaller ports.
 */
final class FormatsTest extends TestCase {

	/**
	 * Canonical URLs match workers/lib/alternate-format.mjs.
	 */
	public function test_canonical_matches_worker() {
		foreach ( norg_edge_vectors()['canonical'] as $c ) {
			$this->assertSame( $c['url'], Alternate_Format::canonical_url( 'https', 'shop.test', $c['path'] ), $c['path'] );
		}
	}

	/**
	 * Referral detection matches workers/lib/referral.mjs.
	 */
	public function test_referrals_match_worker() {
		foreach ( norg_edge_vectors()['referrals'] as $c ) {
			$this->assertSame( $c['detection'], Referral::detect( $c['referer'], $c['utm'], 'shop.example.com' ), json_encode( $c ) );
		}
	}

	/**
	 * Device types match workers/lib/page-view.mjs.
	 */
	public function test_device_types_match_worker() {
		foreach ( norg_edge_vectors()['device_types'] as $c ) {
			$this->assertSame( $c['device'], Page_View::device_type( $c['ua'] ), $c['ua'] );
		}
	}

	/**
	 * Visitor id is sha256 of ip:ua:lang:date truncated to 32 hex chars.
	 */
	public function test_visitor_id() {
		$id = Page_View::visitor_id( '1.2.3.4', 'UA', 'en', gmmktime( 12, 0, 0, 1, 2, 2026 ) );
		$this->assertSame( substr( hash( 'sha256', '1.2.3.4:UA:en:2026-01-02' ), 0, 32 ), $id );
	}

	/**
	 * The visit header decodes to clamped fields, never exceeds 4 KB, and defaults an unknown miss label.
	 */
	public function test_visit_header_round_trip() {
		$visit   = Visit_Header::build(
			array(
				'is_ai_bot' => true,
				'bot_name'  => 'gptbot',
				'company'   => 'openai',
				'purpose'   => 'training',
			),
			'mirror',
			'bogus',
			str_repeat( 'U', 9000 ),
			array( 'ip_country' => 'AUS' )
		);
		$encoded = Visit_Header::encode( $visit );
		$this->assertLessThanOrEqual( Visit_Header::MAX_BYTES, strlen( $encoded ) );
		$decoded = json_decode( base64_decode( strtr( $encoded, '-_', '+/' ) ), true );
		$this->assertSame( 'origin', $decoded['served_on_miss'] );
		$this->assertSame( 'AU', $decoded['ip_country'] );
		$this->assertSame( 512, strlen( $decoded['user_agent'] ) );
		$this->assertTrue( $decoded['is_ai_bot'] );
	}
}
