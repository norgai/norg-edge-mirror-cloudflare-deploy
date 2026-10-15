<?php
/**
 * Classification against workers/lib/classify.mjs outputs.
 *
 * @package NorgEdgeRouter
 */

use Norg\Edge\Classifier;
use Norg\Edge\Paths;
use PHPUnit\Framework\TestCase;

/**
 * Classifier parity and policy gates.
 */
final class ClassifierTest extends TestCase {

	/**
	 * Pattern and automation classification match the worker for every user agent.
	 */
	public function test_classification_matches_worker() {
		$v = norg_edge_vectors();
		foreach ( $v['user_agents'] as $case ) {
			$this->assertSame( $case['classify'], Classifier::classify_request( $case['ua'], $v['patterns'] ), 'classify ' . $case['ua'] );
			$this->assertSame( $case['automation'], Classifier::classify_script_automation( $case['ua'] ), 'automation ' . $case['ua'] );
			$this->assertSame( $case['traditional_search'], Paths::is_traditional_search_bot( $case['ua'] ), 'search ' . $case['ua'] );
		}
	}

	/**
	 * Policy comes from the feed; automation is never diverted; only explicit values divert.
	 */
	public function test_policy_gates() {
		$patterns = norg_edge_vectors()['patterns'];
		$gpt      = Classifier::classify_agent( 'GPTBot/1.2', $patterns );
		$this->assertTrue( Classifier::may_divert( $gpt ) );
		$deep = Classifier::classify_agent( 'DeepSeekBot', $patterns );
		$this->assertFalse( Classifier::may_divert( $deep ) );
		$this->assertTrue( Classifier::may_divert_unverified( $deep ) );
		$this->assertFalse( Classifier::may_divert( Classifier::classify_agent( 'PerplexityBot/1.0', $patterns ) ) );
		$this->assertNull( Classifier::classify_agent( 'Google-Extended', $patterns )['serving_policy'] );
		$curl = Classifier::classify_agent( 'curl/8.4.0', $patterns );
		$this->assertSame( 'never_divert', $curl['serving_policy'] );
		$this->assertFalse( Classifier::classify_agent( 'Mozilla/5.0 Chrome/125', $patterns )['is_ai_bot'] );
	}
}
