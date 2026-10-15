<?php
/**
 * Strip origin HTML to a token-dense form (port of the provider-neutral core/strip.js).
 *
 * A tokenizer, not a DOM: the selector set is a few bare tags plus tag[attr='v'],
 * so no parser dependency is needed, and output is byte-identical to the
 * CloudFront/Bunny adapters. All delimiters are ASCII, so byte offsets are safe
 * on UTF-8 input. The one malformed-input failure mode (an unclosed removed
 * element suppresses to end of document) yields a near-empty page that the
 * word floor rejects, so the visitor still gets the untouched origin.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * HTML stripping and visible-word counting.
 */
final class Strip {

	const VOID_ELEMENTS     = array( 'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr' );
	const RAW_TEXT_ELEMENTS = array( 'script', 'style', 'textarea', 'title' );

	/**
	 * JavaScript's \s set, so word counts match the worker on NBSP and friends.
	 */
	const JS_WHITESPACE = '[\x{0009}-\x{000D}\x{0020}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]';

	/**
	 * Compiled remove matchers.
	 *
	 * @var array|null
	 */
	private static $matchers = null;

	/**
	 * Strip an HTML document to its informational content.
	 *
	 * @param string $html Origin HTML.
	 * @return string Stripped HTML.
	 */
	public static function html( $html ) {
		$out   = array();
		$state = array(
			'tag'   => null,
			'depth' => 0,
		);
		$i     = 0;
		$len   = strlen( $html );
		while ( $i < $len ) {
			$open = strpos( $html, '<', $i );
			if ( false === $open ) {
				if ( null === $state['tag'] ) {
					$out[] = substr( $html, $i );
				}
				break;
			}
			if ( $open > $i && null === $state['tag'] ) {
				$out[] = substr( $html, $i, $open - $i );
			}
			$next = self::consume_markup( $html, $open, $state, $out );
			if ( $next === $open ) {
				if ( null === $state['tag'] ) {
					$out[] = '<';
				}
				$i = $open + 1;
			} else {
				$i = $next;
			}
		}
		return implode( '', $out );
	}

	/**
	 * Count visible words after tags are removed (countVisibleWords).
	 *
	 * @param string $html HTML fragment.
	 * @return int Whitespace-delimited word count.
	 */
	public static function count_words( $html ) {
		$text = preg_replace( '/<[^>]+>/', ' ', $html );
		$ws   = self::JS_WHITESPACE;
		$u    = preg_match( '//u', $text ) ? 'u' : '';
		$text = $u ? preg_replace( '/' . $ws . '+/u', ' ', $text ) : preg_replace( '/[\t\n\v\f\r ]+/', ' ', $text );
		$text = $u ? preg_replace( '/^' . $ws . '+|' . $ws . '+$/u', '', $text ) : trim( $text, " \t\n\r\0\x0B\f" );
		return '' === $text ? 0 : count( explode( ' ', $text ) );
	}

	/**
	 * Consume one markup construct at $open.
	 *
	 * @param string $html  Document.
	 * @param int    $open  Index of "<".
	 * @param array  $state Suppression state (by reference).
	 * @param array  $out   Output accumulator (by reference).
	 * @return int Index to resume from, or $open when this "<" is literal text.
	 */
	private static function consume_markup( $html, $open, array &$state, array &$out ) {
		if ( 0 === substr_compare( $html, '<!--', $open, 4 ) ) {
			$end = strpos( $html, '-->', $open );
			return false === $end ? strlen( $html ) : $end + 3;
		}
		if ( 0 === substr_compare( $html, '<!', $open, 2 ) || 0 === substr_compare( $html, '<?', $open, 2 ) ) {
			$end = self::find_tag_end( $html, $open );
			if ( -1 === $end ) {
				return strlen( $html );
			}
			if ( null === $state['tag'] ) {
				$out[] = substr( $html, $open, $end + 1 - $open );
			}
			return $end + 1;
		}
		if ( 0 === substr_compare( $html, '</', $open, 2 ) ) {
			return self::consume_close_tag( $html, $open, $state, $out );
		}
		$next = isset( $html[ $open + 1 ] ) ? $html[ $open + 1 ] : '';
		if ( '' !== $next && ctype_alpha( $next ) ) {
			return self::consume_open_tag( $html, $open, $state, $out );
		}
		return $open;
	}

