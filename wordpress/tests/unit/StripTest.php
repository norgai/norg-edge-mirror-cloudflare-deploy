<?php
/**
 * Strip output and word counts against the provider-neutral core/strip.js.
 *
 * @package NorgEdgeRouter
 */

use Norg\Edge\Strip;
use PHPUnit\Framework\TestCase;

/**
 * Strip parity.
 */
final class StripTest extends TestCase {

	/**
	 * Byte-identical output to the JavaScript tokenizer for every document.
	 */
	public function test_strip_matches_reference() {
		foreach ( norg_edge_vectors()['strip'] as $i => $c ) {
			$this->assertSame( $c['stripped'], Strip::html( $c['html'] ), "doc $i" );
			$this->assertSame( $c['words'], Strip::count_words( Strip::html( $c['html'] ) ), "words $i" );
		}
	}

	/**
	 * Word counts follow JavaScript's \s, including NBSP and other Unicode spaces.
	 */
	public function test_word_count_matches_worker() {
		foreach ( norg_edge_vectors()['words'] as $c ) {
			$this->assertSame( $c['words'], Strip::count_words( $c['text'] ), json_encode( $c['text'] ) );
		}
	}
}
