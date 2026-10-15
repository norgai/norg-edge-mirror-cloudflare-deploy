<?php
/**
 * Connect::values() is the one validator behind the settings page, WP-CLI and REST.
 *
 * @package Norg\Edge\Tests
 */

use Norg\Edge\Connect;
use PHPUnit\Framework\TestCase;

/**
 * Pure validation: no WordPress needed.
 */
final class ConnectTest extends TestCase {

	const SITE_ID = '9f1c2e4a-1111-4222-8333-444455556666';
	const KEY     = 'nek_live_e2eTestKeyAAAAAAAAAAAAAAAAAAAAAA';

	public function test_valid_values_are_normalised() {
		$out = Connect::values( ' 9F1C2E4A-1111-4222-8333-444455556666 ', self::KEY . ' ', 'test', 'https://api.example/', null );
		$this->assertSame( '', $out['error'] );
		$this->assertSame( self::SITE_ID, $out['values']['site_id'] );
		$this->assertSame( self::KEY, $out['values']['site_key'] );
		$this->assertSame( 'test', $out['values']['edge_env'] );
		$this->assertSame( 'https://api.example', $out['values']['api_url'] );
		$this->assertArrayNotHasKey( 'content_base', $out['values'] );
	}

	public function test_env_is_left_alone_when_omitted_and_blanked_when_unknown() {
		$this->assertArrayNotHasKey( 'edge_env', Connect::values( self::SITE_ID, self::KEY )['values'] );
		$this->assertSame( '', Connect::values( self::SITE_ID, self::KEY, 'staging' )['values']['edge_env'] );
	}

	/**
	 * @dataProvider bad_inputs
	 */
	public function test_bad_inputs_are_refused_with_the_field_named( $site_id, $key, $api_url, $needle ) {
		$out = Connect::values( $site_id, $key, null, $api_url );
		$this->assertSame( array(), $out['values'] );
		$this->assertStringContainsString( $needle, $out['error'] );
	}

	public function bad_inputs() {
		return array(
			'not a uuid'      => array( 'nope', self::KEY, null, 'site_id' ),
			'not a norg key'  => array( self::SITE_ID, 'secret', null, 'site_key' ),
			'short key'       => array( self::SITE_ID, 'nek_live_short', null, 'site_key' ),
			'http api url'    => array( self::SITE_ID, self::KEY, 'http://api.example', 'api_url' ),
			'garbage api url' => array( self::SITE_ID, self::KEY, 'not a url', 'api_url' ),
		);
	}
}