	/**
	 * Index of the ">" closing a tag, ignoring any inside quoted values.
	 *
	 * @param string $html  Document.
	 * @param int    $start Index of the opening "<".
	 * @return int Index of ">", or -1 when unterminated.
	 */
	private static function find_tag_end( $html, $start ) {
		$quote = '';
		$len   = strlen( $html );
		for ( $i = $start + 1; $i < $len; $i++ ) {
			$char = $html[ $i ];
			if ( '' !== $quote ) {
				if ( $char === $quote ) {
					$quote = '';
				}
			} elseif ( '"' === $char || "'" === $char ) {
				$quote = $char;
			} elseif ( '>' === $char ) {
				return $i;
			}
		}
		return -1;
	}

	/**
	 * Consume a closing tag, ending a suppression range when it matches.
	 *
	 * @param string $html  Document.
	 * @param int    $open  Index of "<".
	 * @param array  $state Suppression state.
	 * @param array  $out   Output accumulator.
	 * @return int Resume index.
	 */
	private static function consume_close_tag( $html, $open, array &$state, array &$out ) {
		$end = self::find_tag_end( $html, $open );
		if ( -1 === $end ) {
			return strlen( $html );
		}
		$tag = strtolower( trim( substr( $html, $open + 2, $end - $open - 2 ) ) );
		if ( null !== $state['tag'] ) {
			if ( $tag === $state['tag'] ) {
				--$state['depth'];
				if ( 0 === $state['depth'] ) {
					$state['tag'] = null;
				}
			}
			return $end + 1;
		}
		if ( ! in_array( $tag, Constants::STRIP_UNWRAP_SELECTORS, true ) ) {
			$out[] = '</' . $tag . '>';
		}
		return $end + 1;
	}

	/**
	 * Consume an opening tag, starting a suppression range when it matches.
	 *
	 * @param string $html  Document.
	 * @param int    $open  Index of "<".
	 * @param array  $state Suppression state.
	 * @param array  $out   Output accumulator.
	 * @return int Resume index.
	 */
	private static function consume_open_tag( $html, $open, array &$state, array &$out ) {
		$end = self::find_tag_end( $html, $open );
		if ( -1 === $end ) {
			return strlen( $html );
		}
		$inner       = substr( $html, $open + 1, $end - $open - 1 );
		$self_closed = '/' === substr( $inner, -1 );
		$name_end    = preg_match( '/[\s\/]/', $inner, $m, PREG_OFFSET_CAPTURE ) ? $m[0][1] : -1;
		$tag         = strtolower( -1 === $name_end ? $inner : substr( $inner, 0, $name_end ) );
		$attributes  = self::parse_attributes( -1 === $name_end ? '' : substr( $inner, $name_end ) );

		if ( null !== $state['tag'] ) {
			if ( $tag === $state['tag'] && ! $self_closed && ! in_array( $tag, self::VOID_ELEMENTS, true ) ) {
				++$state['depth'];
			}
			return in_array( $tag, self::RAW_TEXT_ELEMENTS, true ) ? self::read_raw_text( $html, $end + 1, $tag )[1] : $end + 1;
		}
		if ( self::is_removed( $tag, $attributes ) ) {
			return self::start_removal( $html, $end, $tag, $self_closed, $state );
		}
		if ( ! in_array( $tag, Constants::STRIP_UNWRAP_SELECTORS, true ) ) {
			$out[] = self::serialise_open_tag( $tag, $attributes, $self_closed );
		}
		if ( in_array( $tag, self::RAW_TEXT_ELEMENTS, true ) && ! $self_closed ) {
			$raw   = self::read_raw_text( $html, $end + 1, $tag );
			$out[] = $raw[0];
			$out[] = '</' . $tag . '>';
			return $raw[1];
		}
		return $end + 1;
	}

	/**
	 * Begin skipping a removed element (void/self-closed and raw-text ones end at once).
	 *
	 * @param string $html        Document.
	 * @param int    $end         Index of the open tag's ">".
	 * @param string $tag         Tag name.
	 * @param bool   $self_closed Whether the source tag self-closed.
	 * @param array  $state       Suppression state.
	 * @return int Resume index.
	 */
	private static function start_removal( $html, $end, $tag, $self_closed, array &$state ) {
		if ( $self_closed || in_array( $tag, self::VOID_ELEMENTS, true ) ) {
			return $end + 1;
		}
		if ( in_array( $tag, self::RAW_TEXT_ELEMENTS, true ) ) {
			return self::read_raw_text( $html, $end + 1, $tag )[1];
		}
		$state['tag']   = $tag;
		$state['depth'] = 1;
		return $end + 1;
	}

