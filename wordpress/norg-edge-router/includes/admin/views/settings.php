<?php
/**
 * Settings and status page markup. Every value is escaped at output.
 *
 * @package NorgEdgeRouter
 *
 * @var \Norg\Edge\Admin\Status_View $view
 */

use Norg\Edge\Config;

defined( 'ABSPATH' ) || exit;

$norg_edge_config = $view->plugin->config();
$norg_edge_name   = Config::OPTION;
$norg_edge_icons  = array(
	'good' => 'yes-alt',
	'warn' => 'warning',
	'bad'  => 'dismiss',
	'info' => 'info-outline',
);
$norg_edge_lock   = static function ( $field ) use ( $norg_edge_config ) {
	return $norg_edge_config->is_locked( $field ) ? ' disabled' : '';
};
?>
<div class="wrap">
	<h1><?php esc_html_e( 'NORG Edge Router', 'norg-edge-router' ); ?></h1>
	<p><?php esc_html_e( 'Verified AI agents get NORG\'s optimised version of your pages at your own URLs. People and search engines always get your site exactly as it is.', 'norg-edge-router' ); ?></p>

	<h2><?php esc_html_e( 'Status', 'norg-edge-router' ); ?></h2>
	<table class="widefat striped" style="max-width:900px">
		<tbody>
		<?php foreach ( $view->rows() as $norg_edge_label => $norg_edge_row ) : ?>
			<tr>
				<th scope="row" style="width:220px"><?php echo esc_html( $norg_edge_label ); ?></th>
				<td><span class="dashicons dashicons-<?php echo esc_attr( $norg_edge_icons[ $norg_edge_row[0] ] ); ?>" aria-hidden="true"></span> <?php echo esc_html( (string) $norg_edge_row[1] ); ?></td>
			</tr>
		<?php endforeach; ?>
		</tbody>
	</table>
	<p>
		<?php
		foreach ( array(
			'norg_edge_run_checks'   => __( 'Run checks', 'norg-edge-router' ),
			'norg_edge_heartbeat'    => __( 'Send heartbeat', 'norg-edge-router' ),
			'norg_edge_apply_bypass' => __( 'Re-apply cache bypass', 'norg-edge-router' ),
			'norg_edge_debug_report' => __( 'Download debug report', 'norg-edge-router' ),
		) as $norg_edge_action => $norg_edge_text ) :
			?>
			<a class="button" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=' . $norg_edge_action ), $norg_edge_action ) ); ?>"><?php echo esc_html( $norg_edge_text ); ?></a>
		<?php endforeach; ?>
	</p>

	<?php $norg_edge_caches = $view->caches(); ?>
	<h2><?php esc_html_e( 'Page cache', 'norg-edge-router' ); ?></h2>
	<?php if ( ! $norg_edge_caches ) : ?>
		<p><?php esc_html_e( 'No page-cache plugin detected.', 'norg-edge-router' ); ?></p>
	<?php else : ?>
		<table class="widefat striped" style="max-width:900px">
			<thead><tr><th><?php esc_html_e( 'Cache', 'norg-edge-router' ); ?></th><th><?php esc_html_e( 'Bypass for AI agents', 'norg-edge-router' ); ?></th></tr></thead>
			<tbody>
			<?php foreach ( $norg_edge_caches as $norg_edge_cache ) : ?>
				<tr>
					<td><?php echo esc_html( $norg_edge_cache[0] ); ?></td>
					<td>
						<?php
						if ( null === $norg_edge_cache[1] ) {
							esc_html_e( 'Not applied yet', 'norg-edge-router' );
						} else {
							echo esc_html( ( $norg_edge_cache[1]['ok'] ? '✓ ' : '✗ ' ) . $norg_edge_cache[1]['mechanism'] . ( '' !== $norg_edge_cache[1]['note'] ? ' — ' . $norg_edge_cache[1]['note'] : '' ) );
						}
						?>
					</td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>
	<?php endif; ?>
	<?php if ( '' !== $view->host_advice() ) : ?>
		<div class="notice notice-warning inline"><p><?php echo esc_html( $view->host_advice() ); ?></p></div>
	<?php endif; ?>
	<?php if ( $view->tokens() ) : ?>
		<p><label for="norg-edge-uas"><?php esc_html_e( 'AI user agents to exclude from any cache in front of WordPress (for your host):', 'norg-edge-router' ); ?></label></p>
		<textarea id="norg-edge-uas" class="large-text code" rows="3" readonly><?php echo esc_textarea( implode( "\n", $view->tokens() ) ); ?></textarea>
	<?php endif; ?>
	<?php $norg_edge_error = $view->last_error(); ?>
	<?php if ( null !== $norg_edge_error ) : ?>
		<p class="description">
			<?php
			/* translators: 1: time since, 2: error message. */
			echo esc_html( sprintf( __( 'Last internal error %1$s ago: %2$s. Visitors were served your normal site.', 'norg-edge-router' ), human_time_diff( (int) $norg_edge_error['at'] ), $norg_edge_error['message'] ) );
			?>
		</p>
	<?php endif; ?>

	<h2><?php esc_html_e( 'Settings', 'norg-edge-router' ); ?></h2>
	<form method="post" action="options.php">
		<?php settings_fields( \Norg\Edge\Admin\Settings_Page::GROUP ); ?>
		<table class="form-table" role="presentation">
			<tr>
				<th scope="row"><label for="norg-site-id"><?php esc_html_e( 'Site ID', 'norg-edge-router' ); ?></label></th>
				<td><input id="norg-site-id" class="regular-text code" name="<?php echo esc_attr( $norg_edge_name ); ?>[site_id]" value="<?php echo esc_attr( (string) $norg_edge_config->get( 'site_id' ) ); ?>"<?php echo esc_attr( $norg_edge_lock( 'site_id' ) ); ?>></td>
			</tr>
			<tr>
				<th scope="row"><label for="norg-site-key"><?php esc_html_e( 'Site Key', 'norg-edge-router' ); ?></label></th>
				<td>
					<input id="norg-site-key" type="password" autocomplete="off" class="regular-text code" name="<?php echo esc_attr( $norg_edge_name ); ?>[site_key]" value="" placeholder="<?php echo esc_attr( $norg_edge_config->site_key_masked() ); ?>"<?php echo esc_attr( $norg_edge_lock( 'site_key' ) ); ?>>
					<p class="description"><?php esc_html_e( 'Leave empty to keep the current key. For best security define NORG_SITE_KEY in wp-config.php instead.', 'norg-edge-router' ); ?></p>
				</td>
			</tr>
			<tr>
				<th scope="row"><label for="norg-env"><?php esc_html_e( 'NORG environment', 'norg-edge-router' ); ?></label></th>
				<td><select id="norg-env" name="<?php echo esc_attr( $norg_edge_name ); ?>[edge_env]"<?php echo esc_attr( $norg_edge_lock( 'edge_env' ) ); ?>>
					<?php
					foreach ( array(
						''           => __( 'Automatic', 'norg-edge-router' ),
						'production' => 'production',
						'test'       => 'test',
					) as $norg_edge_value => $norg_edge_text ) :
						?>
						<option value="<?php echo esc_attr( $norg_edge_value ); ?>" <?php selected( (string) $norg_edge_config->get( 'edge_env' ), $norg_edge_value ); ?>><?php echo esc_html( $norg_edge_text ); ?></option>
					<?php endforeach; ?>
				</select></td>
			</tr>
			<tr>
				<th scope="row"><label for="norg-proxy"><?php esc_html_e( 'Visitor IP comes from', 'norg-edge-router' ); ?></label></th>
				<td>
					<select id="norg-proxy" name="<?php echo esc_attr( $norg_edge_name ); ?>[trusted_proxy]"<?php echo esc_attr( $norg_edge_lock( 'trusted_proxy' ) ); ?>>
						<?php
						foreach ( array(
							'none'       => __( 'The connection (REMOTE_ADDR)', 'norg-edge-router' ),
							'cloudflare' => __( 'Cloudflare (CF-Connecting-IP, only from Cloudflare IPs)', 'norg-edge-router' ),
							'header'     => __( 'A header set by my proxy', 'norg-edge-router' ),
						) as $norg_edge_value => $norg_edge_text ) :
							?>
							<option value="<?php echo esc_attr( $norg_edge_value ); ?>" <?php selected( (string) $norg_edge_config->get( 'trusted_proxy' ), $norg_edge_value ); ?>><?php echo esc_html( $norg_edge_text ); ?></option>
						<?php endforeach; ?>
					</select>
					<input class="regular-text code" name="<?php echo esc_attr( $norg_edge_name ); ?>[trusted_header]" value="<?php echo esc_attr( (string) $norg_edge_config->get( 'trusted_header' ) ); ?>" placeholder="X-Real-IP">
					<p class="description"><?php esc_html_e( 'AI agents are verified by their IP address. A wrong setting means none are verified, which is safe but serves them your normal pages.', 'norg-edge-router' ); ?></p>
				</td>
			</tr>
			<?php
			$norg_edge_flags = array(
				'disabled'       => __( 'Disable (every visitor gets your normal site)', 'norg-edge-router' ),
				'capture_only'   => __( 'Record only: report AI-agent visits, serve nothing different', 'norg-edge-router' ),
				'strip_fallback' => __( 'Serve a stripped page to agents until NORG has rendered it', 'norg-edge-router' ),
				'lazy_render'    => __( 'Ask NORG to render pages agents request', 'norg-edge-router' ),
				'cache_bypass'   => __( 'Register AI user agents with my page-cache plugin', 'norg-edge-router' ),
				'htaccess_block' => __( 'Add the .htaccess bypass block (Apache/LiteSpeed; for caches without an API)', 'norg-edge-router' ),
				'origin_probe'   => __( 'Let my own llms.txt and similar files win over NORG\'s', 'norg-edge-router' ),
				'auto_update'    => __( 'Install plugin updates automatically', 'norg-edge-router' ),
				'debug'          => __( 'Debug logging to the PHP error log', 'norg-edge-router' ),
			);
			?>
			<tr>
				<th scope="row"><?php esc_html_e( 'Behaviour', 'norg-edge-router' ); ?></th>
				<td><fieldset>
					<?php foreach ( $norg_edge_flags as $norg_edge_flag => $norg_edge_text ) : ?>
						<label><input type="checkbox" name="<?php echo esc_attr( $norg_edge_name ); ?>[<?php echo esc_attr( $norg_edge_flag ); ?>]" value="1" <?php checked( (bool) $norg_edge_config->get( $norg_edge_flag ) ); ?><?php echo esc_attr( $norg_edge_lock( $norg_edge_flag ) ); ?>> <?php echo esc_html( $norg_edge_text ); ?></label><br>
					<?php endforeach; ?>
				</fieldset></td>
			</tr>
		</table>
		<?php submit_button(); ?>
	</form>
</div>
