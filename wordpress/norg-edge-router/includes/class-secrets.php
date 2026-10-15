<?php
/**
 * Site key at rest: authenticated encryption keyed from the site's own salts.
 *
 * Uses libsodium when available, else OpenSSL AES-256-GCM. If neither exists the
 * key is stored with a "plain:" marker and the status page says so; defining
 * NORG_SITE_KEY in wp-config.php avoids storage entirely and is recommended.
 *
 * @package NorgEdgeRouter
 */

namespace Norg\Edge;

defined( 'ABSPATH' ) || exit;

/**
 * Encrypts and decrypts the stored site key.
 */
final class Secrets {

	/**
	 * Encrypt a secret for storage.
	 *
	 * @param string $plain Secret.
	 * @return string Envelope.
	 */
	public static function encrypt( $plain ) {
		$key = self::key();
		if ( function_exists( 'sodium_crypto_secretbox' ) ) {
			$nonce = random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
			return 'sodium:' . self::b64( $nonce . sodium_crypto_secretbox( $plain, $nonce, $key ) );
		}
		if ( function_exists( 'openssl_encrypt' ) ) {
			$iv     = random_bytes( 12 );
			$tag    = '';
			$cipher = openssl_encrypt( $plain, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag );
			if ( false !== $cipher ) {
				return 'gcm:' . self::b64( $iv . $tag . $cipher );
			}
		}
		return 'plain:' . self::b64( $plain );
	}

	/**
	 * Decrypt an envelope.
	 *
	 * @param string $envelope Stored value.
	 * @return string|null Secret, or null when it cannot be read (e.g. salts changed).
	 */
	public static function decrypt( $envelope ) {
		$sep = strpos( $envelope, ':' );
		if ( false === $sep ) {
			return null;
		}
		$scheme = substr( $envelope, 0, $sep );
		$data   = base64_decode( substr( $envelope, $sep + 1 ), true ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode -- storage envelope.
		if ( false === $data ) {
			return null;
		}
		if ( 'plain' === $scheme ) {
			return $data;
		}
		if ( 'sodium' === $scheme && function_exists( 'sodium_crypto_secretbox_open' ) && strlen( $data ) > SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ) {
			$plain = sodium_crypto_secretbox_open( substr( $data, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ), substr( $data, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ), self::key() );
			return false === $plain ? null : $plain;
		}
		if ( 'gcm' === $scheme && function_exists( 'openssl_decrypt' ) && strlen( $data ) > 28 ) {
			$plain = openssl_decrypt( substr( $data, 28 ), 'aes-256-gcm', self::key(), OPENSSL_RAW_DATA, substr( $data, 0, 12 ), substr( $data, 12, 16 ) );
			return false === $plain ? null : $plain;
		}
		return null;
	}

	/**
	 * Which scheme a new secret would be stored with.
	 *
	 * @return string sodium | gcm | plain.
	 */
	public static function scheme() {
		if ( function_exists( 'sodium_crypto_secretbox' ) ) {
			return 'sodium';
		}
		return function_exists( 'openssl_encrypt' ) ? 'gcm' : 'plain';
	}

	/**
	 * 32-byte key derived from the site's auth salt.
	 *
	 * @return string Key.
	 */
	private static function key() {
		$salt = function_exists( 'wp_salt' ) ? wp_salt( 'auth' ) : ( defined( 'AUTH_KEY' ) ? AUTH_KEY : ABSPATH );
		return hash( 'sha256', 'norg-edge-router|' . $salt, true );
	}

	/**
	 * Base64 (storage encoding, not obfuscation).
	 *
	 * @param string $data Bytes.
	 * @return string Encoded.
	 */
	private static function b64( $data ) {
		return base64_encode( $data ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- storage envelope.
	}
}