	/**
	 * Interior text of a raw-text element and the index just past its close tag.
	 *
	 * @param string $html Document.
	 * @param int    $from Index after the open tag.
	 * @param string $tag  Tag name.
	 * @return array array( content, next ).
	 */
	private static function read_raw_text( $html, $from, $tag ) {
		$close = stripos( $html, '</' . $tag, $from );
		if ( false === $close ) {
			return array( substr( $html, $from ), strlen( $html ) );
		}
		$end = self::find_tag_end( $html, $close );
		return array( substr( $html, $from, $close - $from ), -1 === $end ? strlen( $html ) : $end + 1 );
	}

	/**
	 * Parse attributes out of a tag's inner text, in source order.
	 *
	 * PREG_UNMATCHED_AS_NULL mirrors JavaScript's undefined groups, so name="" keeps
	 * an empty value while a bare name has none.
	 *
	 * @param string $source Text after the tag name.
	 * @return array List of array( name, value|null ).
	 */
	private static function parse_attributes( $source ) {
		$attributes = array();
		if ( '' === $source ) {
			return $attributes;
		}
		preg_match_all( '/([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s"\'=<>`]+)))?/', $source, $matches, PREG_SET_ORDER | PREG_UNMATCHED_AS_NULL );
		foreach ( $matches as $match ) {
			$value = null;
			foreach ( array( 2, 3, 4 ) as $g ) {
				if ( isset( $match[ $g ] ) ) {
					$value = $match[ $g ];
					break;
				}
			}
			$attributes[] = array( strtolower( $match[1] ), $value );
		}
		return $attributes;
	}

	/**
	 * Does this element match any remove selector?
	 *
	 * @param string $tag        Tag name.
	 * @param array  $attributes Parsed attributes.
	 * @return bool True when the element must be removed with its content.
	 */
	private static function is_removed( $tag, array $attributes ) {
		foreach ( self::matchers() as $matcher ) {
			if ( null !== $matcher[0] && $matcher[0] !== $tag ) {
				continue;
			}
			if ( null === $matcher[1] ) {
				return true;
			}
			foreach ( $attributes as $attribute ) {
				if ( $attribute[0] === $matcher[1] && $attribute[1] === $matcher[2] ) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * Compile Constants::STRIP_REMOVE_SELECTORS into array( tag, attribute, value ) triples.
	 *
	 * @return array Matchers.
	 */
	private static function matchers() {
		if ( null === self::$matchers ) {
			self::$matchers = array();
			foreach ( Constants::STRIP_REMOVE_SELECTORS as $selector ) {
				preg_match( "/^([a-z0-9-]*)(?:\\[([a-z-]+)='([^']*)'\\])?$/i", $selector, $m );
				self::$matchers[] = array(
					'' !== $m[1] ? strtolower( $m[1] ) : null,
					isset( $m[2] ) && '' !== $m[2] ? strtolower( $m[2] ) : null,
					isset( $m[3] ) ? $m[3] : null,
				);
			}
		}
		return self::$matchers;
	}

	/**
	 * Re-serialise an open tag keeping only meaningful attributes.
	 *
	 * @param string $tag         Tag name.
	 * @param array  $attributes  Parsed attributes.
	 * @param bool   $self_closed Whether the source tag self-closed.
	 * @return string Rewritten tag.
	 */
	private static function serialise_open_tag( $tag, array $attributes, $self_closed ) {
		$kept = '';
		foreach ( $attributes as $attribute ) {
			if ( ! in_array( $attribute[0], Constants::STRIP_KEEP_ATTRIBUTES, true ) ) {
				continue;
			}
			$kept .= null === $attribute[1] ? ' ' . $attribute[0] : ' ' . $attribute[0] . '="' . str_replace( array( '&', '"' ), array( '&amp;', '&quot;' ), $attribute[1] ) . '"';
		}
		return '<' . $tag . $kept . ( $self_closed ? ' /' : '' ) . '>';
	}
}
