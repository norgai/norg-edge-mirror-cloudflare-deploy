<?php
/**
 * Citation-referral detection (port of workers/lib/referral.mjs, Epic CITE 01).
 *
 * UTM first, then the parsed referrer HOST only (never the whole URL), so a path
 * that merely names an assistant never matches.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Detects whether a human visit arrived from an AI answer or a search engine.
 */
final class Referral {

	const SOURCE_REGISTRY = array(
		'chatgpt.com'           => array( 'chatgpt', 'ai_assistant' ),
		'chat.openai.com'       => array( 'chatgpt', 'ai_assistant' ),
		'perplexity.ai'         => array( 'perplexity', 'ai_search' ),
		'claude.ai'             => array( 'claude', 'ai_assistant' ),
		'gemini.google.com'     => array( 'gemini', 'ai_assistant' ),
		'copilot.microsoft.com' => array( 'copilot', 'ai_assistant' ),
		'google.com'            => array( 'google', 'search' ),
		'bing.com'              => array( 'bing', 'search' ),
	);

	const AI_UTM_SOURCE_MAP = array(
		'openai'                => array( 'chatgpt', 'ai_assistant' ),
		'chatgpt.com'           => array( 'chatgpt', 'ai_assistant' ),
		'chat.openai.com'       => array( 'chatgpt', 'ai_assistant' ),
		'perplexity'            => array( 'perplexity', 'ai_search' ),
		'perplexity.ai'         => array( 'perplexity', 'ai_search' ),
		'claude'                => array( 'claude', 'ai_assistant' ),
		'claude.ai'             => array( 'claude', 'ai_assistant' ),
		'gemini'                => array( 'gemini', 'ai_assistant' ),
		'gemini.google.com'     => array( 'gemini', 'ai_assistant' ),
		'copilot'               => array( 'copilot', 'ai_assistant' ),
		'copilot.microsoft.com' => array( 'copilot', 'ai_assistant' ),
		'copilot.com'           => array( 'copilot', 'ai_assistant' ),
	);

	/**
	 * Detect a citation referral, or null (also null for a self-referral).
	 *
	 * @param string|null $referer      Referer header.
	 * @param string|null $utm_source   utm_source query value.
	 * @param string      $request_host Host serving the page.
	 * @return array|null citation_source, citation_category, citation_source_host, citation_detection.
	 */
	public static function detect( $referer, $utm_source, $request_host ) {
		$host = self::referrer_host( $referer );
		$utm  = self::utm_entry( $utm_source );
		if ( null !== $host && self::registrable( $host ) === self::registrable( strtolower( $request_host ) ) ) {
			return null;
		}
		$entry = null === $host ? null : self::lookup( $host );
		if ( null !== $entry ) {
			return self::classify_host( $entry, $host, $utm );
		}
		if ( null === $utm ) {
			return null;
		}
		return null !== $host ? self::result( 'other_ai', 'ai_assistant', $host, 'utm' ) : self::result( $utm[0], $utm[1], '', 'utm' );
	}

	/**
	 * Lower-cased referrer host, or null.
	 *
	 * @param string|null $referer Referer header.
	 * @return string|null Host.
	 */
	private static function referrer_host( $referer ) {
		if ( ! $referer ) {
			return null;
		}
		$host = wp_parse_url( $referer, PHP_URL_HOST );
		return is_string( $host ) && '' !== $host ? strtolower( $host ) : null;
	}

	/**
	 * Last-two-labels registrable domain (no public suffix list, as in the worker).
	 *
	 * @param string $host Host.
	 * @return string Last two labels.
	 */
	private static function registrable( $host ) {
		return implode( '.', array_slice( explode( '.', $host ), -2 ) );
	}

	/**
	 * Registry lookup: exact first, then suffix; search engines only exact or www.
	 *
	 * @param string $host Host.
	 * @return array|null array( source, category ).
	 */
	private static function lookup( $host ) {
		if ( isset( self::SOURCE_REGISTRY[ $host ] ) ) {
			return self::SOURCE_REGISTRY[ $host ];
		}
		foreach ( self::SOURCE_REGISTRY as $key => $entry ) {
			if ( ! Paths::ends_with( $host, '.' . $key ) ) {
				continue;
			}
			if ( 'search' !== $entry[1] || 'www.' . $key === $host ) {
				return $entry;
			}
		}
		return null;
	}

	/**
	 * The AI-UTM entry for a utm_source value.
	 *
	 * @param string|null $utm utm_source.
	 * @return array|null array( source, category ).
	 */
	private static function utm_entry( $utm ) {
		$key = strtolower( (string) $utm );
		return '' !== $key && isset( self::AI_UTM_SOURCE_MAP[ $key ] ) ? self::AI_UTM_SOURCE_MAP[ $key ] : null;
	}

	/**
	 * Classify a referrer host that is in the registry.
	 *
	 * @param array      $entry Registry entry.
	 * @param string     $host  Referrer host.
	 * @param array|null $utm   AI-UTM entry.
	 * @return array Detection.
	 */
	private static function classify_host( array $entry, $host, $utm ) {
		if ( 'search' === $entry[1] ) {
			return null !== $utm ? self::result( $entry[0], 'ai_search', $host, 'both' ) : self::result( $entry[0], 'search', $host, 'referer' );
		}
		$agree = null !== $utm && $utm[0] === $entry[0];
		return self::result( $entry[0], $entry[1], $host, $agree ? 'both' : 'referer' );
	}

	/**
	 * Assemble a detection result.
	 *
	 * @param string $source    Normalised source.
	 * @param string $category  ai_assistant | search | ai_search.
	 * @param string $host      Referrer host or "".
	 * @param string $detection utm | referer | both.
	 * @return array Detection.
	 */
	private static function result( $source, $category, $host, $detection ) {
		return array(
			'citation_source'      => $source,
			'citation_category'    => $category,
			'citation_source_host' => $host,
			'citation_detection'   => $detection,
		);
	}
}
