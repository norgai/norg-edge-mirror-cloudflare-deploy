<?php
/**
 * Every mirrored list equals the declaration in workers/edge-router-worker.js.
 *
 * @package NorgEdgeRouter
 */

use Norg\Edge\Constants;
use PHPUnit\Framework\TestCase;

/**
 * Constants parity.
 */
final class ConstantsParityTest extends TestCase {

	/**
	 * Lists and scalars match the worker source text the vectors were generated from.
	 */
	public function test_constants_match_worker_source() {
		$c = norg_edge_vectors()['constants'];
		$this->assertSame( $c['TRADITIONAL_SEARCH_BOTS'], Constants::TRADITIONAL_SEARCH_BOTS );
		$this->assertSame( $c['STRIP_REMOVE_SELECTORS'], array_map( 'strval', Constants::STRIP_REMOVE_SELECTORS ) );
		$this->assertSame( $c['STRIP_UNWRAP_SELECTORS'], Constants::STRIP_UNWRAP_SELECTORS );
		$this->assertSame( $c['STRIP_KEEP_ATTRIBUTES'], Constants::STRIP_KEEP_ATTRIBUTES );
		$this->assertSame( $c['SIBLING_ARTIFACT_FILENAMES'], Constants::SIBLING_ARTIFACT_FILENAMES );
		$this->assertSame( $c['OPENAI_FEED_PATHS'], Constants::OPENAI_FEED_PATHS );
		$this->assertSame( $c['STATIC_ASSET_SUFFIXES'], Constants::STATIC_ASSET_SUFFIXES );
		$this->assertSame( $c['STRIP_WORD_FLOOR'], Constants::STRIP_WORD_FLOOR );
		$this->assertSame( $c['RESERVED_NORG_PREFIX'], Constants::RESERVED_NORG_PREFIX );
	}
}
