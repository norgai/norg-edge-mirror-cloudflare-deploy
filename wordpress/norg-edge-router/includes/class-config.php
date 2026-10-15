<?php
/**
 * Settings: wp-config constant, then the saved option, then the baked default.
 *
 * A defined constant always wins and locks the field in the admin UI, so a host
 * or agency can pin configuration in wp-config.php. The site key is stored
 * encrypted (see Secrets) and never leaves this class except to the NORG client.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Typed access to the plugin's configuration.
 */
final class Config {

	const OPTION = 'norg_edge_settings';

	/** Field => array( constant, default ). */
	const FIELDS = array(
		'site_id'        => array( 'NORG_SITE_ID', '' ),
		'api_url'        => array( 'NORG_API_URL', 'https://content-craft-api.norg.ai' ),
		'content_base'   => array( 'NORG_CONTENT_BASE', 'https://edge-content.norg.ai' ),
		'edge_env'       => array( 'NORG_EDGE_ENV', '' ),
		'disabled'       => array( 'NORG_EDGE_DISABLED', false ),
		'capture_only'   => array( 'NORG_CAPTURE_ONLY', false ),
		'strip_fallback' => array( 'NORG_STRIP_FALLBACK_ENABLED', true ),
		'lazy_render'    => array( 'NORG_LAZY_RENDER_ENABLED', true ),
		'trusted_proxy'  => array( 'NORG_TRUSTED_PROXY', 'none' ),
		'trusted_header' => array( 'NORG_TRUSTED_PROXY_HEADER', '' ),
		'origin_probe'   => array( 'NORG_EDGE_ORIGIN_PROBE', true ),
		'cache_bypass'   => array( 'NORG_EDGE_CACHE_BYPASS', true ),
		'htaccess_block' => array( 'NORG_EDGE_HTACCESS_BLOCK', false ),
		'auto_update'    => array( 'NORG_EDGE_AUTO_UPDATE', true ),
		'debug'          => array( 'NORG_EDGE_DEBUG', false ),
	);

	const BOOL_FIELDS = array( 'disabled', 'capture_only', 'strip_fallback', 'lazy_render', 'origin_probe', 'cache_bypass', 'htaccess_block', 'auto_update', 'debug' );

	/**
	 * Saved option values.
	 *
	 * @var array
	 */
	private $saved;

	/**
	 * Load the saved option.
	 */
	public function __construct() {
		$saved       = get_option( self::OPTION, array() );
		$this->saved = is_array( $saved ) ? $saved : array();
	}

	/**
	 * A field's effective value.
	 *
	 * @param string $field Field name from FIELDS.
	 * @return mixed Value (booleans already parsed for BOOL_FIELDS).
	 */
	public function get( $field ) {
		list( $constant, $default ) = self::FIELDS[ $field ];
		if ( defined( $constant ) ) {
			$value = constant( $constant );
		} elseif ( array_key_exists( $field, $this->saved ) && '' !== $this->saved[ $field ] ) {
			$value = $this->saved[ $field ];
		} else {
			$value = $default;
		}
		return in_array( $field, self::BOOL_FIELDS, true ) ? self::to_bool( $value ) : $value;
	}

	/**
	 * Is this field pinned by a wp-config constant?
	 *
	 * @param string $field Field name.
	 * @return bool True when locked.
	 */
	public function is_locked( $field ) {
		return 'site_key' === $field ? defined( 'NORG_SITE_KEY' ) : defined( self::FIELDS[ $field ][0] );
	}

	/**
	 * The plaintext site key, or "" when unset or undecryptable.
	 *
	 * @return string Site key.
	 */
	public function site_key() {
		if ( defined( 'NORG_SITE_KEY' ) ) {
			return (string) constant( 'NORG_SITE_KEY' );
		}
		$stored = isset( $this->saved['site_key_enc'] ) ? (string) $this->saved['site_key_enc'] : '';
		return '' === $stored ? '' : (string) Secrets::decrypt( $stored );
	}

	/**
	 * Is a key stored that can no longer be decrypted (salts rotated)?
	 *
	 * @return bool True when the admin must paste the key again.
	 */
	public function site_key_unreadable() {
		return ! defined( 'NORG_SITE_KEY' ) && ! empty( $this->saved['site_key_enc'] ) && null === Secrets::decrypt( (string) $this->saved['site_key_enc'] );
	}

	/**
	 * Masked key for display: "nek_live_…abcd".
	 *
	 * @return string Masked key or "".
	 */
	public function site_key_masked() {
		$key = $this->site_key();
		return strlen( $key ) > 13 ? substr( $key, 0, 9 ) . '…' . substr( $key, -4 ) : ( '' === $key ? '' : '••••' );
	}

	/**
	 * Are both credentials present?
	 *
	 * @return bool True when the router may talk to NORG.
	 */
	public function is_configured() {
		return '' !== (string) $this->get( 'site_id' ) && '' !== $this->site_key();
	}

	/**
	 * Which NORG environment this install is bound to.
	 *
	 * The worker has no default on purpose; here the install action hands the
	 * value over with the Site ID, and an unset value is derived from the API
	 * host so a default install reports "production" rather than "unknown".
	 *
	 * @return string production | test | unknown (or an explicit value).
	 */
	public function edge_env() {
		$explicit = (string) $this->get( 'edge_env' );
		if ( '' !== $explicit ) {
			return $explicit;
		}
		$api = rtrim( (string) $this->get( 'api_url' ), '/' );
		if ( Constants::BINDING_DEFAULTS['NORG_API_URL'] === $api ) {
			return 'production';
		}
		return false !== strpos( $api, 'test' ) ? 'test' : 'unknown';
	}

	/**
	 * Persist new option values (constants are never written).
	 *
	 * @param array $values Field => value; "site_key" is encrypted before storage.
	 * @return void
	 */
	public function save( array $values ) {
		$saved = $this->saved;
		foreach ( $values as $field => $value ) {
			if ( 'site_key' === $field ) {
				if ( '' !== (string) $value ) {
					$saved['site_key_enc'] = Secrets::encrypt( (string) $value );
				}
				continue;
			}
			if ( isset( self::FIELDS[ $field ] ) ) {
				$saved[ $field ] = $value;
			}
		}
		update_option( self::OPTION, $saved, false );
		$this->saved = $saved;
	}

	/**
	 * Parse a boolean-ish value ("true", "1", true, "yes", "on").
	 *
	 * @param mixed $value Value.
	 * @return bool Parsed.
	 */
	public static function to_bool( $value ) {
		if ( is_bool( $value ) ) {
			return $value;
		}
		return in_array( strtolower( trim( (string) $value ) ), array( '1', 'true', 'yes', 'on' ), true );
	}
}
