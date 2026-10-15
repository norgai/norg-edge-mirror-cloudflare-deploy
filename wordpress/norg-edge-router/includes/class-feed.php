<?php
/**
 * The authenticated bot-pattern feed and the entitlement it carries (rule 3).
 *
 * No feed, no behaviour: there is deliberately no baked-in pattern list. A
 * refusal (401/403) revokes at once; an outage never does. One non-autoloaded
 * transient holds the entry; freshness is tracked inside it so a stale but
 * entitled entry keeps serving while a refresh runs after the response.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Caches and refreshes the feed.
 */
final class Feed {

	const RETENTION = DAY_IN_SECONDS;
	const LOCK      = 'norg_edge_feed_lock';

	/**
	 * Configuration.
	 *
	 * @var Config
	 */
	private $config;

	/**
	 * NORG client.
	 *
	 * @var Norg_Client
	 */
	private $client;

	/**
	 * Background work queue.
	 *
	 * @var Deferred
	 */
	private $deferred;

	/**
	 * Entry already read in this request.
	 *
	 * @var array|null
	 */
	private $memo = null;

	/**
	 * Build the feed.
	 *
	 * @param Config      $config   Configuration.
	 * @param Norg_Client $client   NORG client.
	 * @param Deferred    $deferred Background work queue.
	 */
	public function __construct( Config $config, Norg_Client $client, Deferred $deferred ) {
		$this->config   = $config;
		$this->client   = $client;
		$this->deferred = $deferred;
	}

	/**
	 * The current entry, preferring speed over freshness.
	 *
	 * @return array Entry (entitled false when NORG has not confirmed this install).
	 */
	public function get() {
		if ( null !== $this->memo ) {
			return $this->memo;
		}
		$entry = get_transient( $this->key() );
		if ( is_array( $entry ) && isset( $entry['entitled'], $entry['fetched_at'], $entry['ttl'] ) ) {
			$fresh = time() - $entry['fetched_at'] < $entry['ttl'];
			if ( $fresh || $entry['entitled'] ) {
				if ( ! $fresh ) {
					$this->deferred->defer( array( $this, 'refresh_if_unlocked' ) );
				}
				$this->memo = $entry;
				return $entry;
			}
		}
		$this->refresh();
		return null !== $this->memo ? $this->memo : self::negative( 'unreachable' );
	}

	/**
	 * Refresh now, unless another request already is (stale-while-revalidate path).
	 *
	 * @return void
	 */
	public function refresh_if_unlocked() {
		if ( ! add_option( self::LOCK, time(), '', false ) ) {
			$held = (int) get_option( self::LOCK, 0 );
			if ( time() - $held < 30 ) {
				return;
			}
			update_option( self::LOCK, time(), false );
		}
		try {
			$this->refresh();
		} finally {
			delete_option( self::LOCK );
		}
	}

	/**
	 * Fetch the feed from NORG and store the verdict.
	 *
	 * @return string ok | refused | unreachable.
	 */
	public function refresh() {
		$previous = get_transient( $this->key() );
		$previous = is_array( $previous ) ? $previous : array();
		$etag     = ( ! empty( $previous['entitled'] ) && ! empty( $previous['etag'] ) ) ? (string) $previous['etag'] : '';
		$response = $this->config->is_configured() ? $this->client->get_feed( $etag ) : null;
		$outcome  = $this->outcome( $response, $previous );
		if ( 'ok' === $outcome ) {
			$entry = 304 === $response['status'] ? array_merge( $previous, array( 'fetched_at' => time() ) ) : self::parse( $response['body'], $response['etag'] );
			$this->store( $entry );
			Cache\Registry::schedule_if_changed( $entry );
		} elseif ( 'refused' === $outcome || empty( $previous['entitled'] ) ) {
			$this->store( self::negative( $outcome ) );
		} else {
			$this->memo = $previous;
		}
		update_option(
			'norg_edge_feed_status',
			array(
				'outcome' => $outcome,
				'at'      => time(),
				'http'    => $response['status'] ?? null,
			),
			false
		);
		return $outcome;
	}

	/**
	 * Classify a feed response.
	 *
	 * @param array|null $response Client response.
	 * @param array      $previous Entry held before this refresh.
	 * @return string ok | refused | unreachable.
	 */
	private function outcome( $response, array $previous ) {
		if ( null === $response ) {
			return 'unreachable';
		}
		if ( in_array( $response['status'], Constants::REFUSAL_STATUSES, true ) ) {
			return 'refused';
		}
		if ( 304 === $response['status'] && ! empty( $previous['entitled'] ) ) {
			return 'ok';
		}
		return ( 200 === $response['status'] && is_array( $response['body'] ) ) ? 'ok' : 'unreachable';
	}

	/**
	 * Turn a 200 body into an entry (readFeedBody).
	 *
	 * @param array  $data Decoded body.
	 * @param string $etag Response ETag.
	 * @return array Entry.
	 */
	public static function parse( array $data, $etag ) {
		$prefix = isset( $data['agentic_path_prefix'] ) && '' !== $data['agentic_path_prefix'] ? (string) $data['agentic_path_prefix'] : Constants::DEFAULT_AGENTIC_PATH_PREFIX;
		return array(
			'entitled'                  => true,
			'patterns'                  => isset( $data['patterns'] ) && is_array( $data['patterns'] ) ? array_values( $data['patterns'] ) : array(),
			'cidr_ranges'               => isset( $data['cidr_ranges'] ) && is_array( $data['cidr_ranges'] ) ? $data['cidr_ranges'] : array(),
			'agentic_path_prefix'       => $prefix,
			'skip_paths'                => isset( $data['skip_paths'] ) && is_array( $data['skip_paths'] ) ? array_values( $data['skip_paths'] ) : array(),
			'capture_only'              => isset( $data['capture_only'] ) && true === $data['capture_only'],
			'citation_tracking_enabled' => isset( $data['citation_tracking_enabled'] ) && true === $data['citation_tracking_enabled'],
			'etag'                      => (string) $etag,
			'fetched_at'                => time(),
			'ttl'                       => ! empty( $data['cache_ttl'] ) ? (int) $data['cache_ttl'] : Constants::PATTERN_DEFAULT_TTL,
			'outcome'                   => 'ok',
		);
	}

	/**
	 * A short-lived unentitled verdict.
	 *
	 * @param string $outcome Why (refused | unreachable).
	 * @return array Entry.
	 */
	public static function negative( $outcome ) {
		return array(
			'entitled'            => false,
			'patterns'            => array(),
			'cidr_ranges'         => array(),
			'agentic_path_prefix' => '',
			'skip_paths'          => array(),
			'capture_only'        => false,
			'fetched_at'          => time(),
			'ttl'                 => Constants::UNENTITLED_TTL,
			'outcome'             => $outcome,
		);
	}

	/**
	 * Drop the cached entry (settings changed).
	 *
	 * @return void
	 */
	public function forget() {
		delete_transient( $this->key() );
		$this->memo = null;
	}

	/**
	 * Store an entry.
	 *
	 * @param array $entry Entry.
	 * @return void
	 */
	private function store( array $entry ) {
		set_transient( $this->key(), $entry, self::RETENTION );
		$this->memo = $entry;
	}

	/**
	 * Transient key folding the site id and the capture binding (as the worker's feed cache does).
	 *
	 * @return string Key.
	 */
	private function key() {
		$fold = $this->config->get( 'site_id' ) . '|' . ( $this->config->get( 'capture_only' ) ? 'capture' : '' );
		return 'norg_edge_feed_' . substr( sha1( $fold ), 0, 12 );
	}
}
