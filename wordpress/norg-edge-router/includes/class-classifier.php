<?php
/**
 * Visitor classification and serving policy (workers/lib/classify.mjs + the worker's policy gates).
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Classifies a user agent against NORG's feed and decides whether it may be diverted.
 */
final class Classifier {

	/**
	 * A non-bot classification.
	 *
	 * @return array Classification with is_ai_bot false.
	 */
	public static function none() {
		return array(
			'is_ai_bot' => false,
			'bot_name'  => null,
			'company'   => null,
			'purpose'   => null,
		);
	}

	/**
	 * Classify a user agent against the feed's patterns (first substring match wins).
	 *
	 * @param string $user_agent Raw User-Agent header.
	 * @param array  $patterns   Feed patterns: pattern, company, purpose, serving_policy.
	 * @return array Classification.
	 */
	public static function classify_request( $user_agent, array $patterns ) {
		if ( '' === (string) $user_agent ) {
			return self::none();
		}
		$ua = strtolower( $user_agent );
		foreach ( $patterns as $pattern ) {
			$needle = isset( $pattern['pattern'] ) ? (string) $pattern['pattern'] : '';
			if ( '' !== $needle && false !== strpos( $ua, $needle ) ) {
				return array(
					'is_ai_bot' => true,
					'bot_name'  => $needle,
					'company'   => isset( $pattern['company'] ) ? $pattern['company'] : null,
					'purpose'   => isset( $pattern['purpose'] ) ? $pattern['purpose'] : null,
				);
			}
		}
		return self::none();
	}

	/**
	 * Detect headless browsers, HTTP libraries and scanners, in signature order.
	 *
	 * @param string $user_agent Raw User-Agent header.
	 * @return array|null Classification, or null when not automation.
	 */
	public static function classify_script_automation( $user_agent ) {
		$ua   = strtolower( (string) $user_agent );
		$name = self::automation_family( $ua );
		if ( null === $name ) {
			return null;
		}
		return array(
			'is_ai_bot' => true,
			'bot_name'  => $name,
			'company'   => 'script_automation',
			'purpose'   => 'unknown',
		);
	}

	/**
	 * The automation family a lower-cased user agent belongs to.
	 *
	 * Order is significant: python-http before the generic families; curl/wget name themselves.
	 *
	 * @param string $ua Lower-cased user agent.
	 * @return string|null Family name, or null.
	 */
	private static function automation_family( $ua ) {
		if ( self::contains_any( $ua, array( 'headlesschrome', 'puppeteer', 'playwright', 'selenium', 'phantomjs' ) ) ) {
			return 'headless-chrome';
		}
		if ( false !== strpos( $ua, 'python' ) && self::contains_any( $ua, array( 'aiohttp', 'requests', 'httpx', 'urllib' ) ) ) {
			return 'python-http';
		}
		if ( 0 === strpos( $ua, 'curl/' ) || 0 === strpos( $ua, 'wget/' ) ) {
			return explode( '/', $ua )[0];
		}
		if ( self::contains_any( $ua, array( 'node-fetch', 'axios', 'undici' ) ) ) {
			return 'node-http';
		}
		if ( self::contains_any( $ua, array( 'l9scan', 'leakix', 'nuclei', 'zgrab', 'masscan' ) ) ) {
			return 'security-scanner';
		}
		if ( 0 === strpos( $ua, 'go-http-client' ) || false !== strpos( $ua, 'go-resty' ) ) {
			return 'go-http';
		}
		if ( 0 === strpos( $ua, 'java/' ) || self::contains_any( $ua, array( 'apache-httpclient', 'okhttp' ) ) ) {
			return 'java-http';
		}
		return null;
	}

	/**
	 * Classify a visitor: named patterns first, then script automation (never diverted).
	 *
	 * @param string $user_agent Raw User-Agent header.
	 * @param array  $patterns   Feed patterns.
	 * @return array Classification carrying serving_policy.
	 */
	public static function classify_agent( $user_agent, array $patterns ) {
		$match = self::classify_request( $user_agent, $patterns );
		if ( $match['is_ai_bot'] ) {
			$match['serving_policy'] = self::serving_policy_for( $match['bot_name'], $patterns );
			return $match;
		}
		$automation = self::classify_script_automation( $user_agent );
		if ( null !== $automation ) {
			$automation['serving_policy'] = 'never_divert';
			return $automation;
		}
		return $match;
	}

	/**
	 * The serving policy NORG published for a matched pattern.
	 *
	 * @param string|null $bot_name Matched pattern string.
	 * @param array       $patterns Feed patterns.
	 * @return string|null Policy, or null when the feed omits it.
	 */
	public static function serving_policy_for( $bot_name, array $patterns ) {
		foreach ( $patterns as $pattern ) {
			if ( isset( $pattern['pattern'] ) && $pattern['pattern'] === $bot_name ) {
				return isset( $pattern['serving_policy'] ) ? $pattern['serving_policy'] : null;
			}
		}
		return null;
	}

	/**
	 * Has NORG authorised diverting this agent (explicit "divert" only)?
	 *
	 * @param array $classification From classify_agent.
	 * @return bool True only for "divert".
	 */
	public static function may_divert( array $classification ) {
		return isset( $classification['serving_policy'] ) && 'divert' === $classification['serving_policy'];
	}

	/**
	 * Has NORG authorised diverting this agent without source verification?
	 *
	 * @param array $classification From classify_agent.
	 * @return bool True only for "divert_unverified".
	 */
	public static function may_divert_unverified( array $classification ) {
		return isset( $classification['serving_policy'] ) && 'divert_unverified' === $classification['serving_policy'];
	}

	/**
	 * Synthetic classification for a ?agent=true override.
	 *
	 * @return array Classification identifying the override.
	 */
	public static function agent_override() {
		return array(
			'is_ai_bot' => true,
			'bot_name'  => 'agent_param_override',
			'company'   => 'agent_param_override',
			'purpose'   => 'override',
		);
	}

	/**
	 * Does the haystack contain any of the needles?
	 *
	 * @param string $haystack String to search.
	 * @param array  $needles  Substrings.
	 * @return bool True on any match.
	 */
	private static function contains_any( $haystack, array $needles ) {
		foreach ( $needles as $needle ) {
			if ( false !== strpos( $haystack, $needle ) ) {
				return true;
			}
		}
		return false;
	}
}
